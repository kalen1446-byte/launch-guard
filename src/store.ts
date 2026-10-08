import fs from "node:fs";
import path from "node:path";
import type { Flag } from "./rules.ts";

export interface LaunchRecord {
  pool: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
  config: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  detectedAt: number;
  kind: "spl" | "token2022" | "transferHook";
  score: number;
  label: string;
  flags: Flag[];
  name?: string;
}

const DATA_DIR = path.resolve("data");
const FILE = path.join(DATA_DIR, "launches.jsonl");

export class Store {
  private byPool = new Map<string, LaunchRecord>();

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as LaunchRecord;
          this.byPool.set(r.pool, r);
        } catch {
          /* skip corrupt line */
        }
      }
    }
  }

  has(pool: string) {
    return this.byPool.has(pool);
  }

  add(r: LaunchRecord) {
    this.byPool.set(r.pool, r);
    fs.appendFileSync(FILE, JSON.stringify(r) + "\n");
  }

  get(pool: string) {
    return this.byPool.get(pool);
  }

  /** Find a stored launch by pool address or token mint. */
  find(address: string) {
    const byPool = this.byPool.get(address);
    if (byPool) return byPool;
    for (const r of this.byPool.values()) if (r.baseMint === address) return r;
    return undefined;
  }

  latest(limit = 100): LaunchRecord[] {
    return [...this.byPool.values()].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, limit);
  }

  stats() {
    const all = [...this.byPool.values()];
    const dayAgo = Date.now() - 86_400_000;
    const last24h = all.filter((r) => r.detectedAt >= dayAgo);
    const byLabel: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    const byFlag: Record<string, number> = {};
    for (const r of last24h) {
      byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
      for (const f of r.flags) byFlag[f.id] = (byFlag[f.id] ?? 0) + 1;
    }
    return { total: all.length, last24h: last24h.length, byLabel, byFlag };
  }
}
