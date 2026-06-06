/**
 * db.js — Mongoose schemas + billing helpers for the SMPP→HTTP bridge.
 *
 * Set MOCK_DB=true (or NO_DB=true) to run entirely in memory with no MongoDB —
 * handy for UI demos (run_ui_only.js). The mock implements the subset of the
 * Mongoose model API the app actually uses.
 */
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Schema } = mongoose;

const MOCK = process.env.MOCK_DB === 'true' || process.env.NO_DB === 'true';

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const UserSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true }, // bcrypt hash
  role: { type: String, enum: ['admin', 'reseller', 'client'], default: 'client', index: true },
  reseller_id: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  // billing
  credits: { type: Number, default: 0 },
  rate_per_credit: { type: Number, default: 1 },   // what a reseller charges this client per credit
  cost_per_sms: { type: Number, default: 1 },      // price charged per SMS segment (EUR, 0.001 precision)
  currency: { type: String, default: 'EUR' },
  plan_name: { type: String, default: 'standard' }, // standard|gold|...

  // routing
  route_id: { type: Schema.Types.ObjectId, ref: 'Route', default: null },
  backup_route_id: { type: Schema.Types.ObjectId, ref: 'Route', default: null },

  // limits / status
  max_mps: { type: Number, default: 10 },
  is_active: { type: Boolean, default: true },
  is_suspended: { type: Boolean, default: false },
  is_connected: { type: Boolean, default: false },
  allowed_ips: { type: [String], default: [] },

  // content policy
  bypass_template: { type: Boolean, default: true },
  templates: { type: [String], default: [] }, // injection templates ({{code}})
  template_warnings: { type: Number, default: 0 },
  default_sender_id: { type: String, default: '' },

  // IANA timezone this user views reports/panel in ('' = use panel default)
  timezone: { type: String, default: '' },

  // € balance at/below which a Telegram low-balance alert fires (null = use global setting)
  low_balance_threshold: { type: Number, default: null },

  // postpaid billing: balance may go NEGATIVE (debt the client settles on pay_day).
  // credit_limit is a SOFT limit in € — sends are never blocked, but an alert fires
  // when the debt exceeds it (null = no limit alert). pay_day: 0=Sun … 6=Sat.
  billing_mode: { type: String, enum: ['prepaid', 'postpaid'], default: 'prepaid', index: true },
  credit_limit: { type: Number, default: null },
  pay_day: { type: Number, default: 1 },

  // ledger reconciliation anchor: {balance, at} — a verified snapshot; the nightly check
  // proves current credits == anchor.balance + sum(transactions after anchor.at), then
  // rolls the anchor forward. Set automatically; never edit by hand.
  ledger_anchor: { type: Object, default: null },

  // integrations
  webhook_url: { type: String, default: '' },
  webhook_secret: { type: String, default: '' },
  telegram_bot_token: { type: String, default: '' },
  telegram_chat_id: { type: String, default: '' },
  branding: { type: Object, default: {} },

  last_login_at: { type: Date, default: null },
  last_bound_at: { type: Date, default: null },
  last_bound_ip: { type: String, default: '' },
}, { timestamps: true });

const RouteSchema = new Schema({
  name: { type: String, required: true },
  type: { type: String, default: 'custom' }, // quickconnect|custom|smpp|aakash|...
  api_url: { type: String, default: '' },
  auth_token: { type: String, default: '' },
  http_method: { type: String, default: 'POST' },
  sender_id: { type: String, default: '' },
  cost_per_sms: { type: Number, default: 1 },

  // optional onward-SMPP fields (type=smpp)
  smpp_host: { type: String, default: '' },
  smpp_port: { type: Number, default: 2775 },
  smpp_system_id: { type: String, default: '' },
  smpp_password: { type: String, default: '' },

  // provider-specific extras (field maps, headers, etc.)
  config: { type: Object, default: {} },

  // route-level credit pool (= SMS segments remaining at the provider; decremented per part sent)
  route_credits: { type: Number, default: null },
  route_credit_threshold: { type: Number, default: 0 },

  // provider stock tracking: inventory_total = SMS topped up at the provider (sum of recorded
  // top-ups); route_credits above is the REMAINING stock. When remaining/total drops to
  // inventory_alert_pct %, a Telegram alert fires once (inventory_alerted resets on top-up).
  inventory_total: { type: Number, default: 0 },
  inventory_alert_pct: { type: Number, default: 40 },
  inventory_alerted: { type: Boolean, default: false },

  // Does this provider deliver REAL delivery receipts? If false (e.g. QuickConnect), we never
  // claim 'delivered' to clients — only 'accepted' (carrier accepted, delivery unconfirmed).
  provides_dlr: { type: Boolean, default: false },

  auto_failover_route_id: { type: Schema.Types.ObjectId, ref: 'Route', default: null },
  is_active: { type: Boolean, default: true },
}, { timestamps: true });

const CreditTransactionSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  username: { type: String, index: true },
  type: { type: String, enum: ['topup', 'deduction', 'adjustment'], required: true },
  amount: { type: Number, required: true },       // signed
  balance_after: { type: Number, required: true },
  message_id: { type: String, default: null },
  note: { type: String, default: '' },
  payment_status: { type: String, default: 'completed' },
  by: { type: String, default: 'system' },
}, { timestamps: true });

const MessageLogSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  username: { type: String, index: true },
  source: { type: String, default: '' },
  destination: { type: String, index: true },
  text: { type: String, default: '' },
  raw_code: { type: String, default: '' },
  parts: { type: Number, default: 1 },
  credits_used: { type: Number, default: 0 },
  message_id: { type: String, index: true },
  provider_message_id: { type: String, default: null, index: true },
  route_name: { type: String, default: '' },
  route_id: { type: Schema.Types.ObjectId, ref: 'Route', default: null },
  status: { type: String, default: 'submitted', index: true }, // submitted|sent|failed|refunded
  dlr_status: { type: String, default: 'pending', index: true }, // pending|delivered|undelivered|expired|rejected|unknown
  provider_status: { type: String, default: '' }, // the provider's own verdict word (e.g. QuickConnect "success")
  provider_response: { type: Object, default: {} },
  error: { type: String, default: '' },
  channel: { type: String, default: 'smpp' }, // smpp|http
  day: { type: String, index: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 }, // 7-day TTL
}, { timestamps: true });
MessageLogSchema.index({ username: 1, createdAt: -1 });

const BlacklistSchema = new Schema({
  destination: { type: String, required: true },
  username: { type: String, default: null }, // null => global
  reason: { type: String, default: '' },
}, { timestamps: true });
BlacklistSchema.index({ destination: 1, username: 1 }, { unique: true });

const BlockedWordSchema = new Schema({
  word: { type: String, required: true, lowercase: true },
  username: { type: String, default: null },
}, { timestamps: true });

const MessageTemplateSchema = new Schema({
  username: { type: String, default: null }, // null => global
  name: { type: String, default: '' },
  body: { type: String, required: true },
  is_active: { type: Boolean, default: true },
}, { timestamps: true });

const RoutingRuleSchema = new Schema({
  prefix: { type: String, required: true, index: true }, // e.g. 97798
  route_id: { type: Schema.Types.ObjectId, ref: 'Route', required: true },
  priority: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
}, { timestamps: true });

const SettingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed },
}, { timestamps: true });

const ActiveConnectionSchema = new Schema({
  username: { type: String, index: true },
  ip: { type: String, default: '' },
  bind_type: { type: String, default: '' },
  bound_at: { type: Date, default: Date.now },
  is_connected: { type: Boolean, default: true },
}, { timestamps: true });

const ResellerBillSchema = new Schema({
  reseller_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  client_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  client_username: { type: String },
  credits: { type: Number, required: true },
  rate: { type: Number, required: true },
  total: { type: Number, required: true },
  paid: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
}, { timestamps: true });

const WebhookLogSchema = new Schema({
  username: { type: String, index: true },
  url: { type: String },
  payload: { type: Object, default: {} },
  status_code: { type: Number, default: 0 },
  ok: { type: Boolean, default: false },
  error: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
}, { timestamps: true });

