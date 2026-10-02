import AsyncStorage from '@react-native-async-storage/async-storage'
import { createPaperPositionRequestSchema } from '@waffle/shared'
import type { PendingPaperFill } from './paper-state'

export function paperPendingStore(origin: string, owner: string, signalId: string) {
  const key = `waffle:pending-paper:${JSON.stringify([origin, owner, signalId])}`
  return {
    async load(): Promise<PendingPaperFill | null> {
      const stored = await AsyncStorage.getItem(key)
      if (!stored) return null
      const pending = createPaperPositionRequestSchema.parse(JSON.parse(stored))
      if (pending.signalId !== signalId) throw new Error('Saved fill signal mismatch')
      return pending
    },
    save: (pending: PendingPaperFill) => AsyncStorage.setItem(key, JSON.stringify(pending)),
    clear: () => AsyncStorage.removeItem(key),
  }
}
