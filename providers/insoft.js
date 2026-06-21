/**
 * INSOFT R&D (insoftsms.com) — Pokhara, Nepal SMS gateway. Token-based HTTP API.
 *
 * Base URL is per-account: `<initial>.insoftsms.com` (the docs' example is sms.insoftsms.com).
 * Set it via route.api_url (full base, e.g. https://sms.insoftsms.com) or route.config.host.
 *
 *   SEND (POST, default)  POST {base}/smsapi/SendSmsPost
 *        JSON body { senderid, numberto, message, token }
 *   SEND (GET, optional)  GET  {base}/smsapi/sendsms?token=&senderid=&numberto=&message=
 *        (set route.config.method = 'GET' to use this)
 *
 *   OK   200 { response_code:200, response:"success", message_count, balance_deducted, message_type }
 *   FAIL 203 { response_code:203, body:"Authentication Failed. Request Token Not Found." }
 *        (note: response_code may arrive as a STRING — coerced with Number())
 *
 * KEY POOL / failover: when a route has ProviderKey docs (db.ProviderKey, scoped by route_id), this
 * adapter rotates across them — each key is its own INSOFT account (token + sender_id + host + a
 * money balance). It picks the key with the HIGHEST remaining credit, sends, then decrements that
 * key's balance by the gateway's `balance_deducted`. When a key drops to ~0 it flips to 'exhausted'
 * and the next-highest key takes over. A balance/auth error from the gateway also rotates the key
 * (exhausted / disabled) and retries the SAME message on the next key. With NO pool, it falls back
 * to the route's own auth_token/sender_id/api_url (legacy single-key mode).
 *
 * DLR: no per-message id, no status endpoint → synthetic id, provides_dlr=false → honest 'accepted'.
 */
const axios = require('axios');
const outbound = require('../shared/outbound');
const keypool = require('./keypool');

const DEFAULT_BASE = 'https://sms.insoftsms.com';
const POST_PATH = '/smsapi/SendSmsPost';
const GET_PATH = '/smsapi/sendsms';
const toLocal = keypool.toLocal;

// Normalize a configured base into "https://host" (no trailing slash, no path).
function baseUrl(hostOrRoute) {
  let b;
  if (hostOrRoute && typeof hostOrRoute === 'object') {
    const c = hostOrRoute.config || {};
    b = c.api_url || c.host || hostOrRoute.api_url || DEFAULT_BASE;
  } else {
    b = hostOrRoute || DEFAULT_BASE;
  }
  b = String(b).trim();
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '').replace(/\/smsapi.*/i, '');
}

function routeMethod(route) {
  const c = route.config || {};
  return String(c.method || route.http_method || 'POST').toUpperCase();
}

function legacyCreds(route) {
  const c = route.config || {};
  return {
    token: String(c.token || route.auth_token || '').trim(),
    sender_id: String(c.senderid || route.sender_id || '').trim(),
    host: baseUrl(route),
  };
}

// One raw HTTP send with an explicit {token, sender_id, host}. No credit accounting here.
async function sendOnce(route, key, numberto, msg) {
  const method = routeMethod(route);
  const base = baseUrl(key.host || baseUrl(route));
  let res;
  if (method === 'GET') {
    res = await axios.get(base + GET_PATH, outbound.cfg(route, {
      params: { token: key.token, senderid: key.sender_id, numberto, message: msg },
      timeout: (route.config && route.config.timeout_ms) || route.timeout_ms || 35000, validateStatus: () => true,
    }));
  } else {
    res = await axios.post(base + POST_PATH,
      { senderid: key.sender_id, numberto, message: msg, token: key.token },
      outbound.cfg(route, { headers: { 'Content-Type': 'application/json' }, timeout: (route.config && route.config.timeout_ms) || route.timeout_ms || 35000, validateStatus: () => true }));
  }
  let d = res.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = { raw: d }; } }
  d = d || {};
  const code = Number(d.response_code != null ? d.response_code : res.status);
  if (code === 200) {
    return {
      success: true, pending: false, providerStatus: 'queued', rawData: d,
      deducted: Number(d.balance_deducted), messageCount: Number(d.message_count) || 1,
    };
  }
  const why = d.body || d.message || d.response || `HTTP ${res.status}`;
  return { success: false, providerStatus: 'failed', error: `INSOFT ${code}: ${why}`, rawData: d, httpCode: code };
}

// Rotation/credit accounting lives in the shared keypool engine; we just supply the HTTP shape.
async function send(route, dest, msg) {
  return keypool.sendViaPool(route, dest, msg, {
    attempt: sendOnce,
    legacyKey: legacyCreds,
    idPrefix: 'insoft', providerLabel: 'INSOFT', requireSender: true,
  });
}

// Admin/CRM "Test" — reports pool health if a pool exists, else checks the route's own creds.
// INSOFT has no balance/no-send endpoint, so this only confirms reachability + creds present.
async function testConnection(route) {
  let db; try { db = require('../db'); } catch (_) {}
  if (db && db.ProviderKey) {
    let stats = null;
    try {
      const all = await db.ProviderKey.find({ route_id: route._id }).lean();
      if (all.length) {
        const active = all.filter(k => k.status === 'active' && k.credit_remaining > 0);
        const remaining = all.reduce((s, k) => s + (k.credit_remaining || 0), 0);
        stats = { total_keys: all.length, active_keys: active.length, exhausted: all.filter(k => k.status === 'exhausted').length, disabled: all.filter(k => k.status === 'disabled').length, credit_remaining: Math.round(remaining * 1000) / 1000 };
        if (!active.length) return { success: false, error: `pool has ${all.length} keys but none active with credit`, rawData: stats };
        const top = active.sort((a, b) => b.credit_remaining - a.credit_remaining)[0];
        const base = baseUrl(top.host || baseUrl(route));
        try {
          const res = await axios.get(base, outbound.cfg(route, { timeout: 12000, validateStatus: () => true }));
          return { success: true, messageId: null, rawData: Object.assign(stats, { active_host: base, host_status: res.status }) };
        } catch (e) { return { success: false, error: `top key host ${base} unreachable: ${e.message}`, rawData: stats }; }
      }
    } catch (_) {}
  }
  // legacy single-key
  const lc = legacyCreds(route);
  if (!lc.token) return { success: false, error: 'no keys in pool and no route API key set' };
  if (!lc.sender_id) return { success: false, error: 'no Sender ID set (route sender_id)' };
  try {
    const res = await axios.get(lc.host, outbound.cfg(route, { timeout: 12000, validateStatus: () => true }));
    return { success: true, messageId: null, rawData: { reachable: lc.host, status: res.status, note: 'single-key mode; INSOFT has no no-send check — send a test SMS to fully verify' } };
  } catch (e) { return { success: false, error: `cannot reach ${lc.host}: ${e.message}` }; }
}

module.exports = { send, testConnection, _toLocal: toLocal, _baseUrl: baseUrl, _classify: keypool.classify };
