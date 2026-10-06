import { describe, expect, test } from 'bun:test'
import { deferred } from '../test-support/signal-fixture'
import { type PushRegistration, PushRegistrationController } from './push-registration'
import type { PushPermission } from './push-tap'
import type { StoredSession } from './session'

const owner: StoredSession = {
  userId: crypto.randomUUID(),
  accessToken: 'a'.repeat(43),
  walletAddress: '1'.repeat(32),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}
function setup() {
  let disk: PushRegistration | null = null
  let token = 'native-token-1'
  let permission: PushPermission = 'granted'
  const events: string[] = []
  const permissions: PushPermission[] = []
  const dependencies = {
    apiUrl: 'https://api.example.com',
    load: async () => disk,
    save: async (record: PushRegistration) => {
      disk = record
    },
    clear: async () => {
      disk = null
    },
    permission: async () => permission,
    getToken: async () => token,
    rotate: async () => {
      events.push('rotate')
      token = `${token}-rotated`
    },
    register: async (_session: StoredSession, _token: string, value: PushPermission): Promise<{ id: string }> => {
      events.push('register')
      permissions.push(value)
      return { id: crypto.randomUUID() }
    },
    remove: async (_session: StoredSession, id: string) => {
      events.push(`remove:${id}`)
    },
  }
  const controller = new PushRegistrationController(dependencies)
  controller.activate(owner)
  return {
    controller,
    dependencies,
    events,
    permissions,
    disk: () => disk,
    deny: () => {
      permission = 'denied'
    },
    refresh: () => {
      token = 'native-token-2'
    },
  }
}

describe('device registration lifecycle', () => {
  test('registration recovers after an API outage without rotating the same owner token again', async () => {
    const env = setup()
    const register = env.dependencies.register
    const tokens: string[] = []
    env.dependencies.register = async (session, token, permission) => {
      tokens.push(token)
      if (tokens.length === 1) throw new Error('API offline')
      return register(session, token, permission)
    }
    await expect(env.controller.synchronize(owner, true)).rejects.toThrow('API offline')
    expect(env.disk()).toBeNull()
    expect(await env.controller.synchronize(owner)).toBe('granted')
    expect(tokens[0]).toBe(tokens[1])
    expect(env.events.filter((event) => event === 'rotate')).toHaveLength(1)
    expect(env.disk()?.userId).toBe(owner.userId)
  })
  test('unknown previous ownership rotates before registration; refresh uses actual denied permission', async () => {
    const env = setup()
    await env.controller.synchronize(owner)
    expect(env.events).toEqual(['rotate', 'register'])
    const oldId = env.disk()?.id
    env.deny()
    env.refresh()
    expect(await env.controller.synchronize(owner)).toBe('denied')
    expect(env.permissions).toEqual(['granted', 'denied'])
    expect(env.events.slice(-2)).toEqual([`remove:${oldId}`, 'register'])
  })
  test('an owner change after failed registration still rotates before the new owner registers', async () => {
    const env = setup()
    const register = env.dependencies.register
    env.dependencies.register = async () => {
      throw new Error('API offline')
    }
    await expect(env.controller.synchronize(owner)).rejects.toThrow('API offline')
    env.dependencies.register = register
    const next = { ...owner, userId: crypto.randomUUID(), accessToken: 'b'.repeat(43) }
    env.controller.activate(next)
    expect(await env.controller.synchronize(next)).toBe('granted')
    expect(env.events).toEqual(['rotate', 'rotate', 'register'])
    expect(env.disk()?.userId).toBe(next.userId)
    expect(await env.controller.synchronize(owner)).toBeNull()
  })
  test('logout during a registration waits for its reply then removes it before rotating', async () => {
    const env = setup()
    const pending = deferred<{ id: string }>()
    const started = deferred<void>()
    env.dependencies.register = async () => {
      started.resolve()
      return pending.promise
    }
    const registration = env.controller.synchronize(owner)
    await started.promise
    const logout = env.controller.end(owner)
    expect(env.controller.canDeliver(owner.userId)).toBe(false)
    pending.resolve({ id: 'late-id' })
    expect(await registration).toBeNull()
    await logout
    expect(env.events.slice(-2)).toEqual(['remove:late-id', 'rotate'])
    expect(env.disk()).toBeNull()
    expect(await env.controller.synchronize(owner)).toBeNull()
  })
  test('offline or expired-session deletion still rotates the native token', async () => {
    const env = setup()
    await env.controller.synchronize(owner)
    env.dependencies.remove = async () => {
      throw new Error('401 or offline')
    }
    await env.controller.end(owner)
    expect(env.events.at(-1)).toBe('rotate')
    expect(env.disk()).toBeNull()
  })
  test('a failed logout rotation must succeed before registering a different owner', async () => {
    const env = setup()
    await env.controller.synchronize(owner)
    const rotate = env.dependencies.rotate
    env.dependencies.rotate = async () => {
      throw new Error('native unavailable')
    }
    await expect(env.controller.end(owner)).rejects.toThrow('native unavailable')
    const next = { ...owner, userId: crypto.randomUUID(), accessToken: 'b'.repeat(43) }
    env.controller.activate(next)
    await expect(env.controller.synchronize(next)).rejects.toThrow('native unavailable')
    expect(env.permissions).toHaveLength(1)
    env.dependencies.rotate = rotate
    await env.controller.synchronize(next)
    expect(env.disk()?.userId).toBe(next.userId)
  })
  test('failed registration persistence removes the orphan and rotates its native token', async () => {
    const env = setup()
    env.dependencies.save = async () => {
      throw new Error('secure storage failed')
    }
    await expect(env.controller.synchronize(owner)).rejects.toThrow('secure storage failed')
    expect(env.events.at(-2)).toMatch(/^remove:/)
    expect(env.events.at(-1)).toBe('rotate')
  })
})
