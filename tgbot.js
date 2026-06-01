/**
 * tgbot.js — Operator control hub on Telegram.
 *
 * A long-polling bot (no public URL needed) that lets the OPERATOR manage the panel from
 * Telegram: add balance, check a client's status, see totals, per-user usage reports,
 * suspend/unsuspend, and list low-balance clients.
 *
 * Config (env first, else Settings key 'telegram'):
 *   TG_BOT_TOKEN   — the bot token from @BotFather
 *   TG_ADMIN_IDS   — comma-separated Telegram chat IDs allowed to use it (operator only!)
 *
 * Security: every update is checked against the allow-list. Unknown chats get nothing but a
 * hint with their own id (so you can add it). The bot can move money, so this gate is vital.
 */
require('dotenv').config();
const axios = require('axios');
const bcrypt = require('bcryptjs');
const db = require('./db');
const engine = require('./shared/engine');

const SMPP_HOST = process.env.PUBLIC_HOST || 'your-server-ip';
const SMPP_PORT = Number(process.env.SMPP_PORT || 2775);
function pass8() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; let p = ''; for (let i = 0; i < 8; i++) p += c[Math.floor(Math.random() * c.length)]; return p; }

const API = (token) => `https://api.telegram.org/bot${token}`;
const state = new Map();   // chatId -> { mode, uid } conversational state
let TOKEN = '';

async function loadConfig() {
  let token = process.env.TG_BOT_TOKEN || '';
  let ids = (process.env.TG_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const s = await db.Setting.findOne({ key: 'telegram' });
    const v = (s && s.value) || {};
    if (!token && v.bot_token) token = v.bot_token;
    if (!ids.length && v.chat_id) ids = [String(v.chat_id)];
  } catch (_) {}
  return { token, admins: new Set(ids.map(String)) };
}

// ---- Telegram API helpers (transport is swappable so tests can capture sends) ----
let transport = async (method, body) => {
  try { const r = await axios.post(`${API(TOKEN)}/${method}`, body, { timeout: 35000, validateStatus: () => true }); return r.data; }
  catch (e) { return { ok: false, error: e.message }; }
};
function setTransport(fn) { transport = fn; }
async function tg(method, body) { return transport(method, body); }
const send = (chat_id, text, keyboard) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined });
const answer = (id, text) => tg('answerCallbackQuery', { callback_query_id: id, text });

// ---- helpers ----
async function panelTz() { const s = await db.Setting.findOne({ key: 'general' }); return (s && s.value && s.value.timezone) || db.DEFAULT_TZ; }
const eur = (n) => '€' + db.round3(n || 0).toFixed(3);

async function clientButtons(prefix) {
  const users = await db.User.find({ role: { $in: ['client', 'reseller'] } }).sort({ username: 1 }).limit(40);
  const rows = users.map((u) => [{ text: `${u.is_suspended ? '⏸ ' : ''}${u.username} · ${eur(u.credits)}`, callback_data: `${prefix}:${u._id}` }]);
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu' }]);
  return rows;
}

const MENU = [
  [{ text: '💰 Add balance', callback_data: 'bal' }, { text: '💳 Check client', callback_data: 'stat' }],
  [{ text: '➕ New client', callback_data: 'newc' }, { text: '🧪 Send test SMS', callback_data: 'test' }],
  [{ text: '💶 Set price', callback_data: 'price' }, { text: '🔔 Set threshold', callback_data: 'thr' }],
  [{ text: '👥 Clients', callback_data: 'clients' }, { text: '📊 Totals', callback_data: 'totals' }],
  [{ text: '📅 Per-user report', callback_data: 'rep' }, { text: '🔔 Low balance', callback_data: 'low' }],
  [{ text: '⏸ Suspend / ▶️ Resume', callback_data: 'susp' }, { text: '🔑 Reset password', callback_data: 'pw' }],
];
const showMenu = (chat) => send(chat, '🎛 <b>SMPP Bridge — Control Hub</b>\nPick an action:', MENU);

