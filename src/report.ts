/**
 * "State of DBC Launches" — scans every DBC config and pool on mainnet and measures
 * how many launches go live with risky settings. Run with `npm run report`.
 *
 * Uses two getProgramAccounts calls through Solami RPC:
 *  1) all PoolConfig / ConfigWithTransferHook accounts (full data, decoded + scored)
 *  2) all VirtualPool / TransferHookPool accounts, sliced to the 32-byte config field only
 */
import fs from "node:fs";
import bs58 from "bs58";
import { makeConnection, DBC_PROGRAM_ID, DISC, POOL_CONFIG_OFFSET, decodeConfigAccount, mintDecimals, WSOL } from "./solana.ts";
import { scoreConfig, riskLabel } from "./rules.ts";

const conn = makeConnection();
const filterDisc = (d: Buffer) => [{ memcmp: { offset: 0, bytes: bs58.encode(d) } }];

console.log("Fetching DBC configs…");
const configAccs = [
  ...(await conn.getProgramAccounts(DBC_PROGRAM_ID, { filters: filterDisc(DISC.PoolConfig) })),
  ...(await conn.getProgramAccounts(DBC_PROGRAM_ID, { filters: filterDisc(DISC.ConfigWithTransferHook) })),
];
console.log(`  ${configAccs.length} configs`);

const scored = new Map<string, { score: number; label: string; flags: string[] }>();
for (const { pubkey, account } of configAccs) {
  try {
    let d = decodeConfigAccount(pubkey.toBase58(), account.data);
    if (d.quoteMint !== WSOL) d = decodeConfigAccount(pubkey.toBase58(), account.data, await mintDecimals(conn, d.quoteMint));
    const { score, flags } = scoreConfig(d.config);
    scored.set(pubkey.toBase58(), { score, label: riskLabel(score), flags: flags.map((f) => f.id) });
  } catch (e) {
    console.warn("  skip config", pubkey.toBase58(), (e as Error).message);
  }
}

console.log("Counting pools per config (this can take a minute)…");
const slice = { offset: POOL_CONFIG_OFFSET, length: 32 };
const poolAccs = [
  ...(await conn.getProgramAccounts(DBC_PROGRAM_ID, { filters: filterDisc(DISC.VirtualPool), dataSlice: slice })),
  ...(await conn.getProgramAccounts(DBC_PROGRAM_ID, { filters: filterDisc(DISC.TransferHookPool), dataSlice: slice })),
];
const poolsPerConfig = new Map<string, number>();
for (const p of poolAccs) {
  const cfg = bs58.encode(p.account.data);
  poolsPerConfig.set(cfg, (poolsPerConfig.get(cfg) ?? 0) + 1);
}
console.log(`  ${poolAccs.length} pools`);

// Aggregate, weighted by number of pools launched from each config.
let totalPools = 0;
const byLabel: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
const byFlag: Record<string, number> = {};
const configsByLabel: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
for (const [cfg, s] of scored) {
  configsByLabel[s.label]++;
  const n = poolsPerConfig.get(cfg) ?? 0;
  totalPools += n;
  byLabel[s.label] += n;
  for (const f of s.flags) byFlag[f] = (byFlag[f] ?? 0) + n;
}
const pct = (n: number) => (totalPools ? ((n / totalPools) * 100).toFixed(1) + "%" : "0%");

const topConfigs = [...poolsPerConfig.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .map(([config, pools]) => ({ config, pools, ...(scored.get(config) ?? { score: -1, label: "UNKNOWN", flags: [] }) }));

const report = {
  generatedAt: new Date().toISOString(),
  configs: scored.size,
  pools: totalPools,
  poolsByLabel: byLabel,
  poolsByLabelPct: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, pct(v)])),
  poolsByFlag: byFlag,
  poolsByFlagPct: Object.fromEntries(Object.entries(byFlag).map(([k, v]) => [k, pct(v)])),
  configsByLabel,
  topConfigs,
};
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/report.json", JSON.stringify(report, null, 2));

console.log("\n=== State of DBC Launches ===");
console.log(`Configs: ${scored.size} | Pools: ${totalPools}`);
for (const k of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) console.log(`  ${k.padEnd(8)} ${String(byLabel[k]).padStart(8)}  ${pct(byLabel[k])}`);
console.log("Flags (share of pools):");
for (const [k, v] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${pct(v)}`);
console.log("\nSaved data/report.json");
