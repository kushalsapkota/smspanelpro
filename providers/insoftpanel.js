/**
 * INSOFT web-panel adapter (insoftsms.com "web SMS Server", ASP.NET Core).
 * Drives the same UI the browser uses, for accounts WITHOUT API-token access (e.g. puspanjali).
 * Proven via Burp capture: /BulkSms/Save needs only the login SESSION cookie (no antiforgery token
 * header; Cloudflare does NOT gate server requests — cf_clearance not required).
 *
 *   LOGIN  GET  {base}/Login  -> .AspNetCore.Antiforgery cookie + hidden __RequestVerificationToken
 *          POST {base}/Login  (form: username, password, __RequestVerificationToken + that cookie)
 *          -> 302 away from /Login + Set-Cookie .AspNetCore.Session  (session ~cached 20 min)
 *   SEND   POST {base}/BulkSms/Save   (JSON, X-Requested-With: XMLHttpRequest, session cookie)
 *          body: [{ MobileNo, SMS_Message, ReceiverType:1, ReceiverName:"SMS", senderId,
 *                   IsScheduled:0, ScheduleDateTime:"" }]   ->  {"status":200} on success
 *
 * MULTI-ACCOUNT POOL: a route can own many ProviderKey docs, each a separate web account
 * (token = login username, password = login password, sender_id = approved Sender ID, host =
 * per-account base url). Sends fan out across the accounts (keypool round-robin), each keeps its
 * OWN cached session, and a per-account error fails over to the next account. This is what lets the
 * panel absorb high volume — one web session chokes under load (status:401/1006), many don't.
 * No keys => legacy single login from route.auth_token = {"username","password"}.
 *
 * The panel returns no per-send balance, so pool credit is NOT auto-decremented (ignoreCredit) —
 * accounts only leave the pool on a real auth/credit ERROR. DLR: acceptance only.
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');
const keypool = require('./keypool');

const SESSION_TTL_MS = 20 * 60 * 1000;
const DEFAULT_BASE = 'https://insoftsms.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sessionCache = new Map(); // acctId (user@base) -> { cookie, exp }

function cfg(route) { return (route && route.config) || {}; }
function baseUrl(route, hostOverride) {
  let b = String(hostOverride || cfg(route).host || route.api_url || DEFAULT_BASE).trim();
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '');
}

// Route-level creds for the legacy (no-pool) path: route.auth_token={"username","password"} or config.
function parseAuth(route) {
  const c = cfg(route); let user = c.username, pass = c.password;
  const raw = (route.auth_token || '').trim();
  if (raw) { try { const j = JSON.parse(raw); user = j.username || j.user || user; pass = j.password || j.pass || pass; } catch (_) {} }
  return { user, pass };
}

// cookie jar (last value per name wins; ASP.NET re-sets antiforgery + adds the session on login)
function jarAdd(jar, setCookie) {
  if (!setCookie) return jar;
  for (const line of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
    const first = String(line).split(';')[0].trim(); const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return jar;
}
function jarHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
function antiforgeryToken(html) {
  const s = String(html);
  const m = s.match(/name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/i) || s.match(/\bvalue="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  return m ? m[1] : null;
}
function looksLikeLogin(body) { return /__RequestVerificationToken|name="password"|id="password"|\/Login/i.test(String(body || '')); }

// Log a SINGLE account in; cache its session keyed by acctId.
async function loginWith(route, user, pass, hostOverride, acctId) {
  if (!user || !pass) throw new Error('panel login: missing username/password');
  const c = cfg(route);
  const base = baseUrl(route, hostOverride);
  const to = (c && c.timeout_ms) || route.timeout_ms || 25000;
  const jar = {};
  const g = await axios.get(base + '/Login', outbound.cfg(route, { headers: { 'User-Agent': UA, Accept: 'text/html' }, timeout: to, maxRedirects: 0, validateStatus: () => true }));
  jarAdd(jar, g.headers['set-cookie']);
  const token = antiforgeryToken(g.data || '');
  if (!token) throw new Error('panel login: no __RequestVerificationToken on /Login (HTTP ' + g.status + ')');
  const form = { [c.userField || 'username']: user, [c.passField || 'password']: pass, __RequestVerificationToken: token };
  const p = await axios.post(base + '/Login', qs.stringify(form), outbound.cfg(route, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jarHeader(jar), Origin: base, Referer: base + '/Login' },
    timeout: to, maxRedirects: 0, validateStatus: () => true,
  }));
  jarAdd(jar, p.headers['set-cookie']);
  const loc = String(p.headers.location || '');
  if (/\/login/i.test(loc) || (p.status === 200 && looksLikeLogin(p.data))) throw new Error('panel login: credentials rejected');
  if (!jar['.AspNetCore.Session']) throw new Error('panel login: no session cookie (HTTP ' + p.status + ', location "' + loc + '")');
  const cookie = jarHeader(jar);
  sessionCache.set(acctId, { cookie, exp: Date.now() + SESSION_TTL_MS });
  return cookie;
}

async function getSessionFor(route, user, pass, hostOverride, force) {
  const acctId = user + '@' + baseUrl(route, hostOverride);
  const c = sessionCache.get(acctId);
  if (!force && c && c.exp > Date.now()) return c.cookie;
  return loginWith(route, user, pass, hostOverride, acctId);
}

function buildBody(dest, msg, sender) {
  return [{ MobileNo: dest, SMS_Message: msg, ReceiverType: 1, ReceiverName: 'SMS', senderId: sender, IsScheduled: 0, ScheduleDateTime: '' }];
}

function postSave(route, cookie, dest, msg, sender, hostOverride) {
  const base = baseUrl(route, hostOverride);
  const to = (cfg(route).timeout_ms) || route.timeout_ms || 35000;
  return axios.post(base + '/BulkSms/Save', JSON.stringify(buildBody(dest, msg, sender)), outbound.cfg(route, {
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Accept: 'text/plain, */*; q=0.01', Origin: base, Referer: base + '/BulkSms', Cookie: cookie,
    },
    timeout: to, maxRedirects: 0, validateStatus: () => true,
  }));
}

