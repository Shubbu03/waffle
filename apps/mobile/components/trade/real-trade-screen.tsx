import { VersionedTransaction } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { router, useLocalSearchParams } from 'expo-router'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { useAuth } from '@/components/auth/auth-provider'
import { useSignalDetail } from '@/components/signals/use-signals'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ApiError } from '@/lib/api-error'
import {
  createTradeAttempt,
  executeTradeAttempt,
  type RealOrder,
  rejectTradeAttempt,
  type TradeAttempt,
} from '@/lib/trade-api'
import { checkRealOrder, REAL_MAX_LAMPORTS } from '@/lib/trade-guards'

type Phase =
  | { name: 'idle' }
  | { name: 'quoting' }
  | { name: 'quoted'; order: RealOrder; attempt: TradeAttempt }
  | { name: 'signing'; order: RealOrder; attempt: TradeAttempt }
  | { name: 'done'; attempt: TradeAttempt }
  | { name: 'failed'; message: string }
  | { name: 'paper-only'; reason: string }

const DEFAULT_SOL = '0.01'

function toLamports(input: string): number | null {
  const sol = Number(input.trim())
  if (!Number.isFinite(sol) || sol <= 0) return null
  return Math.round(sol * 1_000_000_000)
}

export function RealTradeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { session } = useAuth()
  const { account, signTransactions } = useMobileWallet()
  const detail = useSignalDetail(id ?? '')
  const ink = useThemeColor({}, 'text')
  const paper = useThemeColor({}, 'background')
  const [amount, setAmount] = useState(DEFAULT_SOL)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })

  const taker = account?.address.toString() ?? null
  const token = session?.accessToken ?? ''

  async function onQuote() {
    if (!token) {
      router.push('/sign-in')
      return
    }
    if (!taker) return
    const lamports = toLamports(amount)
    if (lamports === null) {
      setPhase({ name: 'failed', message: 'Enter a positive SOL amount.' })
      return
    }
    if (lamports > REAL_MAX_LAMPORTS) {
      setPhase({ name: 'failed', message: 'Demo cap is 0.05 SOL per real attempt.' })
      return
    }
    setPhase({ name: 'quoting' })
    console.log(`[trade-screen] quote: ${lamports} lamports for signal ${(id ?? '').slice(0, 8)}...`)
    try {
      const { order, attempt } = await createTradeAttempt(token, id ?? '', String(lamports))
      const guard = checkRealOrder(order, taker)
      if (!guard.ok) {
        console.log('[trade-screen] quote rejected by on-device guards — paper only')
        setPhase({ name: 'paper-only', reason: guard.reason })
        return
      }
      console.log('[trade-screen] quote: guards pass')
      setPhase({ name: 'quoted', order, attempt })
    } catch (error) {
      const message = error instanceof ApiError ? `${error.code}: ${error.message}` : 'Quote failed. Try again.'
      console.log(`[trade-screen] quote failed: ${message}`)
      setPhase({ name: 'failed', message })
    }
  }

  async function onSignAndExecute(order: RealOrder, attempt: TradeAttempt) {
    if (!taker) return
    setPhase({ name: 'signing', order, attempt })
    console.log('[trade-screen] signing: decoding server order')
    try {
      const bytes = toUint8Array(order.transactionBase64)
      const transaction = VersionedTransaction.deserialize(bytes)
      console.log('[trade-screen] signing: asking wallet (fully-signed, single signer)')
      const [signed] = await signTransactions([transaction])
      if (!signed) throw new Error('Wallet returned no signed transaction.')
      const signedBase64 = fromUint8Array(signed.serialize())
      console.log('[trade-screen] signing: submitting to /execute')
      const result = await executeTradeAttempt(token, attempt.id, {
        signedTransactionBase64: signedBase64,
        requestId: order.requestId,
        quoteId: order.id,
      })
      console.log(`[trade-screen] execute: status=${result.status}`)
      setPhase({ name: 'done', attempt: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[trade-screen] sign/execute failed: ${message.slice(0, 120)}`)
      if (/cancel|dismiss|reject|decline/i.test(message)) {
        try {
          await rejectTradeAttempt(token, attempt.id, {
            quoteId: order.id,
            requestId: order.requestId,
            reason: 'USER_CANCELLED',
          })
          console.log('[trade-screen] wallet rejection recorded')
        } catch {
          console.log('[trade-screen] rejection record failed')
        }
        setPhase({ name: 'failed', message: 'Declined in wallet — nothing was sent.' })
      } else {
        setPhase({ name: 'failed', message })
      }
    }
  }

  return (
    <AppView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
        <AppText type="title">Real trade</AppText>
        <AppText style={{ opacity: 0.7 }}>Wallet-approved only. Never auto-signed. Cap 0.05 SOL.</AppText>

        {phase.name === 'idle' || phase.name === 'quoting' || phase.name === 'failed' ? (
          <View style={{ gap: 8 }}>
            <AppText type="defaultSemiBold">Size (SOL, max 0.05)</AppText>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.01"
              style={{ borderWidth: 2, borderColor: ink, borderRadius: 12, padding: 12, fontSize: 20 }}
            />
            {phase.name === 'quoting' ? <ActivityIndicator /> : null}
            {phase.name === 'failed' ? <AppText style={{ color: '#B00020' }}>{phase.message}</AppText> : null}
            <Pressable
              accessibilityRole="button"
              disabled={phase.name === 'quoting'}
              style={{ backgroundColor: ink, borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
              onPress={() => void onQuote()}
            >
              <AppText type="defaultSemiBold" lightColor={paper} darkColor={paper}>
                Get guarded quote
              </AppText>
            </Pressable>
          </View>
        ) : null}

        {phase.name === 'paper-only' ? (
          <View style={{ gap: 8 }}>
            <AppText type="defaultSemiBold">Paper only</AppText>
            <AppText>{phase.reason}</AppText>
            <Pressable accessibilityRole="button" onPress={() => setPhase({ name: 'idle' })}>
              <AppText type="link">Back</AppText>
            </Pressable>
          </View>
        ) : null}

        {phase.name === 'quoted' || phase.name === 'signing' ? (
          <View style={{ gap: 8, borderWidth: 2, borderRadius: 16, padding: 16 }}>
            <AppText type="defaultSemiBold">Router: {phase.order.router}</AppText>
            <AppText>In: {(Number(phase.order.inputAmountLamports) / 1_000_000_000).toFixed(5)} SOL</AppText>
            <AppText>Taker is your wallet. Fee payer matches. One signer. Fresh quote.</AppText>
            {phase.name === 'signing' ? <ActivityIndicator /> : null}
            <Pressable
              accessibilityRole="button"
              disabled={phase.name === 'signing'}
              style={{ backgroundColor: ink, borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
              onPress={() => void onSignAndExecute(phase.order, phase.attempt)}
            >
              <AppText type="defaultSemiBold" lightColor={paper} darkColor={paper}>
                Sign in wallet & execute
              </AppText>
            </Pressable>
          </View>
        ) : null}

        {phase.name === 'done' ? (
          <View style={{ gap: 8 }}>
            <AppText type="defaultSemiBold">Result: {phase.attempt.status}</AppText>
            {phase.attempt.signature ? (
              <AppExternalLink href={`https://explorer.solana.com/tx/${phase.attempt.signature}?cluster=mainnet`}>
                <AppText type="link">View on Solana Explorer</AppText>
              </AppExternalLink>
            ) : null}
            {phase.attempt.executeCode !== null && phase.attempt.executeCode !== undefined ? (
              <AppText>Code: {phase.attempt.executeCode}</AppText>
            ) : null}
            {detail.data ? null : <AppText style={{ opacity: 0.7 }}>Signal detail unavailable.</AppText>}
            <Pressable accessibilityRole="button" onPress={() => router.back()}>
              <AppText type="link">Back to signal</AppText>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </AppView>
  )
}