async function statusCard(uid) {
  const u = await db.User.findById(uid); if (!u) return 'Not found.';
  const tz = await panelTz();
  const today = (await db.UsageEvent.aggregate([
    { $match: { username: u.username } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, n: { $sum: 1 }, seg: { $sum: '$parts' } } },
    { $sort: { _id: -1 } }, { $limit: 1 },
  ]))[0];
  const totals = (await db.UsageEvent.aggregate([{ $match: { username: u.username } }, { $group: { _id: null, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } }]))[0] || { n: 0, seg: 0, cr: 0 };
  const thr = u.low_balance_threshold != null ? eur(u.low_balance_threshold) : 'global';
  const smsLeft = u.cost_per_sms > 0 ? Math.floor((u.credits || 0) / u.cost_per_sms) : '∞';
  return `💳 <b>${u.username}</b> ${u.is_suspended ? '⏸ <i>suspended</i>' : '✅ active'}\n`
    + `Balance: <b>${eur(u.credits)}</b>  (~${smsLeft} SMS @ ${eur(u.cost_per_sms)})\n`
    + `Low-bal alert ≤ ${thr}\n`
    + `Latest day: ${today ? `${today.n} msg / ${today.seg} seg` : '—'}\n`
    + `All-time: ${totals.n} msg · ${totals.seg} seg · spent ${eur(totals.cr)}`;
}

async function reportCard(uid) {
  const u = await db.User.findById(uid); if (!u) return 'Not found.';
  const tz = await panelTz();
  const rows = await db.UsageEvent.aggregate([
    { $match: { username: u.username } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } },
    { $sort: { _id: -1 } }, { $limit: 14 },
  ]);
  if (!rows.length) return `📅 <b>${u.username}</b> — no sends yet.`;
  const lines = rows.map((r) => `<code>${r._id}</code>  ${String(r.n).padStart(4)} msg · ${String(r.seg).padStart(4)} seg · ${eur(r.cr)}`);
  return `📅 <b>${u.username}</b> — daily (${tz})\n` + lines.join('\n');
}

async function totalsCard() {
  const tz = await panelTz();
  const all = (await db.UsageEvent.aggregate([{ $group: { _id: null, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } }]))[0] || { n: 0, seg: 0, cr: 0 };
  const days = await db.UsageEvent.aggregate([
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, n: { $sum: 1 }, seg: { $sum: '$parts' } } },
    { $sort: { _id: -1 } }, { $limit: 7 },
  ]);
  const dl = await db.MessageLog.aggregate([{ $group: { _id: '$dlr_status', n: { $sum: 1 } } }]);
  const by = {}; dl.forEach((r) => by[r._id || 'unknown'] = r.n);
  const lines = days.map((d) => `<code>${d._id}</code>  ${String(d.n).padStart(5)} msg · ${d.seg} seg`);
  return `📊 <b>Totals</b>\nAll-time: ${all.n} msg · ${all.seg} seg · revenue ${eur(all.cr)}\n`
    + `DLR (recent): ✅ ${by.delivered || 0} delivered · 📨 ${by.accepted || 0} accepted · ❌ ${(by.undelivered || 0) + (by.rejected || 0)} failed\n\n`
    + `<b>Last 7 days</b>\n` + (lines.join('\n') || '—');
}

async function lowCard() {
  const s = await db.Setting.findOne({ key: 'alerts' }); const g = (s && s.value && s.value.lowBalance) || 0;
  const users = await db.User.find({ role: { $in: ['client', 'reseller'] }, is_active: true });
  const low = users.filter((u) => { const t = u.low_balance_threshold != null ? u.low_balance_threshold : g; return t && (u.credits || 0) <= t; });
  if (!low.length) return '🔔 No clients under their low-balance threshold. 👍';
  return '🔔 <b>Low balance</b>\n' + low.map((u) => `• <b>${u.username}</b> ${eur(u.credits)} (≤ ${eur(u.low_balance_threshold != null ? u.low_balance_threshold : g)})`).join('\n');
}

