/**
 * admin/server.js — operator panel (REST API + static SPA).
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('../db');
const providers = require('../providers');
const engine = require('../shared/engine');

// ---- system metrics helpers ----
function cpuSample() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
let _lastCpu = cpuSample();
function cpuPercent() {
  const cur = cpuSample();
  const idle = cur.idle - _lastCpu.idle, total = cur.total - _lastCpu.total;
  _lastCpu = cur;
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
}
function netSample() {
  let rx = 0, tx = 0;
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of data.split('\n').slice(2)) {
      const [n, r] = line.split(':'); if (!r) continue;
      if (n.trim() === 'lo') continue;
      const f = r.trim().split(/\s+/);
      rx += Number(f[0]) || 0; tx += Number(f[8]) || 0;
    }
  } catch (_) {}
  return { rx, tx };
}
let _lastNet = netSample(); let _lastNetT = Date.now();
function netStats() {
  const cur = netSample(); const now = Date.now();
  const dt = Math.max(1, (now - _lastNetT) / 1000);
  const rxRate = Math.max(0, (cur.rx - _lastNet.rx) / dt), txRate = Math.max(0, (cur.tx - _lastNet.tx) / dt);
  _lastNet = cur; _lastNetT = now;
  return { rxTotal: cur.rx, txTotal: cur.tx, rxRate, txRate };
}
function svcStatus() {
  return new Promise((resolve) => {
    exec('systemctl is-active smpp-bridge smpp-admin smpp-portal mongod', (e, out) => {
      const [bridge = 'unknown', admin = 'unknown', portal = 'unknown', mongod = 'unknown'] = String(out || '').trim().split('\n');
      resolve({ bridge, admin, portal, mongod });
    });
  });
}
function diskStats() {
  return new Promise((resolve) => {
    if (!fs.statfs) return resolve(null);
    fs.statfs('/', (e, s) => {
      if (e || !s) return resolve(null);
      const total = s.blocks * s.bsize, free = s.bfree * s.bsize, used = total - free;
      resolve({ total, used, percent: total ? Math.round(used / total * 100) : 0 });
    });
  });
}

const PORT = Number(process.env.ADMIN_PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'internal-key';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'admin-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 8 * 3600 * 1000 } }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[admin]', e); res.status(500).json({ error: e.message }); });
const requireAuth = (req, res, next) => req.session && req.session.admin ? next() : res.status(401).json({ error: 'unauthorized' });

// recent live events from the bridge (in memory)
const liveEvents = [];

// ---------------- auth ----------------
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  // env admin
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) { req.session.admin = { username }; return res.json({ ok: true }); }
  // or a role=admin user in the DB
  const u = await db.User.findOne({ username: String(username || '').toLowerCase(), role: 'admin' });
  if (u && await bcrypt.compare(password || '', u.password)) { req.session.admin = { username: u.username }; return res.json({ ok: true }); }
  res.status(401).json({ error: 'invalid credentials' });
}));
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.admin));

// ---------------- internal event sink (from bridge) ----------------
app.post('/api/internal/event', (req, res) => {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) return res.status(403).json({ error: 'forbidden' });
  liveEvents.unshift({ ...req.body, at: Date.now() });
  if (liveEvents.length > 200) liveEvents.length = 200;
  res.json({ ok: true });
});

app.use('/api', requireAuth); // everything below requires admin auth

// SMPP connection info shown to operators when handing out client credentials.
app.get('/api/config', (req, res) => res.json({
  smppHost: process.env.PUBLIC_HOST || 'your-server-ip',
  smppPort: Number(process.env.SMPP_PORT || 2775),
}));

// Live system status monitor: CPU / RAM / disk (ROM) / DB / services / traffic.
app.get('/api/system', wrap(async (req, res) => {
  const today = db.dayKey();
  const [services, disk, msgTotal, msgToday, sent, delivered, failed, inbound] = await Promise.all([
    svcStatus(), diskStats(),
    db.MessageLog.countDocuments({}),
    db.MessageLog.countDocuments({ day: today }),
    db.MessageLog.countDocuments({ status: 'sent' }),
    db.MessageLog.countDocuments({ dlr_status: 'delivered' }),
    db.MessageLog.countDocuments({ status: 'failed' }),
    db.MessageLog.countDocuments({ dlr_status: { $in: ['delivered', 'undelivered'] } }), // receipts back = inbound
  ]);
  const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
  res.json({
    cpu: { percent: cpuPercent(), cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '', load: os.loadavg().map((x) => +x.toFixed(2)) },
    mem: { total: totalMem, used: usedMem, percent: Math.round(usedMem / totalMem * 100) },
    disk: disk || { total: 0, used: 0, percent: 0 },
    net: netStats(),
    db: { connected: db.MOCK ? true : (db.mongoose.connection.readyState === 1), name: db.MOCK ? 'mock' : (db.mongoose.connection.name || 'mongo') },
    services,
    traffic: { messagesTotal: msgTotal, today: msgToday, sent, delivered, failed, inbound },
    host: { hostname: os.hostname(), uptime: os.uptime(), platform: os.platform() },
  });
}));

// ---------------- dashboard ----------------
app.get('/api/dashboard', wrap(async (req, res) => {
  const today = db.dayKey();
  const [users, routes, msgsToday, sentToday, conns, recent] = await Promise.all([
    db.User.countDocuments({ role: { $ne: 'admin' } }),
    db.Route.countDocuments({}),
    db.MessageLog.countDocuments({ day: today }),
    db.MessageLog.countDocuments({ day: today, status: 'sent' }),
    db.ActiveConnection.countDocuments({ is_connected: true }),
    db.MessageLog.find({}).sort({ createdAt: -1 }).limit(15),
  ]);
  res.json({
    users, routes, messagesToday: msgsToday, sentToday, activeConnections: conns,
    recent, events: liveEvents.slice(0, 20), routeHealth: providers.healthSnapshot(),
  });
}));

// ---------------- users ----------------
app.get('/api/users', wrap(async (req, res) => {
  const users = await db.User.find(req.query.role ? { role: req.query.role } : {}).sort({ createdAt: -1 });
  const routes = await db.Route.find({});
  const rmap = {}; routes.forEach((r) => rmap[String(r._id)] = r.name);
  res.json(users.map((u) => ({
    id: String(u._id), username: u.username, role: u.role, credits: u.credits, cost_per_sms: u.cost_per_sms,
    rate_per_credit: u.rate_per_credit, plan_name: u.plan_name, max_mps: u.max_mps,
    is_active: u.is_active, is_suspended: u.is_suspended, is_connected: u.is_connected,
    route: u.route_id ? rmap[String(u.route_id)] : null,
    route_id: u.route_id ? String(u.route_id) : '', backup_route_id: u.backup_route_id ? String(u.backup_route_id) : '',
    reseller_id: u.reseller_id, default_sender_id: u.default_sender_id,
    bypass_template: u.bypass_template, templates: u.templates, allowed_ips: u.allowed_ips,
  })));
}));

app.post('/api/users', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: 'username & password required' });
  if (String(b.password).length !== 8) return res.status(400).json({ error: 'password must be exactly 8 characters' });
  if (await db.User.findOne({ username: String(b.username).toLowerCase() })) return res.status(409).json({ error: 'username taken' });
  const u = await db.User.create({
    username: String(b.username).toLowerCase(), password: await bcrypt.hash(b.password, 10),
    role: b.role || 'client', credits: Number(b.credits) || 0, cost_per_sms: Number(b.cost_per_sms) || 1,
    rate_per_credit: Number(b.rate_per_credit) || 1, plan_name: b.plan_name || 'standard',
    max_mps: Number(b.max_mps) || 10, route_id: b.route_id || null, backup_route_id: b.backup_route_id || null,
    bypass_template: b.bypass_template !== false, templates: b.templates || [],
    allowed_ips: Array.isArray(b.allowed_ips) ? b.allowed_ips : String(b.allowed_ips || '').split(',').map((s) => s.trim()).filter(Boolean),
    reseller_id: b.reseller_id || null, default_sender_id: b.default_sender_id || '',
  });
  if (Number(b.credits) > 0) await db.addCredits(u.username, Number(b.credits), { type: 'topup', note: 'initial', by: req.session.admin.username }).catch(() => {});
  res.status(201).json({ id: String(u._id) });
}));

app.get('/api/users/:id', wrap(async (req, res) => {
  const u = await db.User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const [txns, recent] = await Promise.all([
    db.CreditTransaction.find({ username: u.username }).sort({ createdAt: -1 }).limit(50),
    db.MessageLog.find({ username: u.username }).sort({ createdAt: -1 }).limit(50),
  ]);
  const o = u.toObject ? u.toObject() : u; delete o.password;
  res.json({ ...o, id: String(u._id), transactions: txns, recentMessages: recent });
}));

app.patch('/api/users/:id', wrap(async (req, res) => {
  const allowed = ['credits', 'cost_per_sms', 'rate_per_credit', 'plan_name', 'max_mps', 'route_id', 'backup_route_id', 'is_active', 'is_suspended', 'bypass_template', 'templates', 'allowed_ips', 'default_sender_id', 'webhook_url', 'webhook_secret', 'telegram_bot_token', 'telegram_chat_id', 'role', 'timezone', 'low_balance_threshold'];
  const set = {};
  for (const k of allowed) if (k in (req.body || {})) set[k] = req.body[k];
  if ('allowed_ips' in set && !Array.isArray(set.allowed_ips)) set.allowed_ips = String(set.allowed_ips).split(',').map((s) => s.trim()).filter(Boolean);
  await db.User.findByIdAndUpdate(req.params.id, { $set: set });
  res.json({ ok: true });
}));

app.post('/api/users/:id/password', wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length !== 8) return res.status(400).json({ error: 'password must be exactly 8 characters' });
  await db.User.findByIdAndUpdate(req.params.id, { $set: { password: await bcrypt.hash(password, 10) } });
  res.json({ ok: true });
}));

app.post('/api/users/:id/topup', wrap(async (req, res) => {
  const u = await db.User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount required' });
  const r = await db.addCredits(u.username, amount, { type: amount > 0 ? 'topup' : 'adjustment', note: (req.body.note || ''), by: req.session.admin.username });
  res.json({ ok: true, balance: r.balance });
}));

app.post('/api/users/:id/drop', wrap(async (req, res) => {
  const u = await db.User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  await db.DropCommand.create({ username: u.username });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', wrap(async (req, res) => { await db.User.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

// ---------------- routes ----------------
app.get('/api/routes', wrap(async (req, res) => {
  const routes = await db.Route.find({}).sort({ createdAt: -1 });
  const health = providers.healthSnapshot();
  res.json(routes.map((r) => ({ ...(r.toObject ? r.toObject() : r), id: String(r._id), health: health[String(r._id)] || null })));
}));
app.post('/api/routes', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const r = await db.Route.create(b);
  res.status(201).json({ id: String(r._id) });
}));
app.patch('/api/routes/:id', wrap(async (req, res) => { await db.Route.findByIdAndUpdate(req.params.id, { $set: req.body || {} }); res.json({ ok: true }); }));
app.delete('/api/routes/:id', wrap(async (req, res) => { await db.Route.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));
app.post('/api/routes/:id/test', wrap(async (req, res) => {
  const route = await db.Route.findById(req.params.id);
  if (!route) return res.status(404).json({ error: 'not found' });
  const adapter = providers.adapterFor(route.type);
  // Providers with a testConnection() (e.g. QuickConnect) verify auth WITHOUT sending an SMS.
  if (adapter.testConnection && !req.body.send) {
    const r = await adapter.testConnection(route);
    return res.json({ ...r, mode: 'auth-check' });
  }
  const { to, text } = req.body || {};
  const r = await providers.dispatch(route, to || '9779800000000', text || 'Route test from admin', route.sender_id);
  res.json({ ...r, mode: 'live-send' });
}));

// ---------------- live SMS tester ----------------
// Two modes:
//   raw      -> providers.dispatch() straight to one route. No billing/policy/log. Pure connectivity.
//   pipeline -> engine.accept()+fireDispatch() AS a chosen user: real billing, policy, routing,
//               MessageLog + DLR. Exactly the path a bound client takes. Returns logId to poll.
app.post('/api/test-sms', wrap(async (req, res) => {
  const { mode = 'pipeline', route_id, to, text, sender, username } = req.body || {};
  if (!to) return res.status(400).json({ error: 'destination (to) required' });
  if (!text) return res.status(400).json({ error: 'message text required' });

  if (mode === 'raw') {
    const route = await db.Route.findById(route_id);
    if (!route) return res.status(404).json({ error: 'pick a route for raw mode' });
    const r = await providers.dispatch(route, to, text, sender || route.sender_id);
    return res.json({ mode: 'raw', route_name: route.name, ...r });
  }

  // pipeline mode — send as a real user so credit/policy/logging all apply.
  const user = await db.User.findOne({ username: String(username || '').toLowerCase() });
  if (!user) return res.status(400).json({ error: 'pick a user for pipeline mode' });
  const decision = await engine.accept(user, to, text, sender || user.default_sender_id || '', 'http');
  if (!decision.ok) {
    return res.json({ mode: 'pipeline', accepted: false, reason: decision.reason, smppStatus: decision.smppStatus });
  }
  const logId = String(decision.prepared.log._id);
  const dispatch = await engine.fireDispatch(decision.prepared); // resolves after provider responds
  res.json({
    mode: 'pipeline', accepted: true, logId, messageId: decision.messageId,
    parts: decision.prepared.parts, credits_used: decision.prepared.cost,
    route_name: dispatch.via || (decision.prepared.routes[0] && decision.prepared.routes[0].name) || '',
    dispatch,
  });
}));
// Poll a single MessageLog (used by the tester to watch status + DLR resolve).
app.get('/api/test-sms/:logId', wrap(async (req, res) => {
  const log = await db.MessageLog.findById(req.params.logId);
  if (!log) return res.status(404).json({ error: 'not found' });
  res.json(log);
}));

// ---------------- routing rules ----------------
app.get('/api/rules', wrap(async (req, res) => res.json(await db.RoutingRule.find({}).sort({ priority: -1 }))));
app.post('/api/rules', wrap(async (req, res) => { const r = await db.RoutingRule.create(req.body || {}); res.status(201).json({ id: String(r._id) }); }));
app.delete('/api/rules/:id', wrap(async (req, res) => { await db.RoutingRule.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

// ---------------- logs / dlr ----------------
function logQuery(q) {
  const out = {};
  if (q.username) out.username = q.username;
  if (q.status) out.status = q.status;
  if (q.dlr) out.dlr_status = q.dlr;
  if (q.dest) out.destination = new RegExp('^' + String(q.dest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (q.day) out.day = q.day;
  return out;
}
app.get('/api/logs', wrap(async (req, res) => {
  const logs = await db.MessageLog.find(logQuery(req.query)).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 200, 2000));
  res.json(logs);
}));
app.get('/api/logs.csv', wrap(async (req, res) => {
  const logs = await db.MessageLog.find(logQuery(req.query)).sort({ createdAt: -1 }).limit(5000);
  const head = 'time,username,source,destination,parts,credits,status,dlr_status,route,message_id,provider_id\n';
  const rows = logs.map((l) => [l.createdAt && new Date(l.createdAt).toISOString(), l.username, l.source, l.destination, l.parts, l.credits_used, l.status, l.dlr_status, l.route_name, l.message_id, l.provider_message_id].map((x) => `"${String(x == null ? '' : x).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=logs.csv');
  res.send(head + rows);
}));

// Delivery-accuracy snapshot: how many messages reached each DLR state (from recent logs).
app.get('/api/delivery-summary', wrap(async (req, res) => {
  const match = {}; if (req.query.username) match.username = req.query.username; if (req.query.day) match.day = req.query.day;
  const rows = await db.MessageLog.aggregate([{ $match: match }, { $group: { _id: '$dlr_status', n: { $sum: 1 } } }]);
  const by = {}; let total = 0;
  rows.forEach((r) => { by[r._id || 'unknown'] = r.n; total += r.n; });
  const delivered = by.delivered || 0, failed = (by.undelivered || 0) + (by.rejected || 0),
    accepted = by.accepted || 0, pending = by.pending || 0, unknown = by.unknown || 0;
  res.json({ total, delivered, failed, accepted, pending, unknown, by, deliveredPct: total ? +(delivered / total * 100).toFixed(1) : 0 });
}));

// Manually re-query the provider for a message's delivery status (honest about providers
// like QuickConnect that return no post-send receipt).
app.post('/api/logs/:id/recheck', wrap(async (req, res) => {
  const log = await db.MessageLog.findById(req.params.id);
  if (!log) return res.status(404).json({ error: 'not found' });
  if (!log.route_id || !log.provider_message_id) return res.json({ ok: false, status: log.dlr_status, note: 'No provider batch id to query.' });
  const route = await db.Route.findById(log.route_id);
  const adapter = route && providers.adapterFor(route.type);
  if (!adapter || !adapter.pollStatus) return res.json({ ok: false, status: log.dlr_status, note: 'Provider has no status API.' });
  const status = await adapter.pollStatus(route, log.provider_message_id).catch(() => null);
  if (!status) return res.json({ ok: false, status: log.dlr_status, note: `${route.type} returns no post-send delivery receipt — status reflects the send response.` });
  await db.MessageLog.findByIdAndUpdate(log._id, { $set: { dlr_status: status } });
  res.json({ ok: true, status });
}));

// ---------------- analytics ----------------
app.get('/api/analytics/daily', wrap(async (req, res) => {
  const match = {}; if (req.query.username) match.username = req.query.username;
  const rows = await db.MessageLog.aggregate([
    { $match: match },
    { $group: { _id: '$day', count: { $sum: 1 }, parts: { $sum: '$parts' }, credits: { $sum: '$credits_used' } } },
    { $sort: { _id: -1 } }, { $limit: Number(req.query.days) || 30 },
  ]);
  res.json(rows.map((r) => ({ day: r._id, count: r.count, parts: r.parts, credits: +(r.credits || 0).toFixed(2) })));
}));

// ---------------- usage by date (timezone-aware, persistent) ----------------
async function panelTz() {
  const s = await db.Setting.findOne({ key: 'general' });
  return (s && s.value && s.value.timezone) || db.DEFAULT_TZ;
}
// Bucket persistent UsageEvents into LOCAL days for the requested timezone. Nepal is
// UTC+5:45, US zones shift with DST — $dateToString computes the correct local date per tz.
async function usageDaily(q) {
  const tz = (q.tz && String(q.tz)) || await panelTz();
  const match = {};
  if (q.username) match.username = String(q.username).toLowerCase();
  // Loose UTC pre-filter to limit the scan; exact bounds are applied on local-day strings below.
  if (q.from) (match.at = match.at || {}).$gte = new Date(new Date(q.from + 'T00:00:00Z').getTime() - 86400000);
  if (q.to) (match.at = match.at || {}).$lte = new Date(new Date(q.to + 'T00:00:00Z').getTime() + 2 * 86400000);
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
  if (q.from) out = out.filter((r) => r.day >= q.from);
  if (q.to) out = out.filter((r) => r.day <= q.to);
  return { tz, rows: out };
}
app.get('/api/usage/daily', wrap(async (req, res) => res.json(await usageDaily(req.query))));
app.get('/api/usage/daily.csv', wrap(async (req, res) => {
  const { tz, rows } = await usageDaily(req.query);
  const head = `date (${tz}),messages,sent,failed,segments,credits\n`;
  const body = rows.map((r) => [r.day, r.count, r.sent, r.failed, r.parts, r.credits].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=usage.csv');
  res.send(head + body);
}));
app.get('/api/timezones', wrap(async (req, res) => res.json({ list: db.TIMEZONES, panel: await panelTz() })));

// ---------------- per-client API keys ----------------
app.get('/api/users/:id/apikeys', wrap(async (req, res) => {
  const u = await db.User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(await db.ApiKey.find({ user_id: u._id }).sort({ createdAt: -1 }));
}));
app.post('/api/users/:id/apikeys', wrap(async (req, res) => {
  const u = await db.User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const key = db.genApiKey();
  await db.ApiKey.create({ key, user_id: u._id, username: u.username, label: (req.body && req.body.label) || '' });
  res.status(201).json({ key });
}));
app.patch('/api/apikeys/:id', wrap(async (req, res) => {
  await db.ApiKey.findByIdAndUpdate(req.params.id, { $set: { is_active: !!(req.body || {}).is_active } });
  res.json({ ok: true });
}));
app.delete('/api/apikeys/:id', wrap(async (req, res) => { await db.ApiKey.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

// ---------------- blacklist / words / templates ----------------
app.get('/api/blacklist', wrap(async (req, res) => res.json(await db.Blacklist.find({}).sort({ createdAt: -1 }).limit(1000))));
app.post('/api/blacklist', wrap(async (req, res) => { await db.Blacklist.create({ destination: req.body.destination, username: req.body.username || null, reason: req.body.reason || '' }); res.json({ ok: true }); }));
app.delete('/api/blacklist/:id', wrap(async (req, res) => { await db.Blacklist.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

app.get('/api/words', wrap(async (req, res) => res.json(await db.BlockedWord.find({}).sort({ createdAt: -1 }))));
app.post('/api/words', wrap(async (req, res) => { await db.BlockedWord.create({ word: req.body.word, username: req.body.username || null }); res.json({ ok: true }); }));
app.delete('/api/words/:id', wrap(async (req, res) => { await db.BlockedWord.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

app.get('/api/templates', wrap(async (req, res) => res.json(await db.MessageTemplate.find({}).sort({ createdAt: -1 }))));
app.post('/api/templates', wrap(async (req, res) => { await db.MessageTemplate.create({ username: req.body.username || null, name: req.body.name || '', body: req.body.body }); res.json({ ok: true }); }));
app.delete('/api/templates/:id', wrap(async (req, res) => { await db.MessageTemplate.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }));

// ---------------- connections ----------------
app.get('/api/connections', wrap(async (req, res) => res.json(await db.ActiveConnection.find({ is_connected: true }).sort({ bound_at: -1 }))));

// ---------------- webhooks (delivery push log + retry) ----------------
app.get('/api/webhooks', wrap(async (req, res) => {
  const q = req.query.username ? { username: req.query.username } : {};
  res.json(await db.WebhookLog.find(q).sort({ createdAt: -1 }).limit(200));
}));
app.post('/api/webhooks/:id/retry', wrap(async (req, res) => {
  const log = await db.WebhookLog.findById(req.params.id);
  if (!log) return res.status(404).json({ error: 'not found' });
  const user = await db.User.findOne({ username: log.username });
  const entry = { username: log.username, url: log.url, payload: log.payload, ok: false, status_code: 0 };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (user && user.webhook_secret) headers['X-Webhook-Secret'] = user.webhook_secret;
    const r = await require('axios').post(log.url, log.payload, { headers, timeout: 10000, validateStatus: () => true });
    entry.ok = r.status >= 200 && r.status < 300; entry.status_code = r.status;
  } catch (e) { entry.error = e.message; }
  await db.WebhookLog.create(entry);
  res.json({ ok: entry.ok, status: entry.status_code });
}));

// ---------------- live activity feed ----------------
app.get('/api/live', wrap(async (req, res) => {
  const recent = await db.MessageLog.find({}).sort({ createdAt: -1 }).limit(12);
  res.json({ events: liveEvents.slice(0, 30), recent });
}));

// ---------------- reseller ----------------
app.get('/api/resellers', wrap(async (req, res) => {
  const resellers = await db.User.find({ role: 'reseller' });
  const out = [];
  for (const r of resellers) {
    const clients = await db.User.countDocuments({ reseller_id: r._id });
    out.push({ id: String(r._id), username: r.username, credits: r.credits, clients });
  }
  res.json(out);
}));
app.get('/api/bills', wrap(async (req, res) => res.json(await db.ResellerBill.find({}).sort({ createdAt: -1 }).limit(500))));

// ---------------- invoices + payments ----------------
app.get('/api/invoices', wrap(async (req, res) => {
  const q = {}; if (req.query.clientId) q.client_id = req.query.clientId;
  res.json(await db.Invoice.find(q).sort({ createdAt: -1 }).limit(500));
}));
app.get('/api/invoices/:id', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const payments = await db.Payment.find({ invoice_id: inv._id }).sort({ createdAt: -1 });
  res.json({ ...(inv.toObject ? inv.toObject() : inv), id: String(inv._id), payments });
}));
app.post('/api/invoices', wrap(async (req, res) => {
  const b = req.body || {};
  const client = await db.User.findById(b.client_id);
  if (!client) return res.status(400).json({ error: 'client required' });
  const items = (b.items || []).map((it) => {
    const qty = Number(it.qty) || 1, up = Number(it.unit_price) || 0;
    return { description: it.description || '', qty, unit_price: up, amount: +(qty * up).toFixed(2) };
  });
  if (!items.length) return res.status(400).json({ error: 'at least one line item required' });
  const subtotal = +items.reduce((a, i) => a + i.amount, 0).toFixed(2);
  const tax = Number(b.tax) || 0;
  const total = +(subtotal + tax).toFixed(2);
  const inv = await db.Invoice.create({
    number: await db.nextInvoiceNumber(), client_id: client._id, client_username: client.username,
    items, subtotal, tax, total, currency: b.currency || client.currency || 'USD',
    credits_on_pay: Number(b.credits_on_pay) || 0, due_date: b.due_date || null, note: b.note || '',
    by: req.session.admin.username,
  });
  res.status(201).json({ id: String(inv._id), number: inv.number });
}));
app.post('/api/invoices/:id/pay', wrap(async (req, res) => {
  const inv = await db.Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.status === 'void') return res.status(400).json({ error: 'invoice is void' });
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount required' });
  await db.Payment.create({
    invoice_id: inv._id, invoice_number: inv.number, client_id: inv.client_id, client_username: inv.client_username,
    amount, method: req.body.method || 'manual', reference: req.body.reference || '', by: req.session.admin.username,
  });
  inv.paid = +((inv.paid || 0) + amount).toFixed(2);
  inv.status = inv.paid >= inv.total ? 'paid' : inv.paid > 0 ? 'partial' : 'unpaid';
  // Apply credits to the client's balance once, when fully paid.
  if (inv.status === 'paid' && inv.credits_on_pay > 0 && !inv.credits_applied) {
    await db.addCredits(inv.client_username, inv.credits_on_pay, { type: 'topup', note: `invoice ${inv.number} paid`, by: req.session.admin.username });
    inv.credits_applied = true;
  }
  await inv.save();
  res.json({ ok: true, status: inv.status, paid: inv.paid });
}));
app.post('/api/invoices/:id/void', wrap(async (req, res) => {
  await db.Invoice.findByIdAndUpdate(req.params.id, { $set: { status: 'void' } });
  res.json({ ok: true });
}));

// ---------------- settings ----------------
app.get('/api/settings', wrap(async (req, res) => {
  const all = await db.Setting.find({});
  const out = {}; all.forEach((s) => out[s.key] = s.value);
  res.json(out);
}));
app.post('/api/settings', wrap(async (req, res) => {
  for (const [key, value] of Object.entries(req.body || {})) {
    await db.Setting.findOneAndUpdate({ key }, { $set: { key, value } }, { upsert: true, new: true });
  }
  res.json({ ok: true });
}));
// Fire a TEST critical alert: drops a 90s flag the CYD picks up on its next poll (LED + buzzer
// + banner) and also pings the operator Telegram. Lets you verify the alert path end-to-end.
app.post('/api/test-alert', wrap(async (req, res) => {
  const msg = (req.body && req.body.msg) || 'TEST ALERT (manual)';
  await db.Setting.findOneAndUpdate({ key: 'device_test_alert' }, { $set: { key: 'device_test_alert', value: { until: Date.now() + 90000, msg } } }, { upsert: true });
  try { require('../telegram').systemAlert('🔔 Test alert from the panel — control hub check.'); } catch (_) {}
  res.json({ ok: true });
}));
app.post('/api/settings/test-telegram', wrap(async (req, res) => {
  const s = await db.Setting.findOne({ key: 'telegram' }); const cfg = s && s.value;
  if (!cfg || !cfg.bot_token || !cfg.chat_id) return res.json({ sent: false });
  await require('../telegram').sendVia(cfg.bot_token, cfg.chat_id, '✅ SMPP Bridge — Telegram alerts connected.');
  res.json({ sent: true });
}));

// ---------------- backup / disaster recovery ----------------
const BACKUP_DIR = '/root/backups';
const backupList = () => {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^sms-backup-.*\.tar\.gz$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, size: st.size, at: st.mtime }; })
      .sort((a, b) => b.at - a.at);
  } catch (_) { return []; }
};
app.get('/api/backup/list', (req, res) => res.json(backupList()));
app.post('/api/backup', wrap(async (req, res) => {
  const out = await new Promise((resolve, reject) => {
    exec('bash scripts/backup.sh', { cwd: path.join(__dirname, '..'), timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      (e, stdout, stderr) => e ? reject(new Error((stderr || e.message).slice(-400))) : resolve(String(stdout).trim().split('\n').pop()));
  });
  const file = path.basename(out);
  const st = fs.existsSync(out) ? fs.statSync(out) : null;
  res.json({ ok: true, file, size: st ? st.size : 0 });
}));
const safeBackup = (name) => {
  const f = path.basename(String(name || ''));
  if (!/^sms-backup-.*\.tar\.gz$/.test(f)) return null;
  const fp = path.join(BACKUP_DIR, f);
  return fs.existsSync(fp) ? fp : null;
};
app.get('/api/backup/download', (req, res) => {
  const fp = safeBackup(req.query.file);
  if (!fp) return res.status(404).json({ error: 'not found' });
  res.download(fp);
});
app.delete('/api/backup', wrap(async (req, res) => {
  const fp = safeBackup(req.query.file);
  if (!fp) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
}));

// no-cache so UI changes (app.js/css) always show without a hard refresh; browser still
// revalidates via ETag and gets a fast 304 when nothing changed.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// ---- Telegram alert monitor (thresholds, debounced) ----
const telegram = require('../telegram');
const alertCooldowns = new Map();
function maybeAlert(key, text, cooldownMs = 30 * 60 * 1000) {
  const now = Date.now();
  if ((alertCooldowns.get(key) || 0) > now - cooldownMs) return;
  alertCooldowns.set(key, now);
  telegram.systemAlert(text);
}
async function runMonitor() {
  try {
    const sset = await db.Setting.findOne({ key: 'alerts' });
    const cfg = Object.assign({ enabled: true, cpu: 85, ram: 90, disk: 90, lowBalance: 50 }, (sset && sset.value) || {});
    if (cfg.enabled === false) return;
    const cpuPct = Math.min(100, Math.round(os.loadavg()[0] / Math.max(1, os.cpus().length) * 100));
    if (cfg.cpu && cpuPct >= cfg.cpu) maybeAlert('cpu', `🔥 High CPU: ${cpuPct}% (load ${os.loadavg()[0].toFixed(2)})`);
    const memPct = Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100);
    if (cfg.ram && memPct >= cfg.ram) maybeAlert('ram', `🧠 High RAM: ${memPct}%`);
    const disk = await diskStats();
    if (disk && cfg.disk && disk.percent >= cfg.disk) maybeAlert('disk', `💾 Low disk: ${disk.percent}% used`);
    {
      // Per-client threshold (user.low_balance_threshold) overrides the global cfg.lowBalance.
      const users = await db.User.find({ role: { $in: ['client', 'reseller'] }, is_active: true });
      for (const u of users) {
        const thr = (u.low_balance_threshold != null) ? u.low_balance_threshold : cfg.lowBalance;
        if (thr && (u.credits || 0) <= thr) {
          maybeAlert('bal:' + u.username, `⚠️ Low balance: <b>${u.username}</b> is at €${db.round3(u.credits || 0)} (≤ threshold €${db.round3(thr)})`);
        }
      }
    }
    for (const [id, h] of Object.entries(providers.healthSnapshot())) {
      if (h.suspended) maybeAlert('route:' + id, `🛑 Route circuit OPEN (…${id.slice(-6)}) — ${h.lastError || 'repeated failures'}`);
    }
  } catch (e) { console.error('[monitor]', e.message); }
}

db.connect().then(() => app.listen(PORT, '0.0.0.0', () => {
  console.log(`[admin] panel on http://0.0.0.0:${PORT}`);
  setInterval(runMonitor, 60 * 1000);
})).catch((e) => { console.error('admin fatal', e); process.exit(1); });
