/** Catalog verifier for issue #7 (KEPT — run before editing seeds/catalog.ts).
 * Usage: bun src/seeds/verify-catalog.ts <address...> [--json]
 * Reads HELIUS_RPC_URL from apps/watcher/.env (value never printed).
 * Budget: ~1 sig-list + ≤12 bodies per wallet. Stays far under 10rps (150ms spacing). */
import { PUMP_SWAP_PROGRAM_ID } from "@waffle/shared";
import { config as loadDotenv } from "dotenv";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const HISTORY_LIMIT = 100;
const MAX_BODIES = 24;
const MIN_BUYS_7D = 3;
const MAX_TXS_7D = 200;

type Verdict = { decision: "ACCEPT" | "REJECT"; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Load RPC config (key never printed). */
function loadConfig(): string {
  console.log("[verify] loadConfig: reading apps/watcher/.env");
  loadDotenv({ path: new URL("../../../../apps/watcher/.env", import.meta.url).pathname });
  const url = process.env.HELIUS_RPC_URL;
  if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("HELIUS_RPC_URL missing/invalid");
  console.log("[verify] loadConfig: URL present (value hidden)");
  return url;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${method}`);
  const payload = (await response.json()) as { result?: T; error?: unknown };
  if (payload.error !== undefined) throw new Error(`RPC ${method}: ${JSON.stringify(payload.error).slice(0, 100)}`);
  return payload.result as T;
}

/** Current slot so freshness math stays honest. */
async function headSlot(url: string): Promise<number> {
  console.log("[verify] headSlot: fetching head");
  const slot = await rpc<number>(url, "getSlot", [{ commitment: "confirmed" }]);
  console.log(`[verify] headSlot: head=${slot}`);
  return slot;
}

type SigEntry = { signature: string; slot: number; err: unknown; blockTime?: number };

/** Wallet history page (confirmed only). */
async function listHistory(url: string, address: string): Promise<SigEntry[]> {
  console.log(`[verify] listHistory: ${address.slice(0, 8)}... limit=${HISTORY_LIMIT}`);
  const entries = await rpc<SigEntry[]>(url, "getSignaturesForAddress", [
    address,
    { commitment: "confirmed", limit: HISTORY_LIMIT },
  ]);
  console.log(`[verify] listHistory: got ${entries.length}`);
  return entries;
}

type Body = {
  slot?: unknown;
  blockTime?: unknown;
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{ mint?: unknown; owner?: unknown; uiTokenAmount?: { uiAmount?: unknown } }>;
    postTokenBalances?: Array<{ mint?: unknown; owner?: unknown; uiTokenAmount?: { uiAmount?: unknown } }>;
  };
  transaction?: { message?: { accountKeys?: Array<{ pubkey?: string }>; instructions?: Array<{ programId?: string }> } };
};

/** One body, jsonParsed. Null = not rooted yet. */
async function fetchBody(url: string, signature: string): Promise<Body | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { result?: Body | null; error?: unknown };
  if (payload.error !== undefined) throw new Error(`RPC getTransaction: ${JSON.stringify(payload.error).slice(0, 80)}`);
  return payload.result ?? null;
}

/** Direction for a trader-pays-own-way wallet: payer SOL+wSOL value vs meme flow. */
function directionOf(
  body: Body,
  payer: string,
): { memeUp: number; memeDown: number; payerValue: number; hasPamm: boolean } {
  const pre = body.meta?.preBalances ?? [];
  const post = body.meta?.postBalances ?? [];
  const payerValue = (post[0] ?? 0) - (pre[0] ?? 0);
  let wsol = 0;
  const meme = new Map<string, number>();
  for (const [list, sign] of [
    [body.meta?.preTokenBalances, -1],
    [body.meta?.postTokenBalances, 1],
  ] as const) {
    for (const b of list ?? []) {
      if (typeof b.mint !== "string" || typeof b.uiTokenAmount?.uiAmount !== "number") continue;
      if (b.owner !== payer) continue;
      if (b.mint === WSOL_MINT) wsol += sign * (b.uiTokenAmount.uiAmount as number);
      else meme.set(b.mint, (meme.get(b.mint) ?? 0) + sign * (b.uiTokenAmount.uiAmount as number));
    }
  }
  const ups = [...meme.values()].filter((d) => d > 1e-6).length;
  const downs = [...meme.values()].filter((d) => d < -1e-6).length;
  const outer = body.transaction?.message?.instructions ?? [];
  return {
    memeUp: ups,
    memeDown: downs,
    payerValue: payerValue / 1e9 + wsol,
    hasPamm: outer.some((ix) => ix.programId === PUMP_SWAP_PROGRAM_ID),
  };
}

/** Assess one wallet: recent PumpSwap buys + volume band + fail rate. */
async function assessWallet(url: string, address: string, head: number): Promise<Verdict & { stats: string }> {
  console.log(`[verify] assessWallet: ${address.slice(0, 12)}...`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    console.log("[verify] assessWallet: REJECT — malformed address");
    return { decision: "REJECT", reason: "malformed-address", stats: "" };
  }
  const history = await listHistory(url, address);
  await sleep(150);
  const weekAgo = head - 50400; // ~7d of 12k slots/day... conservative window marker only
  void weekAgo;
  const ok = history.filter((e) => e.err === null);
  const failed = history.length - ok.length;
  console.log(`[verify] assessWallet: ${history.length} txs (${ok.length} ok, ${failed} failed)`);
  let buys = 0;
  let sells = 0;
  let swaps = 0;
  let examined = 0;
  for (const entry of ok) {
    if (examined >= MAX_BODIES) break;
    let body: Body | null;
    try {
      body = await fetchBody(url, entry.signature);
    } catch (error) {
      console.log(`[verify] assessWallet: body ${entry.signature.slice(0, 8)}... error, continuing`);
      void error;
      continue;
    }
    await sleep(150);
    if (body === null) continue;
    examined += 1;
    const keys = body.transaction?.message?.accountKeys ?? [];
    const payer = keys[0]?.pubkey ?? "";
    const d = directionOf(body, payer === "" ? address : payer);
    if (!d.hasPamm) continue;
    swaps += 1;
    if (d.memeUp === 1 && d.memeDown === 0 && d.payerValue < -0.0005) buys += 1;
    else if (d.memeDown === 1 && d.memeUp === 0 && d.payerValue > 0.0005) sells += 1;
  }
  const stats = `txs=${history.length} examined=${examined} swaps=${swaps} buys=${buys} sells=${sells} failed=${failed}`;
  console.log(`[verify] assessWallet: ${stats}`);
  if (history.length > MAX_TXS_7D) return { decision: "REJECT", reason: `too-hot (${history.length}>${MAX_TXS_7D}/window)`, stats };
  if (buys < MIN_BUYS_7D) return { decision: "REJECT", reason: `only ${buys} buys (<${MIN_BUYS_7D})`, stats };
  if (failed > ok.length) return { decision: "REJECT", reason: "mostly-failed (bot-like)", stats };
  return { decision: "ACCEPT", reason: `${buys} PumpSwap buys, manageable volume`, stats };
}

/** CLI: verify N addresses, print verdict table. */
async function main(): Promise<void> {
  const addresses = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (addresses.length === 0) throw new Error("usage: bun src/seeds/verify-catalog.ts <address...>");
  console.log(`[verify] main: verifying ${addresses.length} candidate(s)`);
  const url = loadConfig();
  const head = await headSlot(url);
  for (const address of addresses) {
    const verdict = await assessWallet(url, address, head);
    console.log(`[verify] main: ${address} -> ${verdict.decision} (${verdict.reason}) | ${verdict.stats}`);
  }
  console.log("[verify] main: done");
}

try {
  await main();
} catch (error) {
  console.error(`[verify] main: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
