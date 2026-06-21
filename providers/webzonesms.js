/**
 * Webzone SMS (sms.webzonesms.com) — an "Ultimate SMS" / ViserLab-style bulk SMS panel.
 *
 *   SEND  POST {base}/api/v3/sms   form: token, recipient, sender_id, type=plain, message
 *         -> { response_code, body }  on error; success returns response_code 200/1000 (+ body/uid).
 *
 * Auth is NOT Bearer — the API token goes in the `token` form field (Bearer is ignored;
 * a Bearer-only call returns 1001 "Request Token Not Found"). Observed response codes:
 *   1001 = token not found            1004 = account expired (whole account locked, not a per-send error)
 * The panel has NO separate /balance or /me route (everything 404s) — the only endpoint is /api/v3/sms,
 * so the credit/health probe POSTs the token alone (no recipient) and reads the auth verdict; a valid
 * account falls through to a recipient-validation error instead of sending anything.
 *
 * DLR: the basic v3 API returns no per-message status route, so a good send is honestly 'accepted'
 *      (configure the route with provides_dlr = false) unless a delivery webhook is wired on the panel.
 *
 * Creds: route.auth_token = the API token; route.sender_id = approved sender identity.
 *        Override the endpoint via route.api_url (defaults to the path below).
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');

const DEFAULT_URL = 'http://sms.webzonesms.com/api/v3/sms';

// Webzone/Ultimate-SMS auth response_code meanings → clear operator errors.
const CODE = {
  1001: 'token not found — set the route auth_token to your API token',
  1002: 'invalid token',
  1004: 'account has expired — renew/contact the panel administrator',
  1005: 'insufficient balance',
};

// International gateway: full MSISDN with country code, digits only (drop + / 00 / leading zeros).
function toMsisdn(n) {
  let s = String(n).replace(/[^\d]/g, '');
  s = s.replace(/^00/, '').replace(/^0+/, '');
  return s;
}

function creds(route) {
  const c = route.config || {};
  return {
    token: String(c.token || route.auth_token || '').trim(),
    from: String(c.sender_id || route.sender_id || '').trim(),
    url: c.api_url || route.api_url || DEFAULT_URL,
  };
}

// True when the panel accepted the message (success shapes vary across Ultimate-SMS builds).
function isAccepted(d) {
  const code = Number(d.response_code != null ? d.response_code : d.status);
  if (code === 200 || code === 1000) return true;
  if (typeof d.status === 'string' && /success/i.test(d.status)) return true;
  return false;
}

function extractId(d) {
  return String(
    (d.data && (d.data.uid || d.data.message_id || d.data.id)) ||
    d.uid || d.message_id || d.id ||
    ('wz_' + (d.response_code || 'ok'))
  );
}

async function send(route, dest, msg) {
  const { token, from, url } = creds(route);
  if (!token) return { success: false, providerStatus: 'error', error: 'Webzone SMS: no token (set the route auth_token)' };
  try {
    const params = { token, recipient: toMsisdn(dest), type: 'plain', message: msg };
    if (from) params.sender_id = from;
    const res = await axios.post(url, qs.stringify(params), outbound.cfg(route, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: route.timeout_ms || 20000, validateStatus: () => true,
    }));
    const d = res.data || {};
    if (isAccepted(d)) {
      // No per-message DLR route → honest 'accepted' (route.provides_dlr = false).
      return { success: true, pending: false, messageId: extractId(d), providerStatus: 'accepted', rawData: d };
    }
    const code = Number(d.response_code);
    const why = CODE[code] || d.body || d.message || `HTTP ${res.status}`;
    return { success: false, providerStatus: 'failed', error: `Webzone SMS ${code || res.status}: ${why}`, rawData: d };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Admin/CRM "Test" — verifies the token + account WITHOUT sending: POST token alone, read the auth verdict.
// A valid, in-credit account falls through to a recipient-required validation error (which we report as OK).
async function testConnection(route) {
  const { token, url } = creds(route);
  if (!token) return { success: false, error: 'no token set' };
  try {
    const res = await axios.post(url, qs.stringify({ token }), outbound.cfg(route, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: 15000, validateStatus: () => true,
    }));
    const d = res.data || {};
    const code = Number(d.response_code);
    // Hard auth/account failures — token is bad, account expired, or out of credit.
    if ([1001, 1002, 1004, 1005].includes(code)) {
      return { success: false, error: `Webzone SMS ${code}: ${CODE[code] || d.body || 'auth failed'}`, rawData: d };
    }
    // Anything else (validation error about the missing recipient, or an accept) means the
    // token + account cleared auth — i.e. it can send / has credit.
    return { success: true, messageId: null, rawData: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { send, testConnection, _toMsisdn: toMsisdn };
