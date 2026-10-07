/**
 * "State of DBC Launches" — measures how many Meteora DBC launches on mainnet go live with risky settings.
 * Run with `npm run report`.
 *
 * Data comes from paginated getProgramAccountsV2 calls through Solami RPC:
 *  1) every PoolConfig / ConfigWithTransferHook account (full data → decoded and scored)
 *  2) every VirtualPool / TransferHookPool account, sliced to its 32-byte config field (→ pools per config)
 *
 * Most launchpads create a fresh config per launch, so there are hundreds of thousands of configs, while a
 * few configs carry tens of thousands of pools each. Stratified estimate, weighted by pools:
 *  - every config with >= BIG_MIN pools is scored (these carry most launches);
 *  - the remaining configs are sampled uniformly, and each sampled config stands in for (rest / sample) configs.
 */
import fs from "node:fs";
import bs58 from "bs58";
import { makeConnection, rpc, DBC_PROGRAM_ID, DISC, POOL_CONFIG_OFFSET, decodeConfigAccount, mintDecimals, WSOL } from "./solana.ts";
import { scoreConfig, riskLabel } from "./rules.ts";

const conn = makeConnection();
const BIG_MIN = Number(process.env.REPORT_BIG_MIN ?? 5);
const SAMPLE = Number(process.env.REPORT_SAMPLE ?? 20000);
const filterDisc = (d: Buffer) => [{ memcmp: { offset: 0, bytes: bs58.encode(d) } }];

type Acc = { pubkey: string; data: Buffer };
/** DBC has too many accounts for plain getProgramAccounts; Solami pages them with getProgramAccountsV2. */
async function programAccounts(filters: unknown[], dataSlice?: { offset: number; length: number }): Promise<Acc[]> {
  const out: Acc[] = [];
  let paginationKey: string | null = null;
  do {
    const opts: Record<string, unknown> = { encoding: "base64", commitment: "confirmed", filters, limit: 5000 };
    if (dataSlice) opts.dataSlice = dataSlice;
    if (paginationKey) opts.paginationKey = paginationKey;
    const res: any = await rpc("getProgramAccountsV2", [DBC_PROGRAM_ID.toBase58(), opts]);
    for (const a of res?.accounts ?? res?.value?.accounts ?? []) out.push({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], "base64") });
    paginationKey = res?.paginationKey ?? res?.value?.paginationKey ?? null;
    process.stdout.write(`\r  fetched ${out.length}`);
  } while (paginationKey);
  process.stdout.write("\n");
  return out;
}

console.log("Fetching DBC configs…");
const configAccs = [...(await programAccounts(filterDisc(DISC.PoolConfig))), ...(await programAccounts(filterDisc(DISC.ConfigWithTransferHook)))];
console.log(`  ${configAccs.length} configs`);

console.log("Fetching DBC pools (config field only)…");
const slice = { offset: POOL_CONFIG_OFFSET, length: 32 };
const poolAccs = [...(await programAccounts(filterDisc(DISC.VirtualPool), slice)), ...(await programAccounts(filterDisc(DISC.TransferHookPool), slice))];
const poolsPerConfig = new Map<string, number>();
for (const p of poolAccs) {
  const cfg = bs58.encode(p.data);
  poolsPerConfig.set(cfg, (poolsPerConfig.get(cfg) ?? 0) + 1);
}
const totalPools = poolAccs.length;
console.log(`  ${totalPools} pools`);

// Strata: big configs scored in full, small ones sampled.
const big: Acc[] = [];
const small: Acc[] = [];
for (const a of configAccs) ((poolsPerConfig.get(a.pubkey) ?? 0) >= BIG_MIN ? big : small).push(a);
for (let i = small.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [small[i], small[j]] = [small[j], small[i]];
}
const smallSample = small.slice(0, Math.min(SAMPLE, small.length));
const smallWeight = smallSample.length ? small.length / smallSample.length : 0;
const bigPools = big.reduce((s, a) => s + (poolsPerConfig.get(a.pubkey) ?? 0), 0);
console.log(`Scoring ${big.length} configs with >= ${BIG_MIN} pools (${((bigPools / totalPools) * 100).toFixed(1)}% of pools) + a sample of ${smallSample.length} of ${small.length} smaller configs…`);

const feeClaimerOf = (raw: any): string => {
  const v = raw?.feeClaimer ?? raw?.fee_claimer ?? raw?.config?.feeClaimer ?? raw?.config?.fee_claimer;
  return v?.toBase58 ? v.toBase58() : String(v ?? "unknown");
};

