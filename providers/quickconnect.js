/**
 * QuickConnect vendor — https://quickconnect.biz
 *
 * Two-step auth (this is the part that makes it work):
 *   route.auth_token holds a JSON blob:  {"apiToken":"...","mobile":"...","password":"..."}
 *   (email login also supported: {"apiToken":"...","email":"...","password":"..."})
 *
 *   1) LOGIN  POST https://app.quickconnect.biz/api/api/v1/login {source,mobile|email,password}
 *             -> JWT (cached per-route ~50min, so we log in ~once an hour, not per SMS)
 *   2) SEND   POST <messaging>  headers: Api-Token: <apiToken>  +  Authorization: Bearer <jwt>
 *             body: { message, recipients:[{mobile}] }   (+ sender_code if sender_id is a JSON array)
 *
 * DLRs: no webhook — engine polls pollStatus(route, batchId).
 */
const axios = require('axios');
const outbound = require('../shared/outbound');

const DEFAULT_LOGIN_URL = 'https://app.quickconnect.biz/api/api/v1/login';
// NOTE: the v1 /messaging endpoint ACKs {"message":"success"} but does NOT actually send.
// The working endpoint is /v2/messaging, which returns a real batch id in `data`.
const DEFAULT_MESSAGING_BASE = 'https://api.quickconnect.biz';
const TOKEN_TTL_MS = 50 * 60 * 1000;   // refresh well before the JWT expires
const TOKEN_BUFFER_MS = 60 * 1000;

// routeId -> { token, exp }
const tokenCache = new Map();

function parseAuth(route) {
  const raw = (route.auth_token || '').trim();
  if (!raw) throw new Error('QuickConnect route has no auth — set auth_token to {"apiToken","mobile","password"}');
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (_) { throw new Error('QuickConnect auth_token must be JSON: {"apiToken":"...","mobile":"...","password":"..."}'); }
  if (!cfg.apiToken) throw new Error('QuickConnect auth_token missing "apiToken"');
  if (!cfg.password || (!cfg.mobile && !cfg.email)) throw new Error('QuickConnect auth_token needs "password" and "mobile" (or "email")');
  return cfg;
}

function loginUrl(route) { return (route.config && route.config.loginUrl) || DEFAULT_LOGIN_URL; }

// Normalize the messaging endpoint: accept a bare base, or a full .../messaging|/v2/messaging URL.
function messagingUrl(route) {
  let u = (route.api_url || '').trim().replace(/\/$/, '');
  if (!u) return DEFAULT_MESSAGING_BASE + '/v2/messaging';
  if (/\/(v\d+\/)?messaging$/.test(u)) return u;       // already has a /messaging or /v2/messaging suffix
  return u + '/v2/messaging';
}

function toLocal(n) {
  let s = String(n).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}

