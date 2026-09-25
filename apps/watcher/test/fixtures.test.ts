/** Fixture contract tests for issue #8: every manifest entry must parse and match its shape. */
import { describe, expect, test } from "bun:test";
import { PUMP_SWAP_PROGRAM_ID } from "@waffle/shared";

const ROOT = new URL("../../../tests/fixtures/", import.meta.url);
const WSOL = "So11111111111111111111111111111111111111112";

type FixtureEntry = { file: string; signature: string; slot: number; expected: string };
type Tx = {
  slot?: unknown;
  meta?: {
    err?: unknown;
    preTokenBalances?: Array<{ mint?: unknown }>;
    postTokenBalances?: Array<{ mint?: unknown }>;
    logMessages?: unknown;
  };
  transaction?: {
    signatures?: unknown;
    message?: {
      accountKeys?: Array<{ pubkey?: string }>;
      instructions?: Array<{ programId?: string; parsed?: { type?: unknown; info?: { lamports?: unknown } } }>;
    };
  };
};

const manifest = (await Bun.file(new URL("manifest.json", ROOT)).json()) as { fixtures: FixtureEntry[] };

function keysOf(tx: Tx): string[] {
  return (tx.transaction?.message?.accountKeys ?? []).map((k) => k.pubkey ?? "");
}

describe("fixture manifest", () => {
  test("declares exactly the five required shapes", () => {
    const kinds = manifest.fixtures.map((f) => f.expected).sort();
    expect(kinds).toEqual(["buy", "fail-skipped", "sell-skipped", "transfer-skipped", "unknown-skipped"]);
  });

  test("every entry has file, signature, slot", () => {
    for (const f of manifest.fixtures) {
      expect(f.file.endsWith(".json")).toBe(true);
      expect(f.signature.length).toBeGreaterThan(80);
      expect(Number.isInteger(f.slot) && f.slot > 0).toBe(true);
    }
  });
});

const bodies = new Map<string, Tx>();
for (const entry of manifest.fixtures) {
  bodies.set(entry.file, (await Bun.file(new URL(entry.file, ROOT)).json()) as Tx);
}

for (const entry of manifest.fixtures) {
  describe(entry.file, () => {
    const tx = bodies.get(entry.file) as Tx;

    test("slot matches manifest and first signature matches", () => {
      expect(tx.slot).toBe(entry.slot);
      const sigs = tx.transaction?.signatures;
      expect(Array.isArray(sigs) ? (sigs[0] as string) : "").toBe(entry.signature);
    });

    test("has no embedded secrets and stays under size cap", async () => {
      const raw = await Bun.file(new URL(entry.file, ROOT)).text();
      expect(raw.toLowerCase().includes("api-key")).toBe(false);
      expect(raw.length).toBeLessThan(200_000);
    });

    if (entry.expected === "buy" || entry.expected === "sell-skipped") {
      test("PumpSwap outer ix present, err null", () => {
        expect(tx.meta?.err).toBeNull();
        const outer = tx.transaction?.message?.instructions ?? [];
        expect(outer.some((ix) => ix.programId === PUMP_SWAP_PROGRAM_ID)).toBe(true);
      });
    }

    if (entry.expected === "fail-skipped") {
      test("meta.err is set", () => {
        expect(tx.meta?.err !== null && tx.meta?.err !== undefined).toBe(true);
      });
    }

    if (entry.expected === "unknown-skipped") {
      test("no PumpSwap anywhere", () => {
        expect(keysOf(tx).includes(PUMP_SWAP_PROGRAM_ID)).toBe(false);
        const outer = tx.transaction?.message?.instructions ?? [];
        expect(outer.some((ix) => ix.programId === PUMP_SWAP_PROGRAM_ID)).toBe(false);
      });
    }

    if (entry.expected === "transfer-skipped") {
      test("parsed System transfer, zero token legs", () => {
        const outer = tx.transaction?.message?.instructions ?? [];
        const transfers = outer.filter(
          (ix) =>
            ix.programId === "11111111111111111111111111111111" &&
            ix.parsed?.type === "transfer" &&
            typeof ix.parsed.info?.lamports === "number",
        );
        expect(transfers.length).toBeGreaterThan(0);
        expect((tx.meta?.preTokenBalances?.length ?? 0) + (tx.meta?.postTokenBalances?.length ?? 0)).toBe(0);
        expect(keysOf(tx).includes(PUMP_SWAP_PROGRAM_ID)).toBe(false);
      });
    }

    test("mints are real base58 (no mock placeholders)", () => {
      void WSOL;
      const mints = new Set<string>();
      for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
        if (typeof b.mint === "string") mints.add(b.mint);
      }
      for (const m of mints) expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)).toBe(true);
    });
  });
}
