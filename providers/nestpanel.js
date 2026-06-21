/**
 * Nest SMS — WEB PANEL adapter (https://myaccount.nestsms.com), cookie-session driven.
 * For accounts where the public API (auth.nestsms.com/api/v1) bills but doesn't deliver: this drives
 * the same Next.js panel the browser uses. Auth is pure session-cookie (the panel calls its own
 * /api/* routes with credentials:"include" — no Bearer header).
 *
 *   LOGIN  POST {base}/api/auth/login   JSON { email, password }
 *          -> Set-Cookie session (access_token/refresh_token/session_id httpOnly). 2FA not supported.
 *   SEND   POST {base}/api/messages/send   JSON (session cookie), batched 100/req, numbers +977:
 *          { message_content, message_type, sender_id, messages:[{recipient_phone, recipient_name,
 *            message_content}], template_id? }   -> { success, data:{ batch_id, message_id? } }
 *   DLR    GET  {base}/api/messages/batch/:batch_id   -> { data:{ batch_summary:{delivered,failed,
 *            sent,pending,queued} } }
 *   TEST   GET  {base}/api/auth/me   (session cookie) — no-send credential check.
 *
 * Creds: route.config.email + route.config.password, or route.auth_token = {"email","password"}.
 *        route.sender_id (or config.sender) = approved Sender ID (required).
 * Session is cached in-memory per account and re-established on 401 / login-redirect.
 */
const axios = require('axios');
const outbound = require('../shared/outbound');

const DEFAULT_BASE = 'https://myaccount.nestsms.com';
const SESSION_TTL_MS = 20 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sessionCache = new Map(); // email@base -> { cookie, exp }

function cfg(route) { return (route && route.config) || {}; }
function baseUrl(route) {
  let b = String(cfg(route).host || route.api_url || DEFAULT_BASE).trim();
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '');
}

// Creds from config.{email,password} or auth_token JSON {"email","password"}.
function parseAuth(route) {
  const c = cfg(route);
  let email = c.email, password = c.password;
  const raw = String(route.auth_token || '').trim();
  if (raw) { try { const j = JSON.parse(raw); email = j.email || j.username || j.user || email; password = j.password || j.pass || password; } catch (_) {} }
  return { email, password };
}

// cookie jar (last value per name wins)
function jarAdd(jar, setCookie) {
  if (!setCookie) return jar;
  for (const line of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
    const first = String(line).split(';')[0].trim(); const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return jar;
}
function jarHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

// Nest wants the recipient as +977 + local 10-digit (98XXXXXXXX / 97XXXXXXXX).
function toLocal(n) {
  let s = String(n).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}
function toIntl(n) { return '+977' + toLocal(n); }

async function login(route, email, password, acctId) {
  if (!email || !password) throw new Error('Nest panel: missing email/password');
  const base = baseUrl(route);
  const to = cfg(route).timeout_ms || route.timeout_ms || 25000;
  const res = await axios.post(base + '/api/auth/login', { email, password }, outbound.cfg(route, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', Origin: base, Referer: base + '/login' },
    timeout: to, maxRedirects: 0, validateStatus: () => true,
  }));
  const d = res.data || {};
  if (res.status < 200 || res.status >= 300) throw new Error(`Nest panel login HTTP ${res.status}: ${d.message || d.error || 'rejected'}`);
  if (d.requires_2fa) throw new Error('Nest panel login: account has 2FA enabled — disable it or use the API adapter (2FA OTP not supported here)');
  const jar = jarAdd({}, res.headers['set-cookie']);
  // Fallback: some deployments return tokens in the body without httpOnly cookies — set them as cookies.
  if (!jar['access_token'] && d.access_token) jar['access_token'] = d.access_token;
  if (!jar['refresh_token'] && d.refresh_token) jar['refresh_token'] = d.refresh_token;
  const cookie = jarHeader(jar);
  if (!cookie) throw new Error('Nest panel login: no session cookie returned (HTTP ' + res.status + ')');
  sessionCache.set(acctId, { cookie, exp: Date.now() + SESSION_TTL_MS });
  return cookie;
}

async function getSession(route, email, password, force) {
  const acctId = email + '@' + baseUrl(route);
  const c = sessionCache.get(acctId);
  if (!force && c && c.exp > Date.now()) return c.cookie;
  return login(route, email, password, acctId);
}

function postSend(route, cookie, dest, msg, sender) {
  const base = baseUrl(route);
  const c = cfg(route);
  const body = {
    message_content: msg,
    message_type: c.message_type || 'transactional',
    sender_id: sender,
    messages: [{ recipient_phone: toIntl(dest), recipient_name: '', message_content: msg }],
  };
  if (c.template_id) body.template_id = c.template_id;
  return axios.post(base + '/api/messages/send', JSON.stringify(body), outbound.cfg(route, {
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json',
      Origin: base, Referer: base + '/send-sms', Cookie: cookie,
    },
    timeout: c.timeout_ms || route.timeout_ms || 30000, maxRedirects: 0, validateStatus: () => true,
  }));
}

