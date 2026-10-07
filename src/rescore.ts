/** Re-score every saved launch with the current rules (after a rule change). Run: npm run rescore */
import fs from "node:fs";
import { makeConnection, fetchConfig } from "./solana.ts";
import { scoreConfig, riskLabel } from "./rules.ts";
import type { LaunchRecord } from "./store.ts";

const FILE = "data/launches.jsonl";
const conn = makeConnection();
const rows: LaunchRecord[] = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cache = new Map<string, Awaited<ReturnType<typeof fetchConfig>>>();
for (const r of rows) {
  if (!cache.has(r.config)) cache.set(r.config, await fetchConfig(conn, r.config));
  const { score, flags } = scoreConfig(cache.get(r.config)!.config);
  const before = `${r.label} ${r.score}`;
  Object.assign(r, { score, flags, label: riskLabel(score) });
  console.log(`${r.baseMint.slice(0, 6)}…  ${before} → ${r.label} ${r.score}  [${flags.map((f) => f.id).join(", ")}]`);
}
fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\n✅ ${rows.length} launches re-scored.`);
