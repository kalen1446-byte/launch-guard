import "dotenv/config";
import { makeConnection } from "./solana.ts";
import { Store } from "./store.ts";
import { startWatcher } from "./watcher.ts";
import { startServer } from "./server.ts";
import { alertLaunch, startDigest, telegramEnabled } from "./telegram.ts";

const conn = makeConnection();
const store = new Store();
const api = startServer(store, Number(process.env.PORT ?? 8787));

const icon: Record<string, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };

if (telegramEnabled) {
  startDigest(store, 6);
  console.log("[telegram] alerts on");
}

startWatcher(conn, store, (r) => {
  const top = r.flags.filter((f) => f.severity !== "low").map((f) => f.title).join(", ") || "no major flags";
  console.log(`${icon[r.label]} ${r.label.padEnd(8)} ${String(r.score).padStart(3)}  mint ${r.baseMint}  — ${top}`);
  api.broadcast(r);
  alertLaunch(r);
});

// Render's free plan sleeps after ~15 min without inbound traffic, which would pause the watcher.
// RENDER_EXTERNAL_URL is set automatically by Render; ping ourselves every 10 minutes to stay awake.
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    fetch(`${selfUrl}/api/stats`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`[keepalive] pinging ${selfUrl} every 10 min`);
}