// ---- update handling ----
async function onText(chat, text) {
  const st = state.get(chat);
  const num = () => Number(String(text).replace(',', '.').trim());
  if (st) {
    // ---- add / deduct balance ----
    if (st.mode === 'amount') {
      state.delete(chat); const amt = num();
      if (!isFinite(amt) || amt === 0) return send(chat, '❌ Send a number, e.g. <code>18</code> or <code>-5</code> to deduct.', MENU);
      const u = await db.User.findById(st.uid); if (!u) return send(chat, 'Client vanished.', MENU);
      const r = await db.addCredits(u.username, amt, { type: amt >= 0 ? 'topup' : 'adjustment', by: 'telegram', note: 'via Telegram hub' });
      return send(chat, `✅ ${amt >= 0 ? 'Added' : 'Deducted'} ${eur(Math.abs(amt))} ${amt >= 0 ? 'to' : 'from'} <b>${u.username}</b>.\nNew balance: <b>${eur(r.balance)}</b>`, MENU);
    }
    // ---- set price per SMS ----
    if (st.mode === 'setprice') {
      state.delete(chat); const p = num();
      if (!isFinite(p) || p < 0) return send(chat, '❌ Send a price, e.g. <code>0.018</code>.', MENU);
      const u = await db.User.findById(st.uid); if (!u) return send(chat, 'Client vanished.', MENU);
      await db.User.findByIdAndUpdate(u._id, { $set: { cost_per_sms: db.round3(p) } });
      return send(chat, `✅ <b>${u.username}</b> price set to ${eur(p)} / SMS.`, MENU);
    }
    // ---- set low-balance threshold ----
    if (st.mode === 'setthr') {
      state.delete(chat); const raw = text.trim(); const t = (raw === '' || raw === '0') ? null : num();
      if (t !== null && !isFinite(t)) return send(chat, '❌ Send a number (or <code>0</code> for global).', MENU);
      const u = await db.User.findById(st.uid); if (!u) return send(chat, 'Client vanished.', MENU);
      await db.User.findByIdAndUpdate(u._id, { $set: { low_balance_threshold: t === null ? null : db.round3(t) } });
      return send(chat, `✅ <b>${u.username}</b> low-balance alert ${t === null ? 'set to GLOBAL default' : 'at ' + eur(t)}.`, MENU);
    }
    // ---- new client wizard ----
    if (st.mode === 'nc_user') {
      const uname = text.trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,}$/.test(uname)) return send(chat, '❌ Username: 3+ chars, letters/digits/_.- only. Try again:');
      if (await db.User.findOne({ username: uname })) return send(chat, '❌ That username exists. Send another:');
      st.draft = { username: uname }; st.mode = 'nc_price';
      return send(chat, `Price per SMS in € for <b>${uname}</b> (e.g. <code>0.018</code>):`);
    }
    if (st.mode === 'nc_price') {
      const p = num(); if (!isFinite(p) || p < 0) return send(chat, '❌ Send a price like <code>0.018</code>:');
      st.draft.price = db.round3(p); st.mode = 'nc_bal';
      return send(chat, `Initial balance € for <b>${st.draft.username}</b> (<code>0</code> for none):`);
    }
    if (st.mode === 'nc_bal') {
      const bal = num(); state.delete(chat);
      if (!isFinite(bal) || bal < 0) return send(chat, '❌ Send a balance like <code>18</code>.', MENU);
      const pw = pass8();
      const u = await db.User.create({ username: st.draft.username, password: await bcrypt.hash(pw, 10), role: 'client', cost_per_sms: st.draft.price, credits: db.round3(bal), bypass_template: true });
      const sms = u.cost_per_sms > 0 ? Math.floor(u.credits / u.cost_per_sms) : '∞';
      return send(chat, `✅ <b>Client created</b>\nUsername: <code>${u.username}</code>\nPassword: <code>${pw}</code>\nPrice: ${eur(u.cost_per_sms)} / SMS\nBalance: ${eur(u.credits)} (~${sms} SMS)\n\nSMPP: <code>${SMPP_HOST}:${SMPP_PORT}</code> · system_id <code>${u.username}</code>`, MENU);
    }
    // ---- send test SMS wizard ----
    if (st.mode === 'test_to') {
      const to = text.trim().replace(/[^\d+]/g, '');
      if (!to) return send(chat, '❌ Send a destination number, e.g. <code>9779812345678</code>:');
      st.draft = { to }; st.mode = 'test_text';
      return send(chat, 'Message text to send:');
    }
    if (st.mode === 'test_text') {
      const { uid, draft } = st; state.delete(chat);
      const u = await db.User.findById(uid); if (!u) return send(chat, 'Client vanished.', MENU);
      await send(chat, `📤 Sending a REAL SMS as <b>${u.username}</b> to <code>${draft.to}</code>…`);
      const d = await engine.accept(u, draft.to, text, u.default_sender_id || '', 'http');
      if (!d.ok) return send(chat, `❌ Rejected: ${d.reason}`, MENU);
      const r = await engine.fireDispatch(d.prepared);
      return send(chat, r.success
        ? `✅ Sent via <b>${r.via}</b> · DLR: <b>${r.dlr}</b> · id <code>${r.providerId}</code>\nCharged ${eur(d.prepared.cost)} · new balance ${eur((await db.User.findById(uid)).credits)}`
        : `❌ Send failed: ${r.error}`, MENU);
    }
  }
  if (/^\/(start|menu)\b/i.test(text)) return showMenu(chat);
  return showMenu(chat);
}

