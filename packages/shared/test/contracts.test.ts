import { describe, expect, test } from "bun:test";
import {
  authChallengeResponseSchema,
  authVerifyRequestSchema,
  createPaperPositionRequestSchema,
  createTradeAttemptRequestSchema,
  eventCursorSchema,
  getSignalsQuerySchema,
  liveClientMessageSchema,
  liveServerEventSchema,
  PROGRAM_IDS,
  PUMP_SWAP_PROGRAM_ID,
  paperPositionSchema,
  paperQuoteSchema,
  putWalletSubscriptionRequestSchema,
  rawAmountSchema,
  realOrderSchema,
  SPL_TOKEN_PROGRAM_ID,
  scoreReasonSchema,
  signalDetailSchema,
  signalPageSchema,
  solanaAddressSchema,
  tradeAttemptSchema,
  WRAPPED_SOL_MINT,
  walletSchema,
  walletSubscriptionSchema,
} from "../src/index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const address = WRAPPED_SOL_MINT;
const signature = "1".repeat(64);
const timestamp = "2026-09-24T08:00:00.000Z";
const later = "2026-09-24T08:04:00.000Z";

const paperQuote = {
  kind: "paper" as const,
  id,
  signalId: otherId,
  inputMint: WRAPPED_SOL_MINT,
  outputMint: PUMP_SWAP_PROGRAM_ID,
  inputAmountLamports: "100000000",
  outputAmountRaw: "1000",
  minOutputAmountRaw: "950",
  requestId: "jupiter-request",
  router: "metis" as const,
  feeLamports: "5000",
  fees: {
    totalBps: 0,
    mint: null,
    platform: null,
    signatureLamports: "5000",
    prioritizationLamports: "0",
    rentLamports: "0",
  },
  slippageBps: 500,
  priceImpactBps: 100,
  priceImpactPct: -1,
  fetchedAt: timestamp,
  expiresAt: later,
  providerQuoteId: null,
};

const signal = {
  id,
  eventId: "123",
  signature,
  walletId: otherId,
  walletAddress: address,
  mintAddress: PUMP_SWAP_PROGRAM_ID,
  sourceProgramId: PUMP_SWAP_PROGRAM_ID,
  slot: 350_000_000,
  observedAt: timestamp,
  publishedAt: later,
  scoreVersion: 1 as const,
  score: 80,
  status: "eligible" as const,
  dataStatus: "partial" as const,
};

describe("on-chain primitives and catalog", () => {
  test("every checked-in program ID is a 32-byte address", () => {
    for (const programId of Object.values(PROGRAM_IDS)) {
      expect(solanaAddressSchema.safeParse(programId).success).toBe(true);
    }
    expect(solanaAddressSchema.safeParse("0OIl").success).toBe(false);
    expect(solanaAddressSchema.safeParse("2".repeat(32)).success).toBe(false);
  });

  test("wallets and follows reject unexpected owner fields", () => {
    const wallet = {
      id,
      address,
      label: "Catalog whale",
      active: true,
      inclusionReason: "Recent supported activity",
      recentSupportedActivityAt: null,
    };
    expect(walletSchema.safeParse(wallet).success).toBe(true);
    expect(walletSchema.safeParse({ ...wallet, userId: otherId }).success).toBe(false);
    expect(putWalletSubscriptionRequestSchema.safeParse({}).success).toBe(true);
    expect(putWalletSubscriptionRequestSchema.safeParse({ alertsEnabled: true, userId: id }).success).toBe(false);
    expect(
      walletSubscriptionSchema.safeParse({
        walletId: id,
        alertsEnabled: true,
        alertsEnabledAt: null,
        createdAt: timestamp,
      }).success,
    ).toBe(false);
  });
});

