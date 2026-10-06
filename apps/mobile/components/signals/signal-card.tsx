import { PUMP_SWAP_PROGRAM_ID, type SignalSummary } from '@waffle/shared'
import { Link } from 'expo-router'
import { Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ageLabel, signalDataLabel } from '@/lib/signal-state'
import { ellipsify } from '@/utils/ellipsify'

export function SignalCard({
  signal,
  label,
  offline,
  now,
}: {
  signal: SignalSummary
  label?: string
  offline: boolean
  now: number
}) {
  const border = useThemeColor({}, 'border')
  const surface = useThemeColor({}, 'surface')
  const accent = useThemeColor({}, 'accentSoft')
  return (
    <Link href={{ pathname: '/signals/[id]', params: { id: signal.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View signal for ${ellipsify(signal.mintAddress, 6)}, score ${signal.score}`}
        style={{
          borderWidth: 1,
          borderColor: border,
          backgroundColor: surface,
          borderRadius: 20,
          padding: 18,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <AppText type="defaultSemiBold" numberOfLines={1}>
              {label ?? ellipsify(signal.walletAddress, 6)}
            </AppText>
            <AppText style={{ opacity: 0.7, fontSize: 13 }}>
              {ageLabel(signal.observedAt, now)} ·{' '}
              {signal.sourceProgramId === PUMP_SWAP_PROGRAM_ID ? 'PumpSwap' : 'Unknown source'}
            </AppText>
          </View>
          <View style={{ backgroundColor: accent, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 }}>
            <AppText type="subtitle" style={{ fontVariant: ['tabular-nums'] }}>
              {signal.score}
              <AppText style={{ fontSize: 12 }}>/100</AppText>
            </AppText>
          </View>
        </View>
        <AppText selectable type="subtitle">
          {ellipsify(signal.mintAddress, 8)}
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <AppText style={{ fontSize: 13 }}>{signalDataLabel(signal, offline, now)}</AppText>
          <AppText style={{ fontSize: 13, opacity: 0.7 }}>
            ·{' '}
            {signal.status === 'eligible'
              ? 'Eligible at assessment'
              : signal.status === 'history-only'
                ? 'History only'
                : 'Suppressed'}
          </AppText>
        </View>
      </Pressable>
    </Link>
  )
}