async function onCallback(chat, data, cqId) {
  const [action, id] = data.split(':');
  if (action === 'menu') { await answer(cqId); return showMenu(chat); }
  if (action === 'bal' && !id) { await answer(cqId); return send(chat, '💰 Add balance — pick a client:', await clientButtons('bal')); }
  if (action === 'bal' && id) { state.set(chat, { mode: 'amount', uid: id }); await answer(cqId, 'Send the € amount'); const u = await db.User.findById(id); return send(chat, `💰 Top up <b>${u ? u.username : id}</b>\nSend the amount in € (e.g. <code>18</code>). Negative deducts.`); }
  if (action === 'stat' && !id) { await answer(cqId); return send(chat, '💳 Check client — pick:', await clientButtons('stat')); }
  if (action === 'stat' && id) { await answer(cqId); return send(chat, await statusCard(id), [[{ text: '⬅️ Menu', callback_data: 'menu' }]]); }
  if (action === 'newc') { await answer(cqId); state.set(chat, { mode: 'nc_user', draft: {} }); return send(chat, '➕ <b>New client</b>\nSend the username (3+ chars, letters/digits/_.-):'); }
  if (action === 'test' && !id) { await answer(cqId); return send(chat, '🧪 Send test SMS as which client?', await clientButtons('test')); }
  if (action === 'test' && id) { await answer(cqId, 'Real SMS — costs credit'); state.set(chat, { mode: 'test_to', uid: id }); const u = await db.User.findById(id); return send(chat, `🧪 Test as <b>${u ? u.username : id}</b> (a REAL SMS, billed to them).\nSend the destination number:`); }
  if (action === 'price' && !id) { await answer(cqId); return send(chat, '💶 Set price — pick a client:', await clientButtons('price')); }
  if (action === 'price' && id) { await answer(cqId); state.set(chat, { mode: 'setprice', uid: id }); const u = await db.User.findById(id); return send(chat, `💶 New price per SMS for <b>${u ? u.username : id}</b> (now ${eur(u ? u.cost_per_sms : 0)}). Send € value, e.g. <code>0.018</code>:`); }
  if (action === 'thr' && !id) { await answer(cqId); return send(chat, '🔔 Set low-balance threshold — pick a client:', await clientButtons('thr')); }
  if (action === 'thr' && id) { await answer(cqId); state.set(chat, { mode: 'setthr', uid: id }); const u = await db.User.findById(id); return send(chat, `🔔 Low-balance threshold for <b>${u ? u.username : id}</b>. Send € value (e.g. <code>1000</code>), or <code>0</code> for global default:`); }
  if (action === 'rep' && !id) { await answer(cqId); return send(chat, '📅 Per-user report — pick:', await clientButtons('rep')); }
  if (action === 'rep' && id) { await answer(cqId); return send(chat, await reportCard(id), [[{ text: '⬅️ Menu', callback_data: 'menu' }]]); }
  if (action === 'susp' && !id) { await answer(cqId); return send(chat, '⏸/▶️ Toggle suspend — pick:', await clientButtons('susp')); }
  if (action === 'susp' && id) {
    const u = await db.User.findById(id); if (!u) { await answer(cqId); return; }
    await db.User.findByIdAndUpdate(id, { $set: { is_suspended: !u.is_suspended } });
    await answer(cqId, !u.is_suspended ? 'Suspended' : 'Resumed');
    return send(chat, `${!u.is_suspended ? '⏸ Suspended' : '▶️ Resumed'} <b>${u.username}</b>.`, await clientButtons('susp'));
  }
  if (action === 'pw' && !id) { await answer(cqId); return send(chat, '🔑 Reset password — pick a client:', await clientButtons('pw')); }
  if (action === 'pw' && id) {
    const u = await db.User.findById(id); if (!u) { await answer(cqId); return; }
    const np = pass8(); await db.User.findByIdAndUpdate(id, { $set: { password: await bcrypt.hash(np, 10) } });
    await answer(cqId, 'Password reset');
    return send(chat, `🔑 New password for <b>${u.username}</b>: <code>${np}</code>\n(used for portal login + SMPP bind)`, [[{ text: '⬅️ Menu', callback_data: 'menu' }]]);
  }
  if (action === 'clients') { await answer(cqId); const u = await db.User.find({ role: { $in: ['client', 'reseller'] } }).sort({ username: 1 }).limit(50); return send(chat, '👥 <b>Clients</b>\n' + (u.map((x) => `${x.is_suspended ? '⏸' : '•'} <b>${x.username}</b> ${eur(x.credits)}`).join('\n') || 'none'), [[{ text: '⬅️ Menu', callback_data: 'menu' }]]); }
  if (action === 'totals') { await answer(cqId); return send(chat, await totalsCard(), [[{ text: '⬅️ Menu', callback_data: 'menu' }]]); }
  if (action === 'low') { await answer(cqId); return send(chat, await lowCard(), [[{ text: '⬅️ Menu', callback_data: 'menu' }]]); }
  await answer(cqId);
}

