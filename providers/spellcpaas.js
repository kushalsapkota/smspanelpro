/**
 * Spell CPaaS (spellcpaas.com) — bulk SMS HTTP API.
 *
 *   SEND  GET/POST {base}/api/smsapi?key=&campaign=&routeid=&type=text&responsetype=json
 *                                   &contacts=98xxx,98yyy&msg=<url-encoded>&time=<YYYY-MM-DD H:I>
 *         Response (plain text by default):
 *            SMS-SHOOT-ID/<alpha-num>   -> submitted OK; the part after "/" is the shoot id
 *            ERR: {<MESSAGE>}           -> error (e.g. "ERR: INVALID API KEY")
 *
 *   DLR   GET {base}/api/miscapi/<key>/getDLR/<shoot id>
 *         -> delivery report for that submission (parsed leniently — DELIVRD/FAILED/etc).
 *
 * Auth: route.auth_token = the API key (preferred). campaign + routeid are account-specific and
 * live in route.config (campaign, routeid). Optional username/password fall back via config.
 *
 * This provider DOES expose a real per-submission DLR endpoint, so a route may set
 * provides_dlr = true and the engine will poll pollStatus() to resolve delivered/undelivered.
 *
 * Number format: examples are local Nepal 10-digit (e.g. 98411XXXXX). toLocal() strips
 * +977 / 00977 / 977 / leading zeros down to the local number; set config.keepCountryCode=true
 * to send the MSISDN untouched (for non-Nepal / international accounts).
 */
const axios = require('axios');
const outbound = require('../shared/outbound');

const DEFAULT_BASE = 'https://spellcpaas.com';

function cfg(route) {
  const c = route.config || {};
  return {
    key: String(c.key || route.auth_token || '').trim(),
    campaign: c.campaign != null ? String(c.campaign).trim() : '',
    routeid: c.routeid != null ? String(c.routeid).trim() : '',
    username: c.username || '',
    password: c.password || '',
    base: String(c.api_url || route.api_url || DEFAULT_BASE).replace(/\/+$/, ''),
    method: String(route.http_method || c.method || 'POST').toUpperCase(), // live endpoint is POST-only (GET → 405)
    keepCC: !!c.keepCountryCode,
  };
}

// Strip +977 / 00977 / 977 + leading zeros → local 10-digit (guard: don't touch a clean 10-digit).
function toLocal(n, keepCC) {
  let s = String(n).replace(/[^\d]/g, '');
  if (keepCC) return s;
  if (s.length > 10) s = s.replace(/^00977/, '').replace(/^977/, '');
  s = s.replace(/^0+/, '');
  return s;
}

// Build the smsapi querystring shared by send + test (auth params always present; msg/contacts optional).
function params(c, { contacts, msg, time } = {}) {
  const p = { key: c.key, type: 'text', responsetype: 'json' };
  if (c.campaign) p.campaign = c.campaign;
  if (c.routeid) p.routeid = c.routeid;
  if (!c.key && c.username) { p.username = c.username; p.password = c.password; }
  if (contacts != null) p.contacts = contacts;
  if (msg != null) p.msg = msg;
  if (time) p.time = time;
  return p;
}

