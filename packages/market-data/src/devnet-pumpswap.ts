import {
  buyQuoteInput,
  coinCreatorVaultAtaPda,
  computeFeesBps,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  type SwapSolanaState,
  sellBaseInput,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-swap-sdk";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { HttpTransport } from "@waffle/http";
import { JupiterServiceError } from "@waffle/jupiter";
import {
  idSchema,
  type JupiterExecutionResult,
  jupiterExecuteRequestSchema,
  jupiterPaperQuoteRequestSchema,
  jupiterRealOrderRequestSchema,
  type PaperQuote,
  PUMP_SWAP_PROGRAM_ID,
  paperQuoteSchema,
  paperValuationQuoteSchema,
  positiveRawAmountSchema,
  type RealOrder,
  realOrderSchema,
  type SignalDetail,
  SPL_TOKEN_PROGRAM_ID,
  solanaAddressSchema,
  TOKEN_2022_PROGRAM_ID,
  type TradeAssessment,
  type TradeMode,
  tradeAssessmentSchema,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";
import BN from "bn.js";
import bs58 from "bs58";
import * as nacl from "tweetnacl";
import { z } from "zod";
import { decodeMint, decodePool, decodeVault, parseAccounts } from "./accounts.ts";
import { classifyPumpSwapBuy } from "./classify.ts";
import type { TokenChecks } from "./evidence.ts";
import type { MarketRpc } from "./rpc.ts";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TTL = 60_000;
const SLIPPAGE_BPS = 100;
const sdkMethods = z.enum(["getMultipleAccounts", "getAccountInfo"]);
const statusSchema = z.object({
  value: z.array(
    z
      .object({
        err: z.unknown(),
        confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
      })
      .nullable(),
  ),
});
const simulationSchema = z.object({ value: z.object({ err: z.unknown() }) });

/** Direct Devnet-only AMM integration. Every RPC passes through the shared Xior scheduler.
 * No keys, airdrops, pool creation, signing or automatic execution retries. */
export class DevnetPumpSwap {
  private readonly online: OnlinePumpAmmSdk;
  private readonly pools = new Map<string, { mint: string; address: string; slot: number }>();
  private readonly pending = new Map<string, { order: RealOrder; message: Uint8Array }>();
  private genesisChecked = false;
  constructor(
    private readonly rpc: MarketRpc,
    private readonly now: () => number = Date.now,
  ) {
    // The SDK expects web3 Connection's decoding, but its HTTP transport is ours.
    const connection = new Connection("https://api.devnet.solana.com", {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: Object.assign(
        async (_url: Parameters<HttpTransport>[0], init?: Parameters<HttpTransport>[1]) => {
          const request = z
            .object({ id: z.union([z.string(), z.number()]), method: sdkMethods, params: z.array(z.unknown()) })
            .parse(JSON.parse(String(init?.body)));
          const result = await rpc.call(request.method, request.params);
          return Response.json({ jsonrpc: "2.0", id: request.id, result });
        },
        { preconnect: () => {} },
      ),
    });
    this.online = new OnlinePumpAmmSdk(connection);
  }
  async assertNetwork() {
    if (this.genesisChecked) return;
    if ((await this.rpc.call("getGenesisHash", [])) !== DEVNET_GENESIS_HASH)
      throw new JupiterServiceError("UNSUPPORTED_ORDER");
    this.genesisChecked = true;
  }
  private remember(id: string, value: { mint: string; address: string; slot: number }) {
    if (this.pools.size >= 512) {
      const oldest = this.pools.keys().next().value;
      if (oldest) this.pools.delete(oldest);
    }
    this.pools.set(id, value);
  }
  async assess(signal: SignalDetail, mode: TradeMode, size: string): Promise<TradeAssessment> {
    await this.assertNetwork();
    const tx = await this.rpc.getTransaction(signal.signature);
    const result = classifyPumpSwapBuy(tx, signal.walletAddress, signal.signature);
    if (result.status !== "buy" || result.buy.slot !== signal.slot || result.buy.mintAddress !== signal.mintAddress)
      throw new JupiterServiceError("INVALID_ORDER");
    const verified = await this.checkPool(result.buy.poolAddress, signal.mintAddress, result.buy.slot);
    this.remember(signal.id, { mint: signal.mintAddress, address: verified.pool.address, slot: result.buy.slot });
    const at = new Date(verified.at).toISOString();
    return tradeAssessmentSchema.parse({
      network: "devnet",
      policyVersion: 1,
      signalId: signal.id,
      mode,
      inputAmountLamports: size,
      checkedAt: at,
      expiresAt: new Date(verified.at + TTL).toISOString(),
      mint: {
        address: signal.mintAddress,
        tokenProgramId: verified.mint.tokenProgramId,
        decimals: verified.mint.decimals,
        mintAuthority: null,
        freezeAuthority: null,
        fetchedAt: at,
      },
      pool: {
        address: verified.pool.address,
        baseMint: signal.mintAddress,
        quoteMint: WRAPPED_SOL_MINT,
        liquidityUsd: null,
        quoteReserveLamports: verified.quote.toString(),
        fetchedAt: at,
      },
      oracle: { source: "none" },
    });
  }
  private async checkPool(address: string, mint: string, slot: number) {
    await this.assertNetwork();
    const at = this.now();
    const initial = parseAccounts(await this.rpc.getMultipleAccounts([address], slot), 1, slot);
    const pool = decodePool(initial.value[0], address, mint);
    const snapshot = parseAccounts(
      await this.rpc.getMultipleAccounts([address, mint, pool.baseVault, pool.quoteVault], initial.context.slot),
      4,
      initial.context.slot,
    );
    const checked = decodePool(snapshot.value[0], address, mint);
    if (checked.baseVault !== pool.baseVault || checked.quoteVault !== pool.quoteVault)
      throw new JupiterServiceError("INVALID_ORDER");
    const token = decodeMint(snapshot.value[1], mint);
    if (token.mintAuthority || token.freezeAuthority) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    // Token-2022 extensions can change transfers. Only the plain mint layout is supported here.
    const mintAccount = snapshot.value[1];
    if (!mintAccount) throw new JupiterServiceError("INVALID_ORDER");
    const mintBytes = Buffer.from(mintAccount.data[0], "base64");
    if (token.tokenProgramId === TOKEN_2022_PROGRAM_ID && mintBytes.length > 166)
      throw new JupiterServiceError("UNSUPPORTED_ORDER");
    const base = decodeVault(snapshot.value[2], mint, address);
    const quote = decodeVault(snapshot.value[3], WRAPPED_SOL_MINT, address);
    if (base <= 0n || quote <= 0n) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    return { at, mint: token, pool: checked, base, quote };
  }
  private async state(signalId: string, mint: string, user: PublicKey) {
    const binding = this.pools.get(signalId);
    if (!binding || binding.mint !== mint) throw new JupiterServiceError("INVALID_REQUEST");
    await this.checkPool(binding.address, mint, binding.slot);
    const state = await this.online.swapSolanaState(new PublicKey(binding.address), user);
    if (
      !state.poolAccountInfo ||
      state.poolAccountInfo.owner.toBase58() !== PUMP_SWAP_PROGRAM_ID ||
      state.pool.isMayhemMode ||
      state.pool.baseMint.toBase58() !== mint ||
      state.pool.quoteMint.toBase58() !== WRAPPED_SOL_MINT ||
      ![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(state.baseTokenProgram.toBase58()) ||
      state.quoteTokenProgram.toBase58() !== SPL_TOKEN_PROGRAM_ID
    )
      throw new JupiterServiceError("UNSUPPORTED_ORDER");
    const available = state.poolQuoteAmount.sub(state.pool.protocolFees).sub(state.pool.creatorFees);
    if (available.ltn(1_000_000_000)) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    return state;
  }
  private pricing(state: SwapSolanaState, size: string) {
    const available = state.poolQuoteAmount.sub(state.pool.protocolFees).sub(state.pool.creatorFees);
    if (new BN(size).muln(100).gt(available)) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    const args = {
      quote: new BN(size),
      slippage: 0,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      globalConfig: state.globalConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    };
    const price = buyQuoteInput(args);
    const fees = computeFeesBps({ ...args, baseMintSupply: new BN(state.baseMintAccount.supply.toString()) });
    const totalBps = fees.lpFeeBps
      .add(fees.protocolFeeBps)
      .add(state.pool.coinCreator.equals(PublicKey.default) ? new BN(0) : fees.creatorFeeBps)
      .toNumber();
    const minimum = price.base.muln(10_000 - SLIPPAGE_BPS).divn(10_000);
    if (minimum.lten(0)) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    const impact = Math.min(
      100,
      (new BN(size).toNumber() / state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toNumber()) * 100,
    );
    return { output: price.base, minimum, totalBps, impact };
  }
  private fields(signalId: string, mint: string, size: string, state: SwapSolanaState, at: number) {
    const price = this.pricing(state, size);
    return {
      network: "devnet" as const,
      id: crypto.randomUUID(),
      signalId,
      inputMint: WRAPPED_SOL_MINT,
      outputMint: mint,
      inputAmountLamports: size,
      outputAmountRaw: price.output.toString(),
      minOutputAmountRaw: price.minimum.toString(),
      requestId: crypto.randomUUID(),
      router: "pumpswap" as const,
      feeLamports: "0",
      fees: {
        totalBps: price.totalBps,
        mint: WRAPPED_SOL_MINT,
        platform: null,
        signatureLamports: "0",
        prioritizationLamports: "0",
        rentLamports: "0",
      },
      slippageBps: SLIPPAGE_BPS,
      priceImpactPct: price.impact,
      priceImpactBps: Math.round(price.impact * 100),
      fetchedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + TTL).toISOString(),
    };
  }
  async getPaperQuote(input: unknown): Promise<PaperQuote> {
    const request = jupiterPaperQuoteRequestSchema.parse(input);
    const at = this.now();
    // A quote-only request never needs a taker or a funded account.
    const state = await this.state(request.signalId, request.outputMint, PublicKey.default);
    return paperQuoteSchema.parse({
      ...this.fields(request.signalId, request.outputMint, request.inputAmountLamports, state, at),
      kind: "paper",
      providerQuoteId: null,
      outputDecimals: state.baseMintAccount.decimals,
    });
  }
  async getPaperValuation(input: unknown) {
    const request = z
      .strictObject({
        positionId: idSchema,
        signalId: idSchema,
        inputMint: solanaAddressSchema,
        inputAmountRaw: positiveRawAmountSchema,
      })
      .parse(input);
    const at = this.now();
    const state = await this.state(request.signalId, request.inputMint, PublicKey.default);
    const price = sellBaseInput({
      base: new BN(request.inputAmountRaw),
      slippage: 1,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees),
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      globalConfig: state.globalConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    });
    return paperValuationQuoteSchema.parse({
      inputMint: request.inputMint,
      outputMint: WRAPPED_SOL_MINT,
      inputAmountRaw: request.inputAmountRaw,
      outputLamports: price.uiQuote.toString(),
      minOutputLamports: price.minQuote.toString(),
      feeLamports: "0",
      slippageBps: 100,
      priceImpactPct: Math.min(
        100,
        (new BN(request.inputAmountRaw).toNumber() / state.poolBaseAmount.toNumber()) * 100,
      ),
      fetchedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 10_000).toISOString(),
    });
  }
  async getRealOrder(input: unknown, connectedWallet: string): Promise<RealOrder> {
    const request = jupiterRealOrderRequestSchema.parse(input);
    if (request.taker !== connectedWallet) throw new JupiterServiceError("INVALID_REQUEST");
    const at = this.now();
    const state = await this.state(request.signalId, request.outputMint, new PublicKey(connectedWallet));
    const fields = this.fields(request.signalId, request.outputMint, request.inputAmountLamports, state, at);
    // Fix the minimum base output and cap the SOL input exactly at the reviewed amount.
    const instructions = await PUMP_AMM_SDK.buyInstructions(
      state,
      new BN(fields.minOutputAmountRaw),
      new BN(request.inputAmountLamports),
    );
    const block = z
      .object({ value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number().int().positive() }) })
      .parse(await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]));
    const message = new TransactionMessage({
      payerKey: new PublicKey(connectedWallet),
      recentBlockhash: block.value.blockhash,
      instructions,
    }).compileToV0Message();
    if (message.header.numRequiredSignatures !== 1) throw new JupiterServiceError("UNSUPPORTED_ORDER");
    const transaction = new VersionedTransaction(message);
    const encoded = Buffer.from(transaction.serialize()).toString("base64");
    const fee = z
      .object({ value: z.number().int().nonnegative() })
      .parse(
        await this.rpc.call("getFeeForMessage", [
          Buffer.from(message.serialize()).toString("base64"),
          { commitment: "confirmed" },
        ]),
      );
    const accountRent = z
      .number()
      .int()
      .nonnegative()
      .parse(await this.rpc.call("getMinimumBalanceForRentExemption", [165]));
    const poolRent = z
      .number()
      .int()
      .nonnegative()
      .parse(await this.rpc.call("getMinimumBalanceForRentExemption", [300]));
    const oldPoolRent = z
      .number()
      .int()
      .nonnegative()
      .parse(await this.rpc.call("getMinimumBalanceForRentExemption", [state.poolAccountInfo?.data.length ?? 300]));
    const extras = [
      userVolumeAccumulatorPda(state.user).toBase58(),
      coinCreatorVaultAtaPda(state.pool.coinCreator, state.pool.quoteMint, state.quoteTokenProgram).toBase58(),
    ];
    const extraAccounts = parseAccounts(await this.rpc.getMultipleAccounts(extras, 0), extras.length, 0);
    const volumeRent = z
      .number()
      .int()
      .nonnegative()
      .parse(await this.rpc.call("getMinimumBalanceForRentExemption", [73]));
    const extraRent = (extraAccounts.value[0] ? 0 : volumeRent) + (extraAccounts.value[1] ? 0 : accountRent);
    const rent =
      extraRent +
      (state.userBaseAccountInfo ? 0 : accountRent) +
      (state.userQuoteAccountInfo ? 0 : accountRent) +
      Math.max(0, poolRent - oldPoolRent);
    const balance = z
      .object({ value: z.number().int().nonnegative() })
      .parse(await this.rpc.call("getBalance", [connectedWallet, { commitment: "confirmed" }]));
    if (BigInt(balance.value) < BigInt(request.inputAmountLamports) + BigInt(fee.value + rent))
      throw new JupiterServiceError("INSUFFICIENT_FUNDS");
    await this.simulate(encoded);
    const order = realOrderSchema.parse({
      ...fields,
      kind: "real",
      taker: connectedWallet,
      signatureFeePayer: connectedWallet,
      prioritizationFeePayer: null,
      rentFeePayer: connectedWallet,
      gasless: false,
      requiredSignatures: 1,
      lastValidBlockHeight: String(block.value.lastValidBlockHeight),
      transactionBase64: encoded,
      feeLamports: String(fee.value + rent),
      fees: { ...fields.fees, signatureLamports: String(fee.value), rentLamports: String(rent) },
    });
    for (const [id, value] of this.pending)
      if (Date.parse(value.order.expiresAt) <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 256) throw new JupiterServiceError("UPSTREAM_UNAVAILABLE");
    this.pending.set(order.id, { order, message: message.serialize() });
    return order;
  }
  private async simulate(encoded: string) {
    const result = simulationSchema.parse(
      await this.rpc.call("simulateTransaction", [
        encoded,
        { encoding: "base64", commitment: "confirmed", sigVerify: false },
      ]),
    );
    if (result.value.err !== null) throw new JupiterServiceError("ORDER_BUILD_FAILED");
  }
  async execute(
    input: unknown,
    connectedWallet: string,
    onValidated?: (signature: Uint8Array) => Promise<void>,
  ): Promise<JupiterExecutionResult> {
    const request = jupiterExecuteRequestSchema.parse(input);
    const pending = this.pending.get(request.orderId);
    if (!pending || pending.order.requestId !== request.requestId || pending.order.taker !== connectedWallet)
      throw new JupiterServiceError("INVALID_ORDER");
    if (this.now() >= Date.parse(pending.order.expiresAt)) throw new JupiterServiceError("STALE_ORDER");
    const transaction = VersionedTransaction.deserialize(Buffer.from(request.signedTransactionBase64, "base64"));
    const message = transaction.message.serialize();
    const signature = transaction.signatures[0];
    if (
      transaction.version !== 0 ||
      transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.signatures.length !== 1 ||
      !signature ||
      !Buffer.from(message).equals(Buffer.from(pending.message)) ||
      !nacl.sign.detached.verify(message, signature, new PublicKey(connectedWallet).toBytes())
    )
      throw new JupiterServiceError("INVALID_ORDER");
    await this.assertNetwork();
    await this.simulate(request.signedTransactionBase64);
    await onValidated?.(signature);
    this.pending.delete(request.orderId);
    try {
      const expected = bs58.encode(signature);
      const sent = await this.rpc.call("sendTransaction", [
        request.signedTransactionBase64,
        { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 },
      ]);
      if (sent !== expected) throw new JupiterServiceError("EXECUTION_UNKNOWN");
      // Bounded read-only confirmation. A timeout never replays the broadcast.
      for (let i = 0; i < 8; i++) {
        const result = await this.getExecution(expected, request.requestId, connectedWallet, pending.order.outputMint);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw new JupiterServiceError("EXECUTION_UNKNOWN");
    } catch {
      throw new JupiterServiceError("EXECUTION_UNKNOWN");
    }
  }
  /** Reconcile a recorded signature without relying on an in-memory order or sending again. */
  async getExecution(
    signature: string,
    requestId: string,
    taker: string,
    mint: string,
  ): Promise<JupiterExecutionResult | null> {
    await this.assertNetwork();
    const result = statusSchema.parse(
      await this.rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]),
    );
    const status = result.value[0];
    if (status?.err !== null && status?.err !== undefined) return { status: "failed", requestId, code: -1, signature };
    if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") return null;
    const tx = await this.rpc.getTransaction(signature);
    const buy = classifyPumpSwapBuy(tx, taker, signature);
    if (buy.status !== "buy" || buy.buy.mintAddress !== mint) throw new JupiterServiceError("EXECUTION_UNKNOWN");
    const quoteAccount = PublicKey.findProgramAddressSync(
      [
        new PublicKey(taker).toBuffer(),
        new PublicKey(SPL_TOKEN_PROGRAM_ID).toBuffer(),
        new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
      ],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )[0].toBase58();
    const details = z
      .object({
        meta: z.object({
          innerInstructions: z.array(
            z.object({
              instructions: z.array(
                z
                  .object({
                    programId: z.string(),
                    parsed: z
                      .object({
                        type: z.string(),
                        info: z
                          .object({
                            source: z.string().optional(),
                            amount: z.string().regex(/^\d+$/).optional(),
                            tokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }).optional(),
                          })
                          .passthrough(),
                      })
                      .optional(),
                  })
                  .passthrough(),
              ),
            }),
          ),
        }),
      })
      .parse(tx);
    let spent = 0n;
    for (const group of details.meta.innerInstructions)
      for (const instruction of group.instructions) {
        const parsed = instruction.parsed;
        if (
          instruction.programId !== SPL_TOKEN_PROGRAM_ID ||
          parsed?.info.source !== quoteAccount ||
          !["transfer", "transferChecked"].includes(parsed.type)
        )
          continue;
        const raw = parsed.info.amount ?? parsed.info.tokenAmount?.amount;
        if (!raw) throw new JupiterServiceError("EXECUTION_UNKNOWN");
        spent += BigInt(raw);
      }
    if (spent <= 0n) throw new JupiterServiceError("EXECUTION_UNKNOWN");
    return {
      status: "confirmed",
      requestId,
      code: 0,
      signature,
      totalInputAmountRaw: spent.toString(),
      inputAmountResultRaw: spent.toString(),
      totalOutputAmountRaw: buy.buy.baseAmountRaw,
      outputAmountResultRaw: buy.buy.baseAmountRaw,
    };
  }
  /** Watcher evidence has no fabricated USD price for test SOL. Manual trades use the reserve policy. */
  async collect(input: { mintAddress: string; poolAddress: string; slot: number }): Promise<TokenChecks> {
    const unknown = { status: "unknown", reason: "not-available-on-devnet" } as const;
    try {
      const checked = await this.checkPool(input.poolAddress, input.mintAddress, input.slot);
      const id = crypto.randomUUID();
      this.remember(id, { mint: input.mintAddress, address: input.poolAddress, slot: input.slot });
      const quote = await this.getPaperQuote({
        signalId: id,
        outputMint: input.mintAddress,
        inputAmountLamports: "50000000",
      });
      return {
        mint: { status: "fresh", value: checked.mint, fetchedAtMs: checked.at, expiresAtMs: checked.at + 60_000 },
        pool: { status: "unknown", reason: "devnet-liquidity-is-in-test-sol-not-usd" },
        quote: {
          status: "fresh",
          value: quote,
          fetchedAtMs: Date.parse(quote.fetchedAt),
          expiresAtMs: Date.parse(quote.expiresAt),
        },
        holders: unknown,
        creator: unknown,
        oracle: { source: "none", reason: "test-sol-has-no-usd-price" },
      };
    } catch {
      return {
        mint: unknown,
        pool: unknown,
        quote: unknown,
        holders: unknown,
        creator: unknown,
        oracle: { source: "none", reason: "devnet-checks-unavailable" },
      };
    }
  }
}
