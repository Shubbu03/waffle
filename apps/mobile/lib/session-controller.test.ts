import { describe, expect, test } from 'bun:test'
import { deferred } from '../test-support/signal-fixture'
import { ApiError } from './api-error'
import type { StoredSession } from './session'
import { SessionController } from './session-controller'

const session: StoredSession = {
  userId: '11111111-1111-4111-8111-111111111111',
  walletAddress: '1'.repeat(32),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  accessToken: 'a'.repeat(43),
}
function setup(stored: StoredSession | null = session) {
  let disk = stored
  const revoked: string[] = []
  const dependencies = {
    load: async () => disk,
    save: async (value: StoredSession) => {
      disk = value
    },
    clear: async () => {
      disk = null
    },
    verify: async () => ({
      userId: session.userId,
      walletAddress: session.walletAddress,
      expiresAt: session.expiresAt,
    }),
    revoke: async (token: string) => {
      revoked.push(token)
    },
  }
  return { dependencies, revoked, disk: () => disk }
}
describe('mobile sessions', () => {
  test('server verification restores a real session', async () => {
    const env = setup()
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    expect(controller.getSnapshot()).toMatchObject({ status: 'signed-in', session, serverLinked: true })
  })
  test('outage preserves an existing verified token for cached browsing; 401 clears it', async () => {
    const env = setup()
    env.dependencies.verify = async () => {
      throw new Error('offline')
    }
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    expect(controller.getSnapshot()).toMatchObject({ session, serverLinked: false })
    env.dependencies.verify = async () => {
      throw new ApiError(401, 'UNAUTHORIZED', 'Expired')
    }
    await controller.refresh()
    expect(controller.getSnapshot().session).toBeNull()
    expect(env.disk()).toBeNull()
  })
  test('expired and legacy wallet-only sessions are discarded', async () => {
    for (const stored of [
      { ...session, accessToken: '' },
      { ...session, expiresAt: '2000-01-01T00:00:00Z' },
    ]) {
      const env = setup(stored)
      const controller = new SessionController(env.dependencies)
      await controller.restore()
      expect(controller.getSnapshot().session).toBeNull()
      expect(env.disk()).toBeNull()
    }
  })
  test('failed verification cannot manufacture a local authenticated session', async () => {
    const env = setup(null)
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    await expect(
      controller.signIn(async () => {
        throw new ApiError(401, 'UNAUTHORIZED', 'Rejected')
      }),
    ).rejects.toThrow('Rejected')
    expect(controller.getSnapshot()).toMatchObject({ session: null, isSigningIn: false, serverLinked: false })
    expect(env.disk()).toBeNull()
  })
  test('wallet rejection is surfaced once and concurrent sign-ins are blocked', async () => {
    const env = setup(null)
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    const pending = deferred<StoredSession>()
    const login = controller.signIn(() => pending.promise)
    await expect(controller.signIn(async () => session)).rejects.toThrow('already in progress')
    pending.reject(new Error('Wallet rejected'))
    await expect(login).rejects.toThrow('Wallet rejected')
    expect(controller.getSnapshot().session).toBeNull()
  })
  test('logout wins against a late launch restore', async () => {
    const env = setup()
    const pending = deferred<StoredSession | null>()
    env.dependencies.load = () => pending.promise
    const controller = new SessionController(env.dependencies)
    const restore = controller.restore()
    await controller.signOut()
    pending.resolve(session)
    await restore
    expect(controller.getSnapshot().session).toBeNull()
    expect(env.disk()).toBeNull()
  })
  test('logout wins against a late wallet verification', async () => {
    const env = setup(null)
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    const pending = deferred<StoredSession>()
    const login = controller.signIn(() => pending.promise)
    await controller.signOut()
    pending.resolve(session)
    await expect(login).rejects.toThrow('cancelled')
    expect(controller.getSnapshot().session).toBeNull()
    expect(env.disk()).toBeNull()
  })
  test('storage save completing after logout is followed by deletion', async () => {
    const env = setup(null)
    const saved = deferred<void>()
    const writes: string[] = []
    env.dependencies.save = async () => {
      writes.push('save')
      await saved.promise
    }
    env.dependencies.clear = async () => {
      writes.push('clear')
    }
    const controller = new SessionController(env.dependencies)
    const login = controller.signIn(async () => session)
    await Bun.sleep(0)
    const logout = controller.signOut()
    saved.resolve()
    await expect(login).rejects.toThrow('cancelled')
    await logout
    expect(writes).toEqual(['save', 'clear'])
    expect(controller.getSnapshot().session).toBeNull()
  })
  test('a changed server owner and an expired live session fail closed', async () => {
    for (const live of [
      { ...session, walletAddress: 'different' },
      { ...session, expiresAt: '2000-01-01T00:00:00Z' },
    ]) {
      const env = setup()
      env.dependencies.verify = async () => live
      const controller = new SessionController(env.dependencies)
      await controller.restore()
      expect(controller.getSnapshot().session).toBeNull()
    }
  })
  test('a 401 from an old account cannot sign out the current account', async () => {
    const env = setup()
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    await controller.invalidate('old-token')
    expect(controller.getSnapshot().session).toEqual(session)
    await controller.invalidate(session.accessToken)
    expect(controller.getSnapshot().session).toBeNull()
  })
  test('logout clears local state even if secure deletion fails', async () => {
    const env = setup()
    const controller = new SessionController(env.dependencies)
    await controller.restore()
    env.dependencies.clear = async () => {
      throw new Error('Keychain unavailable')
    }
    await expect(controller.signOut()).rejects.toThrow('Keychain unavailable')
    expect(controller.getSnapshot().session).toBeNull()
  })
})
