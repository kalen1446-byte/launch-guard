import bs58 from "bs58";
import type { Connection } from "@solana/web3.js";
import { DBC_PROGRAM_ID, INIT_IX, TOKEN_2022, fetchConfig, mintInfo, rpc, wsUrl, type DecodedConfig } from "./solana.ts";
import { scanNewPools, scanBuckets, type NewPool } from "./poolscan.ts";
import { scoreConfig, riskLabel } from "./rules.ts";
import type { LaunchRecord, Store } from "./store.ts";

type Kind = LaunchRecord["kind"];

interface InitIx {
  kind: Kind;
  accounts: string[]; // resolved pubkeys in IDL order
}

// Account order shared by all three init instructions (see IDL):
// 0 config, 1 pool_authority, 2 creator, 3 base_mint, 4 quote_mint, 5 pool, ...; hook variant: 8 transfer_hook_program
const ACC = { config: 0, creator: 2, baseMint: 3, quoteMint: 4, pool: 5 };
const DBC = DBC_PROGRAM_ID.toBase58();

function matchKind(data: Uint8Array): Kind | null {
  const head = Buffer.from(data.subarray(0, 8));
  if (head.equals(INIT_IX.spl)) return "spl";
  if (head.equals(INIT_IX.token2022)) return "token2022";
  if (head.equals(INIT_IX.transferHook)) return "transferHook";
  return null;
}

/**
 * Transaction as returned by getTransaction with encoding "jsonParsed".
 * jsonParsed resolves every account (including address-lookup-table ones) to a pubkey string,
 * so this works for legacy, v0 and v1 transactions alike.
 */
interface ParsedIx { programId: string; accounts?: string[]; data?: string; parsed?: unknown }
interface RawTx {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; innerInstructions?: { instructions: ParsedIx[] }[] } | null;
  transaction: { message: { instructions: ParsedIx[] } };
}

export function findInitInstructions(tx: RawTx): InitIx[] {
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  const out: InitIx[] = [];
  for (const ix of all) {
    if (ix.programId !== DBC || !ix.data || !ix.accounts) continue;
    const kind = matchKind(bs58.decode(ix.data));
    if (kind) out.push({ kind, accounts: ix.accounts });
  }
  return out;
}

async function getTx(signature: string): Promise<RawTx | null> {
  return rpc<RawTx | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
}

const configCache = new Map<string, DecodedConfig>();

export async function processSignature(conn: Connection, store: Store, signature: string): Promise<LaunchRecord[]> {
  // The transaction can lag the log notification by a moment — retry briefly.
  let tx: RawTx | null = null;
  for (let i = 0; i < 6 && !tx; i++) {
    tx = await getTx(signature);
    if (!tx) await new Promise((r) => setTimeout(r, 700));
  }
  if (!tx || tx.meta?.err) return [];

  const records: LaunchRecord[] = [];
  for (const ix of findInitInstructions(tx)) {
    const pool = ix.accounts[ACC.pool];
    if (store.has(pool)) continue;
    const configAddr = ix.accounts[ACC.config];
    let decoded = configCache.get(configAddr);
    if (!decoded) {
      decoded = await fetchConfig(conn, configAddr);
      configCache.set(configAddr, decoded);
    }
    const { score, flags } = scoreConfig(decoded.config);
    const rec: LaunchRecord = {
      pool,
      baseMint: ix.accounts[ACC.baseMint],
      quoteMint: ix.accounts[ACC.quoteMint],
      creator: ix.accounts[ACC.creator],
      config: configAddr,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      detectedAt: Date.now(),
      kind: ix.kind,
      score,
      label: riskLabel(score),
      flags,
    };
    store.add(rec);
    records.push(rec);
  }
  return records;
}

/** Score a pool found by the pool scan (no transaction parsing needed). */
async function processPool(conn: Connection, store: Store, p: NewPool): Promise<LaunchRecord | null> {
  if (store.has(p.pool)) return null;
  let decoded = configCache.get(p.config);
  if (!decoded) {
    decoded = await fetchConfig(conn, p.config);
    configCache.set(p.config, decoded);
  }
  // The pool's oldest signature is its creation transaction.
  const sigs: { signature: string; slot: number; blockTime: number | null }[] = await rpc("getSignaturesForAddress", [p.pool, { limit: 100 }]);
  const created = sigs[sigs.length - 1];
  const mi = await mintInfo(conn, p.baseMint);
  const kind: LaunchRecord["kind"] = p.hookPool ? "transferHook" : mi.program === TOKEN_2022 ? "token2022" : "spl";
  const { score, flags } = scoreConfig(decoded.config);
  const rec: LaunchRecord = {
    pool: p.pool,
    baseMint: p.baseMint,
    quoteMint: decoded.quoteMint,
    creator: p.creator,
    config: p.config,
    signature: created?.signature ?? "",
    slot: created?.slot ?? 0,
    blockTime: created?.blockTime ?? null,
    detectedAt: Date.now(),
    kind,
    score,
    label: riskLabel(score),
    flags,
    name: mi.name,
  };
  store.add(rec);
  return rec;
}

