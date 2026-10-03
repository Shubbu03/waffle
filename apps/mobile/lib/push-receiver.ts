import { type SignalDetail, scorePolicyV1 } from '@waffle/shared'
import { parseSignalPush, type SignalPush } from './push-tap'

export type SeenPush = { id: string; expiresAt: number }
type Dependencies = {
  now: () => number
  loadSeen: (owner: string) => Promise<SeenPush[]>
  saveSeen: (owner: string, seen: SeenPush[]) => Promise<void>
  signal: (id: string) => Promise<SignalDetail>
}

/** Runs inside the registration queue so delivery and logout cannot race each other. */
export async function receiveSignalPush(
  dependencies: Dependencies,
  data: unknown,
  owner: string,
  canDeliver: () => Promise<boolean>,
  display: (signal: SignalDetail, push: SignalPush) => Promise<void>,
): Promise<boolean> {
  const push = parseSignalPush(data, dependencies.now())
  if (!push || !(await canDeliver())) return false
  const seen = (await dependencies.loadSeen(owner)).filter((entry) => entry.expiresAt > dependencies.now())
  if (seen.some((entry) => entry.id === push.id)) return false
  const signal = await dependencies.signal(push.id)
  const now = dependencies.now()
  const assessment = signal.snapshot.assessment
  const transactionAt = Date.parse(assessment?.transactionAt ?? '')
  const observedAt = Date.parse(signal.observedAt)
  if (
    now >= push.expiresAt ||
    signal.id !== push.id ||
    signal.walletAddress !== push.wallet ||
    signal.mintAddress !== push.mint ||
    signal.slot !== push.slot ||
    signal.eventId !== push.eventId ||
    signal.status !== 'eligible' ||
    signal.score < 70 ||
    signal.dataStatus === 'unknown' ||
    signal.dataStatus === 'stale' ||
    assessment?.streamStale !== false ||
    !signal.snapshot.mint ||
    !signal.snapshot.pool ||
    !signal.snapshot.quote ||
    !(['mint', 'pool', 'quote'] as const).every((key) => assessment?.evidence[key].status === 'fresh') ||
    !Number.isFinite(transactionAt) ||
    transactionAt > now ||
    now - transactionAt >= scorePolicyV1.freshness.signalMs ||
    !Number.isFinite(observedAt) ||
    observedAt > now ||
    now - observedAt >= scorePolicyV1.freshness.signalMs ||
    !(await canDeliver()) ||
    dependencies.now() >= push.expiresAt
  )
    return false
  await display(signal, push)
  await dependencies.saveSeen(owner, [...seen, { id: push.id, expiresAt: push.expiresAt }].slice(-200))
  return true
}
