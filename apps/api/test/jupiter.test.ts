import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PUMP_SWAP_PROGRAM_ID, WRAPPED_SOL_MINT } from "@waffle/shared";
import { JupiterService, JupiterServiceError } from "../src/jupiter.ts";

const signalId = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-09-24T08:00:00.000Z");
const wallet = Keypair.generate();
const otherWallet = Keypair.generate();
const message = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: "11111111111111111111111111111111",
  instructions: [
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: otherWallet.publicKey, lamports: 1 }),
  ],
}).compileToV0Message();
const unsigned = new VersionedTransaction(message);
const signed = new VersionedTransaction(message);
signed.sign([wallet]);
const unsignedBase64 = Buffer.from(unsigned.serialize()).toString("base64");
const signedBase64 = Buffer.from(signed.serialize()).toString("base64");
const changed = new VersionedTransaction(
  new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: otherWallet.publicKey, lamports: 2 }),
    ],
  }).compileToV0Message(),
);
changed.sign([wallet]);
const changedBase64 = Buffer.from(changed.serialize()).toString("base64");
const twoSignerMessage = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: "11111111111111111111111111111111",
  instructions: [
    new TransactionInstruction({
      programId: new PublicKey(PUMP_SWAP_PROGRAM_ID),
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: otherWallet.publicKey, isSigner: true, isWritable: false },
      ],
    }),
  ],
}).compileToV0Message();
const twoSignerBase64 = Buffer.from(new VersionedTransaction(twoSignerMessage).serialize()).toString("base64");

function upstreamOrder(overrides: Record<string, unknown> = {}) {
  return {
    inputMint: WRAPPED_SOL_MINT,
    outputMint: PUMP_SWAP_PROGRAM_ID,
    inAmount: "50000000",
    outAmount: "1000",
    otherAmountThreshold: "950",
    requestId: "jup-request-1",
    router: "metis",
    priceImpact: -0.5,
    slippageBps: 500,
    feeBps: 10,
    feeMint: PUMP_SWAP_PROGRAM_ID,
    platformFee: { amount: "2", feeBps: 10, feeMint: PUMP_SWAP_PROGRAM_ID },
    signatureFeeLamports: 5000,
    signatureFeePayer: wallet.publicKey.toBase58(),
    prioritizationFeeLamports: 1000,
    prioritizationFeePayer: wallet.publicKey.toBase58(),
    rentFeeLamports: 0,
    rentFeePayer: wallet.publicKey.toBase58(),
    gasless: false,
    taker: wallet.publicKey.toBase58(),
    transaction: unsignedBase64,
    lastValidBlockHeight: "123456789",
    ...overrides,
  };
}

function mockService(
  response: unknown,
  requests: Array<{ url: URL; init: RequestInit }> = [],
  clock: () => number = () => now,
  executeResponse?: unknown,
) {
  const fakeFetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, init });
    return Response.json(parsed.pathname.endsWith("/execute") ? executeResponse : response);
  };
  return new JupiterService("server-secret", fakeFetch as typeof fetch, clock);
}

const realRequest = {
  signalId,
  outputMint: PUMP_SWAP_PROGRAM_ID,
  inputAmountLamports: "50000000",
  taker: wallet.publicKey.toBase58(),
};

