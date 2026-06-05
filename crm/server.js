/**
 * crm/server.js — standalone CRM for the SMS business (port 5000).
 *
 * Client relationship management + payment tracking + invoicing on top of the
 * existing smpp_bridge MongoDB: profiles & timeline notes, leads pipeline,
 * follow-up reminders (Telegram), manual + auto-USDT payments, receipt /
 * manual invoices with PDF, and tz-aware monthly statements.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const telegram = require('../telegram');
const M = require('./models');
const { recordPayment, getCrmSettings } = require('./billing');
const crypto2 = require('./crypto');
const pdf = require('./pdf');
const mailer = require('./mailer');
const imap = require('./imap');
const { PassThrough } = require('stream');

const PORT = Number(process.env.CRM_PORT || 5000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
const MongoStore = require('connect-mongo').default; // v6 exports the class as .default in CJS
app.use(session({
  secret: process.env.CRM_SESSION_SECRET || process.env.SESSION_SECRET || 'crm-secret',
  resave: false, saveUninitialized: false, rolling: true,
  // Persist sessions in Mongo so a CRM restart no longer logs everyone out.
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smpp_bridge',
    collectionName: 'crm_sessions', ttl: 7 * 24 * 3600, // 7 days
  }),
  cookie: { maxAge: 7 * 24 * 3600 * 1000 }, // 7 days; rolling refreshes on each request
}));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[crm]', e); res.status(500).json({ error: e.message }); });
const requireAuth = (req, res, next) => req.session && req.session.admin ? next() : res.status(401).json({ error: 'unauthorized' });
const lc = (s) => String(s || '').toLowerCase().trim();

// ---------------- auth (same accounts as the admin panel) ----------------
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) { req.session.admin = { username }; return res.json({ ok: true }); }
  const u = await db.User.findOne({ username: lc(username), role: 'admin' });
  if (u && await bcrypt.compare(password || '', u.password)) { req.session.admin = { username: u.username }; return res.json({ ok: true }); }
  res.status(401).json({ error: 'invalid credentials' });
}));
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.admin));
app.use('/api', requireAuth);

app.get('/api/timezones', wrap(async (req, res) => res.json({ list: db.TIMEZONES, panel: db.DEFAULT_TZ })));

// ---------------- helpers ----------------
// UTC instant of a local wall-clock time in a tz (iterative offset trick —
// correct for Nepal's +5:45 and DST boundaries).
function localToUtc(ymdhms, tz) {
  const wanted = new Date(ymdhms + 'Z').getTime();
  let guess = new Date(wanted);
  for (let i = 0; i < 3; i++) {
    const offset = new Date(guess.toLocaleString('en-US', { timeZone: tz })).getTime() - guess.getTime();
    const next = new Date(wanted - offset);
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}
function monthRange(period, tz) { // period 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
  const [y, m] = period.split('-').map(Number);
  const start = localToUtc(`${period}-01T00:00:00`, tz);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const end = localToUtc(`${next}-01T00:00:00`, tz);
  return { start, end };
}

async function profileFor(username) {
  return (await M.CrmProfile.findOne({ username })) || {};
}

// ---------------- dashboard ----------------
app.get('/api/dashboard', wrap(async (req, res) => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1));

  const [revMonth, revLast, revTotal, monthly, clients, unpaidInv, pendingIntents, leads, tasks, recentPayments] = await Promise.all([
    db.Payment.aggregate([{ $match: { status: 'confirmed', createdAt: { $gte: monthStart } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    db.Payment.aggregate([{ $match: { status: 'confirmed', createdAt: { $gte: lastMonthStart, $lt: monthStart } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    db.Payment.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    db.Payment.aggregate([
      { $match: { status: 'confirmed', createdAt: { $gte: yearStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, s: { $sum: '$amount' }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    db.User.countDocuments({ role: { $ne: 'admin' } }),
    db.Invoice.aggregate([{ $match: { type: 'manual', status: { $in: ['unpaid', 'partial'] } } }, { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $subtract: ['$total', '$paid'] } } } }]),
    M.CryptoIntent.countDocuments({ status: 'pending' }),
    M.CrmLead.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 }, value: { $sum: '$est_value' } } }]),
    M.CrmActivity.find({ due_at: { $ne: null }, done: false }).sort({ due_at: 1 }).limit(6),
    db.Payment.find({}).sort({ createdAt: -1 }).limit(8),
  ]);
  const leadStages = {}; leads.forEach((l) => leadStages[l._id] = { n: l.n, value: db.round3(l.value) });
  res.json({
    revenue: {
      month: db.round3(revMonth[0] ? revMonth[0].s : 0),
      lastMonth: db.round3(revLast[0] ? revLast[0].s : 0),
      total: db.round3(revTotal[0] ? revTotal[0].s : 0),
      monthly,
    },
    clients,
    unpaidInvoices: unpaidInv[0] ? { count: unpaidInv[0].n, due: db.round3(unpaidInv[0].due) } : { count: 0, due: 0 },
    pendingIntents,
    leadStages,
    tasks, recentPayments,
  });
}));

// ---------------- SMS provider routes (for assigning to clients) ----------------
app.get('/api/routes', wrap(async (req, res) => {
  const routes = await db.Route.find({}).sort({ name: 1 });
  res.json(routes.map((r) => ({ id: String(r._id), name: r.name, type: r.type, is_active: r.is_active })));
}));

// Account-level settings the operator manages day-to-day (routing, price, suspend, content mode).
app.patch('/api/clients/:username/account', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const u = await db.User.findOne({ username });
  if (!u) return res.status(404).json({ error: 'client not found' });
  const b = req.body || {};
  const set = {};
  if ('route_id' in b) set.route_id = b.route_id || null;
  if ('backup_route_id' in b) set.backup_route_id = b.backup_route_id || null;
  if ('cost_per_sms' in b) {
    const c = Number(b.cost_per_sms);
    if (!(c > 0)) return res.status(400).json({ error: 'cost_per_sms must be > 0' });
    set.cost_per_sms = db.round3(c);
  }
  if ('is_suspended' in b) set.is_suspended = !!b.is_suspended;
  if ('max_mps' in b) set.max_mps = Math.max(1, Number(b.max_mps) || 10);
  if ('bypass_template' in b) set.bypass_template = !!b.bypass_template; // false = auto-template (numbers-only)
  if ('low_balance_threshold' in b) set.low_balance_threshold = b.low_balance_threshold === null || b.low_balance_threshold === '' ? null : Number(b.low_balance_threshold);
  await db.User.updateOne({ _id: u._id }, { $set: set });
  res.json({ ok: true });
}));

// Adjust a client's balance directly (top-up / bonus / correction) — no payment record.
app.post('/api/clients/:username/topup', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const u = await db.User.findOne({ username });
  if (!u) return res.status(404).json({ error: 'client not found' });
  const amount = db.round3((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount required (use a negative number to deduct)' });
  const note = String((req.body || {}).note || '').trim();
  const r = await db.addCredits(username, amount, {
    type: amount > 0 ? 'topup' : 'adjustment',
    note: note || (amount > 0 ? 'manual credit' : 'manual adjustment'),
    by: req.session.admin.username,
  });
  await M.CrmActivity.create({
    ref_type: 'client', ref_id: username, ref_name: username, kind: 'system',
    body: `Balance ${amount > 0 ? '+' : ''}€${amount.toFixed(2)} (${note || 'manual adjustment'}) → €${db.round3(r.balance).toFixed(3)}`,
    by: req.session.admin.username,
  }).catch(() => {});
  res.json({ ok: true, balance: r.balance });
}));

// Change a client's SMPP/portal password (operator-set, any length).
app.post('/api/clients/:username/password', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const u = await db.User.findOne({ username });
  if (!u) return res.status(404).json({ error: 'client not found' });
  const pw = String((req.body || {}).password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  await db.User.updateOne({ _id: u._id }, { $set: { password: await bcrypt.hash(pw, 10) } });
  await M.CrmActivity.create({ ref_type: 'client', ref_id: username, ref_name: username, kind: 'system', body: 'SMPP/portal password changed', by: req.session.admin.username }).catch(() => {});
  res.json({ ok: true });
}));

// IP whitelist — client may bind/send ONLY from these IPs (empty = any).
app.put('/api/clients/:username/ips', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const u = await db.User.findOne({ username });
  if (!u) return res.status(404).json({ error: 'client not found' });
  const b = req.body || {};
  const raw = Array.isArray(b.allowed_ips) ? b.allowed_ips : String(b.allowed_ips || '').split(/[\s,]+/);
  const ips = raw.map((s) => String(s).trim()).filter(Boolean);
  const bad = ips.find((ip) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip));
  if (bad) return res.status(400).json({ error: 'not a valid IPv4 address: ' + bad });
  await db.User.updateOne({ _id: u._id }, { $set: { allowed_ips: ips } });
  res.json({ ok: true, allowed_ips: ips });
}));

// ---------------- traffic & DLR ----------------
function dayRangeTz(tz) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = localToUtc(`${ymd}T00:00:00`, tz);
  return { start, end: new Date(start.getTime() + 864e5), ymd };
}
const DLR_KEYS = ['delivered', 'accepted', 'undelivered', 'rejected', 'expired', 'unknown', 'pending'];

// Overall snapshot: DLR breakdown (MessageLog, last N days) + sending totals (UsageEvent, persistent).
app.get('/api/traffic/summary', wrap(async (req, res) => {
  const tz = req.query.tz || db.DEFAULT_TZ;
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * 864e5);
  const { start: todayStart } = dayRangeTz(tz);
  const monthStart = localToUtc(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date()) + '-01T00:00:00', tz);

  const match = { createdAt: { $gte: since } };
  if (req.query.username) match.username = lc(req.query.username);
  const ueMatch = {}; if (req.query.username) ueMatch.username = lc(req.query.username);

  const [dlrAgg, statusAgg, totAll, totToday, totMonth] = await Promise.all([
    db.MessageLog.aggregate([{ $match: match }, { $group: { _id: '$dlr_status', n: { $sum: 1 }, parts: { $sum: '$parts' } } }]),
    db.MessageLog.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    db.UsageEvent.aggregate([{ $match: ueMatch }, { $group: { _id: '$status', n: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' } } }]),
    db.UsageEvent.aggregate([{ $match: { ...ueMatch, at: { $gte: todayStart } } }, { $group: { _id: null, n: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' } } }]),
    db.UsageEvent.aggregate([{ $match: { ...ueMatch, at: { $gte: monthStart } } }, { $group: { _id: null, n: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' } } }]),
  ]);
  const dlr = {}; DLR_KEYS.forEach((k) => dlr[k] = 0);
  let dlrTotal = 0; dlrAgg.forEach((d) => { if (d._id) { dlr[d._id] = d.n; dlrTotal += d.n; } });
  const status = { sent: 0, submitted: 0, failed: 0, refunded: 0 }; statusAgg.forEach((s) => { if (s._id != null) status[s._id] = s.n; });
  const sumUE = (rows) => rows.reduce((a, r) => ({ messages: a.messages + r.n, parts: a.parts + r.parts, credits: db.round3(a.credits + r.credits), failed: a.failed + (r._id === 'failed' ? r.n : 0) }), { messages: 0, parts: 0, credits: 0, failed: 0 });
  res.json({
    days, tz,
    dlr, dlrTotal,
    deliveredPct: dlrTotal ? Math.round((dlr.delivered + dlr.accepted) / dlrTotal * 100) : 0,
    status,
    sending: {
      all: sumUE(totAll),
      today: sumUE(totToday),
      month: sumUE(totMonth),
    },
  });
}));

// Permanent DLR history from the file archive (any date range, not just 7 days).
const dlrlog = require('../shared/dlrlog');
app.get('/api/traffic/dlr-history', wrap(async (req, res) => {
  const tz = req.query.tz || db.DEFAULT_TZ;
  const from = req.query.from ? localToUtc(req.query.from + 'T00:00:00', tz) : new Date(Date.now() - 30 * 864e5);
  const to = req.query.to ? new Date(localToUtc(req.query.to + 'T00:00:00', tz).getTime() + 864e5) : new Date();
  const recs = await dlrlog.query({ from, to, username: req.query.username ? lc(req.query.username) : null });
  const dlr = {}; DLR_KEYS.forEach((k) => dlr[k] = 0);
  let parts = 0, credits = 0, sent = 0, failed = 0;
  const byDay = {};
  for (const r of recs) {
    if (r.dlr_status && dlr[r.dlr_status] != null) dlr[r.dlr_status]++;
    parts += r.parts || 0; credits += r.credits || 0;
    if (r.status === 'failed') failed++; else sent++;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(r.at));
    const b = byDay[day] || (byDay[day] = { day, messages: 0, parts: 0, delivered: 0, failed: 0 });
    b.messages++; b.parts += r.parts || 0;
    if (r.dlr_status === 'delivered' || r.dlr_status === 'accepted') b.delivered++;
    if (r.status === 'failed') b.failed++;
  }
  const total = recs.length;
  res.json({
    tz, total, dlr, parts, credits: db.round3(credits), sent, failed,
    deliveredPct: total ? Math.round((dlr.delivered + dlr.accepted) / total * 100) : 0,
    days: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    months: dlrlog.months(),
  });
}));

// Daily sending buckets (tz-aware, persistent) — the long-term report.
app.get('/api/traffic/daily', wrap(async (req, res) => {
  const tz = req.query.tz || db.DEFAULT_TZ;
  const from = req.query.from, to = req.query.to;
  const match = {};
  if (req.query.username) match.username = lc(req.query.username);
  if (from) match.at = Object.assign(match.at || {}, { $gte: localToUtc(from + 'T00:00:00', tz) });
  if (to) match.at = Object.assign(match.at || {}, { $lt: new Date(localToUtc(to + 'T00:00:00', tz).getTime() + 864e5) });
  const rows = await db.UsageEvent.aggregate([
    { $match: match },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } },
      messages: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' },
      failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
    } },
    { $sort: { _id: 1 } },
  ]);
  res.json({ tz, rows: rows.map((r) => ({ day: r._id, messages: r.messages, parts: r.parts, credits: db.round3(r.credits), failed: r.failed, sent: r.messages - r.failed })) });
}));

// Per-client sending leaderboard (UsageEvent) + DLR delivered/failed (MessageLog), last N days.
app.get('/api/traffic/clients', wrap(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 864e5);
  const [usage, dlr] = await Promise.all([
    db.UsageEvent.aggregate([
      { $match: { at: { $gte: since } } },
      { $group: { _id: '$username', messages: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } },
      { $sort: { parts: -1 } }, { $limit: 100 },
    ]),
    db.MessageLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$username', delivered: { $sum: { $cond: [{ $in: ['$dlr_status', ['delivered', 'accepted']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } },
    ]),
  ]);
  const dmap = {}; dlr.forEach((d) => dmap[d._id] = d);
  res.json({ days, rows: usage.map((u) => ({
    username: u._id, messages: u.messages, parts: u.parts, credits: db.round3(u.credits), failed: u.failed,
    delivered7: dmap[u._id] ? dmap[u._id].delivered : 0,
  })) });
}));

// ---------------- clients (CRM view over Users) ----------------
app.get('/api/clients', wrap(async (req, res) => {
  const users = await db.User.find({ role: { $ne: 'admin' } }).sort({ createdAt: -1 });
  const usernames = users.map((u) => u.username);
  const [profiles, paid] = await Promise.all([
    M.CrmProfile.find({ username: { $in: usernames } }),
    db.Payment.aggregate([
      { $match: { status: 'confirmed', client_username: { $in: usernames } } },
      { $group: { _id: '$client_username', total: { $sum: '$amount' }, n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
  ]);
  const pmap = {}; profiles.forEach((p) => pmap[p.username] = p);
  const paymap = {}; paid.forEach((p) => paymap[p._id] = p);
  res.json(users.map((u) => ({
    id: String(u._id), username: u.username, role: u.role,
    credits: db.round3(u.credits), cost_per_sms: u.cost_per_sms,
    is_suspended: u.is_suspended, is_active: u.is_active, created: u.createdAt,
    profile: pmap[u.username] || null,
    revenue: paymap[u.username] ? db.round3(paymap[u.username].total) : 0,
    payments: paymap[u.username] ? paymap[u.username].n : 0,
    last_payment: paymap[u.username] ? paymap[u.username].last : null,
  })));
}));

// Create a client directly from the CRM: real User (SMPP/portal account) + CRM profile.
app.post('/api/clients', wrap(async (req, res) => {
  const b = req.body || {};
  const username = lc(b.username);
  if (!username || !b.password) return res.status(400).json({ error: 'username & password required' });
  if (String(b.password).length !== 8) return res.status(400).json({ error: 'password must be exactly 8 characters' });
  if (await db.User.findOne({ username })) return res.status(409).json({ error: 'username taken' });
  const u = await db.User.create({
    username, password: await bcrypt.hash(b.password, 10), role: 'client',
    credits: 0, cost_per_sms: Number(b.cost_per_sms) || 1,
    route_id: b.route_id || null,
  });
  const fields = {};
  for (const k of ['company', 'contact_name', 'email', 'phone', 'telegram', 'whatsapp', 'country', 'address', 'vat_id', 'source']) {
    if (b[k]) fields[k] = String(b[k]);
  }
  if (b.tags) fields.tags = Array.isArray(b.tags) ? b.tags : String(b.tags).split(',').map((s) => s.trim()).filter(Boolean);
  await M.CrmProfile.findOneAndUpdate({ username }, { $set: { ...fields, user_id: u._id } }, { upsert: true, setDefaultsOnInsert: true });
  // optional opening balance (records a CreditTransaction so statements line up)
  const initial = db.round3(b.credits);
  if (initial > 0) await db.addCredits(username, initial, { type: 'topup', note: 'initial balance', by: req.session.admin.username }).catch(() => {});
  await M.CrmActivity.create({
    ref_type: 'client', ref_id: username, ref_name: username, kind: 'system',
    body: 'Client created in CRM' + (initial > 0 ? ` with €${initial.toFixed(2)} opening balance` : ''), by: req.session.admin.username,
  });
  res.status(201).json({ ok: true, username, id: String(u._id) });
}));

app.get('/api/clients/:username', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const user = await db.User.findOne({ username });
  if (!user) return res.status(404).json({ error: 'not found' });
  const monthAgo = new Date(Date.now() - 30 * 864e5);
  const [profile, activities, payments, invoices, transactions, usage, intents] = await Promise.all([
    M.CrmProfile.findOne({ username }),
    M.CrmActivity.find({ ref_type: 'client', ref_id: username }).sort({ createdAt: -1 }).limit(100),
    db.Payment.find({ client_username: username }).sort({ createdAt: -1 }).limit(50),
    db.Invoice.find({ client_username: username }).sort({ createdAt: -1 }).limit(50),
    db.CreditTransaction.find({ username }).sort({ createdAt: -1 }).limit(30),
    db.UsageEvent.aggregate([
      { $match: { username, at: { $gte: monthAgo } } },
      { $group: { _id: null, parts: { $sum: '$parts' }, credits: { $sum: '$credits' }, n: { $sum: 1 } } },
    ]),
    M.CryptoIntent.find({ username }).sort({ createdAt: -1 }).limit(10),
  ]);
  const revenue = payments.filter((p) => p.status === 'confirmed').reduce((a, p) => a + p.amount, 0);
  res.json({
    user: {
      id: String(user._id), username, credits: db.round3(user.credits), cost_per_sms: user.cost_per_sms,
      is_suspended: user.is_suspended, is_active: user.is_active, created: user.createdAt,
      low_balance_threshold: user.low_balance_threshold,
      route_id: user.route_id ? String(user.route_id) : null,
      backup_route_id: user.backup_route_id ? String(user.backup_route_id) : null,
      allowed_ips: user.allowed_ips || [],
      bypass_template: user.bypass_template,
      max_mps: user.max_mps,
      has_own_templates: !!(user.templates && user.templates.length),
    },
    profile: profile || null, activities, payments, invoices, transactions, intents,
    usage30: usage[0] ? { parts: usage[0].parts, credits: db.round3(usage[0].credits), messages: usage[0].n } : { parts: 0, credits: 0, messages: 0 },
    revenue: db.round3(revenue),
  });
}));

app.put('/api/clients/:username/profile', wrap(async (req, res) => {
  const username = lc(req.params.username);
  const user = await db.User.findOne({ username });
  if (!user) return res.status(404).json({ error: 'client not found' });
  const b = req.body || {};
  const fields = {};
  for (const k of ['company', 'contact_name', 'email', 'phone', 'telegram', 'whatsapp', 'country', 'address', 'vat_id', 'source']) {
    if (k in b) fields[k] = String(b[k] || '');
  }
  if ('tags' in b) fields.tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  const p = await M.CrmProfile.findOneAndUpdate(
    { username }, { $set: { ...fields, user_id: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json(p);
}));

// ---------------- activities / timeline / tasks ----------------
app.get('/api/activities', wrap(async (req, res) => {
  const q = {};
  if (req.query.ref_type) q.ref_type = req.query.ref_type;
  if (req.query.ref_id) q.ref_id = req.query.ref_id;
  if (req.query.tasks === '1') { q.due_at = { $ne: null }; q.done = req.query.done === '1'; }
  const sort = req.query.tasks === '1' ? { due_at: 1 } : { createdAt: -1 };
  res.json(await M.CrmActivity.find(q).sort(sort).limit(300));
}));
app.post('/api/activities', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.ref_type || !b.ref_id) return res.status(400).json({ error: 'ref_type & ref_id required' });
  if (!b.body) return res.status(400).json({ error: 'body required' });
  const a = await M.CrmActivity.create({
    ref_type: b.ref_type, ref_id: String(b.ref_id), ref_name: b.ref_name || String(b.ref_id),
    kind: b.kind || 'note', body: String(b.body),
    due_at: b.due_at ? new Date(b.due_at) : null,
    by: req.session.admin.username,
  });
  res.status(201).json(a);
}));
app.patch('/api/activities/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const set = {};
  if ('body' in b) set.body = String(b.body);
  if ('kind' in b) set.kind = b.kind;
  if ('due_at' in b) { set.due_at = b.due_at ? new Date(b.due_at) : null; set.reminded = false; }
  if ('done' in b) { set.done = !!b.done; set.done_at = b.done ? new Date() : null; }
  const a = await M.CrmActivity.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  res.json(a);
}));
app.delete('/api/activities/:id', wrap(async (req, res) => {
  await M.CrmActivity.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

// ---------------- leads pipeline ----------------
const LEAD_FIELDS = ['name', 'company', 'email', 'phone', 'telegram', 'whatsapp', 'country', 'source', 'stage', 'est_value', 'est_volume', 'next_follow_up', 'lost_reason', 'notes'];
app.get('/api/leads', wrap(async (req, res) => {
  const q = {}; if (req.query.stage) q.stage = req.query.stage;
  res.json(await M.CrmLead.find(q).sort({ updatedAt: -1 }).limit(500));
}));
app.post('/api/leads', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const doc = {};
  for (const k of LEAD_FIELDS) if (k in b) doc[k] = b[k];
  if (doc.next_follow_up) doc.next_follow_up = new Date(doc.next_follow_up);
  res.status(201).json(await M.CrmLead.create(doc));
}));
app.patch('/api/leads/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const set = {};
  for (const k of LEAD_FIELDS) if (k in b) set[k] = b[k];
  if ('next_follow_up' in set) { set.next_follow_up = set.next_follow_up ? new Date(set.next_follow_up) : null; set.fu_reminded = false; }
  if ('est_value' in set) set.est_value = Number(set.est_value) || 0;
  if ('est_volume' in set) set.est_volume = Number(set.est_volume) || 0;
  const l = await M.CrmLead.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  res.json(l);
}));
app.delete('/api/leads/:id', wrap(async (req, res) => {
  await M.CrmLead.findByIdAndDelete(req.params.id);
  await M.CrmActivity.deleteMany({ ref_type: 'lead', ref_id: req.params.id });
  res.json({ ok: true });
}));
// Convert a won lead into a real client (User + CrmProfile, timeline preserved).
app.post('/api/leads/:id/convert', wrap(async (req, res) => {
  const lead = await M.CrmLead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  if (lead.converted_username) return res.status(400).json({ error: 'already converted → ' + lead.converted_username });
  const b = req.body || {};
  const username = lc(b.username);
  if (!username || !b.password) return res.status(400).json({ error: 'username & password required' });
  if (String(b.password).length !== 8) return res.status(400).json({ error: 'password must be exactly 8 characters' });
  if (await db.User.findOne({ username })) return res.status(409).json({ error: 'username taken' });
  const u = await db.User.create({
    username, password: await bcrypt.hash(b.password, 10), role: 'client',
    credits: 0, cost_per_sms: Number(b.cost_per_sms) || 1,
    route_id: b.route_id || null,
  });
  await M.CrmProfile.findOneAndUpdate({ username }, {
    $set: {
      user_id: u._id, company: lead.company, contact_name: lead.name, email: lead.email,
      phone: lead.phone, telegram: lead.telegram, whatsapp: lead.whatsapp,
      country: lead.country, source: lead.source || 'lead',
    },
  }, { upsert: true, setDefaultsOnInsert: true });
  // move the lead's timeline onto the client
  await M.CrmActivity.updateMany({ ref_type: 'lead', ref_id: String(lead._id) }, { $set: { ref_type: 'client', ref_id: username, ref_name: username } });
  await M.CrmActivity.create({
    ref_type: 'client', ref_id: username, ref_name: username, kind: 'system',
    body: `Converted from lead "${lead.name}"${lead.company ? ' (' + lead.company + ')' : ''}`,
    by: req.session.admin.username,
  });
  lead.stage = 'won'; lead.converted_username = username;
  await lead.save();
  res.status(201).json({ ok: true, username, id: String(u._id) });
}));

// ---------------- payments ----------------
app.get('/api/payments', wrap(async (req, res) => {
  const q = {};
  if (req.query.username) q.client_username = lc(req.query.username);
  if (req.query.method) q.method = req.query.method;
  res.json(await db.Payment.find(q).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 300));
}));
app.post('/api/payments', wrap(async (req, res) => {
  const b = req.body || {};
  const r = await recordPayment({
    username: b.username, amount: Number(b.amount),
    method: b.method || 'manual', reference: b.reference || '', note: b.note || '',
    credit: b.credit !== false, receipt: b.receipt !== false,
    by: req.session.admin.username,
  });
  await M.CrmActivity.create({
    ref_type: 'client', ref_id: lc(b.username), ref_name: lc(b.username), kind: 'system',
    body: `Payment €${Number(b.amount).toFixed(2)} (${b.method || 'manual'})${r.invoice ? ' — receipt ' + r.invoice.number : ''}`,
    by: req.session.admin.username,
  }).catch(() => {});
  res.status(201).json({
    ok: true, payment_id: String(r.payment._id),
    invoice: r.invoice ? { id: String(r.invoice._id), number: r.invoice.number } : null,
    balance: r.balance,
  });
}));

// ---------------- crypto auto top-ups (USDT TRC-20, direct wallet) ----------------
app.get('/api/crypto/rate', wrap(async (req, res) => res.json(await crypto2.getRate())));
app.get('/api/crypto/intents', wrap(async (req, res) => {
  const q = {}; if (req.query.status) q.status = req.query.status;
  res.json(await M.CryptoIntent.find(q).sort({ createdAt: -1 }).limit(100));
}));
app.post('/api/crypto/intents', wrap(async (req, res) => {
  const b = req.body || {};
  const intent = await crypto2.createIntent({ username: b.username, eur: Number(b.eur), by: req.session.admin.username });
  res.status(201).json(intent);
}));
app.post('/api/crypto/intents/:id/cancel', wrap(async (req, res) => {
  const i = await M.CryptoIntent.findById(req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  if (i.status !== 'pending') return res.status(400).json({ error: 'not pending' });
  i.status = 'cancelled'; await i.save();
  res.json({ ok: true });
}));
// Force an on-chain check now (the watcher also runs every 30s).
app.post('/api/crypto/check', wrap(async (req, res) => res.json(await crypto2.checkIntents())));
// Operator accepts a flagged wrong-amount tx — records the ACTUAL received value.
app.post('/api/crypto/intents/:id/accept', wrap(async (req, res) => {
  res.json(await crypto2.acceptTx(req.params.id, (req.body || {}).txid));
}));
// Wallet-address QR for an intent (PNG) — scan with any TRON wallet.
app.get('/api/crypto/intents/:id/qr', wrap(async (req, res) => {
  const i = await M.CryptoIntent.findById(req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'image/png');
  require('qrcode').toFileStream(res, i.wallet, { width: 220, margin: 1 });
}));

// ---------------- invoices ----------------
app.get('/api/invoices', wrap(async (req, res) => {
  const q = {};
  if (req.query.username) q.client_username = lc(req.query.username);
  if (req.query.type) q.type = req.query.type;
  if (req.query.status) q.status = req.query.status;
  res.json(await db.Invoice.find(q).sort({ createdAt: -1 }).limit(300));
}));
app.get('/api/invoices/:id', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const payments = await db.Payment.find({ invoice_id: inv._id }).sort({ createdAt: -1 });
  res.json({ ...inv.toObject(), id: String(inv._id), payments });
}));
app.post('/api/invoices', wrap(async (req, res) => {
  const b = req.body || {};
  const client = await db.User.findOne({ username: lc(b.username) });
  if (!client) return res.status(400).json({ error: 'client required' });
  const items = (b.items || []).map((it) => {
    const qty = Number(it.qty) || 1, up = Number(it.unit_price) || 0;
    return { description: it.description || '', qty, unit_price: up, amount: +(qty * up).toFixed(2) };
  }).filter((it) => it.description || it.amount);
  if (!items.length) return res.status(400).json({ error: 'at least one line item required' });
  const subtotal = +items.reduce((a, i) => a + i.amount, 0).toFixed(2);
  const tax = Number(b.tax) || 0;
  const inv = await db.Invoice.create({
    number: await db.nextInvoiceNumber(), type: 'manual',
    client_id: client._id, client_username: client.username,
    items, subtotal, tax, total: +(subtotal + tax).toFixed(2), currency: 'EUR',
    credits_on_pay: Number(b.credits_on_pay) || 0,
    due_date: b.due_date ? new Date(b.due_date) : null, note: b.note || '',
    by: req.session.admin.username,
  });
  res.status(201).json({ id: String(inv._id), number: inv.number });
}));
app.post('/api/invoices/:id/pay', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.status === 'void') return res.status(400).json({ error: 'invoice is void' });
  const amount = db.round3(Number((req.body || {}).amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'amount required' });
  await db.Payment.create({
    invoice_id: inv._id, invoice_number: inv.number, client_id: inv.client_id, client_username: inv.client_username,
    amount, currency: 'EUR', method: req.body.method || 'manual', status: 'confirmed',
    reference: req.body.reference || '', note: req.body.note || '', by: req.session.admin.username,
  });
  inv.paid = +((inv.paid || 0) + amount).toFixed(2);
  inv.status = inv.paid >= inv.total ? 'paid' : 'partial';
  if (inv.status === 'paid' && inv.credits_on_pay > 0 && !inv.credits_applied) {
    await db.addCredits(inv.client_username, inv.credits_on_pay, { type: 'topup', note: `invoice ${inv.number} paid`, by: req.session.admin.username });
    inv.credits_applied = true;
  }
  await inv.save();
  // outstanding changed → any printed USDT amount is stale; next PDF render makes a fresh one
  await M.CryptoIntent.updateMany({ status: 'pending', purpose: 'invoice', target_invoice_id: inv._id }, { $set: { status: 'cancelled' } });
  telegram.systemAlert(`💶 <b>Invoice payment</b> — ${inv.number} (${inv.client_username}): €${amount.toFixed(2)} → ${inv.status}`).catch(() => {});
  res.json({ ok: true, status: inv.status, paid: inv.paid });
}));
app.post('/api/invoices/:id/void', wrap(async (req, res) => {
  await db.Invoice.findByIdAndUpdate(req.params.id, { $set: { status: 'void' } });
  await M.CryptoIntent.updateMany({ status: 'pending', purpose: 'invoice', target_invoice_id: req.params.id }, { $set: { status: 'cancelled' } });
  res.json({ ok: true });
}));
// Hard-delete an invoice created by mistake. Only allowed while nothing has been
// paid against it — once money is recorded, void it instead (audit trail stays).
app.delete('/api/invoices/:id', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const paymentsLinked = await db.Payment.countDocuments({ invoice_id: inv._id });
  if (paymentsLinked || (inv.paid || 0) > 0) return res.status(400).json({ error: 'payments are recorded against this invoice — void it instead of deleting' });
  await M.CryptoIntent.updateMany({ status: 'pending', target_invoice_id: inv._id }, { $set: { status: 'cancelled' } });
  await db.Invoice.deleteOne({ _id: inv._id });
  res.json({ ok: true });
}));
app.get('/api/invoices/:id/pdf', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const [settings, profile, payments] = await Promise.all([
    getCrmSettings(), profileFor(inv.client_username),
    db.Payment.find({ invoice_id: inv._id }).sort({ createdAt: 1 }),
  ]);
  // Unpaid manual invoice + wallet configured → print a unique USDT amount on the
  // PDF so the client can pay on-chain and the watcher settles THIS invoice.
  let cryptoPay = null;
  if (inv.type === 'manual' && ['unpaid', 'partial'].includes(inv.status) && (settings.crypto || {}).wallet) {
    try {
      cryptoPay = await crypto2.intentForInvoice(inv, req.session.admin.username);
      if (cryptoPay) cryptoPay = { ...cryptoPay.toObject(), qr: await require('qrcode').toBuffer(cryptoPay.wallet, { width: 256, margin: 1 }) };
    } catch (e) { console.error('[crm] invoice intent:', e.message); } // rate fetch down / below minimum → PDF still renders, just without the box
  }
  pdf.invoicePdf(res, inv, profile, { ...settings.company, logoPath: logoPath() }, payments, cryptoPay);
}));

// ---------------- monthly statements (tz-aware, on demand) ----------------
async function buildStatement(username, period, tz) {
  const user = await db.User.findOne({ username });
  if (!user) throw new Error('client not found');
  const { start, end } = monthRange(period, tz);
  const [profile, payments, usage, lastBefore, lastIn] = await Promise.all([
    profileFor(username),
    db.Payment.find({ client_username: username, status: 'confirmed', createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }),
    db.UsageEvent.aggregate([
      { $match: { username, at: { $gte: start, $lt: end } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } }, parts: { $sum: '$parts' }, credits: { $sum: '$credits' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    db.CreditTransaction.findOne({ username, createdAt: { $lt: start } }).sort({ createdAt: -1 }),
    db.CreditTransaction.findOne({ username, createdAt: { $lt: end } }).sort({ createdAt: -1 }),
  ]);
  const opening = db.round3(lastBefore ? lastBefore.balance_after : 0);
  const closing = db.round3(lastIn ? lastIn.balance_after : opening);
  const usageRows = usage.map((u) => ({ day: u._id, parts: u.parts, credits: db.round3(u.credits), count: u.count }));
  return {
    username, period, tz, profile,
    opening, closing,
    payments,
    topupTotal: db.round3(payments.reduce((a, p) => a + p.amount, 0)),
    usage: usageRows,
    usageTotal: {
      parts: usageRows.reduce((a, u) => a + u.parts, 0),
      credits: db.round3(usageRows.reduce((a, u) => a + u.credits, 0)),
      count: usageRows.reduce((a, u) => a + u.count, 0),
    },
  };
}
app.get('/api/statements/:username/:period', wrap(async (req, res) => {
  res.json(await buildStatement(lc(req.params.username), req.params.period, req.query.tz || db.DEFAULT_TZ));
}));
app.get('/api/statements/:username/:period/pdf', wrap(async (req, res) => {
  const data = await buildStatement(lc(req.params.username), req.params.period, req.query.tz || db.DEFAULT_TZ);
  const { company } = await getCrmSettings();
  pdf.statementPdf(res, data, { ...company, logoPath: logoPath() });
}));

// ---------------- email (SMTP) — config test + send PDFs to clients ----------------
// Render any pdf.* function (which streams to a "res") into a Buffer for attaching.
function pdfBuffer(renderFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new PassThrough();
    sink.setHeader = () => {};                 // pdf.open() calls res.setHeader()
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try { renderFn(sink); } catch (e) { reject(e); }
  });
}

app.get('/api/email/status', wrap(async (req, res) => {
  const { smtp } = await getCrmSettings();
  res.json({ configured: !!(smtp.host && smtp.user && smtp.pass), host: smtp.host || '', user: smtp.user || '', from: smtp.from || smtp.user || '' });
}));

// Verify the SMTP login; if `to` is given, also send a test email there.
app.post('/api/email/test', wrap(async (req, res) => {
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'SMTP not configured — fill in & save the Email panel first' });
  await mailer.verify();
  const to = ((req.body && req.body.to) || '').trim();
  if (to) {
    const { company } = await getCrmSettings();
    await mailer.send({ to, subject: `Test email from ${company.name || 'the CRM'}`, text: 'This is a test message from your CRM email setup. If you received it, outbound email is working.' });
  }
  res.json({ ok: true, sent: !!to });
}));

// Email an invoice (or paid receipt) PDF to the client — defaults to profile email, override with body.to.
app.post('/api/invoices/:id/email', wrap(async (req, res) => {
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'SMTP not configured — set it in Settings → Email' });
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const [settings, profile, payments] = await Promise.all([
    getCrmSettings(), profileFor(inv.client_username),
    db.Payment.find({ invoice_id: inv._id }).sort({ createdAt: 1 }),
  ]);
  const to = ((req.body && req.body.to) || '').trim() || profile.email;
  if (!to) return res.status(400).json({ error: 'no email on file for this client — add one on their profile or pass an address' });
  let cryptoPay = null;
  if (inv.type === 'manual' && ['unpaid', 'partial'].includes(inv.status) && (settings.crypto || {}).wallet) {
    try {
      cryptoPay = await crypto2.intentForInvoice(inv, req.session.admin.username);
      if (cryptoPay) cryptoPay = { ...cryptoPay.toObject(), qr: await require('qrcode').toBuffer(cryptoPay.wallet, { width: 256, margin: 1 }) };
    } catch (e) { console.error('[crm] invoice intent:', e.message); }
  }
  const buf = await pdfBuffer((sink) => pdf.invoicePdf(sink, inv, profile, { ...settings.company, logoPath: logoPath() }, payments, cryptoPay));
  const co = settings.company || {};
  const due = db.round3(inv.total - (inv.paid || 0));
  const paid = inv.status === 'paid';
  await mailer.send({
    to,
    subject: `${paid ? 'Receipt' : 'Invoice'} ${inv.number} — ${co.name || 'SMS Services'}`,
    text: `Dear ${profile.contact_name || inv.client_username},\n\nPlease find ${paid ? 'your receipt' : 'invoice ' + inv.number} attached${paid ? '' : ` — €${due.toFixed(2)} due${inv.due_date ? ' by ' + new Date(inv.due_date).toISOString().slice(0, 10) : ''}`}.\n\n${co.footer || 'Thank you for your business.'}`,
    attachments: [{ filename: `${inv.number}.pdf`, content: buf }],
  });
  res.json({ ok: true, to });
}));

// Email a monthly statement PDF to the client.
app.post('/api/statements/:username/:period/email', wrap(async (req, res) => {
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'SMTP not configured — set it in Settings → Email' });
  const username = lc(req.params.username);
  const data = await buildStatement(username, req.params.period, req.query.tz || db.DEFAULT_TZ);
  const { company } = await getCrmSettings();
  const to = ((req.body && req.body.to) || '').trim() || (data.profile && data.profile.email);
  if (!to) return res.status(400).json({ error: 'no email on file for this client — add one on their profile or pass an address' });
  const buf = await pdfBuffer((sink) => pdf.statementPdf(sink, data, { ...company, logoPath: logoPath() }));
  await mailer.send({
    to,
    subject: `Statement ${req.params.period} — ${company.name || 'SMS Services'}`,
    text: `Dear ${(data.profile && data.profile.contact_name) || username},\n\nPlease find your account statement for ${req.params.period} attached.\n\n${company.footer || 'Thank you for your business.'}`,
    attachments: [{ filename: `statement-${username}-${req.params.period}.pdf`, content: buf }],
  });
  res.json({ ok: true, to });
}));

// ---------------- mail worksuite (IMAP inbox/sent + compose/reply, linked to clients) ----------------
// Map a set of email addresses → { lowerEmail: {username, contact_name} } for CRM linkage.
async function linkAddresses(addresses) {
  const uniq = [...new Set(addresses.map((a) => (a || '').toLowerCase().trim()).filter(Boolean))];
  if (!uniq.length) return {};
  const profs = await M.CrmProfile.find({ email: { $in: uniq.map((e) => new RegExp('^' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')) } });
  const map = {};
  for (const p of profs) if (p.email) map[p.email.toLowerCase()] = { username: p.username, contact_name: p.contact_name || '' };
  return map;
}

app.get('/api/mail/folders', wrap(async (req, res) => res.json(await imap.folders())));
app.get('/api/mail/unread', wrap(async (req, res) => res.json(await imap.unreadCount())));

app.get('/api/mail/list', wrap(async (req, res) => {
  const r = await imap.list({
    folder: req.query.folder || 'INBOX',
    page: Math.max(1, Number(req.query.page) || 1),
    limit: Math.min(100, Number(req.query.limit) || 30),
    search: req.query.search || '',
  });
  const link = await linkAddresses(r.messages.flatMap((m) => [m.from.address, ...(m.to || []).map((t) => t.address)]));
  r.messages = r.messages.map((m) => ({ ...m, client: link[(m.from.address || '').toLowerCase()] || link[((m.to[0] || {}).address || '').toLowerCase()] || null }));
  res.json(r);
}));

app.get('/api/mail/msg', wrap(async (req, res) => {
  const m = await imap.message({ folder: req.query.folder || 'INBOX', uid: req.query.uid });
  const link = await linkAddresses([m.from.address, ...(m.to || []).map((t) => t.address), ...(m.cc || []).map((t) => t.address)]);
  m.client = link[(m.from.address || '').toLowerCase()] || link[((m.to[0] || {}).address || '').toLowerCase()] || null;
  res.json(m);
}));

app.get('/api/mail/attachment', wrap(async (req, res) => {
  const a = await imap.download({ folder: req.query.folder || 'INBOX', uid: req.query.uid, index: req.query.index });
  res.setHeader('Content-Type', a.contentType);
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${a.filename.replace(/"/g, '')}"`);
  res.send(a.content);
}));

app.post('/api/mail/flag', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await imap.setFlag({ folder: b.folder || 'INBOX', uid: b.uid, flag: b.flag === 'flagged' ? '\\Flagged' : '\\Seen', on: !!b.on }));
}));

app.post('/api/mail/delete', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await imap.moveTo({ folder: b.folder || 'INBOX', uid: b.uid }));
}));

// Compose new / reply / forward. Accepts multipart with file attachments (field `files`).
// Delivers via SMTP, saves a copy to Sent, and (if `log_to` names a CRM client) logs it.
const mailUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 15 } });
app.post('/api/mail/send', mailUpload.array('files', 15), wrap(async (req, res) => {
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'SMTP not configured — set it in Settings → Email' });
  const b = req.body || {};
  if (!b.to) return res.status(400).json({ error: 'recipient (to) required' });
  const attachments = (req.files || []).map((f) => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype }));
  const msg = {
    to: b.to, cc: b.cc || undefined, subject: b.subject || '(no subject)',
    text: b.text || '', html: b.html || undefined,
    inReplyTo: b.inReplyTo || undefined, references: b.references || undefined,
    attachments,
  };
  await mailer.send(msg);
  // Best-effort copy into the IMAP Sent folder (failure here must not fail the send).
  try { const raw = await mailer.buildRaw(msg); await imap.appendToSent(raw); } catch (e) { console.error('[crm] append Sent:', e.message); }
  // Optional CRM timeline log.
  if (b.log_to) {
    await M.CrmActivity.create({
      ref_type: 'client', ref_id: lc(b.log_to), ref_name: lc(b.log_to), kind: 'email',
      body: `✉️ Sent: ${msg.subject}\nTo: ${b.to}${attachments.length ? `\n📎 ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(', ')}` : ''}${b.text ? '\n\n' + String(b.text).slice(0, 500) : ''}`,
      by: req.session.admin.username,
    }).catch(() => {});
  }
  res.json({ ok: true });
}));

// All email to/from a client (their profile email), across Inbox + Sent — for the client page.
app.get('/api/clients/:username/emails', wrap(async (req, res) => {
  const prof = await profileFor(lc(req.params.username));
  if (!prof || !prof.email) return res.json({ email: null, messages: [] });
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'Email not configured' });
  const email = prof.email.toLowerCase();
  const [inbox, sent] = await Promise.all([
    imap.byAddress(email, 'INBOX', 30).catch(() => []),
    imap.byAddress(email, 'INBOX.Sent', 30).catch(() => []),
  ]);
  const tag = (arr, dir) => arr.map((m) => ({ ...m, dir }));
  const messages = [...tag(inbox, 'in'), ...tag(sent, 'out')]
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 40);
  res.json({ email: prof.email, messages });
}));

// ---------------- support tickets ----------------
async function nextTicketNumber() {
  const n = await M.Ticket.countDocuments();
  return 'T-' + String(n + 1).padStart(4, '0');
}

app.get('/api/tickets', wrap(async (req, res) => {
  const q = {};
  if (req.query.status && req.query.status !== 'all') q.status = req.query.status;
  if (req.query.username) q.client_username = lc(req.query.username);
  if (req.query.q) q.subject = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const tickets = await M.Ticket.find(q).sort({ last_at: -1 }).limit(200).lean();
  const counts = await M.Ticket.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  res.json({ tickets: tickets.map((t) => ({ ...t, msgCount: (t.messages || []).length })), counts: counts.reduce((a, c) => (a[c._id] = c.n, a), {}) });
}));

app.get('/api/tickets/:id', wrap(async (req, res) => {
  const t = await M.Ticket.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
}));

// Manual ticket.
app.post('/api/tickets', wrap(async (req, res) => {
  const b = req.body || {};
  const contact_email = (b.contact_email || '').trim().toLowerCase();
  if (!b.subject && !contact_email) return res.status(400).json({ error: 'subject or contact_email required' });
  let client_username = lc(b.client_username || '');
  if (!client_username && contact_email) { const link = await linkAddresses([contact_email]); if (link[contact_email]) client_username = link[contact_email].username; }
  const t = await M.Ticket.create({
    number: await nextTicketNumber(), subject: b.subject || '(no subject)',
    client_username, contact_email, contact_name: b.contact_name || '',
    priority: b.priority || 'normal', source: 'manual',
    messages: b.body ? [{ dir: 'note', from: req.session.admin.username, body: b.body, by: req.session.admin.username }] : [],
    last_at: new Date(),
  });
  res.status(201).json(t);
}));

// Create a ticket FROM an inbox email.
app.post('/api/mail/to-ticket', wrap(async (req, res) => {
  const b = req.body || {};
  const m = await imap.message({ folder: b.folder || 'INBOX', uid: b.uid });
  const from = (m.from.address || '').toLowerCase();
  const link = await linkAddresses([from]);
  const t = await M.Ticket.create({
    number: await nextTicketNumber(), subject: m.subject || '(no subject)',
    client_username: link[from] ? link[from].username : '', contact_email: from, contact_name: m.from.name || '',
    source: 'email', status: 'open',
    messages: [{ dir: 'in', from, body: m.text || (m.html ? '(HTML email — open in Mail to view)' : ''), at: m.date || new Date() }],
    last_message_id: m.messageId || '', references: m.references || '', last_at: m.date || new Date(),
  });
  res.status(201).json(t);
}));

// Reply to a ticket — emails the contact, appends an outbound message, sets status pending.
app.post('/api/tickets/:id/reply', wrap(async (req, res) => {
  if (!(await mailer.isConfigured())) return res.status(400).json({ error: 'SMTP not configured — set it in Settings → Email' });
  const t = await M.Ticket.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!t.contact_email) return res.status(400).json({ error: 'this ticket has no contact email to reply to' });
  const body = String((req.body || {}).body || '');
  if (!body.trim()) return res.status(400).json({ error: 'reply body required' });
  const subject = /^re:/i.test(t.subject) ? t.subject : 'Re: ' + t.subject;
  const msg = { to: t.contact_email, subject, text: body, inReplyTo: t.last_message_id || undefined, references: t.references || undefined };
  await mailer.send(msg);
  try { const raw = await mailer.buildRaw(msg); await imap.appendToSent(raw); } catch (e) { console.error('[crm] ticket reply append:', e.message); }
  t.messages.push({ dir: 'out', from: req.session.admin.username, body, by: req.session.admin.username });
  t.status = (req.body || {}).close ? 'closed' : 'pending';
  t.last_at = new Date();
  await t.save();
  if (t.client_username) await M.CrmActivity.create({ ref_type: 'client', ref_id: t.client_username, ref_name: t.client_username, kind: 'email', body: `🎫 ${t.number} reply: ${subject}\n\n${body.slice(0, 400)}`, by: req.session.admin.username }).catch(() => {});
  res.json(t);
}));

// Internal note (not emailed).
app.post('/api/tickets/:id/note', wrap(async (req, res) => {
  const t = await M.Ticket.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const body = String((req.body || {}).body || '');
  if (!body.trim()) return res.status(400).json({ error: 'note body required' });
  t.messages.push({ dir: 'note', from: req.session.admin.username, body, by: req.session.admin.username });
  t.last_at = new Date(); await t.save();
  res.json(t);
}));

app.patch('/api/tickets/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const set = {};
  for (const k of ['status', 'priority', 'assignee', 'subject', 'client_username']) if (b[k] != null) set[k] = b[k];
  const t = await M.Ticket.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
}));

// ---------------- domains (drives the reverse proxy on :80 via its local API) ----------------
const axios = require('axios');
const dns = require('dns').promises;
const PROXY_ADMIN = process.env.PROXY_ADMIN_URL || 'http://127.0.0.1:8801';
const PUBLIC_IP = process.env.PUBLIC_HOST || '';
function proxyAuth() {
  const pw = fs.readFileSync('/root/reverse-proxy/admin-password.txt', 'utf8').trim();
  return { username: 'admin', password: pw };
}
const proxyApi = (method, p, data) =>
  axios({ method, url: PROXY_ADMIN + p, data, auth: proxyAuth(), timeout: 6000 })
    .then((r) => r.data)
    .catch((e) => {
      if (e.response) throw new Error(e.response.data && e.response.data.error || ('proxy: HTTP ' + e.response.status));
      throw new Error('reverse proxy not reachable on ' + PROXY_ADMIN + ' — is it running?');
    });

app.get('/api/domains', wrap(async (req, res) => {
  const [routes, health] = await Promise.all([proxyApi('get', '/api/routes'), proxyApi('get', '/api/health').catch(() => null)]);
  res.json({ ip: PUBLIC_IP, routes, health });
}));
app.post('/api/domains', wrap(async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const port = parseInt(b.port, 10);
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return res.status(400).json({ error: 'enter a plain domain like panel.yourdomain.com (no http://, no path)' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'valid port required' });
  const r = await proxyApi('put', '/api/routes/' + encodeURIComponent(host), { target_ip: '127.0.0.1', target_port: port, enabled: true, note: b.note || 'via CRM' });
  res.status(201).json(r);
}));
app.patch('/api/domains/:host', wrap(async (req, res) => {
  res.json(await proxyApi('patch', '/api/routes/' + encodeURIComponent(lc(req.params.host)), req.body || {}));
}));
app.delete('/api/domains/:host', wrap(async (req, res) => {
  res.json(await proxyApi('delete', '/api/routes/' + encodeURIComponent(lc(req.params.host))));
}));
// Does this domain's A record point at this server yet?
app.get('/api/domains/:host/dnscheck', wrap(async (req, res) => {
  const host = lc(req.params.host).replace(/^\*\./, 'any-sub.'); // wildcard: test a sample subdomain
  let ips = [];
  try { ips = await dns.resolve4(host); } catch (e) { return res.json({ ok: false, ips: [], error: e.code === 'ENOTFOUND' ? 'no A record found' : e.code }); }
  res.json({ ok: PUBLIC_IP ? ips.includes(PUBLIC_IP) : null, ips, expected: PUBLIC_IP });
}));

// ---------------- auto-templating: global pool + content policy ----------------
async function getPolicy() {
  const s = await db.Setting.findOne({ key: 'content_policy' });
  return Object.assign({ force_auto_template: true, numeric_only: true, min_len: 4, max_len: 10 }, (s && s.value) || {});
}
app.get('/api/templates', wrap(async (req, res) => {
  const [pool, policy] = await Promise.all([
    db.Setting.findOne({ key: 'auto_templates' }),
    getPolicy(),
  ]);
  const list = (pool && Array.isArray(pool.value)) ? pool.value : [];
  res.json({ policy, count: list.length, templates: list });
}));
// Replace the whole pool, or add/remove individual lines.
app.post('/api/templates', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = await db.Setting.findOne({ key: 'auto_templates' });
  let list = (cur && Array.isArray(cur.value)) ? cur.value.slice() : [];
  if (Array.isArray(b.replace)) list = b.replace.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(b.add)) for (const t of b.add) { const v = String(t).trim(); if (v && !list.includes(v)) list.push(v); }
  if (typeof b.add === 'string') { const v = b.add.trim(); if (v && !list.includes(v)) list.push(v); }
  if (b.remove != null) list = list.filter((t) => t !== b.remove);
  list = [...new Set(list)];
  await db.Setting.findOneAndUpdate({ key: 'auto_templates' }, { $set: { key: 'auto_templates', value: list } }, { upsert: true });
  res.json({ ok: true, count: list.length });
}));
// Seed the pool from the bundled library (596 templates) — non-destructive merge by default.
app.post('/api/templates/seed', wrap(async (req, res) => {
  const lib = require('./auto-templates.json');
  const cur = await db.Setting.findOne({ key: 'auto_templates' });
  const existing = (cur && Array.isArray(cur.value)) ? cur.value : [];
  const merged = (req.body && req.body.replace) ? lib : [...new Set([...existing, ...lib])];
  await db.Setting.findOneAndUpdate({ key: 'auto_templates' }, { $set: { key: 'auto_templates', value: merged } }, { upsert: true });
  res.json({ ok: true, count: merged.length, added: merged.length - existing.length });
}));
app.post('/api/policy', wrap(async (req, res) => {
  const cur = await getPolicy();
  const b = req.body || {};
  const value = {
    force_auto_template: 'force_auto_template' in b ? !!b.force_auto_template : cur.force_auto_template,
    numeric_only: 'numeric_only' in b ? !!b.numeric_only : cur.numeric_only,
    min_len: b.min_len != null ? Math.max(1, Number(b.min_len)) : cur.min_len,
    max_len: b.max_len != null ? Math.max(1, Number(b.max_len)) : cur.max_len,
  };
  await db.Setting.findOneAndUpdate({ key: 'content_policy' }, { $set: { key: 'content_policy', value } }, { upsert: true });
  res.json(value);
}));
// Flip every non-admin user into auto-template (numbers-only) mode at once.
app.post('/api/templates/apply-all', wrap(async (req, res) => {
  const r = await db.User.updateMany({ role: { $ne: 'admin' } }, { $set: { bypass_template: false } });
  res.json({ ok: true, updated: r.modifiedCount != null ? r.modifiedCount : r.nModified });
}));

// ---------------- settings (Setting key 'crm') ----------------
// Company logo for PDFs: stored on disk (crm/data/logo.png|jpg), PNG/JPEG ≤ 2 MB.
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const logoPath = () => ['logo.png', 'logo.jpg'].map((f) => path.join(DATA_DIR, f)).find((p) => fs.existsSync(p)) || null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/api/crm-settings/logo', upload.single('logo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (field name "logo")' });
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg' }[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'PNG or JPEG only' });
  for (const f of ['logo.png', 'logo.jpg']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {} }
  fs.writeFileSync(path.join(DATA_DIR, 'logo.' + ext), req.file.buffer);
  res.json({ ok: true });
}));
app.get('/api/crm-settings/logo', requireAuth, (req, res) => {
  const p = logoPath();
  if (!p) return res.status(404).json({ error: 'no logo' });
  res.sendFile(p);
});
app.delete('/api/crm-settings/logo', wrap(async (req, res) => {
  for (const f of ['logo.png', 'logo.jpg']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {} }
  res.json({ ok: true });
}));

app.get('/api/crm-settings', wrap(async (req, res) => {
  const s = await getCrmSettings();
  const smtp = { ...s.smtp };                                  // never ship the mailbox password to the browser
  if (smtp.pass) { smtp.pass = ''; smtp.has_pass = true; }
  res.json({ ...s, smtp, has_logo: !!logoPath() });
}));
app.post('/api/crm-settings', wrap(async (req, res) => {
  const cur = await getCrmSettings();
  const b = req.body || {};
  // SMTP: a blank password from the form means "keep the stored one" (so the
  // saved mailbox password is never wiped just by re-saving other settings).
  const smtp = { ...cur.smtp, ...(b.smtp || {}) };
  if (b.smtp && !b.smtp.pass) smtp.pass = (cur.smtp || {}).pass || '';
  const value = {
    company: { ...cur.company, ...(b.company || {}) },
    crypto: { ...cur.crypto, ...(b.crypto || {}) },
    reminders: { ...cur.reminders, ...(b.reminders || {}) },
    smtp,
    mail: { ...cur.mail, ...(b.mail || {}) }, // keeps runtime poller state (last_uid) when the UI saves only signature/templates/notify
  };
  await db.Setting.findOneAndUpdate({ key: 'crm' }, { $set: { key: 'crm', value } }, { upsert: true });
  res.json(value);
}));

// ---------------- follow-up reminder loop (Telegram) ----------------
async function reminderTick() {
  try {
    const { reminders } = await getCrmSettings();
    if (reminders && reminders.enabled === false) return;
    const now = new Date();
    const due = await M.CrmActivity.find({ due_at: { $ne: null, $lte: now }, done: false, reminded: false }).limit(20);
    for (const a of due) {
      await telegram.systemAlert(`⏰ <b>Follow-up due</b>\n${a.ref_type === 'lead' ? 'Lead' : 'Client'}: <b>${a.ref_name || a.ref_id}</b>\n${a.kind}: ${a.body}`).catch(() => {});
      a.reminded = true; await a.save();
    }
    const leads = await M.CrmLead.find({ next_follow_up: { $ne: null, $lte: now }, fu_reminded: false, stage: { $nin: ['won', 'lost'] } }).limit(20);
    for (const l of leads) {
      await telegram.systemAlert(`⏰ <b>Lead follow-up due</b>\n<b>${l.name}</b>${l.company ? ' (' + l.company + ')' : ''} — stage: ${l.stage}${l.est_value ? ' · est €' + l.est_value : ''}`).catch(() => {});
      l.fu_reminded = true; await l.save();
    }

    // Overdue invoices — nudge the operator (and optionally email the client), debounced 24h.
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const overdue = await db.Invoice.find({
      type: 'manual', status: { $in: ['unpaid', 'partial'] },
      due_date: { $ne: null, $lte: now },
      $or: [{ last_overdue_alert: null }, { last_overdue_alert: { $lt: dayAgo } }],
    }).limit(25);
    for (const inv of overdue) {
      const dueAmt = db.round3(inv.total - (inv.paid || 0));
      const daysLate = Math.floor((now - new Date(inv.due_date)) / 864e5);
      await telegram.systemAlert(`🔴 <b>Overdue invoice</b>\n${inv.number} — <b>${inv.client_username}</b>\n€${dueAmt.toFixed(2)} due, ${daysLate} day(s) late.`).catch(() => {});
      if (reminders && reminders.email_overdue) {
        try {
          const prof = await profileFor(inv.client_username);
          if (prof.email) await mailer.send({ to: prof.email, subject: `Reminder: invoice ${inv.number} is overdue`, text: `Dear ${prof.contact_name || inv.client_username},\n\nInvoice ${inv.number} for €${dueAmt.toFixed(2)} is now ${daysLate} day(s) past due. Please arrange payment at your earliest convenience.\n\nThank you.` });
        } catch (_) {}
      }
      inv.last_overdue_alert = now; await inv.save();
    }
  } catch (e) { console.error('[crm] reminders:', e.message); }
}

// ---------------- inbound mail poller (new-mail Telegram alert + auto-log to client) ----------------
async function mailPollTick() {
  try {
    if (!(await mailer.isConfigured())) return;          // no mailbox configured yet
    const s = await db.Setting.findOne({ key: 'crm' });
    const value = (s && s.value) || {};
    const mail = value.mail || {};
    const notify = mail.notify || 'clients';             // 'clients' | 'all' | 'off'
    const r = await imap.newMessages(mail.last_uid || 0);
    // First run (or the mailbox was recreated → UIDVALIDITY changed): set a baseline, don't alert on the backlog.
    if (!mail.last_uid || (mail.uidvalidity && mail.uidvalidity !== r.uidvalidity)) {
      await db.Setting.findOneAndUpdate({ key: 'crm' }, { $set: { 'value.mail.last_uid': r.maxUid, 'value.mail.uidvalidity': r.uidvalidity } }, { upsert: true });
      return;
    }
    if (!r.messages.length) return;
    const link = await linkAddresses(r.messages.map((m) => m.from.address));
    for (const m of r.messages.slice().reverse()) {       // oldest-first so the timeline reads naturally
      const client = link[(m.from.address || '').toLowerCase()];
      if (client) {
        // Auto-log to the client's timeline.
        await M.CrmActivity.create({
          ref_type: 'client', ref_id: client.username, ref_name: client.username, kind: 'email',
          body: `📨 Received from ${m.from.address}: ${m.subject}`, by: 'mail',
        }).catch(() => {});
        if (notify !== 'off') await telegram.systemAlert(`📨 <b>New email from client</b>\n<b>${client.username}</b> &lt;${m.from.address}&gt;\n${m.subject}`).catch(() => {});
      } else if (notify === 'all') {
        await telegram.systemAlert(`📧 <b>New email</b>\n${m.from.name || m.from.address}\n${m.subject}`).catch(() => {});
      }
    }
    await db.Setting.findOneAndUpdate({ key: 'crm' }, { $set: { 'value.mail.last_uid': r.maxUid, 'value.mail.uidvalidity': r.uidvalidity } });
  } catch (e) { console.error('[crm] mail poll:', e.message); }
}

// ---------------- static SPA + boot ----------------
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

db.connect().then(() => app.listen(PORT, '0.0.0.0', () => {
  console.log(`[crm] CRM panel on http://0.0.0.0:${PORT}`);
  crypto2.startWatcher(30000);
  setInterval(reminderTick, 60000);
  setTimeout(reminderTick, 10000);
  setInterval(mailPollTick, 60000);   // check for new mail every 60s
  setTimeout(mailPollTick, 15000);
})).catch((e) => { console.error('[crm] failed to start:', e); process.exit(1); });
