/**
 * Shared API-key pool rotation for token-pool providers (the INSOFT family).
 *
 * A route can own many ProviderKey docs — each its own account (token + sender + host + balance).
 * sendViaPool() picks the highest-remaining active key, calls the provider-specific `attempt`, then
 * decrements that key's credit by what the gateway deducted; a dry key flips 'exhausted' and the
 * next key takes over. Balance/credit errors exhaust a key + retry the next; auth errors disable it;
 * generic (bad-number) errors stop without blaming the key. No pool → the route's own creds (legacy).
 *
 * The caller supplies the HTTP shape; this module owns the rotation/accounting:
 *   sendViaPool(route, dest, msg, {
 *     attempt:   async (route, key, numberto, msg) => result,   // key = {token, sender_id, host}
 *     legacyKey: (route) => ({ token, sender_id, host }),       // no-pool single-key creds
 *     idPrefix:  'insoft',   providerLabel: 'INSOFT',   requireSender: true,
 *   })
 *   result = { success, providerStatus, rawData, error, httpCode, deducted, messageCount }
 */
let dbMod;
function db() { if (dbMod === undefined) { try { dbMod = require('../db'); } catch (_) { dbMod = null; } } return dbMod; }
const MAX_TRY = 10;

// Round-robin cursor per route so concurrent sends FAN OUT across the active keys instead of all
// piling onto keys[0]. Each key is a separate gateway account/token — funnelling every concurrent
// request onto one account chokes it (the credit decrement only lands AFTER the send returns, so
// keys[0] looks "highest" to every in-flight request at once) → that account times out → the
// route's circuit breaker opens and takes down EVERY client on the route.
const rrCursor = new Map(); // routeId -> counter

// Reorder the active keys so the FIRST attempt spreads load; the rest stay credit-desc as failover
// fallbacks for this one send. Default 'spread' = round-robin across keys; opt back into the old
// drain-the-highest behaviour with route.config.key_strategy = 'highest'.
function spreadOrder(keys, route) {
  if (!Array.isArray(keys) || keys.length <= 1) return keys || [];
  if (((route && route.config) || {}).key_strategy === 'highest') return keys;
  const id = String((route && (route._id || route.name)) || '');
  const n = rrCursor.get(id) || 0;
  rrCursor.set(id, (n + 1) % 1e9);
  const pick = n % keys.length;
  return [keys[pick], ...keys.slice(0, pick), ...keys.slice(pick + 1)];
}