function parseRes(res) {
  let d = res.data;
  if (typeof d === 'string') { const t = d.trim(); try { d = JSON.parse(t); } catch (_) { d = { raw: t }; } }
  return d || {};
}
function statusOf(d) { return d && (d.status != null ? Number(d.status) : (d.Status != null ? Number(d.Status) : null)); }
function needsRelogin(res, respStatus) {
  return res.status === 302 || res.status === 401 || respStatus === 401 ||
    /\/login/i.test(String(res.headers.location || '')) || looksLikeLogin(res.data);
}

// One send attempt on ONE account (key = {token:username, password, sender_id, host}).
async function attemptPanel(route, key, numberto, msg) {
  const user = key.token, pass = key.password;
  const sender = String(key.sender_id || route.sender_id || cfg(route).sender || '').trim();
  if (!user || !pass) return { success: false, providerStatus: 'error', error: 'panel: account missing username/password' };
  if (!sender) return { success: false, providerStatus: 'error', error: 'panel: no Sender ID' };

  const fire = async (force) => {
    const cookie = await getSessionFor(route, user, pass, key.host, force);
    return postSave(route, cookie, numberto, msg, sender, key.host);
  };
  let res;
  try { res = await fire(false); } catch (e) { return { success: false, providerStatus: 'error', error: e.message }; }
  let d = parseRes(res); let respStatus = statusOf(d);
  // session expired / unauthorized (HTTP 302/401 OR body status:401) → re-login this account once, retry
  if (needsRelogin(res, respStatus)) {
    try { res = await fire(true); d = parseRes(res); respStatus = statusOf(d); }
    catch (e) { return { success: false, providerStatus: 'error', error: e.message }; }
  }
  const txt = JSON.stringify(d).toLowerCase();
  const httpOk = res.status >= 200 && res.status < 300;
  const bodyOk = respStatus != null ? respStatus === 200 : !/error|fail|invalid|denied|insuffic|expired|not enough/.test(txt);
  if (httpOk && bodyOk) {
    return { success: true, pending: false, providerStatus: 'queued', rawData: d, messageCount: 1 };
  }
  return {
    success: false, providerStatus: 'failed',
    error: 'panel Save HTTP ' + res.status + (respStatus != null ? ' status:' + respStatus : '') + ': ' + (txt === '{}' ? '(empty)' : txt.slice(0, 160)),
    rawData: d,
  };
}

