/**
 * portal/server.js — customer self-service portal + public HTTP SMS API.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('../db');
const engine = require('../shared/engine');

const PORT = Number(process.env.PORTAL_PORT || 4000);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'portal-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 8 * 3600 * 1000 } }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[portal]', e); res.status(500).json({ error: e.message }); });
const auth = (req, res, next) => req.session && req.session.uid ? next() : res.status(401).json({ error: 'unauthorized' });
const resellerAuth = (req, res, next) => req.session && req.session.role === 'reseller' ? next() : res.status(403).json({ error: 'resellers only' });

async function currentUser(req) { return db.User.findById(req.session.uid); }

// ---------------- session auth ----------------
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = await db.User.findOne({ username: String(username || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(password || '', u.password))) return res.status(401).json({ error: 'invalid credentials' });
  if (u.role === 'admin') return res.status(403).json({ error: 'use the admin panel' });
  if (u.is_suspended) return res.status(403).json({ error: 'account suspended' });
  req.session.uid = String(u._id); req.session.role = u.role; req.session.username = u.username;
  await db.User.findByIdAndUpdate(u._id, { $set: { last_login_at: new Date() } });
  res.json({ ok: true, role: u.role });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  res.json({ id: String(u._id), username: u.username, role: u.role, credits: u.credits, currency: u.currency, cost_per_sms: u.cost_per_sms, webhook_url: u.webhook_url, default_sender_id: u.default_sender_id, plan_name: u.plan_name, timezone: u.timezone || '' });
}));

// ---------------- dashboard / logs / billing ----------------
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const today = db.dayKey();
  const [todayCount, sentCount, recent, daily, invoices] = await Promise.all([
    db.MessageLog.countDocuments({ username: u.username, day: today }),
    db.MessageLog.countDocuments({ username: u.username, status: 'sent' }),
    db.MessageLog.find({ username: u.username }).sort({ createdAt: -1 }).limit(10),
    db.MessageLog.aggregate([{ $match: { username: u.username } }, { $group: { _id: '$day', count: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits_used' } } }, { $sort: { _id: -1 } }, { $limit: 14 }]),
    db.Invoice.find({ client_id: u._id, status: { $in: ['unpaid', 'partial'] } }),
  ]);
  const outstanding = +invoices.reduce((a, i) => a + (i.total - (i.paid || 0)), 0).toFixed(2);
  res.json({
    username: u.username, credits: u.credits, currency: u.currency, cost_per_sms: u.cost_per_sms,
    smpp: { host: process.env.PUBLIC_HOST || 'your-server', port: Number(process.env.SMPP_PORT || 2775), system_id: u.username },
    todayCount, sentCount, recent, outstanding,
    daily: daily.map((d) => ({ day: d._id, count: d.count, parts: d.parts, credits: +(d.credits || 0).toFixed(2) })),
  });
}));
app.get('/api/logs', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const q = { username: u.username };
  if (req.query.dest) q.destination = new RegExp('^' + String(req.query.dest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (req.query.dlr) q.dlr_status = req.query.dlr;
  res.json(await db.MessageLog.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)));
}));
app.get('/api/transactions', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  res.json(await db.CreditTransaction.find({ username: u.username }).sort({ createdAt: -1 }).limit(200));
}));

// ---- invoices (client view) ----
app.get('/api/invoices', auth, wrap(async (req, res) => {
  const invoices = await db.Invoice.find({ client_id: req.session.uid }).sort({ createdAt: -1 }).limit(200);
  const outstanding = invoices.filter((i) => i.status !== 'paid' && i.status !== 'void')
    .reduce((a, i) => a + (i.total - (i.paid || 0)), 0);
  res.json({ invoices, outstanding: +outstanding.toFixed(2) });
}));
app.get('/api/invoices/:id', auth, wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv || String(inv.client_id) !== String(req.session.uid)) return res.status(404).json({ error: 'not found' });
  const payments = await db.Payment.find({ invoice_id: inv._id }).sort({ createdAt: -1 });
  res.json({ ...(inv.toObject ? inv.toObject() : inv), id: String(inv._id), payments });
}));

// ---------------- web SMS (browser) ----------------
app.post('/api/send', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  const d = await engine.accept(u, String(to), String(text), u.default_sender_id || '', 'http');
  if (!d.ok) return res.status(d.httpStatus).json({ error: d.reason });
  engine.fireDispatch(d.prepared).catch(() => {});
  res.status(202).json({ ok: true, message_id: d.messageId });
}));

// ---------------- settings ----------------
app.post('/api/settings', auth, wrap(async (req, res) => {
  const allowed = ['webhook_url', 'webhook_secret', 'telegram_bot_token', 'telegram_chat_id', 'default_sender_id', 'timezone'];
  const set = {}; for (const k of allowed) if (k in (req.body || {})) set[k] = req.body[k];
  await db.User.findByIdAndUpdate(req.session.uid, { $set: set });
  res.json({ ok: true });
}));
app.post('/api/change-password', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const { current, next } = req.body || {};
  if (!(await bcrypt.compare(current || '', u.password))) return res.status(400).json({ error: 'current password wrong' });
  if (!next || String(next).length !== 8) return res.status(400).json({ error: 'new password must be exactly 8 characters' });
  await db.User.findByIdAndUpdate(u._id, { $set: { password: await bcrypt.hash(next, 10) } });
  res.json({ ok: true });
}));

// ---------------- timezones + own usage by date (client self-service) ----------------
async function panelTz() {
  const s = await db.Setting.findOne({ key: 'general' });
  return (s && s.value && s.value.timezone) || db.DEFAULT_TZ;
}
app.get('/api/timezones', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  res.json({ list: db.TIMEZONES, panel: await panelTz(), user: u.timezone || '' });
}));
app.get('/api/usage', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const tz = (req.query.tz && String(req.query.tz)) || u.timezone || await panelTz();
  const match = { username: u.username }; // scoped: a client only ever sees their own usage
  if (req.query.from) (match.at = match.at || {}).$gte = new Date(new Date(req.query.from + 'T00:00:00Z').getTime() - 86400000);
  if (req.query.to) (match.at = match.at || {}).$lte = new Date(new Date(req.query.to + 'T00:00:00Z').getTime() + 2 * 86400000);
  const rows = await db.UsageEvent.aggregate([
    { $match: match },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } },
      count: { $sum: 1 },
      sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      parts: { $sum: '$parts' }, credits: { $sum: '$credits' },
    } },
    { $sort: { _id: -1 } },
  ]);
  let out = rows.map((r) => ({ day: r._id, count: r.count, sent: r.sent, failed: r.failed, parts: r.parts, credits: +(r.credits || 0).toFixed(2) }));
  if (req.query.from) out = out.filter((r) => r.day >= req.query.from);
  if (req.query.to) out = out.filter((r) => r.day <= req.query.to);
  res.json({ tz, rows: out });
}));

// ---------------- API keys (self-service, scoped to the logged-in client) ----------------
app.get('/api/apikeys', auth, wrap(async (req, res) => {
  res.json(await db.ApiKey.find({ user_id: req.session.uid }).sort({ createdAt: -1 }));
}));
app.post('/api/apikeys', auth, wrap(async (req, res) => {
  const u = await currentUser(req);
  const key = db.genApiKey();
  await db.ApiKey.create({ key, user_id: u._id, username: u.username, label: (req.body && req.body.label) || '' });
  res.status(201).json({ key });
}));
async function ownKey(req) {
  const k = await db.ApiKey.findById(req.params.id);
  return k && String(k.user_id) === String(req.session.uid) ? k : null;
}
app.patch('/api/apikeys/:id', auth, wrap(async (req, res) => {
  const k = await ownKey(req); if (!k) return res.status(404).json({ error: 'not found' });
  k.is_active = !!(req.body || {}).is_active; await k.save();
  res.json({ ok: true });
}));
app.delete('/api/apikeys/:id', auth, wrap(async (req, res) => {
  const k = await ownKey(req); if (!k) return res.status(404).json({ error: 'not found' });
  await db.ApiKey.deleteOne({ _id: k._id });
  res.json({ ok: true });
}));

// ---------------- reseller sub-accounts ----------------
app.get('/api/reseller/clients', auth, resellerAuth, wrap(async (req, res) => {
  const clients = await db.User.find({ reseller_id: req.session.uid });
  res.json(clients.map((c) => ({ id: String(c._id), username: c.username, credits: c.credits, rate_per_credit: c.rate_per_credit, is_suspended: c.is_suspended })));
}));
app.post('/api/reseller/clients', auth, resellerAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: 'username & password required' });
  if (String(b.password).length !== 8) return res.status(400).json({ error: 'password must be exactly 8 characters' });
  if (await db.User.findOne({ username: String(b.username).toLowerCase() })) return res.status(409).json({ error: 'username taken' });
  const reseller = await currentUser(req);
  const c = await db.User.create({
    username: String(b.username).toLowerCase(), password: await bcrypt.hash(b.password, 10), role: 'client',
    reseller_id: reseller._id, cost_per_sms: Number(b.cost_per_sms) || reseller.cost_per_sms || 1,
    rate_per_credit: Number(b.rate_per_credit) || 1, route_id: reseller.route_id || null,
  });
  res.status(201).json({ id: String(c._id) });
}));
app.post('/api/reseller/clients/:id/topup', auth, resellerAuth, wrap(async (req, res) => {
  const reseller = await currentUser(req);
  const client = await db.User.findOne({ _id: req.params.id, reseller_id: reseller._id });
  if (!client) return res.status(404).json({ error: 'client not found' });
  const credits = Number((req.body || {}).credits);
  if (!Number.isFinite(credits) || credits <= 0) return res.status(400).json({ error: 'credits required' });
  // reseller pays out of their own balance
  if ((reseller.credits || 0) < credits) return res.status(402).json({ error: 'reseller has insufficient credits' });
  await db.addCredits(reseller.username, -credits, { type: 'adjustment', note: `transfer to ${client.username}`, by: reseller.username });
  await db.addCredits(client.username, credits, { type: 'topup', note: `from reseller ${reseller.username}`, by: reseller.username });
  const rate = client.rate_per_credit || 1;
  await db.ResellerBill.create({ reseller_id: reseller._id, client_id: client._id, client_username: client.username, credits, rate, total: +(credits * rate).toFixed(2) });
  res.json({ ok: true });
}));
app.get('/api/reseller/bills', auth, resellerAuth, wrap(async (req, res) => {
  res.json(await db.ResellerBill.find({ reseller_id: req.session.uid }).sort({ createdAt: -1 }).limit(200));
}));
app.post('/api/reseller/bills/:id/pay', auth, resellerAuth, wrap(async (req, res) => {
  const bill = await db.ResellerBill.findById(req.params.id);
  if (!bill || String(bill.reseller_id) !== String(req.session.uid)) return res.status(404).json({ error: 'not found' });
  const pay = Number((req.body || {}).amount) || 0;
  const paid = (bill.paid || 0) + pay;
  const status = paid >= bill.total ? 'paid' : paid > 0 ? 'partial' : 'pending';
  await db.ResellerBill.findByIdAndUpdate(bill._id, { $set: { paid, status } });
  res.json({ ok: true, status });
}));

// ================= PUBLIC HTTP SMS API =================
async function apiAuth(req) {
  // Preferred: API key via `X-API-Key` header (or `api_key` in body / Bearer token).
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const apiKey = (req.headers['x-api-key'] || (req.body && req.body.api_key) || bearer || '').toString().trim();
  if (apiKey) {
    const k = await db.ApiKey.findOne({ key: apiKey, is_active: true });
    if (!k) return null;
    const u = await db.User.findById(k.user_id);
    if (!u) return null;
    db.ApiKey.updateOne({ _id: k._id }, { $inc: { calls: 1 }, $set: { last_used_at: new Date() } }).catch(() => {});
    return u;
  }
  // Fallback: username + password (header or body).
  const user = (req.headers['x-api-user'] || (req.body && req.body.username) || '').toString().toLowerCase();
  const pass = (req.headers['x-api-pass'] || (req.body && req.body.password) || '').toString();
  if (!user || !pass) return null;
  const u = await db.User.findOne({ username: user });
  if (!u || !(await bcrypt.compare(pass, u.password))) return null;
  return u;
}
app.post('/api/v1/sms/send', wrap(async (req, res) => {
  const u = await apiAuth(req);
  if (!u) return res.status(401).json({ error: 'invalid api credentials' });
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  const d = await engine.accept(u, String(to), String(text), u.default_sender_id || '', 'http');
  if (!d.ok) return res.status(d.httpStatus).json({ error: d.reason });
  engine.fireDispatch(d.prepared).catch(() => {});
  res.status(202).json({ status: 'queued', message_id: d.messageId });
}));
app.get('/api/v1/sms/coverage', wrap(async (req, res) => {
  res.json({ ok: true, prefixes: (await db.RoutingRule.find({ is_active: true })).map((r) => r.prefix) });
}));

// ================= DEVICE CONTROL API (CYD touchscreen hub) =================
// Admin-scoped API key (X-API-Key) → same management actions as the Telegram hub.
// This key moves money — issue a dedicated, revocable 'admin' scope key for the device.
async function deviceAuth(req, res) {
  const key = (req.headers['x-api-key'] || '').toString().trim();
  if (!key) { res.status(401).json({ error: 'api key required' }); return null; }
  const k = await db.ApiKey.findOne({ key, is_active: true, scope: 'admin' });
  if (!k) { res.status(403).json({ error: 'not an admin device key' }); return null; }
  db.ApiKey.updateOne({ _id: k._id }, { $inc: { calls: 1 }, $set: { last_used_at: new Date() } }).catch(() => {});
  return k;
}
const dev = (fn) => wrap(async (req, res) => { const k = await deviceAuth(req, res); if (!k) return; await fn(req, res); });
async function devTz() { const s = await db.Setting.findOne({ key: 'general' }); return (s && s.value && s.value.timezone) || db.DEFAULT_TZ; }
const clientView = (u) => ({ id: String(u._id), username: u.username, credits: db.round3(u.credits || 0), price: u.cost_per_sms, suspended: !!u.is_suspended, threshold: u.low_balance_threshold, sms_left: u.cost_per_sms > 0 ? Math.floor((u.credits || 0) / u.cost_per_sms) : null });

// Dashboard summary
app.get('/api/device/summary', dev(async (req, res) => {
  const tz = await devTz();
  const [all, today, dlr, users] = await Promise.all([
    db.UsageEvent.aggregate([{ $group: { _id: null, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } }]),
    db.UsageEvent.aggregate([{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, n: { $sum: 1 }, seg: { $sum: '$parts' } } }, { $sort: { _id: -1 } }, { $limit: 1 }]),
    db.MessageLog.aggregate([{ $group: { _id: '$dlr_status', n: { $sum: 1 } } }]),
    db.User.find({ role: { $in: ['client', 'reseller'] } }),
  ]);
  const a = all[0] || { n: 0, seg: 0, cr: 0 }; const by = {}; dlr.forEach((r) => by[r._id || 'unknown'] = r.n);
  const s = await db.Setting.findOne({ key: 'alerts' }); const g = (s && s.value && s.value.lowBalance) || 0;
  const low = users.filter((u) => { const t = u.low_balance_threshold != null ? u.low_balance_threshold : g; return u.is_active && t && (u.credits || 0) <= t; });
  res.json({
    tz, clients: users.length, suspended: users.filter((u) => u.is_suspended).length,
    revenue: db.round3(a.cr), total_msgs: a.n, total_seg: a.seg,
    today: today[0] ? { day: today[0]._id, msgs: today[0].n, seg: today[0].seg } : { msgs: 0, seg: 0 },
    dlr: { delivered: by.delivered || 0, accepted: by.accepted || 0, failed: (by.undelivered || 0) + (by.rejected || 0), pending: by.pending || 0 },
    low_balance: low.map(clientView),
  });
}));
// Live traffic graph: last 12 hourly buckets (total + failed) for a CYD bar chart.
app.get('/api/device/graph', dev(async (req, res) => {
  const now = Date.now(), since = new Date(now - 12 * 3600 * 1000);
  const evs = await db.UsageEvent.find({ at: { $gte: since } }, { at: 1, status: 1 }).lean();
  const bars = Array.from({ length: 12 }, () => ({ total: 0, failed: 0 }));
  for (const e of evs) {
    const hoursAgo = Math.floor((now - new Date(e.at).getTime()) / 3600000);
    if (hoursAgo >= 0 && hoursAgo < 12) { const i = 11 - hoursAgo; bars[i].total++; if (e.status === 'failed') bars[i].failed++; }
  }
  res.json({ bars, max: Math.max(1, ...bars.map((b) => b.total)) });
}));
// Clients
app.get('/api/device/clients', dev(async (req, res) => {
  const users = await db.User.find({ role: { $in: ['client', 'reseller'] } }).sort({ username: 1 });
  res.json(users.map(clientView));
}));
app.get('/api/device/client/:id', dev(async (req, res) => {
  const u = await db.User.findById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  const tz = await devTz();
  const tot = (await db.UsageEvent.aggregate([{ $match: { username: u.username } }, { $group: { _id: null, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } }]))[0] || { n: 0, seg: 0, cr: 0 };
  const days = await db.UsageEvent.aggregate([{ $match: { username: u.username } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, n: { $sum: 1 }, seg: { $sum: '$parts' }, cr: { $sum: '$credits' } } }, { $sort: { _id: -1 } }, { $limit: 7 }]);
  res.json({ ...clientView(u), totals: { msgs: tot.n, seg: tot.seg, spent: db.round3(tot.cr) }, daily: days.map((d) => ({ day: d._id, msgs: d.n, seg: d.seg, spent: db.round3(d.cr) })) });
}));
// Mutations
app.post('/api/device/client/:id/balance', dev(async (req, res) => {
  const u = await db.User.findById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  const amt = Number((req.body || {}).amount); if (!isFinite(amt) || amt === 0) return res.status(400).json({ error: 'amount required' });
  const r = await db.addCredits(u.username, amt, { type: amt >= 0 ? 'topup' : 'adjustment', by: 'cyd', note: 'via CYD control hub' });
  res.json({ ok: true, balance: r.balance });
}));
app.post('/api/device/client/:id/suspend', dev(async (req, res) => {
  const sus = !!(req.body || {}).suspend;
  await db.User.findByIdAndUpdate(req.params.id, { $set: { is_suspended: sus } });
  res.json({ ok: true, suspended: sus });
}));
app.post('/api/device/client/:id/price', dev(async (req, res) => {
  const p = Number((req.body || {}).price); if (!isFinite(p) || p < 0) return res.status(400).json({ error: 'price required' });
  await db.User.findByIdAndUpdate(req.params.id, { $set: { cost_per_sms: db.round3(p) } });
  res.json({ ok: true, price: db.round3(p) });
}));
app.post('/api/device/client/:id/threshold', dev(async (req, res) => {
  const raw = (req.body || {}).threshold; const t = (raw === null || raw === '' || Number(raw) === 0) ? null : Number(raw);
  if (t !== null && !isFinite(t)) return res.status(400).json({ error: 'bad threshold' });
  await db.User.findByIdAndUpdate(req.params.id, { $set: { low_balance_threshold: t === null ? null : db.round3(t) } });
  res.json({ ok: true, threshold: t });
}));
app.post('/api/device/client/:id/password', dev(async (req, res) => {
  const u = await db.User.findById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  const pw = Math.random().toString(36).slice(2, 10);
  await db.User.findByIdAndUpdate(u._id, { $set: { password: await bcrypt.hash(pw, 10) } });
  res.json({ ok: true, password: pw });
}));
app.post('/api/device/client', dev(async (req, res) => {
  const b = req.body || {}; const uname = String(b.username || '').toLowerCase().trim();
  if (!/^[a-z0-9_.-]{3,}$/.test(uname)) return res.status(400).json({ error: 'bad username' });
  if (await db.User.findOne({ username: uname })) return res.status(409).json({ error: 'exists' });
  const pw = Math.random().toString(36).slice(2, 10);
  const u = await db.User.create({ username: uname, password: await bcrypt.hash(pw, 10), role: 'client', cost_per_sms: db.round3(Number(b.price) || 1), credits: db.round3(Number(b.balance) || 0), bypass_template: true });
  res.status(201).json({ ok: true, id: String(u._id), username: u.username, password: pw });
}));
// Critical alerts feed for the device (low/zero balance, failed sends, suspended clients).
app.get('/api/device/alerts', dev(async (req, res) => {
  const s = await db.Setting.findOne({ key: 'alerts' }); const g = (s && s.value && s.value.lowBalance) || 0;
  const users = await db.User.find({ role: { $in: ['client', 'reseller'] }, is_active: true });
  const alerts = [];
  for (const u of users) {
    const thr = u.low_balance_threshold != null ? u.low_balance_threshold : g;
    if ((u.credits || 0) <= 0) alerts.push({ level: 'critical', type: 'balance', msg: `${u.username}: OUT OF CREDIT` });
    else if (thr && (u.credits || 0) <= thr) alerts.push({ level: 'warn', type: 'balance', msg: `${u.username}: low EUR ${db.round3(u.credits)}` });
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const failed24 = await db.UsageEvent.countDocuments({ status: 'failed', at: { $gte: since } });
  if (failed24 > 0) alerts.push({ level: failed24 >= 10 ? 'critical' : 'warn', type: 'failed', msg: `${failed24} failed sends (24h)` });
  const susp = users.filter((u) => u.is_suspended).length;
  if (susp) alerts.push({ level: 'warn', type: 'suspended', msg: `${susp} client(s) suspended` });
  // Manual test alert (fired from the admin "Test alert" button) — active for 90s.
  const ta = await db.Setting.findOne({ key: 'device_test_alert' });
  if (ta && ta.value && ta.value.until > Date.now()) alerts.unshift({ level: 'critical', type: 'test', msg: ta.value.msg || 'TEST ALERT' });
  alerts.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  res.json({ alerts, count: alerts.length, critical: alerts.filter((a) => a.level === 'critical').length });
}));
// Send a test SMS as a client (REAL send)
app.post('/api/device/client/:id/test', dev(async (req, res) => {
  const u = await db.User.findById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  const { to, text } = req.body || {}; if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  const d = await engine.accept(u, String(to), String(text), u.default_sender_id || '', 'http');
  if (!d.ok) return res.status(d.httpStatus).json({ error: d.reason });
  const r = await engine.fireDispatch(d.prepared);
  res.json({ ok: r.success, dlr: r.dlr, via: r.via, error: r.error, charged: d.prepared.cost });
}));

// no-cache so UI changes always show without a hard refresh (ETag still gives fast 304s).
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

db.connect().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`[portal] portal + public API on http://0.0.0.0:${PORT}`)))
  .catch((e) => { console.error('portal fatal', e); process.exit(1); });
