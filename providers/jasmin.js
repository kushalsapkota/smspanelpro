/**
 * Jasmin SMS Gateway — HTTP API (http://jasminsms.com). Used here for the NEA reseller route:
 * the bridge POSTs to a Jasmin instance which relays over SMPP to the carrier.
 *
 *   SEND  GET/POST {base}/send?username=&password=&to=&content=&from=&coding=&dlr=...
 *         Response:  Success "<uuid>"   (HTTP 200)        -> submitted; uuid is the message id
 *                    Error "<reason>"   (HTTP 4xx)        -> rejected (auth, balance, throttling, bad args)
 *
 *   BALANCE  GET {balance_url}  (HTTP Basic user:pass, default the mgmt API /secure/balance on :8080)
 *            -> {"balance": <float|"ND">, "sms_count": <int|"ND">}
 *
 * Auth lives in route.config (username, password) — NOT in auth_token, since Jasmin needs both and
 * we keep the password out of the URL by POSTing form-encoded (config.method='GET' to override).
 * Sender id: the per-message `source`, else config.from. DLR is push-only in Jasmin (it calls back a
 * dlr-url); we do not poll, so leave route.provides_dlr=false and report 'accepted' on submit. To get
 * real receipts, set config.dlr_url to a bridge webhook and we pass dlr=yes&dlr-level=2&dlr-method=POST.
 *
 * Numbers: Jasmin/SMPP want full international without '+'. toMsisdn() strips +/00/spaces; a bare
 * Nepal 10-digit (98xxxxxxxx) gets config.cc (default '977') prepended. Set config.keepNumber=true to
 * pass the MSISDN untouched (for accounts that expect local format).
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');

const DEFAULT_SEND = 'http://127.0.0.1:1401/send';

function cfg(route) {
  const c = route.config || {};
  let base = String(c.api_url || route.api_url || DEFAULT_SEND).trim().replace(/\/+$/, '');
  if (!/\/send$/i.test(base)) base += '/send';
  return {
    url: base,
    username: String(c.username || route.username || '').trim(),
    password: String(c.password || route.password || ''),
    from: c.from != null ? String(c.from).trim() : '',
    method: String(route.http_method || c.method || 'POST').toUpperCase(),
    coding: c.coding != null ? Number(c.coding) : null, // null => auto (8 for non-GSM, else 0)
    cc: String(c.cc || '977'),
    keepNumber: !!c.keepNumber,
    balanceUrl: c.balance_url ? String(c.balance_url).trim() : '',
    dlrUrl: c.dlr_url ? String(c.dlr_url).trim() : '',
  };
}

// Strip +/00/spaces; prepend country code to a bare local 10-digit number.
function toMsisdn(n, c) {
  let s = String(n).replace(/[^\d]/g, '');
  if (c.keepNumber) return s;
  s = s.replace(/^00/, '');
  if (s.length === 10 && /^9/.test(s)) s = c.cc + s; // 98xxxxxxxx -> 97798xxxxxxxx
  return s;
}

// UCS2 (coding=8) for anything outside plain ASCII (e.g. Devanagari), GSM 7-bit (0) otherwise.
function codingFor(c, msg) {
  if (c.coding != null) return c.coding;
  return /[^\x00-\x7F]/.test(String(msg)) ? 8 : 0;
}

// Jasmin answers "Success \"<id>\"" or "Error \"<reason>\"" — sometimes the bare word on odd builds.
function parse(status, data) {
  const txt = String(data == null ? '' : data).trim();
  const m = txt.match(/^Success\s*"?([^"\r\n]+)"?/i);
  if (m && status >= 200 && status < 300) return { ok: true, id: m[1].trim() };
  const e = txt.match(/^Error\s*"?([^"\r\n]*)"?/i);
  if (e) return { ok: false, err: (e[1] || 'rejected').trim().slice(0, 200) };
  if (status >= 200 && status < 300 && txt) return { ok: true, id: txt.slice(0, 120) };
  return { ok: false, err: (txt || `HTTP ${status}`).slice(0, 200) };
}

function buildParams(c, { to, content, from } = {}) {
  const p = { username: c.username, password: c.password };
  if (to != null) p.to = to;
  if (content != null) { p.content = content; p.coding = codingFor(c, content); }
  const snd = from || c.from;
  if (snd) p.from = snd;
  if (c.dlrUrl) { p.dlr = 'yes'; p['dlr-url'] = c.dlrUrl; p['dlr-level'] = 2; p['dlr-method'] = 'POST'; }
  return p;
}

async function call(c, extra) {
  // maxRedirects:0 — a Jasmin behind a reverse proxy that 30x-bounces is a fault, not a send; see spellcpaas.
  const opts = outbound.cfg(c.route, { timeout: c.timeout || 20000, maxRedirects: 0, validateStatus: () => true });
  if (c.method === 'GET') {
    return axios.get(c.url, Object.assign(opts, { params: buildParams(c, extra) }));
  }
  return axios.post(c.url, qs.stringify(buildParams(c, extra)), Object.assign(opts, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
}

async function send(route, dest, msg, source) {
  const c = cfg(route); c.route = route; c.timeout = route.timeout_ms || 20000;
  if (!c.username || !c.password) {
    return { success: false, providerStatus: 'error', error: 'Jasmin: missing username/password (set them in the route config)' };
  }
  try {
    const to = toMsisdn(dest, c);
    if (!to) return { success: false, providerStatus: 'failed', error: 'Jasmin: empty/invalid destination' };
    const res = await call(c, { to, content: String(msg).slice(0, 1530), from: source });
    if (res.status >= 300 && res.status < 400) {
      const loc = (res.headers && (res.headers.location || res.headers.Location)) || 'redirect';
      return { success: false, providerStatus: 'failed', error: `Jasmin: unexpected redirect (HTTP ${res.status} -> ${loc}) — check api_url points straight at the gateway`, rawData: { status: res.status, location: loc } };
    }
    const out = parse(res.status, res.data);
    if (out.ok) {
      // Push-DLR only; engine reports 'accepted' unless route.provides_dlr + a DLR webhook resolves it later.
      return { success: true, pending: false, messageId: out.id, providerStatus: 'accepted', rawData: res.data };
    }
    return { success: false, providerStatus: 'failed', error: `Jasmin: ${out.err}`, rawData: res.data };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Admin/CRM "Test": prefer a real balance read (proves user+pass against the mgmt API). If no
// balance_url is set, hit /send with creds only — Jasmin replies "Mandatory arguments not found"
// when auth is OK vs "Authentication failure ..." when it is not, so we learn the creds verdict
// WITHOUT submitting a message.
async function testConnection(route) {
  const c = cfg(route); c.route = route;
  if (!c.username || !c.password) return { success: false, error: 'missing username/password' };
  try {
    if (c.balanceUrl) {
      const res = await axios.get(c.balanceUrl, outbound.cfg(route, {
        timeout: 15000, validateStatus: () => true,
        auth: { username: c.username, password: c.password },
      }));
      if (res.status === 401 || res.status === 403) return { success: false, error: `Jasmin: auth failed (HTTP ${res.status})`, rawData: res.data };
      if (res.status !== 200) return { success: false, error: `Jasmin balance HTTP ${res.status}`, rawData: res.data };
      const bal = res.data && (res.data.balance != null ? res.data.balance : res.data);
      return { success: true, messageId: null, note: `Jasmin OK — balance: ${typeof bal === 'object' ? JSON.stringify(bal) : bal}`, rawData: res.data };
    }
    const res = await call(c, {}); // creds only, no to/content
    const txt = String(res.data || '');
    if (/Authentication failure|authorization failed|incorrect/i.test(txt)) {
      return { success: false, error: `Jasmin: ${txt.replace(/^Error\s*/i, '').replace(/"/g, '').trim().slice(0, 160)}`, rawData: res.data };
    }
    // "Mandatory arguments not found" (or any non-auth error) => creds accepted, just missing to/content.
    return { success: true, messageId: null, note: 'Jasmin: credentials accepted (set a balance_url in config for a balance check).', rawData: res.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { send, testConnection, _toMsisdn: toMsisdn, _parse: parse, _codingFor: codingFor };
