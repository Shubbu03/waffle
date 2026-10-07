import * as Dropdown from '@rn-primitives/dropdown-menu'
import { Children, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/app-text'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useThemeColor } from '@/hooks/use-theme-color'

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ gap: 8 }}>
      <AppText style={{ color: muted, fontSize: 12, paddingHorizontal: 4 }}>{title}</AppText>
      <View
        style={{
          backgroundColor: surface,
          borderColor: border,
          borderWidth: 1,
          borderRadius: 16,
          borderCurve: 'continuous',
        }}
      >
        {Children.toArray(children).map((child, index) => (
          <View
            key={typeof child === 'object' && 'key' in child ? child.key : index}
            style={{ borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderTopColor: border }}
          >
            {child}
          </View>
        ))}
      </View>
    </View>
  )
}

export function SettingsRow({ title, children, detail }: { title: string; children: ReactNode; detail?: string }) {
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, minHeight: 56, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText style={{ fontSize: 15, flex: 1 }}>{title}</AppText>
        {children}
      </View>
      {detail ? (
        <AppText accessibilityLiveRegion="polite" style={{ color: muted, fontSize: 12 }}>
          {detail}
        </AppText>
      ) : null}
    </View>
  )
}

export function SettingsAction({
  title,
  onPress,
  destructive = false,
  disabled = false,
}: {
  title: string
  onPress: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const danger = useThemeColor({}, 'danger')
  const surface = useThemeColor({}, 'surfaceMuted')
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        backgroundColor: pressed ? surface : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <AppText style={{ color: destructive ? danger : ink, fontSize: 15 }}>{title}</AppText>
      {!destructive ? <UiIconSymbol name="chevron.right" color={muted} size={18} /> : null}
    </Pressable>
  )
}

export function SettingsDropdown({
  label,
  value,
  options,
  disabled = false,
}: {
  label: string
  value: string
  options: { label: string; value: string; select: () => void }[]
  disabled?: boolean
}) {
  const muted = useThemeColor({}, 'muted')
  const ink = useThemeColor({}, 'text')
  const surface = useThemeColor({}, 'surface')
  const border = useThemeColor({}, 'border')
  const insets = useSafeAreaInsets()
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        disabled={disabled}
        accessibilityLabel={`${label}: ${value}`}
        accessibilityState={{ disabled }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 10,
          minHeight: 44,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <AppText style={{ color: muted, fontSize: 14 }}>{value}</AppText>
        <UiIconSymbol name="chevron.down" size={18} color={muted} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Overlay style={StyleSheet.absoluteFill}>
          <Dropdown.Content
            align="end"
            sideOffset={4}
            insets={{ top: insets.top + 8, bottom: insets.bottom + 8, left: 16, right: 16 }}
            style={{
              backgroundColor: surface,
              borderWidth: 1,
              borderColor: border,
              borderRadius: 14,
              padding: 4,
              minWidth: 180,
            }}
          >
            {options.map((option) => (
              <Dropdown.Item
                key={option.value}
                textValue={option.label}
                onPress={option.select}
                accessibilityLabel={`${option.label}${option.label === value ? ', selected' : ''}`}
                style={{
                  minHeight: 48,
                  paddingHorizontal: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                }}
              >
                <AppText style={{ fontSize: 14 }}>{option.label}</AppText>
                {option.label === value ? <UiIconSymbol name="checkmark" size={18} color={ink} /> : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Content>
        </Dropdown.Overlay>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
