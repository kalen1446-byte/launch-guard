/**
 * Finds a faster way to detect launches than opening every DBC transaction: npm run wsprobe
 *  1) tries WebSocket URL variants for logsSubscribe (server-side filter → only launch logs reach us)
 *  2) checks whether Solami's getProgramAccountsV2 supports changedSinceSlot (→ poll only changed pools)
 * Prints which ones work; the API key is never printed.
 */
import bs58 from "bs58";
import { rpc, rpcUrl, DBC_PROGRAM_ID, DISC } from "./solana.ts";

const http = rpcUrl();
const u = new URL(http);
const key = u.searchParams.get("api_key") ?? "";
const hide = (s: string) => (key ? s.replace(key, "***") : s);
const candidates = [
  http.replace(/^http/, "ws"),
  `wss://${u.host}/ws${u.pathname}${u.search}`,
  `wss://${u.host}/ws${u.search}`,
  `wss://${u.host}${u.pathname}/ws${u.search}`,
];

function tryWs(url: string): Promise<string> {
  return new Promise((resolve) => {
    const WS = (globalThis as any).WebSocket;
    if (!WS) return resolve("no WebSocket in this Node version");
    let done = false;
    const finish = (msg: string) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(msg); } };
    const ws = new WS(url);
    const timer = setTimeout(() => finish("connected, but no log notification within 15s"), 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [DBC_PROGRAM_ID.toBase58()] }, { commitment: "confirmed" }] }));
    ws.onerror = (e: any) => { clearTimeout(timer); finish(`error: ${e?.message ?? "connection failed"}`); };
    ws.onclose = (e: any) => { clearTimeout(timer); finish(`closed (code ${e?.code})`); };
    ws.onmessage = (m: any) => {
      const d = JSON.parse(String(m.data));
      if (d.method === "logsNotification") { clearTimeout(timer); finish("✅ WORKS: receiving DBC logs"); }
      else if (d.error) { clearTimeout(timer); finish(`rpc error: ${d.error.message}`); }
    };
  });
}

console.log("WebSocket candidates:");
for (const c of candidates) console.log(`  ${hide(c)}\n    → ${await tryWs(c)}`);

console.log("\ngetProgramAccountsV2 with changedSinceSlot:");
try {
  const slot: number = await rpc("getSlot", []);
  const res: any = await rpc("getProgramAccountsV2", [
    DBC_PROGRAM_ID.toBase58(),
    { encoding: "base64", limit: 1000, changedSinceSlot: slot - 30, dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC.VirtualPool) } }] },
  ]);
  const n = (res?.accounts ?? res?.value?.accounts ?? []).length;
  console.log(`  → ${n} pools changed in the last ~30 slots (~12s). ${n > 0 && n < 1000 ? "✅ supported" : "check manually"}`);
} catch (e) {
  console.log(`  → not supported: ${(e as Error).message}`);
}
process.exit(0);
