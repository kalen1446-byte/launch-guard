/** Connection diagnostics for the Solami endpoint. Prints no secrets. Run: npm run diag */
import "dotenv/config";
import dns from "node:dns/promises";
import net from "node:net";

const url = new URL(process.env.SOLAMI_RPC_URL ?? "");
const host = url.hostname;
console.log("host:", host, "| path:", url.pathname, "| query keys:", [...url.searchParams.keys()].join(","));
console.log("env proxies:", ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].filter((k) => process.env[k] || process.env[k.toLowerCase()]).join(",") || "none");

for (const fam of [4, 6] as const) {
  try {
    const addrs = await dns.resolve(host, fam === 4 ? "A" : "AAAA");
    console.log(`DNS ${fam === 4 ? "A   " : "AAAA"}:`, addrs.join(", "));
    for (const ip of addrs) {
      const t = Date.now();
      const ok = await new Promise<string>((res) => {
        const s = net.connect({ host: ip, port: 443, family: fam });
        s.setTimeout(6000);
        s.on("connect", () => { s.destroy(); res(`ok ${Date.now() - t}ms`); });
        s.on("timeout", () => { s.destroy(); res("timeout"); });
        s.on("error", (e) => res((e as any).code ?? e.message));
      });
      console.log(`  tcp ${ip}:443 → ${ok}`);
    }
  } catch (e) {
    console.log(`DNS ${fam === 4 ? "A" : "AAAA"}: ${(e as any).code ?? (e as Error).message}`);
  }
}
try {
  const sys = await dns.lookup(host, { all: true });
  console.log("OS resolver:", sys.map((a) => a.address).join(", "));
} catch (e) {
  console.log("OS resolver:", (e as Error).message);
}

for (let i = 1; i <= 3; i++) {
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = await r.text();
    console.log(`fetch #${i}: HTTP ${r.status} in ${Date.now() - t}ms ${/"result"/.test(body) ? "(slot ok)" : body.slice(0, 60)}`);
  } catch (e) {
    console.log(`fetch #${i}: ${(e as any)?.cause?.code ?? (e as Error).message} after ${Date.now() - t}ms`);
  }
}
