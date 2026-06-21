/**
 * Sparrow SMS (sparrowsms.com) — Nepal SMS gateway, v2 API. This is the gateway the
 * HMS/Ultranet panel uses under the hood; we call it directly for a real message_id.
 *
 *   SEND   POST https://api.sparrowsms.com/v2/sms/   form: token, from, to, text
 *          -> { count, response_code, response, message_id, credits_consumed, credits_available }
 *          response_code 200 = queued/accepted by the gateway. Anything else = error (see CODE).
 *   CREDIT GET  https://api.sparrowsms.com/v2/credit/?token=...  (used as a no-send test)
 *
 * ⚠️ Sparrow IP-WHITELISTS each token — the SENDING server's public IP must be allow-listed on
 *    the Sparrow account, else every call is 403 {response_code:1001,"Invalid IP Address"}.
 *
 * Creds: route.auth_token = the v2 token (e.g. "v2_..."); route.sender_id = approved sender
 *        identity (e.g. "Ultranet"). Override via route.config.{token, from, api_url}.
 * DLR: the basic v2 API has no per-message status GET — Sparrow reports delivery via a callback
 *      URL registered on the account. So a good send is honestly 'accepted' (provides_dlr=false)
 *      unless that webhook is wired. response_code 200 + message_id = gateway accepted it.
 */
const axios = require('axios');
const qs = require('querystring');
const outbound = require('../shared/outbound');

const DEFAULT_URL = 'https://api.sparrowsms.com/v2/sms/';
const CREDIT_URL = 'https://api.sparrowsms.com/v2/credit/';

// Sparrow response_code meanings (for clear operator errors).
const CODE = {
  1000: 'credit not available',
  1001: 'invalid IP address — whitelist this server on the Sparrow account',
  1002: 'invalid token',
  1003: 'invalid sender / from identity',
  1004: 'invalid URL',
  1005: 'invalid message',
  1006: 'invalid receiver',
  1007: 'no valid receiver numbers',
  1010: 'invalid date',
  1011: 'unknown error at gateway',
  1012: 'invalid receiver',
};

// Sparrow expects local 10-digit Nepal numbers (strip +977 / leading zeros).
function toLocal(n) {
  let s = String(n).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}

function creds(route) {
  const c = route.config || {};
  return {
    token: String(c.token || route.auth_token || '').trim(),
    from: String(c.from || route.sender_id || '').trim(),
    url: c.api_url || route.api_url || DEFAULT_URL,
  };
}

async function send(route, dest, msg) {
  const { token, from, url } = creds(route);
  if (!token) return { success: false, providerStatus: 'error', error: 'Sparrow: no token (set the route auth_token to the v2 token)' };
  if (!from) return { success: false, providerStatus: 'error', error: 'Sparrow: no sender (set the route sender_id to the approved identity)' };
  try {
    const body = qs.stringify({ token, from, to: toLocal(dest), text: msg });
    const res = await axios.post(url, body, outbound.cfg(route, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: route.timeout_ms || 20000, validateStatus: () => true,
    }));
    const d = res.data || {};
    const code = Number(d.response_code);
    if (code === 200) {
      // Real Sparrow id. No per-message DLR API → honest 'queued'/accepted (route.provides_dlr=false).
      return { success: true, pending: false, messageId: String(d.message_id || ('sp_' + Date.now())), providerStatus: 'queued', rawData: d };
    }
    const why = CODE[code] || d.response || `HTTP ${res.status}`;
    return { success: false, providerStatus: 'failed', error: `Sparrow ${code || res.status}: ${why}`, rawData: d };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Admin/CRM "Test" — checks token + IP via the credit endpoint, sends NO SMS.
async function testConnection(route) {
  const { token } = creds(route);
  if (!token) return { success: false, error: 'no token set' };
  try {
    const res = await axios.get(CREDIT_URL, outbound.cfg(route, { params: { token }, timeout: 15000, validateStatus: () => true }));
    const d = res.data || {};
    const code = Number(d.response_code);
    if (code === 200 || d.credits_available != null || d.credit != null) {
      return { success: true, messageId: null, rawData: { credits: d.credits_available != null ? d.credits_available : (d.credit != null ? d.credit : d) } };
    }
    return { success: false, error: `Sparrow ${code || res.status}: ${CODE[code] || d.response || 'failed'}`, rawData: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { send, testConnection, _toLocal: toLocal };
