import { type ScoredSignal, scoredSignalSchema } from "@waffle/shared";

export type SignalWriteResult =
  | { status: "inserted"; signalId: string; eventId: string }
  | { status: "duplicate" }
  | { status: "inactive-wallet" };
export type SignalQuery = <T extends Record<string, unknown>>(
  text: string,
  parameters?: (string | number)[],
) => Promise<T[]>;
export type SignalTransaction = (run: (query: SignalQuery) => Promise<SignalWriteResult>) => Promise<SignalWriteResult>;

/** A short transaction; enrichment happens before this boundary. No update of an existing signal. */
export async function storeSignal(
  transaction: SignalTransaction,
  walletAddress: string,
  prepare: () => ScoredSignal,
): Promise<SignalWriteResult> {
  return transaction(async (query) => {
    // Shared by all watcher writers, before sequence allocation, so outbox IDs follow commit order.
    await query("SELECT pg_advisory_xact_lock(1970169702, 1)");
    const [wallet] = await query<{ id: string }>(
      "SELECT id FROM public.watched_wallets WHERE address = $1 AND active = true FOR SHARE",
      [walletAddress],
    );
    if (!wallet) return { status: "inactive-wallet" };
    const signal = scoredSignalSchema.parse(prepare());
    if (signal.walletAddress !== walletAddress) throw new Error("Signal wallet mismatch");
    const [inserted] = await query<{ id: string }>(
      `
      INSERT INTO public.signals
        (signature, wallet_id, mint_address, source_program_id, slot, observed_at,
         published_at, score_version, score, status, data_status, reasons, snapshot)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, clock_timestamp(), $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (signature, wallet_id) DO NOTHING RETURNING id`,
      [
        signal.signature,
        wallet.id,
        signal.mintAddress,
        signal.sourceProgramId,
        signal.slot,
        signal.observedAt,
        signal.scoreVersion,
        signal.score,
        signal.status,
        signal.dataStatus,
        JSON.stringify(signal.reasons),
        JSON.stringify(signal.snapshot),
      ],
    );
    if (!inserted) return { status: "duplicate" };
    const [event] = await query<{ id: string }>(
      "INSERT INTO public.signal_events (signal_id, created_at) VALUES ($1, clock_timestamp()) RETURNING id::text",
      [inserted.id],
    );
    if (!event) throw new Error("Signal outbox insert failed");
    // Backfills must never move the catalog activity timestamp backwards.
    const transactionAt = signal.snapshot.assessment?.transactionAt;
    if (transactionAt)
      await query(
        `
      UPDATE public.watched_wallets SET recent_supported_activity_at =
        GREATEST(recent_supported_activity_at, $2::timestamptz) WHERE id = $1`,
        [wallet.id, transactionAt],
      );
    return { status: "inserted", signalId: inserted.id, eventId: event.id };
  });
}
