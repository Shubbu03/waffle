import { formatPayment, type TradeAttempt } from '@waffle/shared'
import { AppText } from '@/components/app-text'
import { formatSol, formatTokens } from '@/lib/paper-state'

export function TradeReceipt({ attempt }: { attempt: TradeAttempt }) {
  return (
    <>
      <AppText selectable>Purchase: {formatPayment(attempt.inputAmountRaw, attempt.inputMint)}</AppText>
      {attempt.outputMint ? <AppText selectable>Token: {attempt.outputMint}</AppText> : null}
      {attempt.receipt ? (
        <>
          <AppText selectable>Swap input: {formatPayment(attempt.receipt.inputAmountRaw, attempt.inputMint)}</AppText>
          <AppText selectable>
            Received: {formatTokens(attempt.receipt.outputAmountRaw, attempt.receipt.outputDecimals ?? undefined)}
          </AppText>
          <AppText selectable>
            {attempt.receipt.feeLamports === null
              ? 'Network fee pending verification'
              : `Network fee: ${formatSol(attempt.receipt.feeLamports)} · account rent is separate`}
          </AppText>
        </>
      ) : null}
    </>
  )
}
