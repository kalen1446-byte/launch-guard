/**
 * On-demand check for any DBC token: paste a token mint or a DBC pool address, get the risk score.
 * Used by GET /api/check/:address and the dashboard search box.
 *
 * Mint → pool: PoolState stores base_mint at a fixed offset (8 discriminator + 64 volatility tracker
 * + 32 config + 32 creator = 136, see state/virtual_pool.rs), so one filtered getProgramAccountsV2
 * call finds the pool. The pool's config field then gives the config we score.
 */
import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  rpc, fetchConfig, mintInfo, DBC_PROGRAM_ID, DISC, TOKEN_2022,
  POOL_CONFIG_OFFSET, POOL_CREATOR_OFFSET, POOL_BASE_MINT_OFFSET,
} from "./solana.ts";
import { scoreConfig, riskLabel } from "./rules.ts";
import type { LaunchRecord, Store } from "./store.ts";

export type CheckResult =
  | { ok: true; source: "watcher" | "lookup"; record: LaunchRecord }
  | { ok: false; status: number; error: string };

const cache = new Map<string, { at: number; result: CheckResult }>();
const CACHE_MS = 5 * 60 * 1000;

export function isAddress(s: string) {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Pool fields we need: config, creator, base mint (slice 72..168 of PoolState). */
function poolFields(data: Buffer, offsetInData = 0) {
  const at = (o: number) => new PublicKey(data.subarray(o - offsetInData, o - offsetInData + 32)).toBase58();
  return { config: at(POOL_CONFIG_OFFSET), creator: at(POOL_CREATOR_OFFSET), baseMint: at(POOL_BASE_MINT_OFFSET) };
}

async function findPoolByMint(mint: string) {
  const slice = { offset: POOL_CONFIG_OFFSET, length: POOL_BASE_MINT_OFFSET + 32 - POOL_CONFIG_OFFSET };
  for (const [d, kind] of [[DISC.VirtualPool, "pool"], [DISC.TransferHookPool, "transferHook"]] as const) {
    const res: any = await rpc("getProgramAccountsV2", [
      DBC_PROGRAM_ID.toBase58(),
      {
        encoding: "base64",
        commitment: "confirmed",
        limit: 5,
        dataSlice: slice,
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(d) } }, { memcmp: { offset: POOL_BASE_MINT_OFFSET, bytes: mint } }],
      },
    ]);
    const a = (res?.accounts ?? res?.value?.accounts ?? [])[0];
    if (a) return { pool: a.pubkey as string, hookPool: kind === "transferHook", ...poolFields(Buffer.from(a.account.data[0], "base64"), POOL_CONFIG_OFFSET) };
  }
  return null;
}

export async function checkAddress(conn: Connection, store: Store, address: string): Promise<CheckResult> {
  if (!isAddress(address)) return { ok: false, status: 400, error: "Not a valid Solana address" };

  const known = store.find(address);
  if (known) {
    // Records saved before names were added: look the name up once and keep it in memory.
    if (!known.name) known.name = (await mintInfo(conn, known.baseMint)).name;
    return { ok: true, source: "watcher", record: known };
  }

  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const result = await lookup(conn, address);
  cache.set(address, { at: Date.now(), result });
  return result;
}

async function lookup(conn: Connection, address: string): Promise<CheckResult> {
  const info = await conn.getAccountInfo(new PublicKey(address));
  if (!info) return { ok: false, status: 404, error: "Account not found on Solana mainnet" };

  let found: { pool: string; hookPool: boolean; config: string; creator: string; baseMint: string } | null = null;
  const d8 = info.data.subarray(0, 8);
  if (info.owner.equals(DBC_PROGRAM_ID) && (d8.equals(DISC.VirtualPool) || d8.equals(DISC.TransferHookPool))) {
    found = { pool: address, hookPool: d8.equals(DISC.TransferHookPool), ...poolFields(info.data) };
  } else {
    found = await findPoolByMint(address);
  }
  if (!found) return { ok: false, status: 404, error: "No Meteora DBC pool found for this address. Launch Guard only covers tokens launched on Meteora DBC." };

  const decoded = await fetchConfig(conn, found.config);
  const { score, flags } = scoreConfig(decoded.config);
  const mi = await mintInfo(conn, found.baseMint);
  // Oldest of the pool's latest signatures; exact for young pools, an upper bound for very active old ones.
  const sigs: { signature: string; slot: number; blockTime: number | null }[] = await rpc("getSignaturesForAddress", [found.pool, { limit: 1000 }]);
  const created = sigs.length < 1000 ? sigs[sigs.length - 1] : undefined;
  const kind: LaunchRecord["kind"] = found.hookPool ? "transferHook" : mi.program === TOKEN_2022 ? "token2022" : "spl";

  return {
    ok: true,
    source: "lookup",
    record: {
      pool: found.pool,
      baseMint: found.baseMint,
      quoteMint: decoded.quoteMint,
      creator: found.creator,
      config: found.config,
      signature: created?.signature ?? "",
      slot: created?.slot ?? 0,
      blockTime: created?.blockTime ?? null,
      detectedAt: Date.now(),
      kind,
      score,
      label: riskLabel(score),
      flags,
      name: mi.name,
    },
  };
}
