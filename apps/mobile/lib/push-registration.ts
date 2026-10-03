import type { PushPermission } from './push-tap'
import type { StoredSession } from './session'

export type PushRegistration = { id: string; userId: string; apiUrl: string; token: string; rotationRequired?: boolean }
type Dependencies = {
  apiUrl: string
  load: () => Promise<PushRegistration | null>
  save: (record: PushRegistration) => Promise<void>
  clear: () => Promise<void>
  permission: (request: boolean) => Promise<PushPermission>
  getToken: () => Promise<string>
  rotate: () => Promise<void>
  register: (session: StoredSession, token: string, permission: PushPermission) => Promise<{ id: string }>
  remove: (session: StoredSession, id: string) => Promise<void>
}

/** Registration, delivery and logout share a queue; late registration replies cannot survive cleanup. */
export class PushRegistrationController {
  private queue: Promise<unknown> = Promise.resolve()
  private owner: StoredSession | null | undefined
  private generation = 0
  private rotationRequired = false
  constructor(private readonly dependencies: Dependencies) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => {})
    return next
  }

  canDeliver(userId: string): boolean {
    return this.owner === undefined || this.owner?.userId === userId
  }

  activate(session: StoredSession): void {
    if (this.owner?.accessToken !== session.accessToken) ++this.generation
    this.owner = session
  }

  synchronize(session: StoredSession, requestPermission = false): Promise<PushPermission | null> {
    if (this.owner?.accessToken !== session.accessToken) return Promise.resolve(null)
    const generation = this.generation
    const current = () => generation === this.generation
    return this.run(async () => {
      if (!current()) return null
      const permission = await this.dependencies.permission(requestPermission)
      if (!current()) return null
      let record = await this.dependencies.load()
      if (
        this.rotationRequired ||
        record?.rotationRequired ||
        !record ||
        record.userId !== session.userId ||
        record.apiUrl !== this.dependencies.apiUrl
      ) {
        // Unknown/expired previous owner: invalidate its native token before obtaining another.
        if (record?.userId === session.userId && record.apiUrl === this.dependencies.apiUrl)
          await this.dependencies.remove(session, record.id).catch(() => {})
        await this.dependencies.rotate()
        await this.dependencies.clear()
        this.rotationRequired = false
        record = null
      }
      if (!current()) return null
      const token = await this.dependencies.getToken()
      if (!current()) return null
      if (record && record.token !== token) await this.dependencies.remove(session, record.id)
      if (!current()) return null
      const registration = await this.dependencies.register(session, token, permission)
      const next = { ...registration, userId: session.userId, apiUrl: this.dependencies.apiUrl, token }
      try {
        await this.dependencies.save(next)
      } catch (error) {
        await this.dependencies.remove(session, next.id).catch(() => {})
        await this.dependencies.rotate()
        throw error
      }
      // An end() queued during the request will remove this saved registration.
      return current() ? permission : null
    })
  }

  end(session: StoredSession): Promise<void> {
    ++this.generation
    this.owner = null
    this.rotationRequired = true
    return this.run(async () => {
      const record = await this.dependencies.load()
      if (record) await this.dependencies.save({ ...record, rotationRequired: true }).catch(() => {})
      if (record?.userId === session.userId && record.apiUrl === this.dependencies.apiUrl) {
        await this.dependencies.remove(session, record.id).catch(() => {})
      }
      // Always rotate, including offline logout and an unavailable/expired owner session.
      // If rotation fails the record is retained, and the next owner must retry it.
      await this.dependencies.rotate()
      await this.dependencies.clear()
    })
  }
}
