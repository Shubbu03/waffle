import { Redirect } from 'expo-router'
import { useAuth } from '@/components/auth/auth-provider'
export default function EntryScreen() {
  const { isAuthenticated } = useAuth()
  return <Redirect href={isAuthenticated ? '/(tabs)/home' : '/welcome'} />
}
