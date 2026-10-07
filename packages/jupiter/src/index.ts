import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { type HttpClient, type HttpRequest, HttpResponseError, type HttpTransport } from "@waffle/http";
import {
  idSchema,
  type JupiterExecutionResult,
  jupiterExecuteRequestSchema,
  jupiterExecutionResultSchema,
  jupiterPaperQuoteRequestSchema,
  jupiterRealOrderRequestSchema,
  type PaperQuote,
  paperQuoteSchema,
  paperValuationQuoteSchema,
  positiveRawAmountSchema,
  type RealOrder,
  rawAmountSchema,
  realOrderSchema,
  scorePolicyV1,
  solanaAddressSchema,
  transactionSignatureSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import * as nacl from "tweetnacl";
import { z } from "zod";
import { createJupiterClient } from "./client.ts";

const BASE_URL = "https://api.jup.ag/swap/v2";
const MAX_PENDING = 256;
const feeLamports = z.number().int().nonnegative();

const orderResponseSchema = z.object({
  inputMint: solanaAddressSchema,
  outputMint: solanaAddressSchema,
  inAmount: positiveRawAmountSchema,
  outAmount: positiveRawAmountSchema,
  otherAmountThreshold: positiveRawAmountSchema,
  requestId: z.string().min(1).max(200),
  router: z.enum(["metis", "jupiterz", "dflow", "okx"]),
  priceImpact: z.number().min(-100).max(100),
  slippageBps: z.number().int().min(0).max(5_000),
  feeBps: z.number().int().min(0).max(10_000),
  feeMint: solanaAddressSchema.nullish(),
  platformFee: z
    .object({
      /** Jupiter dropped this field from /order responses; derive from bps when absent. */
      amount: rawAmountSchema.optional(),
      feeBps: z.number().int().min(0).max(10_000),
      feeMint: solanaAddressSchema,
    })
    .nullish(),
  signatureFeeLamports: feeLamports,
  signatureFeePayer: solanaAddressSchema.nullish(),
  prioritizationFeeLamports: feeLamports,
  prioritizationFeePayer: solanaAddressSchema.nullish(),
  rentFeeLamports: feeLamports,
  rentFeePayer: solanaAddressSchema.nullish(),
  gasless: z.boolean().optional(),
  taker: solanaAddressSchema.nullish(),
  transaction: z.string().nullable(),
  lastValidBlockHeight: positiveRawAmountSchema.nullish(),
  quoteId: z.string().max(200).nullish(),
  expireAt: z.iso.datetime({ offset: true }).nullish(),
});

const executeResponseSchema = z.object({
  status: z.enum(["Success", "Failed"]),
  code: z.number().int().min(-10_000).max(0),
  signature: z.string().nullish(),
  totalInputAmount: rawAmountSchema.optional(),
  totalOutputAmount: rawAmountSchema.optional(),
  inputAmountResult: rawAmountSchema.optional(),
  outputAmountResult: rawAmountSchema.optional(),
});

export type JupiterServiceErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_ORDER"
  | "STALE_ORDER"
  | "UNSUPPORTED_ORDER"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID"
  | "EXECUTION_UNKNOWN";

export class JupiterServiceError extends Error {
  constructor(
    readonly code: JupiterServiceErrorCode,
    readonly upstreamStatus?: number,
  ) {
    super(code);
    this.name = "JupiterServiceError";
  }
}

type PendingOrder = { expiresAt: string; order: RealOrder; message: Uint8Array };

/** Internal boundary. A future route must supply the authenticated wallet as connectedWallet. */
export class JupiterService {
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly paperQuotes = new Map<string, PaperQuote>();
  private readonly client: HttpClient;

  constructor(
    private readonly apiKey: string,
    transport?: HttpTransport,
    private readonly now: () => number = Date.now,
  ) {
    this.client = createJupiterClient(transport);
    if (!apiKey.trim()) throw new JupiterServiceError("INVALID_REQUEST");
  }

  async getPaperQuote(input: unknown): Promise<PaperQuote> {
    const parsed = jupiterPaperQuoteRequestSchema.safeParse(input);
    if (!parsed.success) throw new JupiterServiceError("INVALID_REQUEST");
    const request = parsed.data;
    const requestedAt = this.now();
    const response = await this.fetchOrder(request.outputMint, request.inputAmountLamports);
    if (
      response.inputMint !== WRAPPED_SOL_MINT ||
      response.outputMint !== request.outputMint ||
      response.inAmount !== request.inputAmountLamports ||
      response.taker != null ||
      response.transaction !== null
    ) {
      throw new JupiterServiceError("UPSTREAM_INVALID");
    }
    this.assertResponseFresh(response, requestedAt);

    const quote = paperQuoteSchema.safeParse({
      ...this.commonQuote(response, request.signalId, requestedAt),
      kind: "paper",
      providerQuoteId: response.quoteId ?? null,
    });
    if (!quote.success) throw new JupiterServiceError("UPSTREAM_INVALID");
    this.assertFresh(quote.data.expiresAt);
    this.remember(this.paperQuotes, quote.data.id, quote.data);
    return structuredClone(quote.data);
  }

  async getPaperValuation(input: unknown) {
    const parsed = z
      .strictObject({ positionId: idSchema, inputMint: solanaAddressSchema, inputAmountRaw: positiveRawAmountSchema })
      .safeParse(input);
    if (!parsed.success || parsed.data.inputMint === WRAPPED_SOL_MINT) throw new JupiterServiceError("INVALID_REQUEST");
    const request = parsed.data;
    const requestedAt = this.now();
    const response = await this.fetchOrder(WRAPPED_SOL_MINT, request.inputAmountRaw, undefined, request.inputMint);
    if (
      response.inputMint !== request.inputMint ||
      response.outputMint !== WRAPPED_SOL_MINT ||
      response.inAmount !== request.inputAmountRaw ||
      response.taker != null ||
      response.transaction !== null
    ) {
      throw new JupiterServiceError("UPSTREAM_INVALID");
    }
    this.assertResponseFresh(response, requestedAt);
    const quote = paperValuationQuoteSchema.safeParse({
      inputMint: response.inputMint,
      outputMint: response.outputMint,
      inputAmountRaw: response.inAmount,
      outputLamports: response.outAmount,
      minOutputLamports: response.otherAmountThreshold,
      feeLamports: (
        BigInt(response.signatureFeeLamports) +
        BigInt(response.prioritizationFeeLamports) +
        BigInt(response.rentFeeLamports)
      ).toString(),
      slippageBps: response.slippageBps,
      priceImpactPct: response.priceImpact,
      fetchedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(
        Math.min(
          requestedAt + scorePolicyV1.freshness.quoteMs,
          response.expireAt ? Date.parse(response.expireAt) : Infinity,
        ),
      ).toISOString(),
    });
    if (!quote.success) throw new JupiterServiceError("UPSTREAM_INVALID");
    this.assertFresh(quote.data.expiresAt);
    return quote.data;
  }

  /** Price provenance includes a block ID; callers must verify its age before using USD values. */
  async getUsdPrice(mintAddress: string): Promise<{ usdPrice: number; blockId: number; decimals: number }> {
    if (!solanaAddressSchema.safeParse(mintAddress).success) throw new JupiterServiceError("INVALID_REQUEST");
    const url = new URL("https://api.jup.ag/price/v3");
    url.searchParams.set("ids", mintAddress);
    const payload = await this.fetchJson(url, {
      headers: { "x-api-key": this.apiKey },
      timeoutMs: 8000,
    });
    const parsed = z
      .record(
        z.string(),
        z.object({
          usdPrice: z.number().finite().positive(),
          blockId: z.number().int().nonnegative().safe(),
          decimals: z.number().int().min(0).max(255),
        }),
      )
      .safeParse(payload);
    const price = parsed.success ? parsed.data[mintAddress] : undefined;
    if (!price) throw new JupiterServiceError("UPSTREAM_INVALID");
    return price;
  }

  getFreshPaperQuote(id: string): PaperQuote {
    const quote = this.paperQuotes.get(id);
    if (!quote) throw new JupiterServiceError("INVALID_ORDER");
    this.assertFresh(quote.expiresAt);
    return structuredClone(quote);
  }

  async getRealOrder(input: unknown, connectedWallet: string): Promise<RealOrder> {
    const parsed = jupiterRealOrderRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      !solanaAddressSchema.safeParse(connectedWallet).success ||
      parsed.data.taker !== connectedWallet
    )
      throw new JupiterServiceError("INVALID_REQUEST");
    const request = parsed.data;
    const requestedAt = this.now();
    const response = await this.fetchOrder(request.outputMint, request.inputAmountLamports, request.taker);
    if (
      response.inputMint !== WRAPPED_SOL_MINT ||
      response.outputMint !== request.outputMint ||
      response.inAmount !== request.inputAmountLamports ||
      response.taker !== request.taker
    ) {
      throw new JupiterServiceError("UPSTREAM_INVALID");
    }
    if (
      response.router === "jupiterz" ||
      response.signatureFeePayer !== request.taker ||
      response.gasless === true ||
      !response.transaction ||
      !response.lastValidBlockHeight
    ) {
      throw new JupiterServiceError("UNSUPPORTED_ORDER");
    }
    this.assertResponseFresh(response, requestedAt);

    const transaction = this.decodeTransaction(response.transaction);
    if (
      transaction.version !== 0 ||
      transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.message.compiledInstructions.length === 0 ||
      transaction.message.staticAccountKeys[0]?.toBase58() !== request.taker ||
      transaction.signatures.length !== 1 ||
      transaction.signatures[0]?.some((byte) => byte !== 0)
    ) {
      throw new JupiterServiceError("UNSUPPORTED_ORDER");
    }

    const order = realOrderSchema.safeParse({
      ...this.commonQuote(response, request.signalId, requestedAt),
      kind: "real",
      taker: request.taker,
      signatureFeePayer: response.signatureFeePayer,
      prioritizationFeePayer: response.prioritizationFeePayer ?? null,
      rentFeePayer: response.rentFeePayer ?? null,
      gasless: false,
      requiredSignatures: 1,
      lastValidBlockHeight: response.lastValidBlockHeight,
      transactionBase64: response.transaction,
    });
    if (!order.success) throw new JupiterServiceError("UPSTREAM_INVALID");
    this.assertFresh(order.data.expiresAt);
    this.remember(this.pendingOrders, order.data.id, {
      expiresAt: order.data.expiresAt,
      order: order.data,
      message: transaction.message.serialize(),
    });
    return structuredClone(order.data);
  }

  async execute(
    input: unknown,
    connectedWallet: string,
    onValidated?: (signature: Uint8Array) => Promise<void>,
  ): Promise<JupiterExecutionResult> {
    const parsed = jupiterExecuteRequestSchema.safeParse(input);
    if (!parsed.success) throw new JupiterServiceError("INVALID_REQUEST");
    const request = parsed.data;
    const pending = this.pendingOrders.get(request.orderId);
    if (!pending || pending.order.requestId !== request.requestId || pending.order.taker !== connectedWallet) {
      throw new JupiterServiceError("INVALID_ORDER");
    }
    this.assertFresh(pending.order.expiresAt);
    const transaction = this.decodeTransaction(request.signedTransactionBase64, "INVALID_ORDER");
    const message = transaction.message.serialize();
    const signature = transaction.signatures[0];
    if (
      transaction.version !== 0 ||
      transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.signatures.length !== 1 ||
      !signature ||
      !Buffer.from(message).equals(Buffer.from(pending.message)) ||
      !nacl.sign.detached.verify(message, signature, new PublicKey(connectedWallet).toBytes())
    ) {
      throw new JupiterServiceError("INVALID_ORDER");
    }

    // Persist a validated, owner-bound submission before any network broadcast.
    await onValidated?.(signature);
    // Consume before broadcast. A timeout cannot establish whether Jupiter landed a trade.
    this.pendingOrders.delete(request.orderId);
    let payload: unknown;
    try {
      payload = await this.fetchJson(
        `${BASE_URL}/execute`,
        {
          method: "POST",
          headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
          data: {
            signedTransaction: request.signedTransactionBase64,
            requestId: pending.order.requestId,
            lastValidBlockHeight: pending.order.lastValidBlockHeight,
          },
          timeoutMs: 20_000,
        },
        true,
      );
    } catch (error) {
      if (error instanceof JupiterServiceError && error.code === "EXECUTION_UNKNOWN") throw error;
      throw new JupiterServiceError("EXECUTION_UNKNOWN");
    }
    const result = executeResponseSchema.safeParse(payload);
    if (!result.success) throw new JupiterServiceError("EXECUTION_UNKNOWN");
    const data = result.data;
    const parsedSignature = transactionSignatureSchema.safeParse(data.signature);
    if (
      data.status === "Success" &&
      data.code === 0 &&
      parsedSignature.success &&
      data.totalInputAmount &&
      data.totalOutputAmount &&
      data.inputAmountResult &&
      data.outputAmountResult
    ) {
      return jupiterExecutionResultSchema.parse({
        status: "confirmed",
        requestId: request.requestId,
        code: 0,
        signature: parsedSignature.data,
        totalInputAmountRaw: data.totalInputAmount,
        totalOutputAmountRaw: data.totalOutputAmount,
        inputAmountResultRaw: data.inputAmountResult,
        outputAmountResultRaw: data.outputAmountResult,
      });
    }
    if (data.status === "Failed" && data.code < 0) {
      return jupiterExecutionResultSchema.parse({
        status: "failed",
        requestId: request.requestId,
        code: data.code,
        signature: parsedSignature.success ? parsedSignature.data : null,
      });
    }
    throw new JupiterServiceError("EXECUTION_UNKNOWN");
  }

  private commonQuote(response: z.infer<typeof orderResponseSchema>, signalId: string, requestedAt: number) {
    const expiresAt = Math.min(
      requestedAt + scorePolicyV1.freshness.quoteMs,
      response.expireAt ? Date.parse(response.expireAt) : Infinity,
    );
    const signature = BigInt(response.signatureFeeLamports);
    const priority = BigInt(response.prioritizationFeeLamports);
    const rent = BigInt(response.rentFeeLamports);
    return {
      id: crypto.randomUUID(),
      signalId,
      inputMint: response.inputMint,
      outputMint: response.outputMint,
      inputAmountLamports: response.inAmount,
      outputAmountRaw: response.outAmount,
      minOutputAmountRaw: response.otherAmountThreshold,
      requestId: response.requestId,
      router: response.router,
      feeLamports: (signature + priority + rent).toString(),
      fees: {
        totalBps: response.feeBps,
        mint: response.feeMint ?? null,
        platform: response.platformFee
          ? {
              amountRaw:
                response.platformFee.amount ??
                (response.platformFee.feeMint === response.inputMint
                  ? ((BigInt(response.inAmount) * BigInt(response.platformFee.feeBps)) / 10_000n).toString()
                  : "0"),
              bps: response.platformFee.feeBps,
              mint: response.platformFee.feeMint,
            }
          : null,
        signatureLamports: signature.toString(),
        prioritizationLamports: priority.toString(),
        rentLamports: rent.toString(),
      },
      slippageBps: response.slippageBps,
      priceImpactBps: Math.round(Math.abs(response.priceImpact) * 100),
      priceImpactPct: response.priceImpact,
      fetchedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async fetchOrder(outputMint: string, amount: string, taker?: string, inputMint: string = WRAPPED_SOL_MINT) {
    const url = new URL(`${BASE_URL}/order`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    if (taker) {
      url.searchParams.set("taker", taker);
      url.searchParams.set("excludeRouters", "jupiterz");
    }
    const payload = await this.fetchJson(url, {
      headers: { "x-api-key": this.apiKey },
      timeoutMs: 8000,
    });
    const parsed = orderResponseSchema.safeParse(payload);
    if (!parsed.success) throw new JupiterServiceError("UPSTREAM_INVALID");
    return parsed.data;
  }

  private async fetchJson(url: URL | string, init: Omit<HttpRequest, "url">, execution = false): Promise<unknown> {
    try {
      const response = await this.client.request({ ...init, url: String(url) });
      if (response.status < 200 || response.status >= 300)
        throw new JupiterServiceError(execution ? "EXECUTION_UNKNOWN" : "UPSTREAM_UNAVAILABLE", response.status);
      return response.data;
    } catch (error) {
      if (error instanceof JupiterServiceError) throw error;
      if (error instanceof HttpResponseError)
        throw new JupiterServiceError(execution ? "EXECUTION_UNKNOWN" : "UPSTREAM_INVALID");
      throw new JupiterServiceError(execution ? "EXECUTION_UNKNOWN" : "UPSTREAM_UNAVAILABLE");
    }
  }

  private decodeTransaction(
    encoded: string,
    errorCode: "INVALID_ORDER" | "UNSUPPORTED_ORDER" = "UNSUPPORTED_ORDER",
  ): VersionedTransaction {
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > 1232 || bytes.length === 0 || bytes.toString("base64") !== encoded)
        throw new Error("invalid bytes");
      return VersionedTransaction.deserialize(bytes);
    } catch {
      throw new JupiterServiceError(errorCode);
    }
  }

  private assertFresh(expiresAt: string): void {
    if (this.now() >= Date.parse(expiresAt)) throw new JupiterServiceError("STALE_ORDER");
  }

  private assertResponseFresh(response: z.infer<typeof orderResponseSchema>, requestedAt: number): void {
    if (
      this.now() >= requestedAt + scorePolicyV1.freshness.quoteMs ||
      (response.expireAt && this.now() >= Date.parse(response.expireAt))
    ) {
      throw new JupiterServiceError("STALE_ORDER");
    }
  }

  private remember<T extends { expiresAt: string }>(cache: Map<string, T>, id: string, value: T): void {
    for (const [key, entry] of cache) if (this.now() >= Date.parse(entry.expiresAt)) cache.delete(key);
    if (cache.size >= MAX_PENDING) {
      const oldestId = cache.keys().next().value;
      if (oldestId !== undefined) cache.delete(oldestId);
    }
    cache.set(id, value);
  }
}

export function createJupiterServiceFromEnv(env: { JUPITER_API_KEY?: string }): JupiterService {
  return new JupiterService(env.JUPITER_API_KEY ?? "");
}