type Scored = { config: string; pools: number; weight: number; score: number; label: string; flags: string[]; launchpad: string };
const scored: Scored[] = [];
let done = 0;
for (const [list, weight] of [[big, 1], [smallSample, smallWeight]] as const) {
  for (const { pubkey, data } of list) {
    if (++done % 2000 === 0) process.stdout.write(`\r  scored ${done}`);
    try {
      let d = decodeConfigAccount(pubkey, data);
      if (d.quoteMint !== WSOL) d = decodeConfigAccount(pubkey, data, await mintDecimals(conn, d.quoteMint));
      const { score, flags } = scoreConfig(d.config);
      scored.push({ config: pubkey, pools: poolsPerConfig.get(pubkey) ?? 0, weight, score, label: riskLabel(score), flags: flags.map((f) => (f.id === "R3_UNLOCKED_LP" ? `R3_UNLOCKED_LP_${f.severity}` : f.id)), launchpad: feeClaimerOf(d.raw) });
    } catch (e) {
      /* unreadable config: skipped */
    }
  }
}
process.stdout.write(`\r  scored ${done}\n`);

// Pool-weighted estimates.
let est = 0;
const byLabel: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
const byFlag: Record<string, number> = {};
const lp = new Map<string, { pools: number; configs: number; risky: number; scoreSum: number; flags: Record<string, number> }>();
for (const s of scored) {
  const n = s.pools * s.weight;
  est += n;
  byLabel[s.label] += n;
  for (const f of s.flags) byFlag[f] = (byFlag[f] ?? 0) + n;
  const e = lp.get(s.launchpad) ?? { pools: 0, configs: 0, risky: 0, scoreSum: 0, flags: {} };
  e.pools += n;
  e.configs += s.weight;
  e.scoreSum += s.score * n;
  if (s.label === "HIGH" || s.label === "CRITICAL") e.risky += n;
  for (const f of s.flags) e.flags[f] = (e.flags[f] ?? 0) + n;
  lp.set(s.launchpad, e);
}
const pct = (n: number) => (est ? ((n / est) * 100).toFixed(1) + "%" : "0%");

const topLaunchpads = [...lp.entries()]
  .filter(([, e]) => e.pools > 0)
  .sort((a, b) => b[1].pools - a[1].pools)
  .slice(0, 20)
  .map(([launchpad, e]) => ({
    launchpad,
    pools: Math.round(e.pools),
    configs: Math.round(e.configs),
    avgScore: Math.round(e.scoreSum / e.pools),
    highOrCritical: ((e.risky / e.pools) * 100).toFixed(1) + "%",
    flags: Object.fromEntries(Object.entries(e.flags).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, ((v / e.pools) * 100).toFixed(0) + "%"])),
  }));

// Launchpads where most launches are HIGH/CRITICAL (at least 100 pools so a single bad config does not dominate).
const riskiestLaunchpads = [...lp.entries()]
  .filter(([, e]) => e.pools >= 100 && e.risky / e.pools >= 0.5)
  .sort((a, b) => b[1].risky - a[1].risky)
  .slice(0, 20)
  .map(([launchpad, e]) => ({
    launchpad,
    pools: Math.round(e.pools),
    highOrCriticalPools: Math.round(e.risky),
    highOrCritical: ((e.risky / e.pools) * 100).toFixed(1) + "%",
    avgScore: Math.round(e.scoreSum / e.pools),
    flags: Object.fromEntries(Object.entries(e.flags).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, ((v / e.pools) * 100).toFixed(0) + "%"])),
  }));

const topConfigs = scored
  .filter((s) => s.weight === 1)
  .sort((a, b) => b.pools - a.pools)
  .slice(0, 20)
  .map(({ config, pools, score, label, flags, launchpad }) => ({ config, pools, score, label, flags, launchpad }));

const report = {
  generatedAt: new Date().toISOString(),
  method: `pool-weighted; all configs with >= ${BIG_MIN} pools scored, ${smallSample.length} of ${small.length} smaller configs sampled`,
  totalConfigs: configAccs.length,
  totalPools,
  estimatedPoolsCovered: Math.round(est),
  poolsByLabelPct: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, pct(v)])),
  poolsByFlagPct: Object.fromEntries(Object.entries(byFlag).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
  topLaunchpads,
  riskiestLaunchpads,
  topConfigs,
};
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/report.json", JSON.stringify(report, null, 2));

console.log("\n=== State of DBC Launches ===");
console.log(`Configs: ${configAccs.length} | Pools: ${totalPools} | estimate covers ${Math.round(est)} pools`);
for (const k of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) console.log(`  ${k.padEnd(8)} ${pct(byLabel[k])}`);
console.log("Flags (share of pools):");
for (const [k, v] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${pct(v)}`);
console.log("\nTop launchpads (fee claimer) by pools:");
for (const l of topLaunchpads.slice(0, 12)) console.log(`  ${l.launchpad.slice(0, 8)}…  pools ${String(l.pools).padStart(8)}  avg ${String(l.avgScore).padStart(3)}  high/critical ${l.highOrCritical}`);
console.log("\nLaunchpads where most launches are HIGH/CRITICAL:");
for (const l of riskiestLaunchpads.slice(0, 10)) console.log(`  ${l.launchpad.slice(0, 8)}…  pools ${String(l.pools).padStart(7)}  high/critical ${l.highOrCritical}`);
console.log("\nSaved data/report.json");