describe("Jupiter quote and order service", () => {
  test("paper quote omits taker and transaction, retains fee and route evidence, and expires locally", async () => {
    let clock = now;
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const service = mockService(
      upstreamOrder({ taker: null, transaction: null, quoteId: "provider-quote" }),
      requests,
      () => clock,
    );
    const quote = await service.getPaperQuote({
      signalId,
      outputMint: PUMP_SWAP_PROGRAM_ID,
      inputAmountLamports: "50000000",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Expected paper quote request");
    expect(request.url.searchParams.has("taker")).toBe(false);
    expect(request.url.searchParams.get("inputMint")).toBe(WRAPPED_SOL_MINT);
    expect((request.init.headers as Record<string, string>)["x-api-key"]).toBe("server-secret");
    expect(quote).toMatchObject({
      kind: "paper",
      requestId: "jup-request-1",
      router: "metis",
      providerQuoteId: "provider-quote",
      minOutputAmountRaw: "950",
      feeLamports: "6000",
      fees: { totalBps: 10, signatureLamports: "5000", prioritizationLamports: "1000" },
      priceImpactPct: -0.5,
      priceImpactBps: 50,
    });
    expect("transactionBase64" in quote).toBe(false);
    expect(service.getFreshPaperQuote(quote.id).id).toBe(quote.id);
    clock += 10_000;
    expect(() => service.getFreshPaperQuote(quote.id)).toThrow(JupiterServiceError);
  });

  test("rejects invalid, stale, mismatched, and transaction-bearing paper quotes", async () => {
    const request = { signalId, outputMint: PUMP_SWAP_PROGRAM_ID, inputAmountLamports: "50000000" };
    let service = mockService(upstreamOrder({ taker: null, transaction: null }));
    await expect(service.getPaperQuote({ ...request, inputAmountLamports: "100000001" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    service = mockService(upstreamOrder({ taker: null, transaction: null, inAmount: "1" }));
    await expect(service.getPaperQuote(request)).rejects.toMatchObject({ code: "UPSTREAM_INVALID" });
    service = mockService(upstreamOrder({ taker: null, transaction: unsignedBase64 }));
    await expect(service.getPaperQuote(request)).rejects.toMatchObject({ code: "UPSTREAM_INVALID" });
    service = mockService(upstreamOrder({ taker: null, transaction: null, expireAt: new Date(now - 1).toISOString() }));
    await expect(service.getPaperQuote(request)).rejects.toMatchObject({ code: "STALE_ORDER" });
  });

  test("real order requests one-signature non-sponsored routing and preserves fee payers", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const service = mockService(upstreamOrder(), requests);
    const order = await service.getRealOrder(realRequest, wallet.publicKey.toBase58());
    const request = requests[0];
    if (!request) throw new Error("Expected real order request");
    expect(request.url.searchParams.get("taker")).toBe(wallet.publicKey.toBase58());
    expect(request.url.searchParams.get("excludeRouters")).toBe("jupiterz");
    expect(order).toMatchObject({
      kind: "real",
      requiredSignatures: 1,
      gasless: false,
      signatureFeePayer: wallet.publicKey.toBase58(),
      prioritizationFeePayer: wallet.publicKey.toBase58(),
      rentFeePayer: wallet.publicKey.toBase58(),
      lastValidBlockHeight: "123456789",
      requestId: "jup-request-1",
    });
  });

  test("rejects unsupported routes, fee sponsorship, malformed signatures, and wallet mismatch", async () => {
    for (const [payload, code] of [
      [upstreamOrder({ router: "jupiterz" }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ signatureFeePayer: otherWallet.publicKey.toBase58() }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ gasless: true }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ transaction: signedBase64 }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ transaction: twoSignerBase64 }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ transaction: "not-base64" }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ transaction: null }), "UNSUPPORTED_ORDER"],
      [upstreamOrder({ lastValidBlockHeight: null }), "UNSUPPORTED_ORDER"],
    ] as const) {
      await expect(mockService(payload).getRealOrder(realRequest, wallet.publicKey.toBase58())).rejects.toMatchObject({
        code,
      });
    }
    await expect(
      mockService(upstreamOrder()).getRealOrder(realRequest, otherWallet.publicKey.toBase58()),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      mockService(upstreamOrder()).getRealOrder(
        { ...realRequest, inputAmountLamports: "50000001" },
        wallet.publicKey.toBase58(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      mockService(upstreamOrder({ expireAt: new Date(now - 1).toISOString() })).getRealOrder(
        realRequest,
        wallet.publicKey.toBase58(),
      ),
    ).rejects.toMatchObject({ code: "STALE_ORDER" });
  });

  test("executes only the exact signed order once, without calling a live endpoint", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const service = mockService(upstreamOrder(), requests, () => now, {
      status: "Success",
      code: 0,
      signature: "1".repeat(64),
      totalInputAmount: "50000000",
      totalOutputAmount: "990",
      inputAmountResult: "50000000",
      outputAmountResult: "1000",
    });
    const order = await service.getRealOrder(realRequest, wallet.publicKey.toBase58());
    const execute = { orderId: order.id, requestId: order.requestId, signedTransactionBase64: signedBase64 };
    await expect(
      service.execute({ ...execute, requestId: "wrong" }, wallet.publicKey.toBase58()),
    ).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(
      service.execute({ ...execute, signedTransactionBase64: unsignedBase64 }, wallet.publicKey.toBase58()),
    ).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(
      service.execute({ ...execute, signedTransactionBase64: changedBase64 }, wallet.publicKey.toBase58()),
    ).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(service.execute(execute, otherWallet.publicKey.toBase58())).rejects.toMatchObject({
      code: "INVALID_ORDER",
    });
    expect(requests).toHaveLength(1);
    expect(await service.execute(execute, wallet.publicKey.toBase58())).toMatchObject({
      status: "confirmed",
      code: 0,
      totalOutputAmountRaw: "990",
      outputAmountResultRaw: "1000",
    });
    expect(requests).toHaveLength(2);
    const executionRequest = requests[1];
    if (!executionRequest) throw new Error("Expected execution request");
    expect(JSON.parse(executionRequest.init.body as string)).toEqual({
      signedTransaction: signedBase64,
      requestId: order.requestId,
      lastValidBlockHeight: order.lastValidBlockHeight,
    });
    await expect(service.execute(execute, wallet.publicKey.toBase58())).rejects.toMatchObject({
      code: "INVALID_ORDER",
    });
    expect(requests).toHaveLength(2);
  });

  test("reports upstream failures and uncertain execution without retrying", async () => {
    const request = { signalId, outputMint: PUMP_SWAP_PROGRAM_ID, inputAmountLamports: "50000000" };
    const unavailable = new JupiterService(
      "server-secret",
      (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      () => now,
    );
    await expect(unavailable.getPaperQuote(request)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      upstreamStatus: 429,
    });
    const malformed = mockService({ error: "bad upstream payload" });
    await expect(malformed.getPaperQuote(request)).rejects.toMatchObject({ code: "UPSTREAM_INVALID" });
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const service = mockService(upstreamOrder(), requests, () => now, {
      status: "Failed",
      code: -1000,
      signature: null,
    });
    const order = await service.getRealOrder(realRequest, wallet.publicKey.toBase58());
    expect(
      await service.execute(
        { orderId: order.id, requestId: order.requestId, signedTransactionBase64: signedBase64 },
        wallet.publicKey.toBase58(),
      ),
    ).toMatchObject({
      status: "failed",
      code: -1000,
      signature: null,
    });
    const failedFetch = new JupiterService(
      "server-secret",
      (async (url) => {
        if (String(url).endsWith("/execute")) throw new Error("timeout");
        return Response.json(upstreamOrder());
      }) as typeof fetch,
      () => now,
    );
    const uncertainOrder = await failedFetch.getRealOrder(realRequest, wallet.publicKey.toBase58());
    const attempt = {
      orderId: uncertainOrder.id,
      requestId: uncertainOrder.requestId,
      signedTransactionBase64: signedBase64,
    };
    await expect(failedFetch.execute(attempt, wallet.publicKey.toBase58())).rejects.toMatchObject({
      code: "EXECUTION_UNKNOWN",
    });
    await expect(failedFetch.execute(attempt, wallet.publicKey.toBase58())).rejects.toMatchObject({
      code: "INVALID_ORDER",
    });
  });
});

test("USD price requests preserve exact mint identity and source block", async () => {
  const service = new JupiterService("private", (async (url, init) => {
    expect(new URL(String(url)).pathname).toBe("/price/v3");
    expect(new URL(String(url)).searchParams.get("ids")).toBe(WRAPPED_SOL_MINT);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("private");
    expect(init?.redirect).toBe("error");
    return Response.json({ [WRAPPED_SOL_MINT]: { usdPrice: 150, blockId: 100, decimals: 9 } });
  }) as typeof fetch);
  expect(await service.getUsdPrice(WRAPPED_SOL_MINT)).toEqual({ usdPrice: 150, blockId: 100, decimals: 9 });
  for (const payload of [
    {},
    { [WRAPPED_SOL_MINT]: null },
    { [WRAPPED_SOL_MINT]: { usdPrice: -1, blockId: 100, decimals: 9 } },
  ]) {
    const invalid = new JupiterService("private", (async (_url: Parameters<typeof fetch>[0]) =>
      Response.json(payload)) as typeof fetch);
    await expect(invalid.getUsdPrice(WRAPPED_SOL_MINT)).rejects.toThrow("UPSTREAM_INVALID");
  }
});
