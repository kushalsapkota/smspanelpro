/**
 * HMS / Ultranet panel (hms.ultranet.com.np — "CMS for ULTRA NET", a peredur.net/SitePoint
 * "secure login" PHP panel). NOT a REST API — it's a web panel you log into. Cookie-based:
 *
 *   1) LOGIN  POST <loginUrl=securelogin.php> (form-encoded):
 *               username, p = HEX_SHA512(password), redirect
 *             The panel's own login form hashes the password in-browser (js/forms.js
 *             formhash() -> p = hex_sha512(pw), plaintext blanked) and posts to
 *             securelogin.php. We replicate that hash server-side with node crypto.
 *             Success -> 302 to a dashboard + Set-Cookie: sec_session_id=...
 *             Failure -> 302 Location: login.php?error=1   (we detect this)
 *             The session cookie is cached per-route ~20min, re-used across sends.
 *   2) SEND   POST <api_url> (form-encoded) action=send_sms, mobile, text + Cookie: sec_session_id
 *
 * axios has no cookie jar, so we capture Set-Cookie from the login response and replay it
 * as a Cookie header on the send. If the session has expired the panel serves the login
 * page back instead of sending — we detect that and log in once more.
 *
 * Credentials live in route.auth_token as JSON: {"username":"...","password":"..."}
 * Everything panel-specific is overridable in route.config so the operator can tune it
 * against the real responses WITHOUT a code change:
 *   { loginUrl, userField, hashField, hashAlgo ('sha512'|'none'), passField, redirectField,
 *     redirectValue, loginFail (regex on Location/body),
 *     actionField, action, mobileField, textField, senderField,
 *     loginPage (regex), sendOk (regex), sendFail (regex), extraLogin{}, extraSend{},
 *     maxConcurrent, tps, minGapMs, queueMax }
 *
 * Throughput / bursts: this is a cookie-session WEB panel, not an API. PHP holds an exclusive
 * session-file lock for the whole request, so all sends sharing one sec_session_id are processed
 * by the panel ONE AT A TIME — firing 15 concurrent POSTs at it just produces timeouts, not 15x
 * throughput. So sends are funnelled through a per-route queue (runLimited): bounded concurrency
 * (config.maxConcurrent, default 2) + paced starts (config.tps or config.minGapMs) so a 10–15/s
 * burst from the SMPP client becomes a steady drip the panel can actually swallow. Logins are
 * single-flighted (loginOnce) so a cold-cache burst triggers ONE login, not one per send (which,
 * with session_regenerate_id, would invalidate each other and collapse). Over-rate sends queue up
 * to config.queueMax (default 500) then fail fast so the engine can fail over / refund.
 *
 * DLRs: these panels have no delivery-report API → set route.provides_dlr = false so a good
 * send is honestly 'accepted' (panel queued it), never a fabricated 'delivered'.
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');
const crypto = require('crypto');
const FormData = require('form-data');

const SESSION_TTL_MS = 20 * 60 * 1000;   // re-login roughly every 20 min
const DEFAULT_LOGIN = 'https://hms.ultranet.com.np/systemadmin/securelogin.php';
const DEFAULT_SMS = 'https://hms.ultranet.com.np/systemadmin/operation.php?module=sms&page=individual_sms_operation';
// The panel processes the send then 302-redirects back to this page (Post-Redirect-Get).
// It requires a multipart POST + a Referer; with urlencoded/no-Referer it silently bails.
const DEFAULT_REFERER = 'https://hms.ultranet.com.np/systemadmin/show_page.php?module=sms&page=individual_sms';

// routeId -> { cookie, exp }
const sessionCache = new Map();
// routeId -> in-flight login Promise (single-flight: a burst triggers ONE login, not one per send)
const loginInFlight = new Map();
// routeId -> { active, last, queue:[], timer } — per-route send pacer (see runLimited)
const limiters = new Map();

function cfg(route) { return (route && route.config) || {}; }

function parseAuth(route) {
  const c = cfg(route);
  // Prefer JSON in auth_token; fall back to config.username/password.
  let user = c.username, pass = c.password;
  const raw = (route.auth_token || '').trim();
  if (raw) {
    try { const j = JSON.parse(raw); user = j.username || j.user || user; pass = j.password || j.pass || pass; }
    catch (_) { /* auth_token isn't JSON — leave config values */ }
  }
  if (!user || !pass) {
    throw new Error('HMS route needs credentials — set auth_token to {"username":"...","password":"..."}');
  }
  return { user, pass };
}

