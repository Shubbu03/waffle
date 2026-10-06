import { Link, router } from 'expo-router'
import { View } from 'react-native'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { AppButton } from '@/components/ui/app-button'
import { useThemeColor } from '@/hooks/use-theme-color'

export function ScreenHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  const { session, status } = useAuth()
  const muted = useThemeColor({}, 'muted')
  return (
    <View style={{ padding: 20, paddingBottom: 16, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText type="title" style={{ flex: 1 }}>
          {title}
        </AppText>
        {!session ? (
          <AppButton
            title={status === 'loading' ? 'Restoring…' : 'Sign in'}
            disabled={status === 'loading'}
            variant="secondary"
            onPress={() => router.push('/sign-in')}
          />
        ) : (
          <Link href="/account" accessibilityLabel="Open your account">
            <AppText type="defaultSemiBold" style={{ fontSize: 13 }}>
              My account ↗
            </AppText>
          </Link>
        )}
      </View>
      {subtitle ? <AppText style={{ color: muted, fontSize: 14, lineHeight: 21 }}>{subtitle}</AppText> : null}
    </View>
  )
}