function needsRelogin(res) {
  return res.status === 401 || res.status === 302 || /\/login/i.test(String(res.headers.location || ''));
}

async function send(route, dest, msg, source) {
  const { email, password } = parseAuth(route);
  if (!email || !password) return { success: false, providerStatus: 'error', error: 'Nest panel: no credentials (set config.email/config.password or auth_token JSON)' };
  const sender = String(source || route.sender_id || cfg(route).sender || '').trim();
  if (!sender) return { success: false, providerStatus: 'error', error: 'Nest panel: no Sender ID (set the route sender_id)' };

  const fire = async (force) => postSend(route, await getSession(route, email, password, force), dest, msg, sender);
  let res;
  try { res = await fire(false); } catch (e) { return { success: false, providerStatus: 'error', error: e.message }; }
  if (needsRelogin(res)) { // session expired -> re-login once and retry
    try { res = await fire(true); } catch (e) { return { success: false, providerStatus: 'error', error: e.message }; }
  }

  let d = res.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = { raw: d }; } }
  d = d || {};
  const data = d.data || {};
  // Send response is flat: { batch_id, queued_count, billing, job_ids }. Some shapes nest under data.
  const batchId = data.batch_id || d.batch_id || data.message_id || d.message_id || (Array.isArray(d.message_ids) && d.message_ids[0]);
  const ok = res.status >= 200 && res.status < 300 && d.success !== false && (!!batchId || (d.queued_count || data.queued_count) > 0);
  if (ok) {
    const messageId = String(batchId || ('nestp_' + Date.now()));
    // Real DLR via /api/messages/batch/:id -> pending so the engine polls for delivery truth.
    return { success: true, pending: true, messageId, providerStatus: 'queued', rawData: d };
  }
  const why = d.error || d.message || `HTTP ${res.status}`;
  const code = d.code ? ` [${d.code}]` : '';
  return { success: false, providerStatus: 'failed', error: `Nest panel${code}: ${why}`, rawData: d };
}

// Poll a batch_id -> 'delivered' | 'undelivered' | null (still in flight). Needs a live session.
async function pollStatus(route, providerId) {
  if (!providerId || providerId.startsWith('nestp_')) return null;
  const { email, password } = parseAuth(route);
  if (!email || !password) return null;
  try {
    const fetchBatch = async (force) => axios.get(`${baseUrl(route)}/api/messages/batch/${encodeURIComponent(providerId)}`,
      outbound.cfg(route, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: await getSession(route, email, password, force) }, timeout: 15000, maxRedirects: 0, validateStatus: () => true }));
    let res = await fetchBatch(false);
    if (needsRelogin(res)) res = await fetchBatch(true);
    if (res.status !== 200) return null;
    const data = (res.data && res.data.data) || {};
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    // Single send: trust the per-message status/timestamps (most precise).
    if (msgs.length === 1) {
      const m = msgs[0];
      if (m.delivered_at || /deliver/i.test(m.status || '')) return 'delivered';
      if (m.failed_at || /(fail|undeliv|reject|expir|block|cancel)/i.test(m.status || '')) return 'undelivered';
      return null; // 'sent' / 'pending' -> keep polling (delivery DLR not in yet)
    }
    // Batch: settle only once nothing is pending/scheduled. (Summary has no delivered_count;
    // 'sent' alone is not proof of delivery, so a fully-sent batch stays unresolved.)
    const s = data.batch_summary || {};
    if ((s.pending_count || 0) + (s.scheduled_count || 0) > 0) return null;
    if ((s.delivered_count || 0) > 0) return 'delivered';
    if ((s.failed_count || 0) > 0 || (s.cancelled_count || 0) > 0) return 'undelivered';
    return null;
  } catch (_) { return null; }
}

// Admin/CRM "Test" — logs in and verifies the session via /api/auth/me. Sends NO SMS.
async function testConnection(route) {
  const { email, password } = parseAuth(route);
  if (!email || !password) return { success: false, error: 'Nest panel: no credentials (set config.email/config.password)' };
  let cookie;
  try { cookie = await login(route, email, password, email + '@' + baseUrl(route)); }
  catch (e) { return { success: false, error: e.message }; }
  try {
    const res = await axios.get(baseUrl(route) + '/api/auth/me', outbound.cfg(route, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie }, timeout: 15000, maxRedirects: 0, validateStatus: () => true }));
    const u = (res.data && (res.data.data || res.data.user || res.data)) || {};
    return { success: true, messageId: null, rawData: { login: 'ok', account: u.email || email, balance: u.balance != null ? u.balance : null } };
  } catch (e) { return { success: true, messageId: null, rawData: { login: 'ok', account: email, note: 'logged in; /me fetch failed: ' + e.message } }; }
}

module.exports = { send, pollStatus, testConnection, _toLocal: toLocal, _toIntl: toIntl, _login: login };
