/**
 * Telegram alerts: posts risky launches to a channel and a periodic digest.
 * Set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (e.g. @launchguard_alerts) in .env.
 * Leave them empty to disable.
 */
import type { LaunchRecord, Store } from "./store.ts";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const MIN_SCORE = Number(process.env.ALERT_MIN_SCORE ?? 35);
const DASHBOARD_URL = process.env.PUBLIC_URL ?? "";

export const telegramEnabled = Boolean(TOKEN && CHAT);

const icon: Record<string, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

// Telegram allows ~20 messages/minute in a group/channel; keep a simple outbound queue.
const queue: string[] = [];
let sending = false;
async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const text = queue.shift()!;
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (res.status === 429) {
        const body: any = await res.json().catch(() => ({}));
        const wait = (body?.parameters?.retry_after ?? 5) * 1000;
        queue.unshift(text);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) console.error("[telegram]", res.status, await res.text());
    } catch (e) {
      console.error("[telegram]", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 3500));
  }
  sending = false;
}
function send(text: string) {
  if (!telegramEnabled) return;
  queue.push(text);
  void pump();
}

export function formatAlert(r: LaunchRecord): string {
  const flags = r.flags
    .filter((f) => f.severity !== "low" && f.severity !== "info")
    .map((f) => `• <b>${esc(f.title)}</b>: ${esc(f.detail)}`)
    .join("\n");
  const link = DASHBOARD_URL ? `\n<a href="${DASHBOARD_URL}">Launch Guard</a> · ` : "\n";
  return [
    `${icon[r.label]} <b>${r.label} risk · ${r.score}/100</b> — new Meteora DBC launch`,
    `<code>${r.baseMint}</code>`,
    "",
    flags || "No major flags.",
    `${link}<a href="https://solscan.io/token/${r.baseMint}">Solscan</a> · <a href="https://solscan.io/tx/${r.signature}">Launch tx</a>`,
    "<i>On-chain settings report, not financial advice.</i>",
  ].join("\n");
}

export function alertLaunch(r: LaunchRecord) {
  if (r.score >= MIN_SCORE) send(formatAlert(r));
}

/** Every `hours`, post a digest: how many launches, how many risky, most common flag. */
export function startDigest(store: Store, hours = 6) {
  if (!telegramEnabled) return;
  setInterval(() => {
    const since = Date.now() - hours * 3600_000;
    const recent = store.latest(100_000).filter((r) => r.detectedAt >= since);
    if (!recent.length) return;
    const risky = recent.filter((r) => r.label === "HIGH" || r.label === "CRITICAL").length;
    const flagCount: Record<string, { title: string; n: number }> = {};
    for (const r of recent) for (const f of r.flags) {
      if (f.severity === "low") continue;
      flagCount[f.id] ??= { title: f.title, n: 0 };
      flagCount[f.id].n++;
    }
    const top = Object.values(flagCount).sort((a, b) => b.n - a.n).slice(0, 3)
      .map((f) => `• ${esc(f.title)}: ${f.n}`).join("\n");
    send([
      `📊 <b>Last ${hours}h on Meteora DBC</b>`,
      `${recent.length} launches scored · ${risky} high/critical (${Math.round((risky / recent.length) * 100)}%)`,
      top ? `\nMost common risks:\n${top}` : "",
    ].join("\n"));
  }, hours * 3600_000);
}
