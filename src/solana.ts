import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import idlJson from "./dbc-idl.json" with { type: "json" };
import type { DbcConfig } from "./rules.ts";

export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const WSOL = "So11111111111111111111111111111111111111112";

const idl = idlJson as unknown as Idl;
export const coder = new BorshAccountsCoder(idl);

// Account discriminators (first 8 bytes) from the IDL.
const disc = (name: string) => Buffer.from((idl.accounts ?? []).find((a) => a.name === name)!.discriminator);
export const DISC = {
  PoolConfig: disc("PoolConfig"),
  ConfigWithTransferHook: disc("ConfigWithTransferHook"),
  VirtualPool: disc("VirtualPool"),
  TransferHookPool: disc("TransferHookPool"),
};

// Instruction discriminators for pool creation.
const ixDisc = (name: string) => Buffer.from(idl.instructions.find((i) => i.name === name)!.discriminator);
export const INIT_IX = {
  spl: ixDisc("initialize_virtual_pool_with_spl_token"),
  token2022: ixDisc("initialize_virtual_pool_with_token2022"),
  transferHook: ixDisc("initialize_virtual_pool_with_token2022_transfer_hook"),
};

// Byte offset of PoolState.config inside a VirtualPool account:
// 8 (discriminator) + 64 (VolatilityTracker) — see state/virtual_pool.rs.
export const POOL_CONFIG_OFFSET = 72;
// PoolState continues with creator (32 bytes) and base_mint (32 bytes).
export const POOL_CREATOR_OFFSET = 104;
export const POOL_BASE_MINT_OFFSET = 136;
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// ---------- rate limiting ----------
// Every HTTP RPC call goes through one queue so we stay under the plan's requests-per-second.
const RPS = Math.max(1, Number(process.env.RPC_RPS ?? 8));
let nextSlot = 0;
export async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1000 / RPS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

export function wsUrl(): string | undefined {
  if (process.env.DEV_RPC_URL) return process.env.DEV_WS_URL || undefined;
  return process.env.SOLAMI_WS_URL || undefined;
}

