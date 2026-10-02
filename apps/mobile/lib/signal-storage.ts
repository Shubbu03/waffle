import AsyncStorage from '@react-native-async-storage/async-storage'
import { idSchema } from '@waffle/shared'
import { AppConfig } from '@/constants/app-config'
import { type CachedDetail, type FeedCache, parseCachedDetail, parseFeedCache } from './signal-cache'

export async function loadFeed(key: string) {
  return parseFeedCache(await AsyncStorage.getItem(key))
}
export async function saveFeed(key: string, cache: FeedCache) {
  await AsyncStorage.setItem(key, JSON.stringify(cache))
}
const detailPrefix = `waffle.signal-detail.v1:${encodeURIComponent(AppConfig.apiUrl)}:`
let detailWrites: Promise<void> = Promise.resolve()
export async function loadDetail(id: string) {
  const cached = parseCachedDetail(await AsyncStorage.getItem(`${detailPrefix}${id}`))
  return cached?.signal.id === id ? cached : null
}
export function saveDetail(detail: CachedDetail): Promise<void> {
  const write = detailWrites.then(async () => {
    const indexKey = `${detailPrefix}index`
    const raw = await AsyncStorage.getItem(indexKey)
    let previous: string[] = []
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed))
        previous = parsed.filter((id): id is string => idSchema.safeParse(id).success).slice(0, 50)
    } catch {
      /* A corrupt index is rebuilt from this detail. */
    }
    const ids = [detail.signal.id, ...previous.filter((id) => id !== detail.signal.id)]
    await AsyncStorage.setItem(`${detailPrefix}${detail.signal.id}`, JSON.stringify(detail))
    await AsyncStorage.setItem(indexKey, JSON.stringify(ids.slice(0, 50)))
    await AsyncStorage.multiRemove(ids.slice(50).map((id) => `${detailPrefix}${id}`))
  })
  detailWrites = write.catch(() => {})
  return write
}
