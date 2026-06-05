/**
 * Core message pipeline shared by the SMPP server (index.js) and the portal HTTP API.
 *
 *   accept(user, dest, text, source, channel) -> decision (runs checks + billing + logs,
 *      returns FAST so the SMPP server can reply ESME_ROK before the slow downstream call)
 *   fireDispatch(decision.prepared)            -> async send to provider + failover + refund + DLR
 *
 * DLRs are delivered back to bound SMPP clients via a hook the SMPP server registers
 * with setDlrDeliver(); HTTP tenants get them via webhook.
 */
const db = require('../db');
const providers = require('../providers');
const axios = require('axios');
const dlrlog = require('./dlrlog'); // permanent file-based DLR/sending archive

// SMPP command_status codes (so this module needn't depend on the smpp lib).
const S = {
  ROK: 0x00, RINVMSGLEN: 0x01, RSYSERR: 0x08, RINVSRCADR: 0x0a, RINVDSTADR: 0x0b,
  RINVPASWD: 0x0e, RINVSYSID: 0x0f, RSUBMITFAIL: 0x45, RTHROTTLED: 0x58,
};
const HTTP_FOR = { [S.RINVDSTADR]: 400, [S.RTHROTTLED]: 402, [S.RINVMSGLEN]: 403, [S.RSUBMITFAIL]: 422, [S.RSYSERR]: 500 };

let telegram = { systemAlert: () => {}, userAlert: () => {} };
try { telegram = require('../telegram'); } catch (_) {}

let dlrDeliver = null; // (username, dlr) => void  registered by the SMPP server
function setDlrDeliver(fn) { dlrDeliver = fn; }

// ---- low-balance alerting (immediate, debounced per user) ----
const lowBalCooldown = new Map(); // username -> last alert ts
const LOWBAL_COOLDOWN_MS = 30 * 60 * 1000;
let _globalLowBal = null, _globalLowBalAt = 0;
async function globalLowBalThreshold() {
  if (Date.now() - _globalLowBalAt < 60000) return _globalLowBal; // cache 60s, off the hot path
  try { const s = await db.Setting.findOne({ key: 'alerts' }); _globalLowBal = (s && s.value && s.value.lowBalance) || 0; }
  catch (_) { _globalLowBal = 0; }
  _globalLowBalAt = Date.now();
  return _globalLowBal;
}
async function maybeLowBalanceAlert(user, balance) {
  const thr = (user.low_balance_threshold != null) ? user.low_balance_threshold : await globalLowBalThreshold();
  if (!thr || balance > thr) return;
  const now = Date.now();
  if ((lowBalCooldown.get(user.username) || 0) > now - LOWBAL_COOLDOWN_MS) return; // one alert per 30 min
  lowBalCooldown.set(user.username, now);
  const bal = db.round3(balance);
  telegram.systemAlert(`⚠️ Low balance: <b>${user.username}</b> is at €${bal} (≤ threshold €${db.round3(thr)}). Top-up needed.`);
  telegram.userAlert(user, `⚠️ Your balance is low: €${bal}. Please top up to keep sending.`);
}

// ---- in-memory trackers ----
const recent = new Map();       // dedup key -> ts
const mps = new Map();          // username -> { sec, count }
const rrIndex = new Map();      // username -> round-robin template index
const DEDUP_MS = 3000;

function dedupHit(username, dest, text) {
  const key = `${username}|${dest}|${text}`;
  const now = Date.now();
  const prev = recent.get(key);
  recent.set(key, now);
  if (recent.size > 5000) for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
  return prev && now - prev < DEDUP_MS;
}

function mpsExceeded(user) {
  const sec = Math.floor(Date.now() / 1000);
  const t = mps.get(user.username);
  if (!t || t.sec !== sec) { mps.set(user.username, { sec, count: 1 }); return false; }
  t.count++;
  return t.count > (user.max_mps || 10);
}

