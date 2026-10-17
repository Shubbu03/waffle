import type { PaymentAsset } from '@waffle/shared'
import { View } from 'react-native'
import { AppButton } from '@/components/ui/app-button'

export function PaymentAssetPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: PaymentAsset
  onChange: (asset: PaymentAsset) => void
  disabled?: boolean
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {(['SOL', 'USDC'] as const).map((asset) => (
        <AppButton
          key={asset}
          title={asset}
          accessibilityLabel={`Pay with ${asset}${value === asset ? ', selected' : ''}`}
          variant={value === asset ? 'primary' : 'secondary'}
          disabled={disabled}
          style={{ flex: 1 }}
          onPress={() => onChange(asset)}
        />
      ))}
    </View>
  )
}
