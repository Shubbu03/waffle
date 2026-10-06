import { describe, expect, test } from 'bun:test'
import { resolveDevelopmentApiUrl } from './development-api-url'

describe('device development API origin', () => {
  test('uses the Metro host for local API addresses on simulators and LAN devices', () => {
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', 'localhost:8081', true, 'ios')).toBe(
      'http://localhost:3000',
    )
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', '192.168.1.8:8081', true, 'ios')).toBe(
      'http://192.168.1.8:3000',
    )
    expect(resolveDevelopmentApiUrl('http://localhost:3000/api', '10.0.2.2:8081', true)).toBe(
      'http://10.0.2.2:3000/api',
    )
  })
  test('preserves the explicit Android emulator bridge even when Metro advertises a LAN host', () => {
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', '192.168.29.177:8081', true, 'android')).toBe(
      'http://10.0.2.2:3000',
    )
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', 'localhost:8081', true, 'android')).toBe(
      'http://10.0.2.2:3000',
    )
  })
  test('preserves production and explicitly configured remote endpoints', () => {
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', 'localhost:8081', false)).toBe('http://10.0.2.2:3000')
    expect(resolveDevelopmentApiUrl('https://api.example.com', '192.168.1.8:8081', true)).toBe(
      'https://api.example.com',
    )
    expect(resolveDevelopmentApiUrl('http://192.168.1.9:3000', '192.168.1.8:8081', true)).toBe(
      'http://192.168.1.9:3000',
    )
  })
  test('does not infer an API from an Expo tunnel, absent host, or invalid config', () => {
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', 'a.exp.direct:80', true)).toBe('http://10.0.2.2:3000')
    expect(resolveDevelopmentApiUrl('http://10.0.2.2:3000', undefined, true)).toBe('http://10.0.2.2:3000')
    expect(resolveDevelopmentApiUrl('', 'localhost:8081', true)).toBe('')
    expect(resolveDevelopmentApiUrl('bad url', 'localhost:8081', true)).toBe('bad url')
  })
})
