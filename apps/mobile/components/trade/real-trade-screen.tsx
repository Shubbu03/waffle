import { VersionedTransaction } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { router, useLocalSearchParams } from 'expo-router'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AppExternalLink } from '@/components/app-external-link'
import { AppText } from '@/components/app-text'
import { useAuth } from '@/components/auth/auth-provider'
import { useCluster } from '@/components/cluster/cluster-provider'
import { useSignalClock, useSignalDetail } from '@/components/signals/use-signals'
import { AppButton } from '@/components/ui/app-button'
import { AppCard } from '@/components/ui/app-card'
import { AppConfig } from '@/constants/app-config'
import { useThemeColor } from '@/hooks/use-theme-color'
import { ApiError } from '@/lib/api-error'
import { parsePaperSize } from '@/lib/paper-state'
import {
  createTradeAttempt,
  executeTradeAttempt,
  getTradeAttempt,
  type RealOrder,
  rejectTradeAttempt,
  type TradeAttempt,
} from '@/lib/trade-api'
import { checkRealOrder, REAL_MAX_LAMPORTS } from '@/lib/trade-guards'
import { returnToSignal, TradeAmount, TradeError, TradeIdentity, TradePage, TradeQuoteDetails } from './trade-ui'

type Phase =
  | { name: 'idle' }
  | { name: 'quoting' }
  | { name: 'quoted'; order: RealOrder; attempt: TradeAttempt }
  | { name: 'signing'; order: RealOrder; attempt: TradeAttempt }
  | { name: 'submitting'; attempt: TradeAttempt }
  | { name: 'done'; attempt: TradeAttempt }
  | { name: 'failed'; message: string }
  | { name: 'uncertain'; attempt: TradeAttempt; message: string }

