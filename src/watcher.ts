import bs58 from "bs58";
import type { Connection } from "@solana/web3.js";
import { DBC_PROGRAM_ID, INIT_IX, fetchConfig, rpc, wsUrl, type DecodedConfig } from "./solana.ts";
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

/** Watch the DBC program over Solami (WebSocket logs, or polling as a fallback) and score every new launch. */
export function startWatcher(conn: Connection, store: Store, onLaunch: (r: LaunchRecord) => void) {
  const queue: string[] = [];
  let busy = false;

  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const sig = queue.shift()!;
      try {
        for (const rec of await processSignature(conn, store, sig)) onLaunch(rec);
      } catch (e) {
        console.error(`[watcher] ${sig.slice(0, 8)}… ${(e as Error).message}`);
      }
    }
    busy = false;
  };

  // No WebSocket configured → poll recent program signatures instead.
  if (!wsUrl()) {
    let last: string | undefined;
    const poll = async () => {
      try {
        const sigs = await conn.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: 100, until: last });
        const first = last === undefined;
        if (sigs.length) last = sigs[0].signature;
        if (first) return; // start from "now"; history is covered by `npm run check`
        for (const s of sigs.reverse()) if (!s.err) queue.push(s.signature);
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