const DropCommandSchema = new Schema({
  username: { type: String, index: true },
  createdAt: { type: Date, default: Date.now, expires: 60 },
}, { timestamps: true });

// Invoices (admin -> client) with payment tracking. Visible on the client dashboard.
const InvoiceSchema = new Schema({
  number: { type: String, unique: true, index: true },
  // 'manual' = ad-hoc invoice with line items; 'receipt' = auto-generated for a confirmed top-up payment
  type: { type: String, enum: ['manual', 'receipt'], default: 'manual', index: true },
  client_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  client_username: { type: String, index: true },
  items: { type: [{ description: String, qty: Number, unit_price: Number, amount: Number }], default: [] },
  subtotal: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  currency: { type: String, default: 'EUR' },
  // credits to add to the client's balance once the invoice is fully paid (0 = none)
  credits_on_pay: { type: Number, default: 0 },
  credits_applied: { type: Boolean, default: false },
  status: { type: String, enum: ['unpaid', 'partial', 'paid', 'void'], default: 'unpaid', index: true },
  paid: { type: Number, default: 0 },
  issued_date: { type: Date, default: Date.now },
  due_date: { type: Date, default: null },
  note: { type: String, default: '' },
  by: { type: String, default: 'admin' },
  // last time an overdue reminder fired for this invoice (debounce)
  last_overdue_alert: { type: Date, default: null },
}, { timestamps: true });
InvoiceSchema.index({ client_id: 1, createdAt: -1 });

const PaymentSchema = new Schema({
  invoice_id: { type: Schema.Types.ObjectId, ref: 'Invoice', index: true },
  invoice_number: { type: String },
  client_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  client_username: { type: String, index: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'EUR' },
  method: { type: String, default: 'manual' }, // manual|cash|bank|crypto|usdt-trc20|other
  status: { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'confirmed', index: true },
  // true once this payment topped up the client's balance (prevents double-credit)
  credited: { type: Boolean, default: false },
  credited_amount: { type: Number, default: 0 },
  // crypto details when method is usdt-trc20: { txid, usdt_amount, rate, wallet, network }
  crypto: { type: Object, default: {} },
  reference: { type: String, default: '' },
  note: { type: String, default: '' },
  by: { type: String, default: 'admin' },
}, { timestamps: true });
PaymentSchema.index({ client_id: 1, createdAt: -1 });

// Persistent, lightweight per-message usage record for long-term reporting.
// MessageLog has a 7-day TTL; this has none, so daily reports survive indefinitely.
// We store the raw UTC timestamp and bucket into local days per timezone at query time.
const UsageEventSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  username: { type: String, index: true },
  at: { type: Date, default: Date.now, index: true }, // UTC instant of the send
  parts: { type: Number, default: 1 },
  credits: { type: Number, default: 0 },
  route_name: { type: String, default: '' },
  status: { type: String, default: 'sent' }, // sent | failed
}, { timestamps: false });
UsageEventSchema.index({ username: 1, at: 1 });

// Operator-recorded SMS top-ups at an upstream provider (route stock purchases).
const RouteTopupSchema = new Schema({
  route_id: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
  route_name: { type: String, default: '' },
  sms: { type: Number, required: true },        // SMS segments purchased (negative = correction)
  cost: { type: Number, default: 0 },           // € paid to the provider (optional, for margin math)
  note: { type: String, default: '' },
  by: { type: String, default: 'admin' },
}, { timestamps: true });

// Per-client API keys for the public HTTP send API (alternative to username/password).
const ApiKeySchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  user_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  username: { type: String, index: true },
  label: { type: String, default: '' },
  // 'send' = client send-only (public SMS API). 'admin' = device control hub (manage everything).
  scope: { type: String, default: 'send' },
  is_active: { type: Boolean, default: true },
  calls: { type: Number, default: 0 },
  last_used_at: { type: Date, default: null },
}, { timestamps: true });

