import { AppExternalLink, type AppExternalLinkProps } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { AppConfig } from '@/constants/app-config'

export function SettingsAppConfig() {
  return (
    <AppView>
      <AppText type="subtitle">App Config</AppText>
      <AppText type="default">
        Name <AppText type="defaultSemiBold">{AppConfig.name}</AppText>
      </AppText>
      {AppConfig.uri ? (
        <AppText type="default">
          URL{' '}
          <AppText type="link">
            <AppExternalLink href={AppConfig.uri as AppExternalLinkProps['href']}>{AppConfig.uri}</AppExternalLink>
          </AppText>
        </AppText>
      ) : (
        <AppText type="default">App URL not configured</AppText>
      )}
    </AppView>
  )
}