// Web-panel fault classification (overrides the API keypool's default).
//  - genuinely-bad account (login rejected / auth) -> 'auth'  : disable + fail over
//  - out of balance / expired                       -> 'balance': exhaust + fail over
//  - bad recipient / transport timeout              -> 'other' : stop (don't blame the account)
//  - anything else, incl. opaque codes like 1006/401 -> 'rotate': try another account, keep this one
function classifyPanel(r) {
  const txt = ((r.error || '') + ' ' + JSON.stringify(r.rawData || {})).toLowerCase();
  if (/timeout|timed out|socket hang|econnreset|econnrefused|etimedout|ehostunreach|enetunreach|enotfound|eai_again|aborted|network error|gateway timeout|service unavailable|\b50[234]\b/.test(txt)) return 'other';
  if (/invalid\s*(number|mobile|recipient|msisdn|destination)|number\s+is\s+invalid|not\s+a\s+valid|bad\s+number|blacklist|do not disturb|\bdnd\b/.test(txt)) return 'other';
  if (/credentials? rejected|authentication failed|invalid (token|login|password|user)|login failed|account (disabled|blocked)|missing (username|password)/.test(txt)) return 'auth';
  if (/insuffic|no\s*credit|out of (credit|balance|fund|sms)|low\s*(fund|balance)|expire|recharge|not enough|balance not/.test(txt)) return 'balance';
  return 'rotate';
}

async function send(route, dest, msg) {
  return keypool.sendViaPool(route, dest, msg, {
    idPrefix: 'insoftpanel',
    providerLabel: 'panel',
    requireSender: true,
    ignoreCredit: true,           // panel reports no per-send balance — don't gate/exhaust on credit
    classify: classifyPanel,
    attempt: attemptPanel,
    legacyKey: (r) => { const a = parseAuth(r); return { token: a.user || '', password: a.pass || '', sender_id: r.sender_id || cfg(r).sender || '' }; },
  });
}

// No-send check: log in (first pool account, else route creds) and scrape the dashboard balance.
async function testConnection(route) {
  let user, pass, host;
  try {
    const db = require('../db');
    const k = await db.ProviderKey.findOne({ route_id: route._id, status: 'active', password: { $nin: ['', null] } }).sort({ createdAt: 1 }).lean();
    if (k) { user = k.token; pass = k.password; host = k.host; }
  } catch (_) {}
  if (!user) { const a = parseAuth(route); user = a.user; pass = a.pass; }
  if (!user || !pass) return { success: false, error: 'panel: no credentials (add an account via 🔑 Keys, or set the route auth_token)' };
  let cookie;
  try { cookie = await loginWith(route, user, pass, host, user + '@' + baseUrl(route, host)); }
  catch (e) { return { success: false, error: e.message }; }
  try {
    const base = baseUrl(route, host);
    const r = await axios.get(base + '/BulkSms', outbound.cfg(route, { headers: { 'User-Agent': UA, Cookie: cookie }, timeout: route.timeout_ms || 20000, maxRedirects: 0, validateStatus: () => true }));
    const m = String(r.data || '').match(/Balance[\s:]*Rs[\s.]*([0-9][0-9.,]*)/i); // balance is JS-loaded; usually absent from static HTML
    return { success: true, messageId: null, rawData: { login: 'ok', account: user, balance: m ? m[1] : null, note: 'login OK (session established)' } };
  } catch (e) { return { success: true, messageId: null, rawData: { login: 'ok', account: user, note: 'logged in; dashboard fetch failed: ' + e.message } }; }
}

module.exports = { send, testConnection, _login: loginWith, _buildBody: buildBody, _classifyPanel: classifyPanel, _attemptPanel: attemptPanel };
