import {
  PUMP_SWAP_PROGRAM_ID,
  parseRawAmount,
  rawAmountSchema,
  SPL_TOKEN_PROGRAM_ID,
  solanaAddressSchema,
  TOKEN_2022_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "@waffle/shared";

// PumpSwap's published pump_amm IDL: buy, buy_exact_quote_in, and sell.
const BUY = "66063d1201daebea";
const BUY_EXACT_QUOTE_IN = "c62e1552b4d9e870";
const SELL = "33e685a4017f83ad";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type PumpSwapBuy = {
  wallet: string;
  signature: string;
  slot: number;
  sourceProgramId: typeof PUMP_SWAP_PROGRAM_ID;
  poolAddress: string;
  mintAddress: string;
  baseAmountRaw: string;
  /** Instruction limit, not an observed fill or fee-inclusive spend. */
  quoteAmountLimitRaw: string;
};

export type ClassificationSkipReason =
  | "failed-transaction"
  | "invalid-transaction"
  | "unsupported-program"
  | "transfer"
  | "sell"
  | "unsupported-instruction"
  | "wrong-wallet"
  | "unsupported-pair"
  | "missing-balance-evidence"
  | "no-base-increase"
  | "ambiguous-swap";

export type PumpSwapClassification =
  | { status: "buy"; buy: PumpSwapBuy }
  | { status: "ignored"; reason: ClassificationSkipReason };

type JsonRecord = Record<string, unknown>;
const ignored = (reason: ClassificationSkipReason): PumpSwapClassification => ({ status: "ignored", reason });

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function address(value: unknown): value is string {
  return typeof value === "string" && solanaAddressSchema.safeParse(value).success;
}

function decodeBase58(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  return Uint8Array.from([...Array<number>(leadingZeroes).fill(0), ...bytes]);
}

function parsedAmount(entry: unknown, mint: string, owner: string, programId: string): bigint | null {
  const balance = record(entry);
  const token = record(balance?.uiTokenAmount);
  if (
    balance?.mint !== mint ||
    balance.owner !== owner ||
    balance.programId !== programId ||
    typeof token?.amount !== "string" ||
    !rawAmountSchema.safeParse(token.amount).success
  )
    return null;
  return parseRawAmount(token.amount);
}

function balanceFor(entries: unknown[], accountIndex: number): unknown | null {
  const matches = entries.filter((entry) => record(entry)?.accountIndex === accountIndex);
  return matches.length === 1 ? matches[0] : null;
}

/** Only a direct, successful PumpSwap buy with wallet-owned output balance evidence is eligible. */
export function classifyPumpSwapBuy(transaction: unknown, wallet: string, signature: string): PumpSwapClassification {
  const tx = record(transaction);
  const meta = record(tx?.meta);
  if (!meta || !Object.hasOwn(meta, "err")) return ignored("invalid-transaction");
  if (meta.err !== null) return ignored("failed-transaction");

  const body = record(tx?.transaction);
  const message = record(body?.message);
  const slot = tx?.slot;
  const signatures = body?.signatures;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;
  if (
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !Array.isArray(signatures) ||
    signatures[0] !== signature ||
    !Array.isArray(accountKeys) ||
    !Array.isArray(instructions) ||
    !Array.isArray(meta.preTokenBalances) ||
    !Array.isArray(meta.postTokenBalances)
  ) {
    return ignored("invalid-transaction");
  }
  const keys = accountKeys.map(record);
  if (!keys.some((key) => key?.pubkey === wallet && key.signer === true)) return ignored("wrong-wallet");

  const pumpInstructions = instructions.map(record).filter((ix) => ix?.programId === PUMP_SWAP_PROGRAM_ID);
  if (pumpInstructions.length === 0) {
    const transferOnly =
      instructions.length > 0 &&
      instructions
        .map(record)
        .every((ix) => ix?.programId === SYSTEM_PROGRAM_ID && record(ix.parsed)?.type === "transfer");
    return ignored(transferOnly ? "transfer" : "unsupported-program");
  }

  const buyInstructions: Array<{ accounts: unknown[]; bytes: Uint8Array; kind: "buy" | "exact" }> = [];
  let sawSell = false;
  for (const ix of pumpInstructions) {
    const bytes = decodeBase58(ix?.data);
    const discriminator = bytes && bytes.length >= 8 ? Buffer.from(bytes.subarray(0, 8)).toString("hex") : "";
    if (discriminator === SELL) {
      sawSell = true;
      continue;
    }
    if (discriminator !== BUY && discriminator !== BUY_EXACT_QUOTE_IN) continue;
    if (!Array.isArray(ix?.accounts) || !bytes || bytes.length < 24) return ignored("unsupported-instruction");
    buyInstructions.push({
      accounts: ix.accounts,
      bytes,
      kind: discriminator === BUY ? "buy" : "exact",
    });
  }
  if (buyInstructions.length === 0) return ignored(sawSell ? "sell" : "unsupported-instruction");
  if (buyInstructions.length !== 1 || sawSell) return ignored("ambiguous-swap");

  const instruction = buyInstructions[0];
  if (instruction === undefined) return ignored("invalid-transaction");
  const accounts = instruction.accounts;
  if (accounts[1] !== wallet) return ignored("wrong-wallet");
  const [pool, mint, quoteMint, baseAccount, baseTokenProgram, quoteTokenProgram] = [
    accounts[0],
    accounts[3],
    accounts[4],
    accounts[5],
    accounts[11],
    accounts[12],
  ];
  if (
    !address(pool) ||
    !address(mint) ||
    !address(baseAccount) ||
    mint === WRAPPED_SOL_MINT ||
    quoteMint !== WRAPPED_SOL_MINT ||
    (baseTokenProgram !== SPL_TOKEN_PROGRAM_ID && baseTokenProgram !== TOKEN_2022_PROGRAM_ID) ||
    quoteTokenProgram !== SPL_TOKEN_PROGRAM_ID
  )
    return ignored("unsupported-pair");

  const accountIndex = keys.findIndex((key) => key?.pubkey === baseAccount);
  if (accountIndex < 0) return ignored("missing-balance-evidence");
  const postEntry = balanceFor(meta.postTokenBalances, accountIndex);
  const postAmount = parsedAmount(postEntry, mint, wallet, baseTokenProgram);
  if (postAmount === null) return ignored("missing-balance-evidence");

  const preEntry = balanceFor(meta.preTokenBalances, accountIndex);
  let preAmount: bigint | null = preEntry === null ? null : parsedAmount(preEntry, mint, wallet, baseTokenProgram);
  if (preAmount === null && preEntry === null) {
    const createdHere = instructions.map(record).some((ix) => {
      const parsed = record(ix?.parsed);
      const info = record(parsed?.info);
      return (
        ix?.programId === ASSOCIATED_TOKEN_PROGRAM_ID &&
        (parsed?.type === "create" || parsed?.type === "createIdempotent") &&
        info?.account === baseAccount &&
        info.wallet === wallet &&
        info.mint === mint
      );
    });
    if (createdHere) preAmount = 0n;
  }
  if (preAmount === null) return ignored("missing-balance-evidence");
  if (postAmount <= preAmount) return ignored("no-base-increase");

  const args = Buffer.from(instruction.bytes);
  const firstAmount = args.readBigUInt64LE(8);
  const secondAmount = args.readBigUInt64LE(16);
  if (firstAmount === 0n || secondAmount === 0n) return ignored("unsupported-instruction");
  return {
    status: "buy",
    buy: {
      wallet,
      signature,
      slot,
      sourceProgramId: PUMP_SWAP_PROGRAM_ID,
      poolAddress: pool,
      mintAddress: mint,
      baseAmountRaw: (postAmount - preAmount).toString(),
      quoteAmountLimitRaw: (instruction.kind === "buy" ? secondAmount : firstAmount).toString(),
    },
  };
}