export function RealTradeScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const { selectedCluster, getExplorerUrl } = useCluster()
  const network = AppConfig.network
  const { session, serverLinked } = useAuth()
  const { account, signTransactions } = useMobileWallet()
  const detail = useSignalDetail(id)
  const now = useSignalClock()
  const ink = useThemeColor({}, 'text')
  const muted = useThemeColor({}, 'muted')
  const [amount, setAmount] = useState('0.01')
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [checking, setChecking] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  const taker = account?.address.toString() ?? null
  const token = session?.accessToken ?? ''
  const current = useRef({ network, token, taker, id, wallet: session?.walletAddress, serverLinked })
  current.current = { network, token, taker, id, wallet: session?.walletAddress, serverLinked }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const sameReview = () =>
    mounted.current &&
    current.current.network === network &&
    current.current.token === token &&
    current.current.taker === taker &&
    current.current.id === id &&
    current.current.wallet === taker &&
    current.current.serverLinked

  async function onQuote() {
    if (locked.current) return
    if (selectedCluster.id === 'solana:testnet') {
      setPhase({ name: 'failed', message: 'PumpSwap is not deployed on Testnet. Use Devnet for test-token trades.' })
      return
    }
    if (!token) {
      router.push('/sign-in')
      return
    }
    if (!taker || !serverLinked || session?.walletAddress !== taker) {
      setPhase({ name: 'failed', message: 'Reconnect the wallet you signed in with before buying.' })
      return
    }
    const raw = parsePaperSize(amount)
    if (!raw || BigInt(raw) > BigInt(REAL_MAX_LAMPORTS)) {
      setPhase({ name: 'failed', message: 'Enter an amount between 0 and 0.05 SOL, with up to 9 decimal places.' })
      return
    }
    locked.current = true
    setPhase({ name: 'quoting' })
    try {
      const { order, attempt } = await createTradeAttempt(token, id, raw)
      if (!sameReview()) throw new Error('Your wallet or session changed. Reconnect and request a new quote.')
      const guard = checkRealOrder(order, taker, Date.now(), network)
      if (!guard.ok) throw new Error(guard.reason)
      setPhase({ name: 'quoted', order, attempt })
    } catch (error) {
      if (mounted.current)
        setPhase({ name: 'failed', message: error instanceof Error ? error.message : 'Quote unavailable. Try again.' })
    } finally {
      locked.current = false
    }
  }

  async function onSignAndExecute(order: RealOrder, attempt: TradeAttempt) {
    if (locked.current) return
    if (!taker || !token || !sameReview()) {
      setPhase({ name: 'failed', message: 'Reconnect the wallet you signed in with.' })
      return
    }
    if (order.signalId !== id || order.inputAmountLamports !== parsePaperSize(amount)) {
      setPhase({ name: 'failed', message: 'Review changed. Request a new quote.' })
      return
    }
    const guard = checkRealOrder(order, taker, Date.now(), network)
    if (!guard.ok) {
      setPhase({ name: 'failed', message: guard.reason })
      return
    }
    locked.current = true
    setPhase({ name: 'signing', order, attempt })
    let sent = false
    try {
      const transaction = VersionedTransaction.deserialize(toUint8Array(order.transactionBase64))
      const [signed] = await signTransactions([transaction])
      if (!signed) throw new Error('Wallet returned no signed transaction.')
      if (!sameReview()) throw new Error('Review closed or wallet changed. No transaction was submitted by waffle.')
      if (!checkRealOrder(order, taker, Date.now(), network).ok)
        throw new Error('Quote expired during wallet approval. Request a new quote.')
      const signedBase64 = fromUint8Array(signed.serialize())
      setPhase({ name: 'submitting', attempt })
      sent = true
      const result = await executeTradeAttempt(token, attempt.id, {
        signedTransactionBase64: signedBase64,
        requestId: order.requestId,
        quoteId: order.id,
      })
      if (mounted.current) setPhase({ name: 'done', attempt: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to complete the purchase.'
      if (sent) {
        // A lost response does not prove failure. Offer a read-only status check, never a replay.
        if (mounted.current)
          setPhase({
            name: 'uncertain',
            attempt,
            message: 'The execution response was not received. Check status before making another purchase.',
          })
      } else if (/cancel|dismiss|reject|decline/i.test(message)) {
        try {
          await rejectTradeAttempt(token, attempt.id, {
            quoteId: order.id,
            requestId: order.requestId,
            reason: 'USER_CANCELLED',
          })
        } catch {
          /* Declining the wallet did not dispatch execution. */
        }
        if (mounted.current)
          setPhase({ name: 'failed', message: 'Wallet approval cancelled. No purchase was submitted.' })
      } else if (mounted.current) setPhase({ name: 'failed', message })
    } finally {
      locked.current = false
    }
  }

  async function checkStatus(attempt: TradeAttempt) {
    if (locked.current) return
    locked.current = true
    setChecking(true)
    try {
      const saved = await getTradeAttempt(token, attempt.id)
      if (!mounted.current) return
      if (saved.status === 'confirmed' || saved.status === 'failed' || saved.status === 'wallet_rejected')
        setPhase({ name: 'done', attempt: saved })
      else
        setPhase({
          name: 'uncertain',
          attempt: saved,
          message: 'No final result is recorded yet. Check the transaction on Explorer before trying another purchase.',
        })
    } catch (error) {
      if (mounted.current)
        setPhase({
          name: 'uncertain',
          attempt,
          message: error instanceof ApiError ? error.message : 'Unable to check status. Try again.',
        })
    } finally {
      locked.current = false
      if (mounted.current) setChecking(false)
    }
  }

  const reviewing = phase.name === 'quoted' || phase.name === 'signing' ? phase : null
  const result =
    phase.name === 'done' || phase.name === 'uncertain' || phase.name === 'submitting' ? phase.attempt : null
  return (
    <TradePage title="Buy with wallet" signalId={id}>
      <TradeIdentity
        mint={detail.data?.signal.mintAddress}
        description={
          network === 'devnet'
            ? 'Buy test tokens on Devnet using test SOL. Approve each purchase in your wallet.'
            : network === 'testnet'
              ? 'PumpSwap trading is unavailable on Testnet. Switch to Devnet to test purchases.'
              : 'Buy on Solana Mainnet with real SOL. Review the quote, then approve the purchase in your wallet.'
        }
      />
      {phase.name === 'failed' ? <TradeError message={phase.message} /> : null}
      {phase.name === 'idle' || phase.name === 'quoting' || phase.name === 'failed' ? (
        <TradeAmount
          value={amount}
          onChange={(value) => {
            setAmount(value)
            setPhase({ name: 'idle' })
          }}
          max="0.05"
          disabled={false}
          busy={phase.name === 'quoting'}
          onQuote={() => void onQuote()}
        />
      ) : null}
      {reviewing ? (
        <AppCard>
          <AppText type="subtitle">Review purchase</AppText>
          <TradeQuoteDetails quote={reviewing.order} />
          <AppText style={{ color: muted, fontSize: 12 }}>
            {now < Date.parse(reviewing.order.expiresAt)
              ? `Quote valid for ${Math.max(0, Math.ceil((Date.parse(reviewing.order.expiresAt) - now) / 1000))}s`
              : 'Quote expired. Get a new quote to continue.'}
          </AppText>
          <AppButton
            title={phase.name === 'signing' ? 'Waiting for wallet approval…' : 'Approve in wallet'}
            busy={phase.name === 'signing'}
            disabled={now >= Date.parse(reviewing.order.expiresAt)}
            onPress={() => void onSignAndExecute(reviewing.order, reviewing.attempt)}
          />
          <AppButton
            title="Get a new quote"
            variant="secondary"
            disabled={phase.name === 'signing'}
            onPress={() => void onQuote()}
          />
          <AppButton
            title="Change amount"
            variant="quiet"
            disabled={phase.name === 'signing'}
            onPress={() => setPhase({ name: 'idle' })}
          />
        </AppCard>
      ) : null}
      {result ? (
        <AppCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {phase.name === 'submitting' ? <ActivityIndicator color={ink} /> : null}
            <AppText type="subtitle" style={{ flex: 1 }}>
              {phase.name === 'submitting'
                ? 'Submitting purchase…'
                : result.status === 'confirmed'
                  ? 'Purchase confirmed'
                  : phase.name === 'uncertain' || result.status === 'submitted'
                    ? 'Check purchase status'
                    : 'Purchase not completed'}
            </AppText>
          </View>
          <AppText selectable style={{ color: muted, fontSize: 13, lineHeight: 21 }}>
            {phase.name === 'uncertain'
              ? phase.message
              : phase.name === 'submitting'
                ? 'Waiting for the network result. This can take up to 30 seconds.'
                : result.status === 'confirmed'
                  ? 'The transaction was confirmed on Solana.'
                  : (result.failureReason ?? 'No final confirmation is available.')}
          </AppText>
          {result.signature ? (
            <AppExternalLink href={getExplorerUrl(`tx/${result.signature}`)}>
              <AppText type="link" style={{ fontSize: 14 }}>
                View transaction
              </AppText>
            </AppExternalLink>
          ) : null}
          {phase.name === 'uncertain' || (result.status === 'submitted' && phase.name !== 'submitting') ? (
            <AppButton title="Check status" busy={checking} onPress={() => void checkStatus(result)} />
          ) : null}
        </AppCard>
      ) : null}
      {phase.name === 'idle' || phase.name === 'failed' ? (
        <AppButton
          title="Try a paper trade instead"
          variant="secondary"
          onPress={() => router.replace({ pathname: '/paper/[id]', params: { id } })}
        />
      ) : null}
      <AppButton title="Back to signal" variant="quiet" onPress={() => returnToSignal(id)} />
    </TradePage>
  )
}
