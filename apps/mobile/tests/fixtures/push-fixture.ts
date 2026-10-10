import { signalFixture } from './signal-fixture'

export function pushFixture(now = Date.now()) {
  const signal = signalFixture(undefined, now)
  return {
    signal,
    data: {
      id: signal.id,
      eventId: signal.eventId,
      score: String(signal.score),
      wallet: signal.walletAddress,
      mint: signal.mintAddress,
      slot: String(signal.slot),
      age: '0',
      expiresAt: new Date(now + 90_000).toISOString(),
    },
  }
}
