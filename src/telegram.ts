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

// ---------- /check command ----------
// Anyone can add the bot to a group (or DM it) and type `/check <token or pool address>`.
import type { Connection } from "@solana/web3.js";
import { checkAddress } from "./lookup.ts";

async function reply(chatId: number, replyTo: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_to_message_id: replyTo, allow_sending_without_reply: true }),
  }).catch((e) => console.error("[telegram] reply", (e as Error).message));
}

export function formatCheck(r: LaunchRecord): string {
  const flags = r.flags
    .filter((f) => f.severity !== "info")
    .map((f) => `• <b>${esc(f.title)}</b>: ${esc(f.detail)}`)
    .join("\n");
  const page = DASHBOARD_URL ? `<a href="${DASHBOARD_URL}/?check=${r.baseMint}">Full report</a> · ` : "";
  return [
    `${icon[r.label]} <b>${r.label} · ${r.score}/100</b>${r.name ? ` · ${esc(r.name)}` : ""}`,
    `<code>${r.baseMint}</code>`,
    "",
    flags || "No risky settings in this launch's configuration.",
    "",
    `${page}<a href="https://solscan.io/token/${r.baseMint}">Solscan</a>`,
    "<i>On-chain settings report, not financial advice.</i>",
  ].join("\n");
}

const HELP = [
  "🛡️ <b>Launch Guard</b> scores Meteora DBC token launches by their on-chain settings.",
  "",
  "Send <code>/check &lt;token or pool address&gt;</code>",
  "Example: <code>/check DdFaU39Wv3nozNznGBeCYhjkb7rNLeoYtsUzA1B8QJXV</code>",
].join("\n");

/** Long-poll getUpdates and answer /check and /start. Only one running instance should do this. */
export function startCommands(conn: Connection, store: Store) {
  if (!TOKEN || process.env.TELEGRAM_COMMANDS === "off") return;
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=50&offset=${offset}&allowed_updates=["message"]`);
        const body: any = await res.json();
        if (!body.ok) {
          console.error("[telegram] getUpdates", body.description);
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }
        for (const u of body.result) {
          offset = u.update_id + 1;
          const m = u.message;
          const text: string = m?.text ?? "";
          const [cmd, arg] = text.trim().split(/\s+/, 2);
          const name = cmd?.split("@")[0].toLowerCase();
          if (name === "/start" || name === "/help" || (name === "/check" && !arg)) {
            await reply(m.chat.id, m.message_id, HELP);
          } else if (name === "/check") {
            const r = await checkAddress(conn, store, arg).catch((e) => ({ ok: false as const, status: 502, error: (e as Error).message }));
            await reply(m.chat.id, m.message_id, r.ok ? formatCheck(r.record) : `⚠️ ${esc(r.error)}`);
          }
        }
      } catch (e) {
        console.error("[telegram] commands", (e as Error).message);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  console.log("[telegram] /check command on");
}
