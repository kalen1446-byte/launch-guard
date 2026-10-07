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