// ----------------------------------------------------------------------------
// Model registration (real Mongoose, or in-memory mock)
// ----------------------------------------------------------------------------
const defs = {
  User: UserSchema, Route: RouteSchema, CreditTransaction: CreditTransactionSchema,
  MessageLog: MessageLogSchema, Blacklist: BlacklistSchema, BlockedWord: BlockedWordSchema,
  MessageTemplate: MessageTemplateSchema, RoutingRule: RoutingRuleSchema, Setting: SettingSchema,
  ActiveConnection: ActiveConnectionSchema, ResellerBill: ResellerBillSchema,
  WebhookLog: WebhookLogSchema, DropCommand: DropCommandSchema,
  Invoice: InvoiceSchema, Payment: PaymentSchema,
  UsageEvent: UsageEventSchema, ApiKey: ApiKeySchema, RouteTopup: RouteTopupSchema,
};

let models = {};
if (MOCK) {
  const { makeMockModel } = require('./shared/mockdb');
  for (const [name, schema] of Object.entries(defs)) models[name] = makeMockModel(name, schema);
} else {
  for (const [name, schema] of Object.entries(defs)) models[name] = mongoose.model(name, schema);
}

async function connect() {
  if (MOCK) { console.log('[db] MOCK_DB mode — in-memory, no MongoDB'); return null; }
  mongoose.set('strictQuery', true);
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smpp_bridge';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log('[db] connected to ' + uri);
  return mongoose.connection;
}

