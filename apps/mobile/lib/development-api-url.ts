/** Local development origins follow Metro, except the explicit Android emulator bridge. */
export function resolveDevelopmentApiUrl(
  configured: string,
  metroHost: string | undefined,
  development: boolean,
  platform?: string,
): string {
  if (!development || !configured || !metroHost) return configured
  try {
    const api = new URL(configured)
    // This bridge reaches the host loopback listener from an Android emulator.
    if (platform === 'android' && api.hostname === '10.0.2.2') return configured
    if (api.protocol !== 'http:' || !['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(api.hostname))
      return configured
    const metro = new URL(metroHost.includes('://') ? metroHost : `http://${metroHost}`)
    const host = metro.hostname
    // Expo tunnels forward Metro only, not the API port.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return configured
    api.hostname = host
    return api.href.replace(/\/$/, '')
  } catch {
    return configured
  }
}
