import Clipboard from '@react-native-clipboard/clipboard'
import { useState } from 'react'
import { AccessibilityInfo, Pressable, View } from 'react-native'
import { AppText } from '@/components/app-text'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'
import type { EvidenceLabel } from '@/lib/signal-evidence-state'

export function DetailRow({ label, value }: { label: string; value: string }) {
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
      <AppText style={{ color: muted, fontSize: 13, flex: 1 }}>{label}</AppText>
      <AppText selectable style={{ fontSize: 13, flex: 1.4, textAlign: 'right' }}>
        {value}
      </AppText>
    </View>
  )
}

export function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const muted = useThemeColor({}, 'muted')
  const ink = useThemeColor({}, 'text')
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <AppText style={{ color: muted, fontSize: 12 }}>{label}</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy ${label.toLowerCase()}`}
          onPress={() => {
            Clipboard.setString(value)
            setCopied(true)
            AccessibilityInfo.announceForAccessibility(`${label} copied`)
          }}
          style={{
            minHeight: 44,
            minWidth: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
          }}
        >
          <UiIconSymbol name="doc.on.doc" size={15} color={ink} />
          <AppText style={{ fontSize: 12 }}>{copied ? 'Copied' : 'Copy'}</AppText>
        </Pressable>
      </View>
      <AppText selectable style={{ fontSize: 13, lineHeight: 22 }}>
        {value}
      </AppText>
    </View>
  )
}

export function SnapshotMetric({ label, value, status }: { label: string; value: string; status: EvidenceLabel }) {
  const surface = useThemeColor({}, 'surfaceMuted')
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ flexBasis: '45%', flexGrow: 1, padding: 14, borderRadius: 16, backgroundColor: surface, gap: 6 }}>
      <AppText style={{ color: muted, fontSize: 12 }}>{label}</AppText>
      <AppText selectable type="defaultSemiBold" style={{ fontSize: 18, lineHeight: 26 }}>
        {value}
      </AppText>
      {status !== value ? <AppText style={{ color: muted, fontSize: 11 }}>{status}</AppText> : null}
    </View>
  )
}