// ----------------------------------------------------------------------------
// Billing helpers
// ----------------------------------------------------------------------------
// GSM-7 default + extension alphabet for segment math.
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
function isGsm7(text) {
  for (const ch of text) if (GSM7_BASIC.indexOf(ch) === -1 && GSM7_EXT.indexOf(ch) === -1) return false;
  return true;
}
function calculateSmsParts(text, forceUcs2) {
  if (!text) return 1;
  const ucs2 = forceUcs2 || !isGsm7(text);
  if (ucs2) {
    const n = Array.from(text).length;
    return n <= 70 ? 1 : Math.ceil(n / 67);
  }
  let len = 0;
  for (const ch of text) len += GSM7_EXT.indexOf(ch) !== -1 ? 2 : 1;
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

function dayKey(d = new Date()) { return new Date(d).toISOString().slice(0, 10); }

// Round money to 0.001 (EUR millis) — keeps balances on a clean 3-decimal grid, no float drift.
function round3(x) { return Math.round((Number(x) || 0) * 1000 + (Number.EPSILON * 1000)) / 1000; }

// Snap a user's stored balance back onto the 3-decimal grid after an $inc (floats drift).
async function snapBalance(updated) {
  const bal = round3(updated.credits);
  if (bal !== updated.credits) { await models.User.updateOne({ _id: updated._id }, { $set: { credits: bal } }); }
  return bal;
}

// Atomically deduct money (cost_per_sms * parts), to 0.001 precision. Returns {ok, balance, cost}.
// Prepaid: rejected when the balance can't cover the cost. Postpaid: always charged —
// the balance goes NEGATIVE (debt the client settles on their pay day).
async function deductCredit(username, parts, opts = {}) {
  const user = await models.User.findOne({ username }).exec ? await models.User.findOne({ username }).exec() : await models.User.findOne({ username });
  if (!user) return { ok: false, balance: 0, reason: 'no user' };
  const cost = round3((user.cost_per_sms || 1) * (parts || 1));
  const postpaid = user.billing_mode === 'postpaid';
  if (!postpaid && round3(user.credits || 0) < cost) return { ok: false, balance: round3(user.credits || 0), reason: 'insufficient' };
  const updated = await models.User.findOneAndUpdate(
    postpaid ? { username } : { username, credits: { $gte: cost } },
    { $inc: { credits: -cost } },
    { new: true }
  );
  if (!updated) return { ok: false, balance: round3(user.credits || 0), reason: 'insufficient' };
  const balance = await snapBalance(updated);
  await models.CreditTransaction.create({
    user_id: updated._id, username, type: 'deduction', amount: -cost,
    balance_after: balance, message_id: opts.message_id || null, note: opts.note || `${parts} part(s)`,
  });
  return { ok: true, balance, cost };
}

async function addCredits(username, amount, opts = {}) {
  amount = round3(amount);
  const updated = await models.User.findOneAndUpdate({ username }, { $inc: { credits: amount } }, { new: true });
  if (!updated) return { ok: false };
  const balance = await snapBalance(updated);
  await models.CreditTransaction.create({
    user_id: updated._id, username,
    type: opts.type || (amount >= 0 ? 'topup' : 'adjustment'),
    amount, balance_after: balance, note: opts.note || '', by: opts.by || 'system',
    payment_status: opts.payment_status || 'completed',
  });
  return { ok: true, balance };
}

// Refund a failed message's credits as an adjustment.
async function refundCredit(username, cost, opts = {}) {
  return addCredits(username, Math.abs(cost), { type: 'adjustment', note: opts.note || 'refund: dispatch failed', ...opts });
}

// Deduct from a route's own credit pool (if configured). Returns remaining or null.
async function deductRouteCredit(routeId, parts) {
  const route = await models.Route.findById(routeId);
  if (!route || route.route_credits == null) return null;
  const updated = await models.Route.findOneAndUpdate(
    { _id: routeId, route_credits: { $gte: parts } },
    { $inc: { route_credits: -parts } }, { new: true }
  );
  return updated ? updated.route_credits : null;
}

// Atomic invoice counter (Setting 'invoice_seq') — numbers must NEVER repeat, even
// after an invoice is deleted (the old countDocuments() approach reused numbers).
async function nextInvoiceNumber() {
  let s = await models.Setting.findOneAndUpdate(
    { key: 'invoice_seq', 'value.n': { $gte: 1 } },
    { $inc: { 'value.n': 1 } },
    { new: true }
  );
  if (!s) {
    // one-time seed: highest number ever issued (scan all — invoice count is small)
    const all = await models.Invoice.find({}, { number: 1 });
    let max = 0;
    for (const inv of (all || [])) {
      const m = /(\d+)\s*$/.exec(inv.number || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    await models.Setting.updateOne(
      { key: 'invoice_seq' },
      { $setOnInsert: { value: { n: max } } },
      { upsert: true }
    );
    s = await models.Setting.findOneAndUpdate({ key: 'invoice_seq' }, { $inc: { 'value.n': 1 } }, { new: true });
  }
  return `INV-${new Date().getUTCFullYear()}-${String(s.value.n).padStart(4, '0')}`;
}

// Supported reporting/display timezones (Nepal + US + UTC). [iana, label].
const TIMEZONES = [
  ['Asia/Kathmandu', 'Nepal — NPT (UTC+5:45)'],
  ['UTC', 'UTC'],
  ['America/New_York', 'US Eastern (ET)'],
  ['America/Chicago', 'US Central (CT)'],
  ['America/Denver', 'US Mountain (MT)'],
  ['America/Phoenix', 'US Arizona (no DST)'],
  ['America/Los_Angeles', 'US Pacific (PT)'],
  ['America/Anchorage', 'US Alaska (AKT)'],
  ['Pacific/Honolulu', 'US Hawaii (HST)'],
];
const DEFAULT_TZ = 'Asia/Kathmandu';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'EUR';

function genApiKey() { return 'sk_' + crypto.randomBytes(24).toString('hex'); }

// Append a persistent usage record (best-effort; never throws into the hot path).
async function recordUsage(ev) {
  try {
    await models.UsageEvent.create({
      user_id: ev.user_id || null, username: ev.username,
      parts: ev.parts || 1, credits: ev.credits || 0,
      route_name: ev.route_name || '', status: ev.status || 'sent',
    });
  } catch (_) {}
}

module.exports = {
  mongoose, connect, MOCK, models, ...models,
  calculateSmsParts, isGsm7, dayKey, nextInvoiceNumber,
  deductCredit, addCredits, refundCredit, deductRouteCredit, round3,
  recordUsage, genApiKey, TIMEZONES, DEFAULT_TZ, DEFAULT_CURRENCY,
};