async function handle(update, admins) {
  const msg = update.message || update.edited_message;
  const cq = update.callback_query;
  const chat = msg ? msg.chat.id : (cq ? cq.message.chat.id : null);
  const fromId = msg ? (msg.from && msg.from.id) : (cq && cq.from && cq.from.id);
  if (chat == null) return;
  if (!admins.has(String(fromId)) && !admins.has(String(chat))) {
    // Not authorized — give a bootstrap hint only.
    if (cq) await answer(cq.id, 'Not authorized');
    if (msg) await send(chat, `⛔ Not authorized.\nYour chat id is <code>${fromId}</code> — add it to <b>TG_ADMIN_IDS</b> (or set it as the alert chat_id in Settings) to use this bot.`);
    return;
  }
  try {
    if (cq) return await onCallback(chat, cq.data || '', cq.id);
    if (msg && msg.text) return await onText(chat, msg.text.trim());
  } catch (e) {
    console.error('[tgbot] handler', e.message);
    state.delete(chat); // reset any half-finished wizard so the user isn't stuck
    try { await send(chat, '⚠️ Something went wrong: ' + e.message, MENU); } catch (_) {}
  }
}

// ---- main poll loop ----
async function main() {
  await db.connect();
  let offset = 0; let commandsSet = false;
  console.log('[tgbot] starting…');
  for (;;) {
    const cfg = await loadConfig();
    if (!cfg.token) { console.log('[tgbot] no TG_BOT_TOKEN (env or Settings) — waiting 20s'); await new Promise((r) => setTimeout(r, 20000)); continue; }
    TOKEN = cfg.token;
    if (!commandsSet) { // make /start & /menu show in Telegram's command menu
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Open the control menu' }, { command: 'menu', description: 'Open the control menu' }] });
      commandsSet = true;
    }
    if (!cfg.admins.size) console.log('[tgbot] WARN: no TG_ADMIN_IDS configured — bot will only hand out chat ids until one is set.');
    const res = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
    if (!res || !res.ok) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const upd of res.result) {
      offset = upd.update_id + 1;
      try { await handle(upd, cfg.admins); } catch (e) { console.error('[tgbot] handler', e.message); }
    }
  }
}
if (require.main === module) main().catch((e) => { console.error('[tgbot] fatal', e); process.exit(1); });

module.exports = { handle, onText, onCallback, setTransport, state, statusCard, totalsCard, reportCard, lowCard, clientButtons };
