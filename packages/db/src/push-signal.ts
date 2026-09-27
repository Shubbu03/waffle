import { scorePolicyV1, signalDetailSchema } from "@waffle/shared";
import type { signals } from "./schema/index.ts";

/** Check stored eligibility plus original transaction age; never renew freshness at dispatch. */
export function pushSignal(row: typeof signals.$inferSelect, walletAddress: string, eventId: bigint, now: number) {
  const parsed = signalDetailSchema.safeParse({
    ...row,
    walletAddress,
    eventId: eventId.toString(),
    observedAt: row.observedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
  });
  if (!parsed.success) return null;
  const signal = parsed.data;
  const { assessment } = signal.snapshot;
  if (
    signal.status !== "eligible" ||
    signal.score < scorePolicyV1.alertThreshold ||
    !assessment?.transactionAt ||
    assessment.streamStale ||
    !["complete", "partial"].includes(signal.dataStatus)
  )
    return null;
  const scoredAt = Date.parse(assessment.scoredAt);
  const transactionAt = Date.parse(assessment.transactionAt);
  const observedAt = row.observedAt.getTime();
  if (scoredAt > now || transactionAt > scoredAt || observedAt > scoredAt) return null;
  const expiresAt = Math.min(transactionAt, observedAt) + scorePolicyV1.freshness.signalMs;
  if (expiresAt <= now) return null;
  for (const key of ["mint", "pool", "quote"] as const) {
    const evidence = assessment.evidence[key];
    const snapshot = signal.snapshot[key];
    const fetchedAt = snapshot ? Date.parse(snapshot.fetchedAt) : Number.NaN;
    if (
      evidence.status !== "fresh" ||
      !evidence.expiresAt ||
      Date.parse(evidence.expiresAt) < scoredAt ||
      !Number.isFinite(fetchedAt) ||
      fetchedAt > scoredAt ||
      scoredAt - fetchedAt > scorePolicyV1.freshness[`${key}Ms`]
    )
      return null;
  }
  if (
    signal.snapshot.transactionSlot !== signal.slot ||
    signal.snapshot.currentSlot < signal.slot ||
    signal.snapshot.currentSlot - signal.slot > scorePolicyV1.freshness.signalSlots
  )
    return null;
  return {
    expiresAt,
    data: {
      id: signal.id,
      eventId: eventId.toString(),
      score: String(signal.score),
      wallet: walletAddress,
      mint: signal.mintAddress,
      slot: String(signal.slot),
      age: String(Math.max(0, Math.floor((now - transactionAt) / 1000))),
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}