function loginUrl(route) { return cfg(route).loginUrl || DEFAULT_LOGIN; }
function smsUrl(route) { return (route.api_url || '').trim() || DEFAULT_SMS; }

// Collapse a Set-Cookie array into a single "name=value; name2=value2" Cookie header.
// Last value wins per cookie name — PHP session_regenerate_id sends the SAME cookie name
// twice (old then new); we must keep the LAST (regenerated) one.
function cookieHeader(setCookie) {
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const byName = new Map();
  for (const line of arr) {
    const first = String(line).split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq > 0) byName.set(first.slice(0, eq), first.slice(eq + 1));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Replicate the panel's in-browser hex_sha512(password). hashAlgo='none' sends plaintext.
function hashPassword(pass, route) {
  const algo = (cfg(route).hashAlgo || 'sha512').toLowerCase();
  if (algo === 'none' || algo === 'plain') return pass;
  return crypto.createHash(algo).update(String(pass)).digest('hex');
}

// True when the HTML looks like the login page (i.e. our session is gone / creds bad).
function looksLikeLogin(body, route) {
  const c = cfg(route);
  if (c.loginPage) { try { return new RegExp(c.loginPage, 'i').test(body); } catch (_) {} }
  return /name=["']?password["']?|type=["']?password["']?|login\.php|invalid\s+(user|password|login)|unauthor/i.test(body);
}

async function login(route) {
  const { user, pass } = parseAuth(route);
  const c = cfg(route);
  // Build the form the panel itself would post: username + hashed password (field `p`) + redirect.
  const form = {
    [c.userField || 'username']: user,
    [c.hashField || 'p']: hashPassword(pass, route),
    [c.redirectField || 'redirect']: c.redirectValue != null ? c.redirectValue : '',
    ...(c.extraLogin && typeof c.extraLogin === 'object' ? c.extraLogin : {}),
  };
  const res = await axios.post(loginUrl(route), qs.stringify(form), outbound.cfg(route, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html,application/xhtml+xml' },
    timeout: route.timeout_ms || 20000,
    maxRedirects: 0,                 // capture Set-Cookie + Location on the immediate response, before redirect
    validateStatus: () => true,
  }));
  const cookie = cookieHeader(res.headers && res.headers['set-cookie']);
  const loc = String((res.headers && res.headers.location) || '');
  // Failed login redirects back to the login page (e.g. login.php?error=1).
  const failRe = c.loginFail ? new RegExp(c.loginFail, 'i') : /login\.php|error=?1?|invalid|incorrect|denied/i;
  if (loc && failRe.test(loc)) {
    throw new Error(`HMS login: credentials rejected (redirect -> ${loc})`);
  }
  if (!cookie) {
    throw new Error(`HMS login: no session cookie returned (HTTP ${res.status}, location "${loc}"). Check loginUrl/credentials.`);
  }
  // Body-based failure signal too (some panels echo the login page instead of redirecting).
  if (!loc && looksLikeLogin(res.data || '', route)) {
    throw new Error('HMS login: credentials rejected (login page returned)');
  }
  const id = String(route._id || route.name);
  sessionCache.set(id, { cookie, exp: Date.now() + SESSION_TTL_MS });
  return cookie;
}

// Single-flight login: concurrent callers (a cold-cache burst, or several sends that all hit an
// expired session at once) share ONE login() instead of each firing their own. Without this, the
// panel's session_regenerate_id makes each parallel login invalidate the others' cookies.
function loginOnce(route) {
  const id = String(route._id || route.name);
  let p = loginInFlight.get(id);
  if (p) return p;
  p = login(route).finally(() => { loginInFlight.delete(id); });
  loginInFlight.set(id, p);
  return p;
}

async function getSession(route, force) {
  const id = String(route._id || route.name);
  const cached = sessionCache.get(id);
  if (!force && cached && cached.exp > Date.now() + 30 * 1000) return cached.cookie;
  return loginOnce(route);
}

// ---- per-route send pacer ----
// The panel serializes one session server-side (PHP session lock), so we bound how many sends are
// in flight at once and space their starts. Converts a bursty 10–15/s SMPP stream into a steady
// rate the panel tolerates. Knobs (route.config): maxConcurrent (default 2), tps OR minGapMs
// (start spacing; tps wins if both unset → no spacing), queueMax (default 500, then fail fast).
function limiter(route) {
  const id = String(route._id || route.name);
  let l = limiters.get(id);
  if (!l) { l = { active: 0, last: 0, queue: [], timer: null }; limiters.set(id, l); }
  return l;
}

function runLimited(route, fn) {
  const c = cfg(route);
  const max = Math.max(1, Number(c.maxConcurrent) || 2);
  const tps = Number(c.tps) > 0 ? Number(c.tps) : 0;
  const minGap = Number(c.minGapMs) > 0 ? Number(c.minGapMs) : (tps ? Math.ceil(1000 / tps) : 0);
  const queueMax = Number(c.queueMax) > 0 ? Number(c.queueMax) : 500;
  const l = limiter(route);
  return new Promise((resolve, reject) => {
    if (l.queue.length >= queueMax) {
      return reject(new Error(`HMS queue full (${queueMax}) — panel can't keep up with the send rate`));
    }
    l.queue.push({ fn, resolve, reject });
    pump(l, max, minGap);
  });
}

function pump(l, max, minGap) {
  if (l.active >= max || !l.queue.length) return;
  const wait = minGap ? Math.max(0, l.last + minGap - Date.now()) : 0;
  if (wait > 0) {
    if (!l.timer) l.timer = setTimeout(() => { l.timer = null; pump(l, max, minGap); }, wait);
    return;
  }
  const job = l.queue.shift();
  l.active++; l.last = Date.now();
  Promise.resolve().then(job.fn).then(job.resolve, job.reject)
    .finally(() => { l.active--; pump(l, max, minGap); });
  if (l.active < max) pump(l, max, minGap); // fill remaining slots (still gap-paced via the timer)
}

// Normalize a destination to the LOCAL 10-digit Nepal number the panel/Sparrow expects.
// Clients often submit with the 977 country code (e.g. 9779704500025) — the panel "accepts"
// that (302) but Sparrow silently can't deliver to a 13-digit number, so the SMS vanishes.
// Strip +977 / 00977 / 977 prefixes and leading zeros. Set config.keepCountryCode=true to skip.
function toLocal(n, route) {
  if (cfg(route).keepCountryCode) return String(n).replace(/[^\d]/g, '');
  let s = String(n).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}

function buildSendForm(route, dest, msg, source) {
  const c = cfg(route);
  // dest may be a single number or comma-separated; normalize each.
  const mobile = String(dest).split(',').map((d) => toLocal(d.trim(), route)).filter(Boolean).join(',');
  const form = {
    [c.actionField || 'action']: c.action || 'send_sms',
    [c.mobileField || 'mobile']: mobile,
    [c.textField || 'text']: msg,
  };
  const sender = source || route.sender_id;
  if (sender && c.senderField) form[c.senderField] = sender;
  if (c.extraSend && typeof c.extraSend === 'object') Object.assign(form, c.extraSend);
  return form;
}

// Encode the send body. HMS requires multipart/form-data (its form's enctype); urlencoded
// makes operation.php bail with no redirect. enctype='urlencoded' available for other panels.
function buildBody(route, formObj) {
  const enctype = (cfg(route).enctype || 'multipart').toLowerCase();
  if (enctype === 'urlencoded' || enctype === 'form') {
    return { data: qs.stringify(formObj), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  }
  const fd = new FormData();
  for (const [k, v] of Object.entries(formObj)) fd.append(k, v == null ? '' : String(v));
  return { data: fd, headers: fd.getHeaders() };
}

// Read the panel's verdict from the HTML response. Returns { ok, failReason }.
function readVerdict(body, route) {
  const c = cfg(route);
  const text = String(body || '');
  // Explicit failure first (configurable), then explicit success (configurable), then defaults.
  const failRe = c.sendFail ? new RegExp(c.sendFail, 'i')
    : /invalid|fail|error|insufficient|not\s+sent|denied|balance|expired|blocked/i;
  const okRe = c.sendOk ? new RegExp(c.sendOk, 'i')
    : /sent|success|queued|submitted|delivered|message.*sent|sms.*sent/i;
  if (failRe.test(text)) return { ok: false, failReason: (text.match(failRe) || [])[0] || 'panel reported failure' };
  if (okRe.test(text)) return { ok: true };
  // Ambiguous: panel returned something we don't recognize. Treat as failure so we never
  // silently bill a non-send — operator can add a config.sendOk regex once they see the body.
  return { ok: false, failReason: 'unrecognized panel response (set config.sendOk to match a success marker)' };
}

// Public entrypoint: queue the send through the per-route pacer, then run the real work (doSend).
// A queue-full rejection surfaces as a normal failed-send object so the engine fails over/refunds.
function send(route, dest, msg, source) {
  return runLimited(route, () => doSend(route, dest, msg, source))
    .catch((err) => ({ success: false, providerStatus: 'error', error: err.message }));
}

async function doSend(route, dest, msg, source) {
  try {
    let cookie = await getSession(route);
    const url = smsUrl(route);
    const c = cfg(route);
    const referer = c.referer || DEFAULT_REFERER;
    const failRe = c.loginFail ? new RegExp(c.loginFail, 'i') : /login\.php|error=?1?|unauthor/i;
    const okLocRe = c.sendOkLocation ? new RegExp(c.sendOkLocation, 'i') : null;

    const doPost = (ck) => {
      const b = buildBody(route, buildSendForm(route, dest, msg, source));
      return axios.post(url, b.data, outbound.cfg(route, {
        headers: { ...b.headers, Accept: 'text/html,application/xhtml+xml', Cookie: ck, Referer: referer },
        timeout: route.timeout_ms || 30000, maxRedirects: 0, validateStatus: () => true,
      }));
    };

    let res = await doPost(cookie);
    let loc = String((res.headers && res.headers.location) || '');
    // Session expired (login redirect / 401 / login page) -> re-login once and retry.
    if (res.status === 401 || res.status === 403 || (loc && failRe.test(loc)) || looksLikeLogin(res.data || '', route)) {
      cookie = await getSession(route, true);
      res = await doPost(cookie);
      loc = String((res.headers && res.headers.location) || '');
    }

    const snippet = String(res.data || '').replace(/\s+/g, ' ').slice(0, 300);

    // PRIMARY success signal: Post-Redirect-Get back to a panel page (NOT the login page).
    // HMS has no per-send body verdict — the redirect IS the "panel accepted it" signal.
    if (res.status >= 300 && res.status < 400) {
      if (loc && !failRe.test(loc) && (!okLocRe || okLocRe.test(loc))) {
        return { success: true, pending: false, messageId: 'hms_' + Date.now(), providerStatus: 'accepted', rawData: loc };
      }
      return { success: false, providerStatus: 'failed', error: `HMS: send rejected (redirect "${loc || 'none'}")`, rawData: loc || snippet };
    }

    // Non-redirect: hard HTTP error, login page, or a panel that DOES echo a body verdict.
    if (res.status < 200 || res.status >= 400) {
      return { success: false, providerStatus: 'failed', error: `HMS HTTP ${res.status}: ${snippet}`, rawData: snippet };
    }
    if (looksLikeLogin(res.data || '', route)) {
      return { success: false, providerStatus: 'error', error: 'HMS: session/login rejected (check credentials)', rawData: snippet };
    }
    const verdict = readVerdict(res.data || '', route);
    if (!verdict.ok) {
      return { success: false, providerStatus: 'failed', error: 'HMS: ' + verdict.failReason, rawData: snippet };
    }
    // Panel has no message id — mint a traceable synthetic one. No DLR API → 'accepted'
    // (route.provides_dlr should be false; engine then never claims a fake 'delivered').
    return { success: true, pending: false, messageId: 'hms_' + Date.now(), providerStatus: 'accepted', rawData: snippet };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Admin "Test" button — verifies login works without sending an SMS.
async function testConnection(route) {
  try {
    const cookie = await login(route);
    return { success: true, messageId: null, rawData: { login: 'ok', cookie: cookie.split('=')[0] + '=…' } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { send, testConnection, _login: login, _readVerdict: readVerdict, _toLocal: toLocal, _runLimited: runLimited };
