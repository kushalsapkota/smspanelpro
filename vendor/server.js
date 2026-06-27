/**
 * vendor/server.js — Vendor self-service portal (port 6699).
 *
 * External SMS suppliers ("vendors") log in here with credentials the operator hands them from the
 * CRM, register their own endpoint API + declared balance, and watch how many SMS have been sent
 * through each of their endpoints. A vendor is STRICTLY scoped to their own routes — they never see
 * the operator's clients, pricing to clients, recipient numbers, or message content.
 *
 * Each endpoint a vendor adds becomes a Route with vendor_id set, vendor_status 'pending' and
 * is_active=false, so it cannot carry any traffic until the operator approves & assigns it in the CRM.
 *
 *   balance (remaining) = route.route_credits   (decremented per segment by the engine)
 *   total provided      = route.inventory_total
 *   SMS used            = inventory_total - route_credits
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('../db');

const PORT = Number(process.env.VENDOR_PORT || 6699);

// Provider adapter types a vendor may pick for their endpoint. 'custom' is a generic HTTP endpoint;
// the rest map to built-in adapters. The operator can refine the config on approval.
const ALLOWED_TYPES = ['custom', 'quickconnect', 'spellcpaas', 'sparrow', 'hms', 'sociair', 'aakash',
  'webzonesms', 'nestsms', 'nestpanel', 'xoro', 'smpp'];

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const MongoStore = require('connect-mongo').default;
app.use(session({
  secret: process.env.VENDOR_SESSION_SECRET || process.env.SESSION_SECRET || 'vendor-secret',
  resave: false, saveUninitialized: false, rolling: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smpp_bridge',
    collectionName: 'vendor_sessions', ttl: 7 * 24 * 3600,
  }),
  cookie: { maxAge: 7 * 24 * 3600 * 1000 },
}));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[vendor]', e); res.status(500).json({ error: e.message }); });
const requireAuth = (req, res, next) => req.session && req.session.vendor ? next() : res.status(401).json({ error: 'unauthorized' });
const lc = (s) => String(s || '').toLowerCase().trim();
const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

// ---------------- auth ----------------
app.post('/api/login', wrap(async (req, res) => {
  const vendor_id = lc((req.body || {}).vendor_id);
  const password = (req.body || {}).password || '';
  if (!vendor_id || !password) return res.status(400).json({ error: 'vendor id and password required' });
  const v = await db.Vendor.findOne({ vendor_id });
  if (!v || !v.is_active || !(await bcrypt.compare(password, v.password))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  req.session.vendor = { vendor_id: v.vendor_id, name: v.name };
  db.Vendor.updateOne({ _id: v._id }, { $set: { last_login_at: new Date() } }).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.vendor));

// Everything below requires a logged-in vendor.
app.use('/api', requireAuth);

const vid = (req) => req.session.vendor.vendor_id;

// Shape a Route into the limited view a vendor is allowed to see.
function publicEndpoint(r) {
  const remaining = r.route_credits != null ? r.route_credits : 0;
  const total = r.inventory_total || 0;
  const used = Math.max(0, total - remaining);
  return {
    id: String(r._id),
    name: r.name,
    type: r.type,
    api_url: r.api_url || '',
    sender_id: r.sender_id || '',
    cost_per_sms: r.cost_per_sms,
    status: r.vendor_status || 'pending',
    is_active: !!r.is_active,
    balance: remaining,   // SMS remaining
    used,                 // SMS sent through this endpoint
    total,                // SMS ever provided (declared + top-ups)
    has_token: !!r.auth_token,
    createdAt: r.createdAt,
  };
}

app.get('/api/types', (req, res) => res.json(ALLOWED_TYPES));

// Dashboard totals across the vendor's own endpoints.
app.get('/api/summary', wrap(async (req, res) => {
  const rs = await db.Route.find({ vendor_id: vid(req) }).lean();
  let balance = 0, used = 0, total = 0, pending = 0, approved = 0;
  for (const r of rs) {
    const rem = r.route_credits != null ? r.route_credits : 0;
    const tot = r.inventory_total || 0;
    balance += rem; total += tot; used += Math.max(0, tot - rem);
    if (r.vendor_status === 'approved') approved++; else if (r.vendor_status !== 'rejected') pending++;
  }
  res.json({ endpoints: rs.length, balance, used, total, pending, approved });
}));

// List the vendor's own endpoints.
app.get('/api/endpoints', wrap(async (req, res) => {
  const rs = await db.Route.find({ vendor_id: vid(req) }).sort({ createdAt: -1 }).lean();
  res.json(rs.map(publicEndpoint));
}));

// Add a new endpoint API. Lands as a Route owned by this vendor, pending + inactive.
app.post('/api/endpoints', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const type = ALLOWED_TYPES.includes(b.type) ? b.type : 'custom';
  const balance = Math.max(0, Math.round(num(b.balance, 0)));
  const set = {
    name, type,
    api_url: String(b.api_url || '').trim(),
    auth_token: String(b.auth_token || '').trim(),
    sender_id: String(b.sender_id || '').trim(),
    http_method: String(b.http_method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
    cost_per_sms: db.round3(num(b.cost_per_sms, 0)),
    vendor_id: vid(req),
    vendor_status: 'pending',
    is_active: false,            // cannot carry traffic until the operator approves
    route_credits: balance,      // declared balance = SMS remaining
    inventory_total: balance,    // and total provided (so used starts at 0)
    inventory_alerted: false,
  };
  const r = await db.Route.create(set);
  res.json({ ok: true, endpoint: publicEndpoint(r) });
}));

// Edit an endpoint. Name is always editable; the API url/token/type/method/price are editable only
// while still pending (a live, approved route is locked to the vendor — they top up balance instead,
// or ask the operator to change it). Always ownership-checked.
app.patch('/api/endpoints/:id', wrap(async (req, res) => {
  const r = await db.Route.findOne({ _id: req.params.id, vendor_id: vid(req) });
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const set = {};
  if (b.name != null) { const n = String(b.name).trim(); if (n) set.name = n; }
  if (r.vendor_status === 'pending') {
    if (b.type != null && ALLOWED_TYPES.includes(b.type)) set.type = b.type;
    if (b.api_url != null) set.api_url = String(b.api_url).trim();
    if (b.auth_token != null && String(b.auth_token).trim()) set.auth_token = String(b.auth_token).trim();
    if (b.sender_id != null) set.sender_id = String(b.sender_id).trim();
    if (b.http_method != null) set.http_method = String(b.http_method).toUpperCase() === 'GET' ? 'GET' : 'POST';
    if (b.cost_per_sms != null) set.cost_per_sms = db.round3(num(b.cost_per_sms, 0));
  }
  if (!Object.keys(set).length) return res.json({ ok: true, endpoint: publicEndpoint(r) });
  const updated = await db.Route.findByIdAndUpdate(r._id, { $set: set }, { new: true });
  res.json({ ok: true, endpoint: publicEndpoint(updated) });
}));

// Top up the declared balance (adds SMS to both remaining + total stock).
app.post('/api/endpoints/:id/topup', wrap(async (req, res) => {
  const sms = Math.round(num((req.body || {}).sms, 0));
  if (!sms || sms <= 0) return res.status(400).json({ error: 'positive sms amount required' });
  const r = await db.Route.findOne({ _id: req.params.id, vendor_id: vid(req) });
  if (!r) return res.status(404).json({ error: 'not found' });
  const update = r.route_credits == null
    ? { $set: { route_credits: sms, inventory_alerted: false }, $inc: { inventory_total: sms } }
    : { $inc: { route_credits: sms, inventory_total: sms }, $set: { inventory_alerted: false } };
  const updated = await db.Route.findByIdAndUpdate(r._id, update, { new: true });
  res.json({ ok: true, endpoint: publicEndpoint(updated) });
}));

app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

db.connect().then(() => app.listen(PORT, '0.0.0.0', () => {
  console.log(`[vendor] portal on :${PORT}`);
})).catch((e) => { console.error('[vendor] startup failed', e); process.exit(1); });