// ---- content policy / auto-templating ----
// Global content policy + the shared auto-template pool, cached 30s off the hot path.
//   Setting 'content_policy' = { force_auto_template, numeric_only, min_len, max_len }
//   Setting 'auto_templates' = [ "…XXXXXX…", … ]  (shared library, applies to every user)
let _cp = null, _cpAt = 0, _pool = [], _poolAt = 0;
async function contentPolicy() {
  if (Date.now() - _cpAt < 30000) return _cp;
  try { const s = await db.Setting.findOne({ key: 'content_policy' }); _cp = (s && s.value) || {}; }
  catch (_) { _cp = _cp || {}; }
  // sensible defaults: force auto-templating on for everyone, numeric codes 4–10 digits
  _cp = Object.assign({ force_auto_template: true, numeric_only: true, min_len: 4, max_len: 10 }, _cp);
  _cpAt = Date.now();
  return _cp;
}
async function autoTemplatePool() {
  if (Date.now() - _poolAt < 30000) return _pool;
  try { const s = await db.Setting.findOne({ key: 'auto_templates' }); _pool = (s && Array.isArray(s.value) ? s.value : []) || []; }
  catch (_) { _pool = _pool || []; }
  _poolAt = Date.now();
  return _pool;
}

function templateToRegex(body) {
  // {{code}}, {code}, runs of X (4+), or digit runs become wildcards.
  let re = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  re = re.replace(/\\\{\\\{[^}]*\\\}\\\}/g, '.*?').replace(/\\\{[^}]*\\\}/g, '.*?');
  re = re.replace(/X{4,}/gi, '.*?').replace(/\d+/g, '\\d+');
  return new RegExp('^' + re + '$', 'i');
}

