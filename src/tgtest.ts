import "dotenv/config";

// Sends one test message to the alert channel: npm run tg:test
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
if (!token || !chat) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");

const text = "🛡️ <b>Launch Guard is live.</b>\nRisky Meteora DBC launches (score ≥ 35) will be posted here in real time.";
const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
});
const body = (await res.json()) as { ok: boolean; description?: string };
console.log(body.ok ? "✅ Telegram: message sent" : `❌ Telegram: ${body.description}`);
