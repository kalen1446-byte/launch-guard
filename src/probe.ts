/**
 * Finds the working Solami RPC/WebSocket URL format for your key and rewrites .env.
 * Your key is read from .env (any existing SOLAMI_* line) and never printed.
 * Run: npm run probe
 */
import fs from "node:fs";

const env = fs.readFileSync(".env", "utf8");
const key =
  env.match(/SOLAMI_API_KEY=([A-Za-z0-9_\-]{8,})/)?.[1] ??
  env.match(/api[-_]key=([A-Za-z0-9_\-]{8,})/)?.[1] ??
  env.match(/rpc\.solami\.[a-z]+\/(?:sol\/)?([A-Za-z0-9_\-]{20,})/)?.[1];
if (!key) {
  console.error("No Solami key found in .env. Add a line: SOLAMI_API_KEY=your_key and run again.");
  process.exit(1);
}

const candidates = [
  { rpc: `https://rpc.solami.fast/sol?api_key=${key}`, ws: `wss://rpc.solami.fast/ws/sol?api_key=${key}` },
  { rpc: `https://rpc.solami.dev/sol?api_key=${key}`, ws: `wss://rpc.solami.dev/ws/sol?api_key=${key}` },
  { rpc: `https://rpc.solami.dev/?api_key=${key}`, ws: `wss://rpc.solami.dev/?api_key=${key}` },
  { rpc: `https://rpc.solami.dev/?api-key=${key}`, ws: `wss://rpc.solami.dev/?api-key=${key}` },
  { rpc: `https://rpc.solami.dev/${key}`, ws: `wss://rpc.solami.dev/${key}` },
];
const mask = (u: string) => u.replace(key, "***");

async function tryRpc(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (res.ok && /"result"\s*:\s*\d+/.test(text)) return "ok";
    return `${res.status} ${text.slice(0, 80).replace(/\s+/g, " ")}`;
  } catch (e) {
    return (e as Error).message;
  }
}

async function tryWs(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    const ws = new WebSocket(url);
    const t = setTimeout(() => finish(false), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    ws.onmessage = () => { clearTimeout(t); finish(true); };
    ws.onerror = () => { clearTimeout(t); finish(false); };
  });
}

for (const c of candidates) {
  const r = await tryRpc(c.rpc);
  console.log(`RPC ${mask(c.rpc).padEnd(48)} → ${r}`);
  if (r !== "ok") continue;
  const wsOk = await tryWs(c.ws);
  console.log(`WS  ${mask(c.ws).padEnd(48)} → ${wsOk ? "ok" : "failed"}`);
  const lines = env.split(/\r?\n/).filter((l) => !/^\s*#?\s*SOLAMI_(RPC_URL|WS_URL|API_KEY)=/.test(l));
  lines.unshift(`SOLAMI_API_KEY=${key}`, `SOLAMI_RPC_URL=${c.rpc}`, `SOLAMI_WS_URL=${wsOk ? c.ws : ""}`);
  fs.writeFileSync(".env", lines.join("\n"));
  console.log(`\n✅ Working RPC found and saved to .env${wsOk ? " (WebSocket too)" : " — WebSocket failed, live watcher will poll instead"}.`);
  process.exit(0);
}
console.error("\n❌ None of the URL formats worked. Check that the key is an RPC key (Dashboard → API Keys) and copy the endpoint shown there.");
process.exit(1);
