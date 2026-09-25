import { z } from "zod";
import { classifyPumpSwapBuy } from "./classify.ts";

const ROOT = new URL("../../../tests/fixtures/", import.meta.url);
const manifestSchema = z.object({
  fixtures: z.array(
    z.object({
      file: z.string().regex(/^[a-z0-9-]+\.json$/),
      signature: z.string().min(1),
      expected: z.enum(["buy", "sell-skipped", "fail-skipped", "transfer-skipped", "unknown-skipped"]),
    }),
  ),
});

const manifest = manifestSchema.parse(await Bun.file(new URL("manifest.json", ROOT)).json());
let mismatches = 0;
for (const entry of manifest.fixtures) {
  const transaction: unknown = await Bun.file(new URL(entry.file, ROOT)).json();
  const keys = (
    transaction as { transaction?: { message?: { accountKeys?: Array<{ pubkey?: string; signer?: boolean }> } } }
  ).transaction?.message?.accountKeys;
  const wallet = keys?.find((key) => key.signer)?.pubkey ?? "";
  const result = classifyPumpSwapBuy(transaction, wallet, entry.signature);
  const actual = result.status === "buy" ? "buy" : result.reason;
  const expected = {
    buy: "buy",
    "sell-skipped": "sell",
    "fail-skipped": "failed-transaction",
    "transfer-skipped": "transfer",
    "unknown-skipped": "unsupported-program",
  }[entry.expected];
  const pass = actual === expected;
  if (!pass) mismatches++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${entry.file}: ${actual}${result.status === "buy" ? ` ${result.buy.mintAddress}` : ""}`,
  );
}
console.log(`${manifest.fixtures.length - mismatches}/${manifest.fixtures.length} fixtures matched`);
if (mismatches > 0) process.exitCode = 1;