// Bare 10-digit Nepal number (strip +977 / 00977 / 977 / leading zeros).
function toLocal(n) {
  let s = String(n).replace(/[^\d]/g, '');
  s = s.replace(/^00977/, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}

// Failed-send classification: KEY fault (rotate) vs MESSAGE/transient fault (stop, don't blame key).
// Pure TEXT-based (providers return descriptive messages) — httpCodes are NOT reliable across the
// family (402 = "No Credits" on v2 but "Something is wrong" on v1), so we read the words.
function classify(r) {
  const txt = ((r.error || '') + ' ' + JSON.stringify(r.rawData || {})).toLowerCase();
  // Transport/transient errors are NEVER a key fault — a slow/unreachable gateway must not exhaust a
  // key that still has credit. (This is what wrongly killed INSOFT keys: "timeout of …" ⊃ "out of".)
  if (/timeout|timed out|socket hang up|econnreset|econnrefused|etimedout|ehostunreach|enetunreach|enotfound|eai_again|aborted|network error|503|502|504|bad gateway|gateway timeout|service unavailable/.test(txt)) return 'other';
  // Real out-of-credit / expired-account signals (specific phrases, no bare substrings).
  if (/insuffic|recharge|expire|no\s*credit|no\s*sms|low\s*(fund|balance)|\bran out\b|out of (credit|balance|fund|sms)|not enough|balance not/.test(txt)) return 'balance';
  // Bad token / auth.
  if (/authenticat|token not found|invalid token|unauthor/.test(txt)) return 'auth';
  return 'other';
}

// Atomically consume a key's credit; flip to 'exhausted' when it can't cover another SMS.
// noExhaust (web-panel pool): the provider gives no per-send balance, so never auto-exhaust on
// credit — those accounts only leave the pool on a real auth/credit ERROR.
async function consume(route, keyId, amount, segs, noExhaust) {
  const database = db(); if (!database) return null;
  const min = Number((route.config || {}).key_min_credit) || 0;
  const dec = (isFinite(amount) && amount > 0) ? amount : 0;
  const updated = await database.ProviderKey.findOneAndUpdate(
    { _id: keyId },
    { $inc: { credit_remaining: -dec, sms_sent: segs || 1 }, $set: { last_used_at: new Date(), last_error: '' } },
    { new: true }
  );
  if (!noExhaust && updated && updated.status === 'active' && updated.credit_remaining <= min) {
    await database.ProviderKey.updateOne({ _id: keyId }, { $set: { status: 'exhausted' } });
  }
  return updated;
}

async function sendViaPool(route, dest, msg, opts) {
  const numberto = toLocal(dest);
  const label = opts.providerLabel || 'Provider';
  const idPrefix = opts.idPrefix || 'msg';
  const requireSender = opts.requireSender !== false;
  const ignoreCredit = !!opts.ignoreCredit; // web-panel pool: accounts have no per-send balance to gate on
  const classifyFn = opts.classify || classify;
  const maxRotate = opts.maxRotate != null ? opts.maxRotate : 2; // cap retries on opaque/unknown errors (likely a bad message, not the account)
  const database = db();

  let keys = [];
  if (database && database.ProviderKey) {
    const min = Number((route.config || {}).key_min_credit) || 0;
    const q = ignoreCredit
      ? { route_id: route._id, status: 'active' }
      : { route_id: route._id, status: 'active', credit_remaining: { $gt: min } };
    try {
      keys = await database.ProviderKey.find(q).sort({ credit_remaining: -1, createdAt: 1 }).limit(MAX_TRY).lean();
    } catch (_) { keys = []; }
  }

  if (!keys.length) {
    let poolExists = 0;
    if (database && database.ProviderKey) { try { poolExists = await database.ProviderKey.countDocuments({ route_id: route._id }); } catch (_) {} }
    if (poolExists > 0) return { success: false, providerStatus: 'failed', error: `${label}: every key in the pool is exhausted/disabled — top up or add keys` };
    const lc = opts.legacyKey(route);
    if (!lc.token) return { success: false, providerStatus: 'error', error: `${label}: no token (add API keys to the pool, or set the route auth_token)` };
    if (requireSender && !lc.sender_id) return { success: false, providerStatus: 'error', error: `${label}: no Sender ID (set the route sender_id)` };
    try {
      const r = await opts.attempt(route, lc, numberto, msg);
      if (r.success) r.messageId = idPrefix + '_' + numberto + '_' + Date.now();
      return r;
    } catch (err) { return { success: false, providerStatus: 'error', error: err.message }; }
  }

  keys = spreadOrder(keys, route); // fan concurrent sends across accounts; rest = failover order

  let lastErr = '', rotates = 0, lastRotateRes = null;
  for (const key of keys) {
    const k = { token: key.token, password: key.password || '', sender_id: key.sender_id || route.sender_id || '', host: key.host || '' };
    if (requireSender && !k.sender_id) {
      lastErr = 'key ' + (key.label || key._id) + ' has no Sender ID';
      await database.ProviderKey.updateOne({ _id: key._id }, { $set: { status: 'disabled', last_error: lastErr } });
      continue;
    }
    let r;
    try { r = await opts.attempt(route, k, numberto, msg); }
    catch (err) { r = { success: false, providerStatus: 'error', error: err.message }; }

    if (r.success) {
      const segs = Number(r.messageCount) || 1;
      const amount = (isFinite(r.deducted) && r.deducted > 0) ? r.deducted : segs * (Number((route.config || {}).fallback_cost_per_sms) || 0);
      await consume(route, key._id, amount, segs, ignoreCredit).catch(() => {});
      r.messageId = idPrefix + '_' + key._id + '_' + numberto + '_' + Date.now();
      r.rawData = Object.assign({}, r.rawData, { key_id: String(key._id), key_label: key.label || '', deducted: amount });
      delete r.deducted; delete r.messageCount;
      return r;
    }

    const cls = classifyFn(r);
    if (cls === 'balance') { await database.ProviderKey.updateOne({ _id: key._id }, { $set: { status: 'exhausted', last_error: r.error, last_used_at: new Date() } }); lastErr = r.error; continue; }
    if (cls === 'auth') { await database.ProviderKey.updateOne({ _id: key._id }, { $set: { status: 'disabled', last_error: r.error, last_used_at: new Date() } }); lastErr = r.error; continue; }
    if (cls === 'rotate') {
      // Opaque/transient account-level error (e.g. web panel status:1006) — try ANOTHER account but
      // leave this one active. Cap the rotations so a bad number/content doesn't burn every account.
      await database.ProviderKey.updateOne({ _id: key._id }, { $set: { last_error: r.error, last_used_at: new Date() } }).catch(() => {});
      lastErr = r.error; lastRotateRes = r;
      if (++rotates > maxRotate) return r;
      continue;
    }
    return r; // 'other' — same outcome on every key, stop.
  }
  if (lastRotateRes) return lastRotateRes; // ran out of accounts mid-rotation
  return { success: false, providerStatus: 'failed', error: `${label}: pool exhausted while sending — ` + (lastErr || 'no usable key') };
}

// Pool health for testConnection (shared shape).
async function poolStats(routeId) {
  const database = db(); if (!database) return null;
  const all = await database.ProviderKey.find({ route_id: routeId }).lean();
  if (!all.length) return null;
  const active = all.filter(k => k.status === 'active' && k.credit_remaining > 0);
  const remaining = all.reduce((s, k) => s + (k.credit_remaining || 0), 0);
  return {
    total_keys: all.length, active_keys: active.length,
    exhausted: all.filter(k => k.status === 'exhausted').length,
    disabled: all.filter(k => k.status === 'disabled').length,
    credit_remaining: Math.round(remaining * 1000) / 1000,
    keys: all,
    top: active.slice().sort((a, b) => b.credit_remaining - a.credit_remaining)[0] || null,
  };
}

module.exports = { sendViaPool, classify, consume, toLocal, poolStats, MAX_TRY };
