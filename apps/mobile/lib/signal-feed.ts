import {
  type LiveClientMessage,
  liveServerEventSchema,
  type SignalDetail,
  type SignalPage,
  type SignalSummary,
} from '@waffle/shared'
import { ApiError } from './api-error'
import type { FeedCache } from './signal-cache'
import { MAX_CACHED_SIGNALS, mergeSignals, type SignalView } from './signal-state'

export type FeedState = {
  items: SignalSummary[]
  status: 'loading' | 'ready' | 'cached' | 'error'
  connection: 'connecting' | 'live' | 'reconnecting' | 'paused'
  error: string | null
  historyGap: boolean
  refreshing: boolean
  loadingMore: boolean
  hasMore: boolean
  fetchedAt: number
}
export type LiveSocket = {
  send: (message: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}
type Dependencies = {
  view: SignalView
  token?: string
  subscriptionKey: string | null
  networkEnabled: boolean
  load: () => Promise<FeedCache | null>
  save: (cache: FeedCache) => Promise<void>
  list: (cursor: string | undefined, signal: AbortSignal) => Promise<SignalPage>
  detail: (id: string, signal: AbortSignal) => Promise<SignalDetail>
  socket: () => LiveSocket
  unauthorized: () => void
  retryDelay?: (attempt: number) => number
}

/** Applied cursors belong to this view/owner. REST refresh and ready watermarks never advance them. */
export class SignalFeed {
  private state: FeedState = {
    items: [],
    status: 'loading',
    connection: 'paused',
    error: null,
    historyGap: false,
    refreshing: false,
    loadingMore: false,
    hasMore: false,
    fetchedAt: 0,
  }
  private listeners = new Set<() => void>()
  private active = false
  private generation = 0
  private socketGeneration = 0
  private abort = new AbortController()
  private live: LiveSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private retry = 0
  private appliedCursor: string | null = null
  private nextCursor: string | null = null
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly dependencies: Dependencies) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(update: Partial<FeedState>) {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) listener()
  }
  private async persist(cursor = this.appliedCursor): Promise<void> {
    const cache: FeedCache = {
      version: 1,
      items: this.state.items.slice(0, MAX_CACHED_SIGNALS),
      appliedCursor: cursor,
      nextCursor:
        this.state.items.length > MAX_CACHED_SIGNALS
          ? this.state.items[MAX_CACHED_SIGNALS - 1].eventId
          : this.nextCursor,
      hasMore: this.state.hasMore || this.state.items.length > MAX_CACHED_SIGNALS,
      fetchedAt: this.state.fetchedAt,
      subscriptionKey: this.dependencies.subscriptionKey,
    }
    const write = this.writes.then(() => this.dependencies.save(cache))
    this.writes = write.catch(() => {})
    await write
  }
  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    const generation = ++this.generation
    this.abort = new AbortController()
    try {
      const cached = await this.dependencies.load()
      if (!this.active || generation !== this.generation) return
      if (
        cached &&
        (this.dependencies.subscriptionKey === null || cached.subscriptionKey === this.dependencies.subscriptionKey)
      ) {
        this.appliedCursor = cached.appliedCursor
        this.nextCursor = cached.nextCursor
        this.set({ items: cached.items, status: 'cached', hasMore: cached.hasMore, fetchedAt: cached.fetchedAt })
      }
    } catch {
      /* Storage failure still permits a network load. */
    }
    if (!this.active || generation !== this.generation) return
    if (!this.dependencies.networkEnabled) {
      this.set({ status: this.state.items.length ? 'cached' : 'ready', connection: 'paused' })
      return
    }
    await this.refresh()
    if (this.active && generation === this.generation) this.connect()
  }
  stop(): void {
    this.active = false
    ++this.generation
    this.abort.abort()
    this.disconnect()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.set({
      connection: 'paused',
      refreshing: false,
      loadingMore: false,
      status: this.state.items.length ? 'cached' : this.state.status,
    })
  }
  private disconnect() {
    ++this.socketGeneration
    clearTimeout(this.handshakeTimer)
    const socket = this.live
    this.live = null
    if (socket) {
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.onopen = null
      socket.close()
    }
  }
  async refresh(): Promise<void> {
    if (!this.active || !this.dependencies.networkEnabled || this.state.refreshing) return
    const generation = this.generation
    this.set({ refreshing: true })
    try {
      const page = await this.dependencies.list(undefined, this.abort.signal)
      if (!this.active || generation !== this.generation) return
      this.nextCursor = page.nextCursor
      this.set({
        items: mergeSignals(this.state.items, page.items),
        status: 'ready',
        error: null,
        hasMore: page.hasMore,
        fetchedAt: Date.now(),
      })
      await this.persist()
    } catch (error) {
      if (!this.active || generation !== this.generation) return
      this.set({
        status: this.state.items.length ? 'cached' : 'error',
        error: error instanceof Error ? error.message : 'Signals unavailable.',
      })
    } finally {
      if (generation === this.generation) this.set({ refreshing: false })
    }
  }
  async loadMore(): Promise<void> {
    if (
      !this.active ||
      !this.dependencies.networkEnabled ||
      this.state.loadingMore ||
      this.state.refreshing ||
      !this.nextCursor
    )
      return
    const generation = this.generation
    this.set({ loadingMore: true })
    try {
      const page = await this.dependencies.list(this.nextCursor, this.abort.signal)
      if (!this.active || generation !== this.generation) return
      this.nextCursor = page.nextCursor
      this.set({ items: mergeSignals(this.state.items, page.items), hasMore: page.hasMore, error: null })
      await this.persist()
    } catch (error) {
      if (generation === this.generation)
        this.set({ error: error instanceof Error ? error.message : 'History unavailable.' })
    } finally {
      if (generation === this.generation) this.set({ loadingMore: false })
    }
  }
  private reconnect() {
    this.disconnect()
    if (!this.active || this.reconnectTimer) return
    this.set({ connection: 'reconnecting' })
    const attempt = this.retry++
    const delay =
      this.dependencies.retryDelay?.(attempt) ??
      Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5) * (0.75 + Math.random() * 0.5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
  private connect() {
    if (!this.active || !this.dependencies.networkEnabled) return
    this.disconnect()
    const version = this.socketGeneration
    this.set({ connection: 'connecting' })
    let socket: LiveSocket
    try {
      socket = this.dependencies.socket()
    } catch {
      this.reconnect()
      return
    }
    this.live = socket
    let sequence = Promise.resolve()
    let buffered = 0
    this.handshakeTimer = setTimeout(() => this.reconnect(), 15_000)
    socket.onopen = () => {
      if (version !== this.socketGeneration) return
      const message: LiveClientMessage =
        this.dependencies.view === 'all'
          ? { v: 1, type: 'subscribe', view: 'all', cursor: this.appliedCursor }
          : {
              v: 1,
              type: 'auth',
              view: 'following',
              cursor: this.appliedCursor,
              accessToken: this.dependencies.token ?? '',
            }
      try {
        socket.send(JSON.stringify(message))
      } catch {
        this.reconnect()
      }
    }
    socket.onclose = () => {
      if (version === this.socketGeneration) this.reconnect()
    }
    socket.onerror = socket.onclose
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string' || message.data.length > 8192 || buffered >= 200) {
        this.set({ error: 'Live delivery exceeded the client buffer. Recovering saved history.' })
        this.reconnect()
        return
      }
      buffered++
      sequence = sequence
        .then(async () => {
          if (version !== this.socketGeneration || !this.active) return
          if (typeof message.data !== 'string' || message.data.length > 8192) throw new Error('Invalid live event.')
          const parsed = liveServerEventSchema.safeParse(JSON.parse(message.data))
          if (!parsed.success) throw new Error('Invalid live event.')
          const event = parsed.data
          clearTimeout(this.handshakeTimer)
          if (event.type === 'error') {
            if (event.error.code === 'UNAUTHORIZED') {
              this.dependencies.unauthorized()
              this.stop()
              return
            }
            if (event.error.code === 'CURSOR_EXPIRED') {
              await this.resetHistory()
              return
            }
            throw new Error(event.error.message)
          }
          if (event.view !== this.dependencies.view) throw new Error('Live view mismatch.')
          if (event.type === 'gap') {
            await this.resetHistory()
            return
          }
          if (event.type === 'ready') {
            clearTimeout(this.handshakeTimer)
            this.retry = 0
            this.set({ connection: 'live' })
            return
          }
          if (this.appliedCursor && BigInt(event.eventId) <= BigInt(this.appliedCursor)) return
          const detail = await this.dependencies.detail(event.signalId, this.abort.signal)
          if (version !== this.socketGeneration || !this.active) return
          if (detail.id !== event.signalId || detail.eventId !== event.eventId || detail.walletId !== event.walletId) {
            throw new Error('Live signal mismatch.')
          }
          const { reasons: _reasons, snapshot: _snapshot, ...summary } = detail
          this.set({ items: mergeSignals(this.state.items, [summary]), error: null })
          await this.persist(event.eventId)
          if (version === this.socketGeneration && this.active) this.appliedCursor = event.eventId
        })
        .catch((error) => {
          if (version !== this.socketGeneration || !this.active) return
          if (error instanceof ApiError && error.status === 401) {
            this.dependencies.unauthorized()
            this.stop()
            return
          }
          this.set({ error: 'Live updates interrupted. Reconnecting from the last saved event.' })
          this.reconnect()
        })
        .finally(() => {
          buffered--
        })
    }
  }
  private async resetHistory() {
    this.disconnect()
    this.appliedCursor = null
    this.nextCursor = null
    this.set({ items: [], historyGap: true, hasMore: false, status: 'loading' })
    try {
      await this.persist()
    } catch {
      this.set({ error: 'The history reset could not be cached. Recent data will be reloaded.' })
    }
    await this.refresh()
    if (this.active) this.reconnect()
  }
}