describe("auth and JSON-safe cursors", () => {
  test("SIWS challenge has a bounded lifetime and mainnet domain", () => {
    const challenge = {
      challengeId: id,
      signInInput: {
        domain: "waffle.example",
        uri: "https://waffle.example",
        version: "1",
        chainId: "mainnet",
        nonce: "AbCdEf0123456789012345",
        issuedAt: timestamp,
        expirationTime: later,
        statement: "Sign in to waffle",
      },
    };
    expect(authChallengeResponseSchema.safeParse(challenge).success).toBe(true);
    expect(
      authChallengeResponseSchema.safeParse({
        ...challenge,
        signInInput: { ...challenge.signInInput, chainId: "devnet" },
      }).success,
    ).toBe(false);
    expect(
      authChallengeResponseSchema.safeParse({
        ...challenge,
        signInInput: { ...challenge.signInInput, domain: "other.example" },
      }).success,
    ).toBe(false);
    expect(
      authChallengeResponseSchema.safeParse({
        ...challenge,
        signInInput: { ...challenge.signInInput, expirationTime: "2026-09-24T08:06:00.000Z" },
      }).success,
    ).toBe(false);
    expect(
      authVerifyRequestSchema.safeParse({
        challengeId: id,
        accountAddress: address,
        signedMessageBase64: "c2lnbmVk",
        signatureBase64: "c2lnbmF0dXJl",
        userId: otherId,
      }).success,
    ).toBe(false);
  });

  test("event cursors stay decimal strings and query pages are bounded", () => {
    expect(eventCursorSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(eventCursorSchema.safeParse("9223372036854775808").success).toBe(false);
    expect(eventCursorSchema.safeParse(123).success).toBe(false);
    expect(eventCursorSchema.safeParse("1e3").success).toBe(false);
    expect(rawAmountSchema.safeParse("1e3").success).toBe(false);
    expect(getSignalsQuerySchema.parse({})).toMatchObject({ view: "all", direction: "before", limit: 50 });
    expect(getSignalsQuerySchema.parse({ cursor: "123", direction: "after", limit: "10" }).limit).toBe(10);
    expect(getSignalsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });
});

describe("signals, quotes, and positions", () => {
  test("score reasons are known and detail score equals their points", () => {
    const detail = {
      ...signal,
      reasons: [
        { code: "supported_buy", points: 20 },
        { code: "fresh_signal", points: 15 },
        { code: "mint_safe", points: 20 },
        { code: "pool_liquid", points: 15 },
        { code: "quote_available", points: 10 },
        { code: "holders_missing_stale_or_concentrated", points: 0 },
        { code: "creator_missing_stale_or_concentrated", points: 0 },
        { code: "oracle_none_or_stale", points: 0 },
      ],
      snapshot: {
        transactionSlot: 350_000_000,
        currentSlot: 350_000_010,
        mint: {
          address: PUMP_SWAP_PROGRAM_ID,
          tokenProgramId: SPL_TOKEN_PROGRAM_ID,
          mintAuthority: null,
          freezeAuthority: null,
          fetchedAt: timestamp,
        },
        pool: {
          baseMint: PUMP_SWAP_PROGRAM_ID,
          quoteMint: WRAPPED_SOL_MINT,
          liquidityUsd: 100_000,
          fetchedAt: timestamp,
        },
        quote: {
          inputMint: WRAPPED_SOL_MINT,
          outputMint: PUMP_SWAP_PROGRAM_ID,
          inputLamports: "50000000",
          outputAmountRaw: "1000",
          fetchedAt: timestamp,
        },
        holders: null,
        creator: null,
        oracle: null,
      },
    };
    expect(signalDetailSchema.safeParse(detail).success).toBe(true);
    expect(signalDetailSchema.safeParse({ ...detail, score: 81 }).success).toBe(false);
    expect(
      signalDetailSchema.safeParse({
        ...detail,
        snapshot: { ...detail.snapshot, mint: null },
      }).success,
    ).toBe(false);
    expect(
      signalDetailSchema.safeParse({
        ...detail,
        snapshot: { ...detail.snapshot, mint: { ...detail.snapshot.mint, tokenProgramId: WRAPPED_SOL_MINT } },
      }).success,
    ).toBe(false);
    expect(
      signalDetailSchema.safeParse({
        ...detail,
        snapshot: { ...detail.snapshot, quote: { ...detail.snapshot.quote, inputLamports: "bad" } },
      }).success,
    ).toBe(false);
    expect(
      signalDetailSchema.safeParse({
        ...detail,
        reasons: detail.reasons.map((reason, index) => (index === 0 ? { ...reason, points: 100 } : reason)),
      }).success,
    ).toBe(false);
    expect(scoreReasonSchema.safeParse({ code: "made_up", points: 1 }).success).toBe(false);
    expect(
      signalPageSchema.safeParse({
        view: "all",
        direction: "after",
        items: [signal],
        nextCursor: "123",
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  test("paper quotes and positions reject excess size or inconsistent output", () => {
    expect(paperQuoteSchema.safeParse(paperQuote).success).toBe(true);
    expect(paperQuoteSchema.safeParse({ ...paperQuote, inputAmountLamports: "100000001" }).success).toBe(false);
    expect(paperQuoteSchema.safeParse({ ...paperQuote, inputAmountLamports: "bad" }).success).toBe(false);
    expect(paperQuoteSchema.safeParse({ ...paperQuote, minOutputAmountRaw: "1001" }).success).toBe(false);
    expect(
      createPaperPositionRequestSchema.safeParse({
        signalId: otherId,
        quoteId: id,
        sizeLamports: "100000000",
      }).success,
    ).toBe(true);
    expect(
      paperPositionSchema.safeParse({
        id,
        signalId: otherId,
        sizeLamports: "100000000",
        entryQuote: paperQuote,
        simulated: true,
        status: "open",
        createdAt: timestamp,
        closedAt: null,
      }).success,
    ).toBe(true);
    expect(
      paperPositionSchema.safeParse({
        id,
        signalId: otherId,
        sizeLamports: "100000000",
        entryQuote: paperQuote,
        simulated: false,
        status: "open",
        createdAt: timestamp,
        closedAt: null,
      }).success,
    ).toBe(false);
  });

  test("real order contract rejects other routers, fee payers, and size above 0.05 SOL", () => {
    const { providerQuoteId: _providerQuoteId, ...baseQuote } = paperQuote;
    const order = {
      ...baseQuote,
      kind: "real",
      inputAmountLamports: "50000000",
      taker: address,
      signatureFeePayer: address,
      prioritizationFeePayer: address,
      rentFeePayer: address,
      gasless: false,
      requiredSignatures: 1,
      router: "metis",
      requestId: "jupiter-request",
      lastValidBlockHeight: "123456789",
      transactionBase64: "dHJhbnNhY3Rpb24=",
    };
    expect(realOrderSchema.safeParse(order).success).toBe(true);
    expect(realOrderSchema.safeParse({ ...order, router: "jupiterz" }).success).toBe(false);
    expect(realOrderSchema.safeParse({ ...order, signatureFeePayer: PUMP_SWAP_PROGRAM_ID }).success).toBe(false);
    expect(realOrderSchema.safeParse({ ...order, requiredSignatures: 2 }).success).toBe(false);
    expect(realOrderSchema.safeParse({ ...order, inputAmountLamports: "50000001" }).success).toBe(false);
    expect(
      createTradeAttemptRequestSchema.safeParse({
        signalId: id,
        quoteId: otherId,
        inputAmountLamports: "50000001",
      }).success,
    ).toBe(false);
  });

  test("confirmed trade attempt needs a signature", () => {
    const attempt = {
      id,
      signalId: otherId,
      quoteId: id,
      requestId: "jupiter-request",
      taker: address,
      router: "metis",
      inputAmountLamports: "50000000",
      status: "confirmed",
      signature: null,
      executeCode: 0,
      failureReason: null,
      createdAt: timestamp,
      updatedAt: later,
    };
    expect(tradeAttemptSchema.safeParse(attempt).success).toBe(false);
    expect(tradeAttemptSchema.safeParse({ ...attempt, signature }).success).toBe(true);
  });
});

describe("live protocol", () => {
  test("Following requires an auth frame; public All has no token", () => {
    expect(
      liveClientMessageSchema.safeParse({
        v: 1,
        type: "subscribe",
        view: "all",
        cursor: null,
      }).success,
    ).toBe(true);
    expect(
      liveClientMessageSchema.safeParse({
        v: 1,
        type: "subscribe",
        view: "following",
        cursor: null,
      }).success,
    ).toBe(false);
    expect(
      liveClientMessageSchema.safeParse({
        v: 1,
        type: "auth",
        view: "following",
        accessToken: "a".repeat(43),
        cursor: "123",
      }).success,
    ).toBe(true);
    expect(
      liveClientMessageSchema.safeParse({
        v: 1,
        type: "subscribe",
        view: "all",
        cursor: null,
        accessToken: "a".repeat(43),
      }).success,
    ).toBe(false);
  });

  test("live signal carries stable IDs for card fetch and deduplication", () => {
    expect(
      liveServerEventSchema.safeParse({
        v: 1,
        type: "signal",
        view: "following",
        eventId: "123",
        signalId: id,
        walletId: otherId,
      }).success,
    ).toBe(true);
    expect(
      liveServerEventSchema.safeParse({
        v: 1,
        type: "signal",
        view: "following",
        eventId: 123,
        signalId: id,
        walletId: otherId,
      }).success,
    ).toBe(false);
  });
});
