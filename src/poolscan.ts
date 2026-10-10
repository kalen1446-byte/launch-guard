/**
 * Launch feed without opening transactions.
 *
 * Every DBC pool stores activation_point (u64) at account offset 296 (8 discriminator + 288, see
 * PoolState in state/virtual_pool.rs). A pool's activation point is the slot or unix time when it
 * was created (unless the config schedules it later). A memcmp filter on the top 7 bytes of that
 * little-endian u64 selects every pool whose activation point falls in one 256-unit bucket
 * (256 s, or 256 slots ≈ 100 s). Querying the current and previous bucket returns only pools
 * created in the last few minutes, so swaps never have to be fetched.
 */
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { rpc, DBC_PROGRAM_ID, DISC, POOL_CONFIG_OFFSET, POOL_BASE_MINT_OFFSET } from "./solana.ts";

export const ACTIVATION_OFFSET = 296;

export interface NewPool {
  pool: string;
  config: string;
  creator: string;
  baseMint: string;
  hookPool: boolean;
  activationPoint: number;
}

/**
 * memcmp bytes (base58) that match every u64 in one bucket: [bucket << bits, (bucket + 1) << bits).
 * bits = 8 gives 256-unit buckets (the live feed); bits = 16 gives 65,536-unit buckets (about 18 h of
 * unix time or 7 h of slots), which the capture check uses to cover hours in a few queries.
 */
function bucketBytes(bucket: bigint, bits: 8 | 16) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(bucket << BigInt(bits));
  return bs58.encode(b.subarray(bits / 8));
}

export async function scanNewPools(): Promise<NewPool[]> {
  const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
  const ts = BigInt(Math.floor(Date.now() / 1000));
  return scanBuckets([ts >> 8n, (ts >> 8n) - 1n, BigInt(slot) >> 8n, (BigInt(slot) >> 8n) - 1n]);
}

/** Every DBC pool whose activation point falls in one of the given buckets. */
export async function scanBuckets(buckets: bigint[], bits: 8 | 16 = 8): Promise<NewPool[]> {
  const slice = { offset: POOL_CONFIG_OFFSET, length: ACTIVATION_OFFSET + 8 - POOL_CONFIG_OFFSET };
  const out = new Map<string, NewPool>();
  for (const [disc, hookPool] of [[DISC.VirtualPool, false], [DISC.TransferHookPool, true]] as const) {
    for (const bucket of buckets) {
      let paginationKey: string | null = null;
      do {
        const opts: Record<string, unknown> = {
          encoding: "base64",
          commitment: "confirmed",
          limit: 1000,
          dataSlice: slice,
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }, { memcmp: { offset: ACTIVATION_OFFSET + bits / 8, bytes: bucketBytes(bucket, bits) } }],
        };
        if (paginationKey) opts.paginationKey = paginationKey;
        const res: any = await rpc("getProgramAccountsV2", [DBC_PROGRAM_ID.toBase58(), opts]);
        for (const a of res?.accounts ?? res?.value?.accounts ?? []) {
          const d = Buffer.from(a.account.data[0], "base64");
          const at = (o: number) => new PublicKey(d.subarray(o - POOL_CONFIG_OFFSET, o - POOL_CONFIG_OFFSET + 32)).toBase58();
          out.set(a.pubkey, {
            pool: a.pubkey,
            config: at(POOL_CONFIG_OFFSET),
            creator: at(POOL_CONFIG_OFFSET + 32),
            baseMint: at(POOL_BASE_MINT_OFFSET),
            hookPool,
            activationPoint: Number(d.readBigUInt64LE(ACTIVATION_OFFSET - POOL_CONFIG_OFFSET)),
          });
        }
        paginationKey = res?.paginationKey ?? res?.value?.paginationKey ?? null;
      } while (paginationKey);
    }
  }
  return [...out.values()];
}

// `npm run poolscan`: print what one scan finds, to check the feed before relying on it.
if (process.argv[1]?.endsWith("poolscan.ts")) {
  const t = Date.now();
  const pools = await scanNewPools();
  console.log(`found ${pools.length} pools created in the last few minutes (${Date.now() - t} ms)`);
  for (const p of pools.slice(0, 15)) console.log(`  pool ${p.pool.slice(0, 8)}…  mint ${p.baseMint}  activation ${p.activationPoint}${p.hookPool ? "  (hook)" : ""}`);
  process.exit(0);
}