/** Watch the DBC program over Solami (WebSocket logs, or polling as a fallback) and score every new launch. */
export function startWatcher(conn: Connection, store: Store, onLaunch: (r: LaunchRecord) => void) {
  const queue: string[] = [];
  let busy = false;
  // In polling mode every DBC transaction (mostly swaps) has to be opened to find launches. If the queue
  // grows faster than RPC_RPS allows, drop the oldest signatures so the feed never falls hours behind.
  const MAX_QUEUE = Number(process.env.WATCH_MAX_QUEUE ?? 200);
  let processed = 0;
  let dropped = 0;
  setInterval(() => {
    if (processed || dropped || queue.length) console.log(`[watcher] last minute: ${processed} tx checked, ${dropped} skipped, queue ${queue.length}`);
    processed = 0;
    dropped = 0;
  }, 60_000);

  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const sig = queue.shift()!;
      processed++;
      try {
        for (const rec of await processSignature(conn, store, sig)) onLaunch(rec);
      } catch (e) {
        console.error(`[watcher] ${sig.slice(0, 8)}… ${(e as Error).message}`);
      }
    }
    busy = false;
  };

  // Default without WebSocket: scan for newly created pools by activation point (see poolscan.ts).
  if (!wsUrl() && process.env.WATCH_MODE !== "signatures") {
    let running = false;
    let runs = 0;
    // Every 20th scan (~5 min), also sweep the last hour with wide buckets, so a pool missed by a
    // failed scan or a failed lookup is picked up on the next sweep instead of being lost.
    const backfill = async (): Promise<NewPool[]> => {
      const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
      const ts = Math.floor(Date.now() / 1000);
      const pools = await scanBuckets(
        [BigInt(ts) >> 16n, (BigInt(ts) >> 16n) - 1n, BigInt(slot) >> 16n, (BigInt(slot) >> 16n) - 1n],
        16,
      );
      const recent = pools.filter((p) => (p.activationPoint > 1e9 ? p.activationPoint >= ts - 3600 : p.activationPoint >= slot - 9000));
      const missing = recent.filter((p) => !store.has(p.pool));
      if (missing.length) console.log(`[watcher] backfill: ${missing.length} pool(s) from the last hour were not scored yet`);
      return missing;
    };
    const scan = async () => {
      if (running) return;
      running = true;
      try {
        const pools = await scanNewPools();
        if (++runs % 20 === 0) pools.push(...(await backfill().catch((e) => (console.error("[watcher] backfill", (e as Error).message), []))));
        for (const p of pools) {
          try {
            const rec = await processPool(conn, store, p);
            if (rec) onLaunch(rec);
          } catch (e) {
            console.error(`[watcher] pool ${p.pool.slice(0, 8)}… ${(e as Error).message}`);
          }
        }
      } catch (e) {
        console.error("[watcher] scan", (e as Error).message);
      } finally {
        running = false;
      }
    };
    void scan();
    const id = setInterval(scan, 15_000);
    console.log("[watcher] scanning for new DBC pools every 15s (getProgramAccountsV2, activation-point filter)");
    return () => clearInterval(id);
  }

  // Fallback (WATCH_MODE=signatures): poll recent program signatures and open each transaction.
  if (!wsUrl()) {
    let last: string | undefined;
    const poll = async () => {
      try {
        const sigs = await conn.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: 100, until: last });
        const first = last === undefined;
        if (sigs.length) last = sigs[0].signature;
        if (first) return; // start from "now"; history is covered by `npm run check`
        for (const s of sigs.reverse()) if (!s.err) queue.push(s.signature);
        if (queue.length > MAX_QUEUE) dropped += queue.splice(0, queue.length - MAX_QUEUE).length;
        void drain();
      } catch (e) {
        console.error("[watcher] poll", (e as Error).message);
      }
    };
    void poll();
    const id = setInterval(poll, 4000);
    console.log("[watcher] polling DBC program every 4s (no WebSocket URL set)");
    return () => clearInterval(id);
  }

  // WebSocket: only launches are fetched, because the log line tells us which instruction ran.
  const subId = conn.onLogs(
    DBC_PROGRAM_ID,
    (logs) => {
      if (logs.err) return;
      if (!logs.logs.some((l) => l.includes("Instruction: InitializeVirtualPool"))) return;
      queue.push(logs.signature);
      void drain();
    },
    "confirmed",
  );
  console.log(`[watcher] listening for new DBC launches (subscription ${subId})`);
  return () => conn.removeOnLogsListener(subId);
}