let warned = false;
export function rpcUrl(): string {
  // DEV_RPC_URL lets you keep developing if Solami is unreachable from your network.
  // Leave it empty for demos/submission: Solami is the data path.
  const dev = process.env.DEV_RPC_URL;
  if (dev) {
    if (!warned) {
      console.warn(`⚠️  Using DEV_RPC_URL (${new URL(dev).host}) instead of Solami. Clear it in .env before recording the demo.`);
      warned = true;
    }
    return dev;
  }
  const rpc = process.env.SOLAMI_RPC_URL;
  if (!rpc) throw new Error("SOLAMI_RPC_URL is missing — put your key in .env and run `npm run probe`.");
  return rpc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with throttling and retries. Connection errors (timeouts, resets) are retried because some
 * of the provider's edge locations can be unreachable from a given network; the next attempt usually
 * lands on a reachable one. 429s back off exponentially.
 */
export async function robustFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    try {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 || res.status >= 502) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function makeConnection(): Connection {
  return new Connection(rpcUrl(), {
    commitment: "confirmed",
    wsEndpoint: wsUrl(),
    disableRetryOnRateLimit: true, // robustFetch handles retries
    fetch: robustFetch as typeof fetch,
  });
}

/** Raw JSON-RPC call through robustFetch. */
export async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const res = await robustFetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: any = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

// ---------- decoding ----------

// Accept both snake_case and camelCase keys, whatever the coder returns.
function get(o: any, snake: string): any {
  if (o == null) return undefined;
  if (snake in o) return o[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return o[camel];
}
const big = (v: any): bigint => (v == null ? 0n : BigInt(v.toString()));
const num = (v: any): number => (v == null ? 0 : Number(v.toString()));

const decimalsCache = new Map<string, number>([[WSOL, 9]]);
export async function mintDecimals(conn: Connection, mint: string): Promise<number> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const d = (info.value?.data as any)?.parsed?.info?.decimals ?? 9;
  decimalsCache.set(mint, d);
  return d;
}

export interface DecodedConfig {
  address: string;
  quoteMint: string;
  config: DbcConfig;
  raw: any;
}

/** Decode a PoolConfig or ConfigWithTransferHook account into the shape the rules engine scores. */
export function decodeConfigAccount(address: string, data: Buffer, quoteDecimals = 9): DecodedConfig {
  let raw: any;
  let hook: string | null = null;
  const d8 = data.subarray(0, 8);
  if (d8.equals(DISC.ConfigWithTransferHook)) {
    const wrapped = coder.decode("ConfigWithTransferHook", data);
    raw = get(wrapped, "config");
    hook = get(wrapped, "transfer_hook_program")?.toBase58?.() ?? null;
  } else if (d8.equals(DISC.PoolConfig)) {
    raw = coder.decode("PoolConfig", data);
  } else {
    throw new Error(`Account ${address} is not a DBC config`);
  }

  const fees = get(get(raw, "pool_fees"), "base_fee");
  const lv = get(raw, "locked_vesting_config");
  const cv = get(raw, "creator_liquidity_vesting_info");
  const pv = get(raw, "partner_liquidity_vesting_info");
  const quoteMint: string = get(raw, "quote_mint").toBase58();

  const config: DbcConfig = {
    tokenUpdateAuthority: num(get(raw, "token_update_authority")),
    tokenType: num(get(raw, "token_type")),
    transferHookProgram: hook,
    activationType: num(get(raw, "activation_type")),
    creatorLiquidityPercentage: num(get(raw, "creator_liquidity_percentage")),
    partnerLiquidityPercentage: num(get(raw, "partner_liquidity_percentage")),
    creatorPermanentLockedLiquidityPercentage: num(get(raw, "creator_permanent_locked_liquidity_percentage")),
    partnerPermanentLockedLiquidityPercentage: num(get(raw, "partner_permanent_locked_liquidity_percentage")),
    creatorLiquidityVestingInfo: cv ? { isInitialized: num(get(cv, "is_initialized")), vestingPercentage: num(get(cv, "vesting_percentage")) } : undefined,
    partnerLiquidityVestingInfo: pv ? { isInitialized: num(get(pv, "is_initialized")), vestingPercentage: num(get(pv, "vesting_percentage")) } : undefined,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: big(get(fees, "cliff_fee_numerator")),
        firstFactor: num(get(fees, "first_factor")),
        secondFactor: big(get(fees, "second_factor")),
        thirdFactor: big(get(fees, "third_factor")),
        baseFeeMode: num(get(fees, "base_fee_mode")),
      },
    },
    migrationQuoteThreshold: big(get(raw, "migration_quote_threshold")),
    quoteMintDecimals: quoteDecimals,
    quoteIsSol: quoteMint === WSOL,
    migrationFeePercentage: num(get(raw, "migration_fee_percentage")),
    creatorMigrationFeePercentage: num(get(raw, "creator_migration_fee_percentage")),
    migratedPoolFeeBps: num(get(raw, "migrated_pool_fee_bps")),
    lockedVestingConfig: {
      amountPerPeriod: big(get(lv, "amount_per_period")),
      numberOfPeriod: big(get(lv, "number_of_period")),
      cliffUnlockAmount: big(get(lv, "cliff_unlock_amount")),
      cliffDurationFromMigrationTime: big(get(lv, "cliff_duration_from_migration_time")),
    },
    preMigrationTokenSupply: big(get(raw, "pre_migration_token_supply")),
    postMigrationTokenSupply: big(get(raw, "post_migration_token_supply")),
    fixedTokenSupplyFlag: num(get(raw, "fixed_token_supply_flag")),
  };
  return { address, quoteMint, config, raw };
}

export async function fetchConfig(conn: Connection, address: string): Promise<DecodedConfig> {
  const info = await conn.getAccountInfo(new PublicKey(address));
  if (!info) throw new Error(`Config ${address} not found`);
  if (!info.owner.equals(DBC_PROGRAM_ID)) throw new Error(`Config ${address} is not owned by the DBC program`);
  // Decode once to learn the quote mint, then fix decimals if the quote is not SOL.
  const first = decodeConfigAccount(address, info.data);
  if (first.quoteMint === WSOL) return first;
  const dec = await mintDecimals(conn, first.quoteMint);
  return decodeConfigAccount(address, info.data, dec);
}

// ---------- token name ----------
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const readStr = (b: Buffer, o: number) => {
  const n = b.readUInt32LE(o);
  return { value: b.subarray(o + 4, o + 4 + n).toString("utf8").replace(/\0/g, "").trim(), next: o + 4 + n };
};

/** Token program and display name ("Name (SYMBOL)") from Token-2022 metadata or the Metaplex metadata account. */
export async function mintInfo(conn: Connection, mint: string): Promise<{ program: string | null; name?: string }> {
  try {
    const acc: any = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const program: string | null = acc?.value?.owner ?? null;
    const ext = (acc?.value?.data?.parsed?.info?.extensions ?? []).find((e: any) => e.extension === "tokenMetadata");
    if (ext?.state?.name) return { program, name: `${ext.state.name} (${ext.state.symbol})` };
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX);
    const md = await conn.getAccountInfo(pda);
    if (!md) return { program };
    const name = readStr(md.data, 65); // key (1) + update authority (32) + mint (32)
    const symbol = readStr(md.data, name.next);
    return { program, name: name.value ? `${name.value} (${symbol.value})` : undefined };
  } catch {
    return { program: null };
  }
}
