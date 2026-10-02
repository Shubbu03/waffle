import type { Session } from '@waffle/shared'
import { ApiError } from './api-error'
import { isSessionExpired, type StoredSession } from './session'

export type SessionState = {
  status: 'loading' | 'signed-in' | 'signed-out'
  session: StoredSession | null
  serverLinked: boolean
  isSigningIn: boolean
}
type Dependencies = {
  load: () => Promise<StoredSession | null>
  save: (session: StoredSession) => Promise<void>
  clear: () => Promise<void>
  verify: (token: string) => Promise<Session>
  revoke: (token: string) => Promise<void>
}
const signedOut: SessionState = { status: 'signed-out', session: null, serverLinked: false, isSigningIn: false }

/** Serial storage writes and generations prevent late replies from undoing logout. */
export class SessionController {
  private state: SessionState = { ...signedOut, status: 'loading' }
  private generation = 0
  private writes: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  constructor(private readonly dependencies: Dependencies) {}
  getSnapshot = (): SessionState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(state: SessionState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  private write(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation, operation)
    this.writes = next.catch(() => {})
    return next
  }
  async restore(): Promise<void> {
    const generation = ++this.generation
    try {
      const session = await this.dependencies.load()
      if (generation !== this.generation) return
      if (!session?.accessToken || isSessionExpired(session.expiresAt)) {
        this.set(signedOut)
        await this.write(this.dependencies.clear)
        return
      }
      this.set({ ...signedOut, status: 'signed-in', session })
      await this.refresh()
    } catch {
      if (generation === this.generation) this.set(signedOut)
    }
  }
  async refresh(): Promise<void> {
    const { session } = this.state
    const generation = this.generation
    if (!session || this.state.isSigningIn) return
    if (isSessionExpired(session.expiresAt)) return this.signOut()
    try {
      const live = await this.dependencies.verify(session.accessToken)
      if (generation !== this.generation) return
      if (
        live.userId !== session.userId ||
        live.walletAddress !== session.walletAddress ||
        isSessionExpired(live.expiresAt)
      ) {
        await this.signOut()
        return
      }
      this.set({ ...this.state, session: { ...session, expiresAt: live.expiresAt }, serverLinked: true })
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError && (error.status === 401 || error.code === 'BAD_RESPONSE')) {
        await this.signOut()
      } else {
        // Previously verified sessions can read their own cache during an outage.
        this.set({ ...this.state, serverLinked: false })
      }
    }
  }
  async signIn(operation: () => Promise<StoredSession>): Promise<void> {
    if (this.state.isSigningIn) throw new Error('A wallet sign-in is already in progress.')
    const generation = ++this.generation
    this.set({ ...this.state, isSigningIn: true })
    try {
      const session = await operation()
      if (generation !== this.generation) throw new Error('Sign-in was cancelled.')
      if (!session.accessToken || isSessionExpired(session.expiresAt))
        throw new Error('The sign-in session has expired.')
      await this.write(() => this.dependencies.save(session))
      if (generation !== this.generation) throw new Error('Sign-in was cancelled.')
      this.set({ status: 'signed-in', session, serverLinked: true, isSigningIn: false })
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.state, isSigningIn: false })
      throw error
    }
  }
  async invalidate(token: string): Promise<void> {
    if (this.state.session?.accessToken === token) await this.signOut()
  }
  async signOut(): Promise<void> {
    const token = this.state.session?.accessToken
    ++this.generation
    this.set(signedOut)
    if (token) void this.dependencies.revoke(token).catch(() => {})
    await this.write(this.dependencies.clear)
  }
}