// Replace any supported code placeholder in a template with the actual code (any length).
function injectCode(tpl, code) {
  return String(tpl)
    .replace(/\{\{\s*(code|otp|pin)\s*\}\}/gi, code)
    .replace(/\{\s*(code|otp|pin)\s*\}/gi, code)
    .replace(/X{3,}/gi, code)   // XXXX / XXXXXX / XXXXXXXX -> code (length-independent)
    .replace(/#{3,}/g, code);   // #### / ###### -> code
}

async function checkTemplate(user, text) {
  const cp = await contentPolicy();

  // Auto-templating is active when the operator forces it globally, OR this user
  // is individually set to injection mode (bypass_template=false). When forced,
  // it overrides a user's passthrough — every client is auto-templated.
  const autoActive = cp.force_auto_template || !user.bypass_template;

  if (autoActive) {
    // The client must send ONLY a numeric code (4–10 digits by default). Anything
    // with letters / words / symbols is rejected outright — codes, not messages.
    const raw = String(text).trim();
    if (cp.numeric_only !== false) {
      const min = Number(cp.min_len) || 4, max = Number(cp.max_len) || 10;
      if (!new RegExp(`^\\d{${min},${max}}$`).test(raw)) {
        return { ok: false, finalText: text, reason: `expects a ${min}-${max} digit number only` };
      }
    }
    // Code = the numeric payload (or, if non-numeric input is allowed, the longest digit run).
    const code = cp.numeric_only !== false ? raw : ((String(text).match(/\d{3,}/g) || [raw]).sort((a, b) => b.length - a.length)[0]);

    // Prefer the client's own templates; else fall back to the shared global pool.
    const pool = (user.templates && user.templates.length) ? user.templates : await autoTemplatePool();
    if (!pool.length) return { ok: false, finalText: text, reason: 'no templates configured' };

    // RANDOM pick — no round-robin pattern (consecutive sends use unrelated templates).
    const tpl = pool[Math.floor(Math.random() * pool.length)];
    const finalText = injectCode(tpl, code);
    return { ok: true, finalText, rawCode: code };
  }

  // Passthrough (only when force is off AND the user is set to bypass).
  return { ok: true, finalText: text, rawCode: '' };
}

async function isBlacklisted(username, dest) {
  const hit = await db.Blacklist.findOne({ destination: dest, $or: [{ username: null }, { username }] });
  return !!hit;
}
async function hasBlockedWord(username, text) {
  const words = await db.BlockedWord.find({ $or: [{ username: null }, { username }] });
  const low = String(text).toLowerCase();
  return (words || []).some((w) => low.includes(String(w.word).toLowerCase()));
}

// ---- route selection (LCR -> primary -> backup -> gold-any) ----
async function pickRoutes(user, dest) {
  const out = [];
  const push = (r) => { if (r && r.is_active && !out.find((x) => String(x._id) === String(r._id))) out.push(r); };

  // LCR: longest matching prefix rule
  const rules = await db.RoutingRule.find({ is_active: true });
  const matched = (rules || []).filter((r) => String(dest).startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length || (b.priority - a.priority));
  for (const m of matched) push(await db.Route.findById(m.route_id));

  if (user.route_id) push(await db.Route.findById(user.route_id));
  if (user.backup_route_id) push(await db.Route.findById(user.backup_route_id));

  if (user.plan_name === 'gold') {
    const all = await db.Route.find({ is_active: true });
    for (const r of all) push(r);
  }
  return out;
}

/**
 * Phase 1 — validate, bill, log. Returns a decision object:
 *   { ok, smppStatus, httpStatus, messageId, prepared }
 */
async function accept(user, dest, text, source, channel = 'smpp') {
  const reject = (smppStatus, reason) => ({ ok: false, smppStatus, httpStatus: HTTP_FOR[smppStatus] || 400, reason });

  if (!user.is_active || user.is_suspended) return reject(S.RSUBMITFAIL, 'inactive/suspended');
  if (!dest) return reject(S.RINVDSTADR, 'no destination');
  if (dedupHit(user.username, dest, text)) return reject(S.RSUBMITFAIL, 'duplicate');
  if (await isBlacklisted(user.username, dest)) return reject(S.RINVDSTADR, 'blacklisted');
  if (await hasBlockedWord(user.username, text)) return reject(S.RINVDSTADR, 'blocked word');
  if (mpsExceeded(user)) return reject(S.RTHROTTLED, 'mps exceeded');

  // template policy — auto-templating rejects anything that isn't a bare numeric code
  const tpl = await checkTemplate(user, text);
  if (!tpl.ok) {
    const warnings = (user.template_warnings || 0) + 1;
    await db.User.findByIdAndUpdate(user._id, { $set: { template_warnings: warnings } });
    telegram.userAlert(user, `❌ Rejected: ${tpl.reason || 'template policy'} (warning ${warnings}). Send only the numeric code.`);
    return reject(S.RINVMSGLEN, tpl.reason || 'template mismatch');
  }
  const finalText = tpl.finalText;

  // billing
  const parts = db.calculateSmsParts(finalText);
  const debit = await db.deductCredit(user.username, parts, { note: `${parts} part(s) -> ${dest}` });
  if (!debit.ok) {
    telegram.userAlert(user, `⚠️ Insufficient credits — message to ${dest} rejected.`);
    return reject(S.RTHROTTLED, 'insufficient credits');
  }
  maybeLowBalanceAlert(user, debit.balance).catch(() => {}); // fire immediately when this charge crosses the threshold

  // route selection
  const routes = await pickRoutes(user, dest);
  const messageId = genId();
  const primary = routes[0] || null;

  const log = await db.MessageLog.create({
    user_id: user._id, username: user.username, source: source || user.default_sender_id || '',
    destination: dest, text: finalText, raw_code: tpl.rawCode, parts, credits_used: debit.cost,
    message_id: messageId, route_name: primary ? primary.name : '', route_id: primary ? primary._id : null,
    status: 'submitted', dlr_status: 'pending', channel, day: db.dayKey(),
  });

  if (!primary) {
    // No route configured — refund and fail.
    await db.refundCredit(user.username, debit.cost, { note: 'no route', message_id: messageId });
    await db.MessageLog.findByIdAndUpdate(log._id, { $set: { status: 'failed', error: 'no route configured' } });
    telegram.systemAlert(`🚫 No route for ${user.username} -> ${dest}`);
    return reject(S.RSYSERR, 'no route');
  }

  return {
    ok: true, smppStatus: S.ROK, httpStatus: 202, messageId,
    prepared: { user, dest, finalText, source: source || user.default_sender_id || '', routes, log, cost: debit.cost, parts, messageId, channel },
  };
}

/** Phase 2 — dispatch to provider with failover; refund on total failure; schedule DLR. */
async function fireDispatch(p) {
  let lastErr = '';
  for (const route of p.routes) {
    if (!providers.isHealthy(route._id)) { lastErr = 'route suspended (circuit open)'; continue; }
    const r = await providers.dispatch(route, p.dest, p.finalText, p.source);
    if (r.success) {
      if (route.route_credits != null) await db.deductRouteCredit(route._id, p.parts).catch(() => {});
      // DLR honesty: only claim 'delivered' if the route actually reports real receipts
      // (route.provides_dlr). Otherwise the truth is 'accepted' — carrier took it, delivery
      // unconfirmed. We NEVER fabricate a 'delivered' for providers like QuickConnect.
      const verdict = r.pending ? 'pending' : (route.provides_dlr ? (r.dlr || 'delivered') : 'accepted');
      await db.MessageLog.findByIdAndUpdate(p.log._id, { $set: {
        status: 'sent', route_name: route.name, route_id: route._id,
        provider_message_id: r.messageId, provider_response: r.rawData || {},
        provider_status: r.providerStatus || '', dlr_status: verdict,
      } });
      if (route !== p.routes[0]) telegram.systemAlert(`🔁 Failover: ${p.user.username} -> ${p.dest} via ${route.name}`);
      db.recordUsage({ user_id: p.user._id, username: p.user.username, parts: p.parts, credits: p.cost, route_name: route.name, status: 'sent' });
      dlrlog.append({ username: p.user.username, destination: p.dest, message_id: p.messageId, parts: p.parts, credits: p.cost, route_name: route.name, status: 'sent', dlr_status: verdict, provider_status: r.providerStatus || '' });
      if (r.pending) scheduleDlrPoll(p, route, r.messageId);
      else if (verdict === 'delivered' || verdict === 'undelivered') deliverDlr(p, verdict);
      return { success: true, via: route.name, providerId: r.messageId, dlr: verdict };
    }
    lastErr = r.error || 'unknown';
  }
  // all routes failed -> refund, mark failed, alert
  await db.refundCredit(p.user.username, p.cost, { note: 'dispatch failed', message_id: p.messageId });
  db.recordUsage({ user_id: p.user._id, username: p.user.username, parts: p.parts, credits: 0, route_name: '', status: 'failed' });
  dlrlog.append({ username: p.user.username, destination: p.dest, message_id: p.messageId, parts: p.parts, credits: 0, route_name: '', status: 'failed', dlr_status: 'undelivered', provider_status: 'failed' });
  await db.MessageLog.findByIdAndUpdate(p.log._id, { $set: { status: 'failed', dlr_status: 'undelivered', provider_status: 'failed', error: lastErr } });
  telegram.systemAlert(`❌ Dispatch failed ${p.user.username} -> ${p.dest}: ${lastErr}`);
  return { success: false, error: lastErr };
}

// ---- DLR handling ----
function scheduleDlrPoll(p, route, providerId) {
  const started = Date.now();
  const interval = 15000, maxMs = 300000;
  const tick = async () => {
    const status = await providers.pollStatus(route, providerId).catch(() => null);
    if (status) { await deliverDlr(p, status); return; }
    if (Date.now() - started < maxMs) setTimeout(tick, interval);
  };
  setTimeout(tick, interval);
}

async function deliverDlr(p, status) {
  await db.MessageLog.findByIdAndUpdate(p.log._id, { $set: { dlr_status: status } });
  const dlr = { messageId: p.messageId, destination: p.dest, source: p.source, status, text: p.finalText, submittedAt: p.log.createdAt };
  if (p.channel === 'smpp' && dlrDeliver) { try { dlrDeliver(p.user.username, dlr); } catch (_) {} }
  if (p.user.webhook_url) postWebhook(p.user, dlr).catch(() => {});
}

async function postWebhook(user, dlr) {
  const payload = { event: 'dlr', message_id: dlr.messageId, to: dlr.destination, status: dlr.status, ts: Date.now() };
  let entry = { username: user.username, url: user.webhook_url, payload, ok: false, status_code: 0 };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (user.webhook_secret) headers['X-Webhook-Secret'] = user.webhook_secret;
    const res = await axios.post(user.webhook_url, payload, { headers, timeout: 10000, validateStatus: () => true });
    entry.ok = res.status >= 200 && res.status < 300; entry.status_code = res.status;
  } catch (e) { entry.error = e.message; }
  await db.WebhookLog.create(entry).catch(() => {});
}

function genId() { return (Date.now().toString() + Math.floor(Math.random() * 1000)).slice(-12); }

module.exports = { accept, fireDispatch, setDlrDeliver, deliverDlr, postWebhook, S, pickRoutes, checkTemplate, injectCode };