// Spell returns the shoot-id on success and "ERR: ..." on error. The DOCUMENTED success shape is
// "SMS-SHOOT-ID/<id>", but the live spellcpaas.com deployment returns the shoot-id as a BARE token
// (e.g. a 32-char hex) with no prefix. JSON shapes are also handled. So: an ERR-prefixed body (or a
// Laravel exception object) is the only failure; anything else that yields an id token is a success.
function parseSubmit(data) {
  if (data && typeof data === 'object') {
    // Laravel error envelope (validation / exception) → failure.
    if (data.exception || data.errors) return { ok: false, err: String(data.message || JSON.stringify(data)).slice(0, 200) };
    const id = data.shoot_id || data.shootid || data.id || data.message_id ||
      (data.data && (data.data.shoot_id || data.data.id));
    const err = data.error || data.err || data.message || data.msg || data.status;
    if (id) return { ok: true, id: String(id) };
    return { ok: false, err: String(err || JSON.stringify(data)).slice(0, 200) };
  }
  const txt = String(data == null ? '' : data).trim();
  if (!txt) return { ok: false, err: 'empty response' };
  // Explicit error.
  if (/^ERR\b/i.test(txt) || /\bERR:/i.test(txt)) {
    return { ok: false, err: txt.replace(/^ERR:?\s*/i, '').replace(/[{}]/g, '').trim().slice(0, 200) };
  }
  // Documented "SMS-SHOOT-ID/<id>" form.
  const m = txt.match(/SMS-SHOOT-ID\s*\/\s*([^\s"<]+)/i);
  if (m) return { ok: true, id: m[1] };
  // Bare shoot-id token (single word, no whitespace/markup) — this deployment's success shape.
  if (/^[A-Za-z0-9._:-]{6,}$/.test(txt)) return { ok: true, id: txt };
  return { ok: false, err: txt.slice(0, 200) };
}

async function call(c, extra) {
  const url = `${c.base}/api/smsapi`;
  const opts = outbound.cfg(c.route, { timeout: c.timeout || 20000, validateStatus: () => true });
  if (c.method === 'POST') {
    const qs = require('querystring');
    return axios.post(url, qs.stringify(params(c, extra)), Object.assign(opts, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    }));
  }
  return axios.get(url, Object.assign(opts, { params: params(c, extra), headers: { Accept: 'application/json' } }));
}

async function send(route, dest, msg) {
  const c = cfg(route); c.route = route; c.timeout = route.timeout_ms || 20000;
  if (!c.key && !c.username) {
    return { success: false, providerStatus: 'error', error: 'Spell CPaaS: no API key (set the route auth_token, or username/password in config)' };
  }
  try {
    const contacts = String(dest).split(',').map(s => toLocal(s, c.keepCC)).filter(Boolean).join(',');
    const res = await call(c, { contacts, msg: String(msg).slice(0, 720) });
    const out = parseSubmit(res.data);
    if (out.ok) {
      // Real DLR endpoint exists → engine will poll if route.provides_dlr is true; report 'accepted' now.
      return { success: true, pending: false, messageId: out.id, providerStatus: 'accepted', rawData: res.data };
    }
    return { success: false, providerStatus: 'failed', error: `Spell CPaaS: ${out.err}`, rawData: res.data };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Poll the per-submission DLR endpoint → 'delivered' | 'undelivered' | null (still pending).
async function pollStatus(route, providerId) {
  const c = cfg(route); c.route = route;
  if (!providerId || !c.key) return null;
  try {
    const url = `${c.base}/api/miscapi/${encodeURIComponent(c.key)}/getDLR/${encodeURIComponent(providerId)}`;
    const res = await axios.get(url, outbound.cfg(route, { timeout: 15000, validateStatus: () => true, headers: { Accept: 'application/json' } }));
    if (res.status !== 200) return null;
    const v = (typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '')).toUpperCase();
    if (/DELIVRD|DELIVERED|\bSUCCESS\b/.test(v)) return 'delivered';
    if (/UNDELIV|FAIL|REJECT|EXPIR|BLOCK|ERROR|INVALID/.test(v)) return 'undelivered';
    return null; // SUBMITTED / ENROUTE / unknown → keep polling
  } catch (_) { return null; }
}

// Admin/CRM "Test" — verifies the API key WITHOUT sending: hit smsapi with auth only (no contacts/msg).
// An invalid key returns "ERR: INVALID API KEY"; a valid key returns a different ERR (missing contacts/msg)
// or an accept — either way auth cleared.
async function testConnection(route) {
  const c = cfg(route); c.route = route;
  if (!c.key && !c.username) return { success: false, error: 'no API key set' };
  try {
    const res = await call(c, {});
    const txt = (typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '')).toUpperCase();
    // Bad key / bad login → hard fail.
    if (/INVALID\s*API\s*KEY|INVALID\s*KEY|INVALID\s*USER|INVALID\s*PASS/.test(txt)) {
      return { success: false, error: `Spell CPaaS: ${String(res.data).slice(0, 160)}`, rawData: res.data };
    }
    // Key authenticated, but the account still needs a valid campaign / route id (config) before it can send.
    if (/INVALID\s*CAMPAIGN|INVALID\s*ROUTE/.test(txt)) {
      return { success: true, messageId: null, note: `Key OK, but ${String(res.data).replace(/^ERR:\s*/i, '').trim()} — set a valid Campaign ID / Route ID in the route config (from your spellcpaas.com panel).`, rawData: res.data };
    }
    // Anything else (key cleared auth + campaign/route accepted; falls through to a missing-contacts error) = ready.
    return { success: true, messageId: null, rawData: res.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { send, pollStatus, testConnection, _toLocal: toLocal, _parseSubmit: parseSubmit };
