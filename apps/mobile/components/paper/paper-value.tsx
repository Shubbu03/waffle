import { useQuery } from '@tanstack/react-query'
import type { PaperPositionWithFill } from '@waffle/shared'
import { AppText } from '@/components/app-text'
import { useSignalClock } from '@/components/signals/use-signals'
import { AppConfig } from '@/constants/app-config'
import { getPaperValuation } from '@/lib/paper-api'
import { formatSol } from '@/lib/paper-state'
import { PaperButton } from './paper-ui'
import { usePaperAvailability } from './use-paper'

export function PaperValue({ position, automatic }: { position: PaperPositionWithFill; automatic: boolean }) {
  const auth = usePaperAvailability()
  const now = useSignalClock()
  const token = auth.session?.accessToken ?? ''
  const query = useQuery({
    queryKey: ['paper', auth.session?.userId ?? null, AppConfig.apiUrl, 'value', position.id, auth.session?.expiresAt],
    queryFn: ({ signal }) => getPaperValuation(position.id, token, signal),
    enabled: automatic && auth.available && position.status === 'open',
    retry: false,
    refetchOnWindowFocus: false,
  })
  const value = query.data
  const quote = value?.status === 'available' ? value.quote : null
  const fresh =
    quote &&
    now >= Date.parse(quote.fetchedAt) &&
    now < Date.parse(quote.expiresAt) &&
    now - Date.parse(quote.fetchedAt) < 10_000
  const matches =
    quote?.inputMint === position.entryQuote.outputMint && quote?.inputAmountRaw === position.fill.outputAmountRaw
  return (
    <>
      <AppText type="defaultSemiBold">
        {fresh && matches && quote
          ? `Current exit value: ${formatSol(quote.outputLamports)}`
          : 'Current value unavailable'}
      </AppText>
      {fresh && matches && quote ? (
        <>
          <AppText>Minimum exit value: {formatSol(quote.minOutputLamports)}</AppText>
          <AppText>Exit network fees: {formatSol(quote.feeLamports)} (not deducted above)</AppText>
          <AppText>
            Indicative change after exit fees:{' '}
            {formatSol(
              (
                BigInt(quote.outputLamports) -
                BigInt(quote.feeLamports) -
                BigInt(position.fill.totalDebitLamports)
              ).toString(),
            )}
          </AppText>
          <AppText>
            Exit slippage: {quote.slippageBps / 100}% · Impact: {quote.priceImpactPct}%
          </AppText>
          <AppText>Quote expires: {new Date(quote.expiresAt).toLocaleTimeString()}</AppText>
        </>
      ) : value?.status === 'unavailable' ? (
        <AppText>{value.reason}</AppText>
      ) : quote ? (
        <AppText>Exit quote expired. Refresh for a current value.</AppText>
      ) : (
        <AppText>Request a fresh quote for this exact holding.</AppText>
      )}
      {query.isError ? <AppText selectable>Value refresh failed: {query.error.message}</AppText> : null}
      <PaperButton
        title={query.isFetching ? 'Refreshing value…' : 'Refresh value'}
        disabled={!auth.available || query.isFetching || position.status !== 'open'}
        onPress={() => void query.refetch()}
      />
      <AppText style={{ fontSize: 13 }}>
        Indicative SOL quote, including router fees. No sale or realized return is recorded.
      </AppText>
    </>
  )
}
