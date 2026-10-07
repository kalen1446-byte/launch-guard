/**
 * Smoke test: connects to Solami, finds the most recent DBC launches in program history,
 * decodes their configs and prints risk scores. Run with `npm run check`.
 */
import { makeConnection, DBC_PROGRAM_ID, rpc, rpcUrl } from "./solana.ts";
import { Store } from "./store.ts";
import { processSignature } from "./watcher.ts";

const host = new URL(rpcUrl()).host;
try {
  const slot = await rpc<number>("getSlot", []);
  console.log(`Connected to ${host} · slot ${slot}`);
} catch (e) {
  const cause = (e as any)?.cause?.code ?? (e as Error).message;
  console.error(`❌ Can't reach ${host} (${cause}).`);
  console.error("   Check your internet/VPN, or run `npm run probe` again to re-detect the endpoint.");
  process.exit(1);
}

const conn = makeConnection();
const sigs = await conn.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: 300 });
console.log(`Scanning ${sigs.length} recent DBC transactions for launches (≈${Math.ceil(sigs.length / 8)}s)…`);

const store = new Store();
let found = 0;
let scanned = 0;
for (const s of sigs) {
  if (s.err) continue;
  scanned++;
  try {
    const recs = await processSignature(conn, store, s.signature);
    for (const r of recs) {
      found++;
      console.log(`\n${r.label} (${r.score})  mint ${r.baseMint}  config ${r.config}  [${r.kind}]`);
      for (const f of r.flags) console.log(`   - [${f.severity}] ${f.title}: ${f.detail}`);
    }
  } catch (e) {
    console.error("error", s.signature.slice(0, 8), (e as Error).message);
  }
  if (found >= 5) break;
}
console.log(
  found
    ? `\n✅ Pipeline works — ${found} launches scored (${scanned} transactions read).`
    : `\n⚠️ No launches in the last ${scanned} DBC transactions; run \`npm start\` and wait for a new one.`,
);