async function getBearerToken(route, force) {
  const cfg = parseAuth(route);
  const id = String(route._id || route.name);
  const cached = tokenCache.get(id);
  if (!force && cached && cached.exp > Date.now() + TOKEN_BUFFER_MS) {
    return { bearerToken: cached.token, apiToken: cfg.apiToken };
  }
  const body = { source: cfg.mobile ? 'mobile' : 'email', password: cfg.password };
  if (cfg.mobile) body.mobile = String(cfg.mobile); else body.email = cfg.email;

  const res = await axios.post(loginUrl(route), body,
    outbound.cfg(route, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000, validateStatus: () => true }));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`QuickConnect login HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const d = res.data || {};
  const token = d.token || (d.data && (d.data.token || d.data.access_token || d.data.jwt)) || d.access_token;
  if (!token) throw new Error('QuickConnect login: no token in response: ' + JSON.stringify(d).slice(0, 200));
  tokenCache.set(id, { token, exp: Date.now() + TOKEN_TTL_MS });
  return { bearerToken: token, apiToken: cfg.apiToken };
}

function buildHeaders(bearerToken, apiToken) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Token': apiToken, Authorization: 'Bearer ' + bearerToken };
}

function senderCode(route) {
  if (!route.sender_id) return null;
  try { const arr = JSON.parse(route.sender_id); if (Array.isArray(arr) && arr.length) return arr[0]; } catch (_) {}
  return null; // plain sender ids are account-bound on QuickConnect; only JSON-array sender pools are sent
}

async function send(route, dest, msg, source) {
  try {
    let auth = await getBearerToken(route);
    const body = { message: msg, recipients: [{ mobile: toLocal(dest) }] };
    const sc = senderCode(route) || (source && /^\[/.test(source) ? null : null);
    if (sc) body.sender_code = sc;

    const url = messagingUrl(route);
    let res = await axios.post(url, body, outbound.cfg(route, { headers: buildHeaders(auth.bearerToken, auth.apiToken), timeout: 20000, validateStatus: () => true }));
    // JWT expired between cache hits -> re-login once.
    if (res.status === 401 || res.status === 403) {
      auth = await getBearerToken(route, true);
      res = await axios.post(url, body, outbound.cfg(route, { headers: buildHeaders(auth.bearerToken, auth.apiToken), timeout: 20000, validateStatus: () => true }));
    }
    if (res.status < 200 || res.status >= 300) {
      return { success: false, providerStatus: 'failed', error: `QuickConnect HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`, rawData: res.data };
    }
    // Read QuickConnect's OWN verdict from the response body — don't just trust the 2xx.
    // /v2/messaging returns the batch id as `data` (a string); some shapes use data.batch_id.
    const data = res.data || {};
    const batchId = (typeof data.data === 'string' && data.data) || (data.data && data.data.batch_id) || data.batch_id || null;
    const msgWord = data.message ? String(data.message) : '';
    const accepted = !!batchId || data.status === true || /success|queued|accepted/i.test(msgWord);
    if (!accepted) {
      // QuickConnect itself rejected it -> failed, with its own message.
      return { success: false, providerStatus: 'failed', error: 'QuickConnect: ' + (msgWord || JSON.stringify(data).slice(0, 160)), rawData: data };
    }
    // QuickConnect provides no post-send delivery receipt for this account (probed: every
    // report/status endpoint 404s, and /v2/messaging/status returns 401). Its send response
    // IS the delivery verdict, so we take it at face value: "success" -> delivered, and we
    // record QC's literal word + real batch_id. A bare "success" with no batch_id is only an
    // accept ack (can't be confirmed), so we mark it 'unknown' rather than 'delivered'.
    return {
      success: true, pending: false,
      messageId: String(batchId || ('qc_' + Date.now())),
      providerStatus: batchId ? 'success' : 'accepted',
      dlr: batchId ? 'delivered' : 'unknown',
      rawData: data,
    };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Poll batch status -> 'delivered' | 'undelivered' | null (still pending).
async function pollStatus(route, providerId) {
  if (!providerId || providerId.startsWith('qc_')) return null; // no real batch id to query
  try {
    const auth = await getBearerToken(route);
    const base = messagingUrl(route).replace(/\/(v\d+\/)?messaging$/, '');
    const hdr = buildHeaders(auth.bearerToken, auth.apiToken);
    // status path is under-documented; try v2 then v1.
    let res = await axios.get(`${base}/v2/messaging/status/${encodeURIComponent(providerId)}`, outbound.cfg(route, { headers: hdr, timeout: 15000, validateStatus: () => true }));
    if (res.status === 404) res = await axios.get(`${base}/messaging/status/${encodeURIComponent(providerId)}`, outbound.cfg(route, { headers: hdr, timeout: 15000, validateStatus: () => true }));
    if (res.status !== 200) return null;
    const d = res.data || {};
    const raw = d.status || d.state || (d.data && (d.data.status || d.data.state)) ||
      (Array.isArray(d.data) && d.data[0] && (d.data[0].status || d.data[0].state));
    const v = String(raw || '').toUpperCase();
    if (/(DELIVER|SUCCESS|^OK$)/.test(v)) return 'delivered';
    if (/(FAIL|UNDELIV|REJECT|ERROR|EXPIR|BLOCK)/.test(v)) return 'undelivered';
    return null;
  } catch (_) { return null; }
}

// Admin "Test" button — verifies the login credentials without sending an SMS.
async function testConnection(route) {
  try {
    const auth = await getBearerToken(route, true);
    return { success: true, messageId: null, rawData: { login: 'ok', tokenPreview: String(auth.bearerToken).slice(0, 12) + '…' } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { send, pollStatus, testConnection, getBearerToken, _toLocal: toLocal };
