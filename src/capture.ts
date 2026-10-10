/**
 * Capture rate: how many DBC launches happened on mainnet in a time window, and how many of them
 * the live Launch Guard server scored.
 *
 *   npm run capture            last 60 minutes
 *   npm run capture -- 180     last 180 minutes
 *   npm run capture:4h         last 240 minutes (no "--", which PowerShell can swallow)
 *
 * Ground truth comes straight from the chain: every pool whose activation point (unix time or
 * slot) falls in the window, found with the same memcmp bucket query the watcher uses. The
 * server's view comes from PUBLIC_URL/api/launches. The window starts no earlier than the oldest
 * launch the server holds, because the free Render disk resets on every deploy.
 */
import "dotenv/config";
import { rpc } from "./solana.ts";
import { scanBuckets, type NewPool } from "./poolscan.ts";

const minutes = Number(process.argv[2] ?? 60);
const base = (process.env.PUBLIC_URL || "https://launch-guard.onrender.com").replace(/\/$/, "");
const SETTLE_S = 180; // ignore the last 3 minutes: the watcher may not have reached them yet
const SLOT_S = 0.4;

const res = await fetch(`${base}/api/launches?limit=500`);
if (!res.ok) throw new Error(`${base}/api/launches returned ${res.status}`);
const served: { pool: string; detectedAt: number }[] = await res.json();
const seen = new Set(served.map((r) => r.pool));
const oldest = served.length ? Math.min(...served.map((r) => r.detectedAt)) / 1000 : Infinity;

const now = Math.floor(Date.now() / 1000);
const end = now - SETTLE_S;
const start = Math.max(now - minutes * 60, Math.ceil(oldest) + 60);
if (start >= end) {
  console.log(`The server has only been running since ${new Date(oldest * 1000).toISOString()}. Try again in a few minutes.`);
  process.exit(0);
}

const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
const slotAt = (t: number) => Math.round(slot - (now - t) / SLOT_S);
// 65,536-unit buckets: a few queries cover hours; pools outside the window are filtered below.
const range = (a: number, b: number) => {
  const out: bigint[] = [];
  for (let k = BigInt(a) >> 16n; k <= BigInt(b) >> 16n; k++) out.push(k);
  return out;
};
const pools = await scanBuckets([...range(start, end), ...range(slotAt(start), slotAt(end))], 16);

// Timestamps are ~1.8e9, slots ~4e8, so the activation point tells which clock a pool uses.
const inWindow = (p: NewPool) =>
  p.activationPoint > 1e9 ? p.activationPoint >= start && p.activationPoint <= end : p.activationPoint >= slotAt(start) && p.activationPoint <= slotAt(end);
const truth = pools.filter(inWindow);
const missed = truth.filter((p) => !seen.has(p.pool));
const caught = truth.length - missed.length;
const mins = (end - start) / 60;

console.log(`Window: ${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()} (${mins.toFixed(0)} min)`);
console.log(`DBC launches on mainnet: ${truth.length}  (~${Math.round((truth.length / mins) * 60 * 24)} per day at this pace)`);
console.log(`Scored by Launch Guard:  ${caught}`);
console.log(`Capture rate:            ${truth.length ? ((caught / truth.length) * 100).toFixed(1) : "–"}%`);
for (const p of missed.slice(0, 10)) console.log(`  missed ${p.pool}  mint ${p.baseMint}  activation ${p.activationPoint}`);
process.exit(0);
