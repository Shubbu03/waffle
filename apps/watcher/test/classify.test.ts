import { describe, expect, test } from "bun:test";
import { PUMP_SWAP_PROGRAM_ID, WRAPPED_SOL_MINT } from "@waffle/shared";
import { classifyPumpSwapBuy } from "../src/classify.ts";

const ROOT = new URL("../../../tests/fixtures/", import.meta.url);
const manifest = (await Bun.file(new URL("manifest.json", ROOT)).json()) as {
  fixtures: Array<{ file: string; signature: string; expected: string }>;
};

type Instruction = { programId: string; program?: string; data?: string; accounts?: string[] };
type TokenBalance = { mint: string; owner: string; uiTokenAmount: { amount: string } };
type FixtureTransaction = {
  meta: {
    err: unknown;
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
    innerInstructions?: unknown;
  };
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean }>;
      instructions: Instruction[];
    };
  };
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture field");
  return value;
}

const fixtures = new Map<string, FixtureTransaction>();
for (const entry of manifest.fixtures) {
  fixtures.set(entry.file, (await Bun.file(new URL(entry.file, ROOT)).json()) as FixtureTransaction);
}

function fixture(file: string): FixtureTransaction {
  return structuredClone(required(fixtures.get(file)));
}

function signature(file: string): string {
  return required(manifest.fixtures.find((entry) => entry.file === file)).signature;
}

function classify(file: string, override?: (transaction: FixtureTransaction) => void) {
  const transaction = fixture(file);
  override?.(transaction);
  const wallet = required(transaction.transaction.message.accountKeys.find((key) => key.signer)).pubkey;
  return classifyPumpSwapBuy(transaction, wallet, signature(file));
}

describe("PumpSwap classifier", () => {
  test("matches every real fixture and reports the observed buy", () => {
    expect(classify("pumpswap-buy.json")).toMatchObject({
      status: "buy",
      buy: {
        sourceProgramId: PUMP_SWAP_PROGRAM_ID,
        mintAddress: "8Vte25yt28L8BfLXm8DrzjSYEyaKX8yry6hRKRmX7FGd",
        baseAmountRaw: "392237471",
        quoteAmountLimitRaw: "1000000",
      },
    });
    expect(classify("pumpswap-sell.json")).toEqual({ status: "ignored", reason: "sell" });
    expect(classify("pumpswap-fail.json")).toEqual({ status: "ignored", reason: "failed-transaction" });
    expect(classify("transfer-sol.json")).toEqual({ status: "ignored", reason: "transfer" });
    expect(classify("unknown-raydium.json")).toEqual({ status: "ignored", reason: "unsupported-program" });
  });

  test("checks failure before parsing instruction data, and tolerates missing inner instructions", () => {
    expect(
      classify("pumpswap-buy.json", (tx) => {
        tx.meta.err = { InstructionError: [5, "Custom"] };
        tx.transaction.message.instructions = [];
      }),
    ).toEqual({ status: "ignored", reason: "failed-transaction" });
    expect(
      classify("pumpswap-buy.json", (tx) => {
        delete tx.meta.innerInstructions;
      }).status,
    ).toBe("buy");
  });

  test("requires watched wallet, direct buy discriminator, SOL pair, and output balance increase", () => {
    expect(
      classifyPumpSwapBuy(
        fixture("pumpswap-buy.json"),
        "11111111111111111111111111111111",
        signature("pumpswap-buy.json"),
      ),
    ).toEqual({
      status: "ignored",
      reason: "wrong-wallet",
    });
    expect(
      classify("pumpswap-buy.json", (tx) => {
        const ix = required(
          tx.transaction.message.instructions.find(
            (instruction) =>
              instruction.programId === PUMP_SWAP_PROGRAM_ID &&
              typeof instruction.data === "string" &&
              instruction.data.length > 20,
          ),
        );
        required(ix.accounts)[4] = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      }),
    ).toEqual({ status: "ignored", reason: "unsupported-pair" });
    expect(
      classify("pumpswap-buy.json", (tx) => {
        required(tx.meta.postTokenBalances.find((balance) => balance.mint !== WRAPPED_SOL_MINT)).uiTokenAmount.amount =
          "0";
      }),
    ).toEqual({ status: "ignored", reason: "no-base-increase" });
    expect(
      classify("pumpswap-buy.json", (tx) => {
        required(tx.meta.postTokenBalances.find((balance) => balance.mint !== WRAPPED_SOL_MINT)).owner =
          "11111111111111111111111111111111";
      }),
    ).toEqual({ status: "ignored", reason: "missing-balance-evidence" });
  });

  test("does not infer a new token balance without account-creation evidence", () => {
    expect(
      classify("pumpswap-buy.json", (tx) => {
        tx.transaction.message.instructions = tx.transaction.message.instructions.filter(
          (ix) => ix.program !== "spl-associated-token-account",
        );
      }),
    ).toEqual({ status: "ignored", reason: "missing-balance-evidence" });
  });

  test("skips multi-buy transactions rather than assigning the wrong mint", () => {
    expect(
      classify("pumpswap-buy.json", (tx) => {
        tx.transaction.message.instructions.push(required(tx.transaction.message.instructions[5]));
      }),
    ).toEqual({ status: "ignored", reason: "ambiguous-swap" });
  });
});
