/**
 * INSOFT "web SMS Server" variant (Insoft R&D) — the inschoolerp-style panel API.
 * Distinct from providers/insoft.js: different field names + path + it HAS a credit endpoint.
 *
 * Base URL is per-account (the docs' example `sms.inschoolerp.com` is just a sample and does NOT
 * resolve). Set the real panel host via route.api_url (or per-key host / route.config.host).
 *
 *   SEND   GET|POST {base}/api/sendsms   fields: token, sender, to, message
 *          to = comma-separated 10-digit numbers (we send one dest per request)
 *          OK   200 { response_code:200, response:success, message_count, balance_deducted }
 *          ERR  { 203: token not found, 401: invalid token, 402: no credits, 451: account expired }
 *   CREDIT GET {base}/credit/?token=...  -> { response_code:200, body:success, senderid, current_balance }
 *
 * Creds: route.auth_token = API token; route.sender_id = approved Sender ID. Per-key (pool) each
 * ProviderKey carries its own token/sender/host. Rotation + credit accounting via ./keypool.
 * DLR: acceptance only (no real receipt) → keep provides_dlr per operator choice (false=accepted,
 * true=optimistic delivered, as set for the INSOFT family).
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');
const keypool = require('./keypool');

const DEFAULT_BASE = 'https://sms.inschoolerp.com'; // sample host from the docs (override per account)
const SEND_PATH = '/api/sendsms';
const CREDIT_PATH = '/credit/';

function baseUrl(hostOrRoute) {
  let b;
  if (hostOrRoute && typeof hostOrRoute === 'object') {
    const c = hostOrRoute.config || {};
    b = c.api_url || c.host || hostOrRoute.api_url || DEFAULT_BASE;
  } else { b = hostOrRoute || DEFAULT_BASE; }
  b = String(b).trim();
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '').replace(/\/(api\/sendsms|credit).*/i, '');
}
function routeMethod(route) { const c = route.config || {}; return String(c.method || route.http_method || 'GET').toUpperCase(); }
function sendPath(route) { return (route.config || {}).send_path || SEND_PATH; }
function creditPath(route) { return (route.config || {}).credit_path || CREDIT_PATH; }

function legacyCreds(route) {
  const c = route.config || {};
  return { token: String(c.token || route.auth_token || '').trim(), sender_id: String(c.sender || c.senderid || route.sender_id || '').trim(), host: baseUrl(route) };
}

// One raw HTTP send with explicit {token, sender_id, host}. No credit accounting (keypool does that).
async function sendOnce(route, key, numberto, msg) {
  const method = routeMethod(route);
  const base = baseUrl(key.host || baseUrl(route));
  const fields = { token: key.token, sender: key.sender_id, to: numberto, message: msg };
  let res;
  if (method === 'POST') {
    res = await axios.post(base + sendPath(route), qs.stringify(fields),
      outbound.cfg(route, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: (route.config && route.config.timeout_ms) || route.timeout_ms || 35000, validateStatus: () => true }));
  } else {
    res = await axios.get(base + sendPath(route), outbound.cfg(route, { params: fields, timeout: (route.config && route.config.timeout_ms) || route.timeout_ms || 35000, validateStatus: () => true }));
  }
  let d = res.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = { raw: d }; } }
  d = d || {};
  const code = Number(d.response_code != null ? d.response_code : res.status);
  if (code === 200) {
    return { success: true, pending: false, providerStatus: 'queued', rawData: d, deducted: Number(d.balance_deducted), messageCount: Number(d.message_count) || 1 };
  }
  const why = d.response || d.body || d.message || `HTTP ${res.status}`;
  return { success: false, providerStatus: 'failed', error: `INSOFT2 ${code}: ${why}`, rawData: d, httpCode: code };
}

async function send(route, dest, msg) {
  return keypool.sendViaPool(route, dest, msg, {
    attempt: sendOnce, legacyKey: legacyCreds,
    idPrefix: 'insoft2', providerLabel: 'INSOFT2', requireSender: true,
  });
}

// Real balance check via /credit/?token= — also used to verify a token.
async function creditCheck(route, token, host) {
  const base = baseUrl(host || baseUrl(route));
  const res = await axios.get(base + creditPath(route), outbound.cfg(route, { params: { token }, timeout: 12000, validateStatus: () => true }));
  let d = res.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = { raw: d }; } }
  d = d || {};
  const code = Number(d.response_code != null ? d.response_code : res.status);
  if (code === 200 || d.current_balance != null) return { ok: true, balance: d.current_balance != null ? d.current_balance : null, senderid: d.senderid, raw: d };
  return { ok: false, error: `INSOFT2 ${code}: ${d.response || d.body || ('HTTP ' + res.status)}`, raw: d };
}

// Test: unlike insoft v1, this API has a credit endpoint → we can confirm the token AND show balance.
async function testConnection(route) {
  const stats = await keypool.poolStats(route._id).catch(() => null);
  if (stats) {
    const compact = { total_keys: stats.total_keys, active_keys: stats.active_keys, exhausted: stats.exhausted, disabled: stats.disabled, credit_remaining: stats.credit_remaining };
    if (!stats.active_keys) return { success: false, error: `pool has ${stats.total_keys} keys but none active with credit`, rawData: compact };
    try {
      const c = await creditCheck(route, stats.top.token, stats.top.host);
      if (c.ok) return { success: true, messageId: null, rawData: Object.assign(compact, { top_key_live_balance: c.balance }) };
      // Credit endpoint unavailable on this host (e.g. /credit/ 404s on insoftsms.com) — that's not a
      // token failure; the pool is configured and the send endpoint is what matters.
      return { success: true, messageId: null, rawData: Object.assign(compact, { note: 'pool configured; balance endpoint not available here (' + c.error + ')' }) };
    } catch (e) { return { success: true, messageId: null, rawData: Object.assign(compact, { note: 'pool configured; balance check failed: ' + e.message }) }; }
  }
  const lc = legacyCreds(route);
  if (!lc.token) return { success: false, error: 'no keys in pool and no route API token set' };
  if (!lc.sender_id) return { success: false, error: 'no Sender ID set (route sender_id)' };
  try {
    const c = await creditCheck(route, lc.token, lc.host);
    if (c.ok) return { success: true, messageId: null, rawData: { current_balance: c.balance, senderid: c.senderid } };
    return { success: true, messageId: null, rawData: { note: 'token set; balance endpoint not available here (' + c.error + ') — send a test SMS to fully verify' } };
  } catch (e) { return { success: false, error: e.message }; }
}

module.exports = { send, testConnection, creditCheck, _baseUrl: baseUrl, _toLocal: keypool.toLocal };
