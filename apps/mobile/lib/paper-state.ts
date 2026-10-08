import { type PaperPositionWithFill, type PaperQuote, type SignalDetail, scorePolicyV1 } from '@waffle/shared'
import { ApiError } from './api-error'
import { copyBlockReason } from './signal-state'

export function parsePaperSize(text: string): string | null {
  if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(text) || text.length > 12) return null
  const [whole = '0', fraction = ''] = text.split('.')
  const raw = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  return raw > 0n && raw <= scorePolicyV1.sizeLamports.paperMax ? raw.toString() : null
}
export function formatRaw(raw: string, decimals: number): string {
  const value = BigInt(raw)
  const sign = value < 0n ? '-' : ''
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0')
  if (!decimals) return sign + digits
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return `${sign}${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`
}
export const formatSol = (raw: string) => `${formatRaw(raw, 9)} SOL`
export const formatTokens = (raw: string, decimals?: number) =>
  decimals === undefined ? `${raw} base units (decimals unknown)` : `${formatRaw(raw, decimals)} tokens`
export function paperQuoteFresh(quote: PaperQuote, now: number): boolean {
  const age = now - Date.parse(quote.fetchedAt)
  return (
    age >= 0 &&
    age < (quote.network === 'devnet' ? 60_000 : scorePolicyV1.freshness.quoteMs) &&
    now < Date.parse(quote.expiresAt)
  )
}
export function paperReviewBlock(signal: SignalDetail | undefined, offline: boolean, now: number) {
  return signal ? copyBlockReason(signal, offline, now) : 'Refresh the signal before preparing a quote.'
}
export type PendingPaperFill = { quoteId: string; signalId: string; sizeLamports: string }
type State = {
  ready: boolean
  size: string
  quote: PaperQuote | null
  busy: boolean
  pending: PendingPaperFill | null
  canStartOver: boolean
  position: PaperPositionWithFill | null
  error: string | null
}
type Dependencies = {
  load: () => Promise<PendingPaperFill | null>
  save: (pending: PendingPaperFill) => Promise<void>
  clear: () => Promise<void>
  prepare: (size: string, signal: AbortSignal) => Promise<PaperQuote>
  create: (pending: PendingPaperFill) => Promise<PaperPositionWithFill>
  lookup: (quoteId: string) => Promise<PaperPositionWithFill | null>
  now?: () => number
  canSubmit?: () => boolean
}
/** One instance per account, API origin and signal. Mutations are never automatically replayed. */
export class PaperTradeController {
  private state: State = {
    ready: false,
    size: '0.1',
    quote: null,
    busy: false,
    pending: null,
    canStartOver: false,
    position: null,
    error: null,
  }
  private listeners = new Set<() => void>()
  private restoring = false
  private submitting = false
  private revision = 0
  private request: AbortController | null = null
  private readonly now: () => number
  constructor(
    private readonly signalId: string,
    private readonly dependencies: Dependencies,
  ) {
    this.now = dependencies.now ?? Date.now
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  async restore() {
    if (this.restoring) return
    if (this.state.ready) {
      if (this.state.pending) await this.reconcile()
      return
    }
    this.restoring = true
    try {
      const pending = await this.dependencies.load()
      this.update({ ready: true, pending })
      if (pending) await this.reconcile()
    } catch {
      this.update({ error: 'Unable to read saved fill status. Retry before trading.' })
    } finally {
      this.restoring = false
    }
  }
  invalidate() {
    this.revision++
    this.request?.abort()
    this.request = null
    this.update({ quote: null, busy: this.submitting || (this.state.pending !== null && this.state.busy) })
  }
  setSize(size: string) {
    if (this.state.pending || this.state.busy || this.state.position) return
    this.invalidate()
    this.update({ size, error: null })
  }
  async prepare() {
    if (!this.state.ready || this.state.busy || this.state.pending || this.state.position) return
    const size = parsePaperSize(this.state.size)
    if (!size) {
      this.update({ error: 'Enter up to 0.1 SOL with at most 9 decimal places.' })
      return
    }
    this.invalidate()
    const revision = this.revision
    const request = new AbortController()
    this.request = request
    this.update({ busy: true, error: null })
    try {
      const quote = await this.dependencies.prepare(size, request.signal)
      if (revision !== this.revision) return
      if (quote.signalId !== this.signalId || quote.inputAmountLamports !== size || !paperQuoteFresh(quote, this.now()))
        throw new Error('Quote expired or does not match. Request a fresh quote.')
      this.update({ quote })
    } catch (error) {
      if (revision === this.revision)
        this.update({ error: error instanceof Error ? error.message : 'Quote unavailable.' })
    } finally {
      if (revision === this.revision) this.update({ busy: false })
    }
  }
  async confirm() {
    const { quote, busy, pending, position } = this.state
    if (this.dependencies.canSubmit && !this.dependencies.canSubmit()) {
      this.invalidate()
      this.update({ error: 'Review changed. Reconnect and request a fresh quote.' })
      return
    }
    if (!quote || busy || pending || position || !paperQuoteFresh(quote, this.now())) {
      if (quote && !paperQuoteFresh(quote, this.now()))
        this.update({ quote: null, error: 'Quote expired. Request a fresh quote.' })
      return
    }
    const record = { quoteId: quote.id, signalId: this.signalId, sizeLamports: quote.inputAmountLamports }
    const revision = this.revision
    this.submitting = true
    this.update({ busy: true, error: null })
    try {
      // Save before sending. A terminated app can reconcile this exact quote on restart.
      await this.dependencies.save(record)
    } catch {
      this.submitting = false
      this.update({ busy: false, quote: null, error: 'Unable to save pending status. No fill was submitted.' })
      return
    }
    if (
      revision !== this.revision ||
      !paperQuoteFresh(quote, this.now()) ||
      (this.dependencies.canSubmit && !this.dependencies.canSubmit())
    ) {
      await this.dependencies.clear().catch(() => {})
      this.submitting = false
      this.update({ busy: false, quote: null, error: 'Review changed or quote expired. Request a fresh quote.' })
      return
    }
    this.update({ pending: record, quote: null })
    try {
      const filled = await this.dependencies.create(record)
      this.update({ position: filled, pending: null })
      await this.dependencies.clear().catch(() => {})
    } catch (error) {
      // Only a definitive client error establishes that this request was rejected.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await this.dependencies.clear().catch(() => {})
        this.update({ pending: null, error: error.message })
      } else {
        this.update({ error: 'Fill status is uncertain. Check status before making another fill.' })
      }
    } finally {
      this.submitting = false
      this.update({ busy: false })
    }
    if (this.state.pending) await this.reconcile()
  }
  async reconcile() {
    const pending = this.state.pending
    if (!pending || this.state.busy) return
    this.update({ busy: true, canStartOver: false })
    try {
      const position = await this.dependencies.lookup(pending.quoteId)
      if (position) {
        this.update({ position, pending: null, error: null })
        await this.dependencies.clear().catch(() => {})
      } else
        this.update({
          canStartOver: true,
          error: 'No saved paper trade found yet. The earlier request could still finish.',
        })
    } catch {
      this.update({ error: 'Unable to check fill status. Reconnect and check again.' })
    } finally {
      this.update({ busy: false })
    }
  }
  /** Explicitly abandon local recovery for a simulation; never cancel or replay the old POST. */
  async startOver() {
    if (!this.state.pending || !this.state.canStartOver || this.state.busy || this.submitting) return
    this.update({ busy: true, canStartOver: false })
    try {
      await this.dependencies.clear()
      this.invalidate()
      this.update({ pending: null, quote: null, error: null })
    } catch {
      this.update({ canStartOver: true, error: 'Unable to clear the saved review. Try again.' })
    } finally {
      this.update({ busy: false })
    }
  }
}
