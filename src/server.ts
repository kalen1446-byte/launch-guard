import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Connection } from "@solana/web3.js";
import type { Store, LaunchRecord } from "./store.ts";
import { checkAddress } from "./lookup.ts";

/** Minimal JSON API + Server-Sent Events stream for the dashboard. */
export function startServer(store: Store, port: number, conn?: Connection) {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/launches") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      return json(200, store.latest(limit));
    }
    if (url.pathname.startsWith("/api/launch/")) {
      const r = store.get(url.pathname.split("/").pop()!);
      return r ? json(200, r) : json(404, { error: "not found" });
    }
    if (url.pathname.startsWith("/api/check/") && conn) {
      const address = decodeURIComponent(url.pathname.slice("/api/check/".length)).trim();
      checkAddress(conn, store, address)
        .then((r) => (r.ok ? json(200, { source: r.source, ...r.record }) : json(r.status, { error: r.error })))
        .catch((e) => json(502, { error: `Lookup failed: ${(e as Error).message}` }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.resolve("public/index.html")));
    }
    if (url.pathname === "/api/stats") return json(200, store.stats());
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    json(404, { error: "unknown route" });
  });

  server.listen(port, () => console.log(`[api] http://localhost:${port}/api/launches`));

  return {
    broadcast(r: LaunchRecord) {
      const msg = `data: ${JSON.stringify(r)}\n\n`;
      for (const c of clients) c.write(msg);
    },
  };
}
