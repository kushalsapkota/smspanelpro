/**
 * Telegram alerts. Two layers:
 *   - systemAlert(text): operator alerts via the bot token in Settings (key 'telegram')
 *   - userAlert(user, text): per-tenant alerts via user.telegram_bot_token + telegram_chat_id
 * Safe no-op when not configured; never throws into the hot path.
 */
const axios = require('axios');
let db = null;
try { db = require('./db'); } catch (_) {}

async function sendVia(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' }, { timeout: 8000 });
  } catch (_) { /* swallow — alerts must never break dispatch */ }
}

async function systemAlert(text) {
  if (!db) return;
  try {
    const s = await db.Setting.findOne({ key: 'telegram' });
    const cfg = s && s.value;
    if (cfg && cfg.bot_token && cfg.chat_id) await sendVia(cfg.bot_token, cfg.chat_id, text);
  } catch (_) {}
}

function userAlert(user, text) {
  if (!user || !user.telegram_bot_token || !user.telegram_chat_id) return;
  sendVia(user.telegram_bot_token, user.telegram_chat_id, text);
}

module.exports = { systemAlert, userAlert, sendVia };
