/**
 * Nest SMS (Nepal) — https://auth.nestsms.com/api/v1/sms  (JSON REST API).
 * Docs: API Token in the Nest panel -> key looks like "nsms_live_...".
 *
 *   SEND   POST {base}/send      header X-API-Key: <token>   body { to, message, sender_id?, type?, message_type? }
 *          -> 200/202 { success:true, data:{ message_id, batch_id, job_id, cost, remaining_balance } }
 *   STATUS GET  {base}/status/:id   -> { type:'single'|'batch', data:{ status, ... } }
 *   BALANCE GET {base}/balance      -> { data:{ balance, currency, ... } }   (used as a no-send test)
 *
 * Nest exposes a REAL per-message status endpoint, so a good send is 'pending' (provides_dlr-style):
 * the engine polls pollStatus(message_id) until it resolves delivered/undelivered.
 *
 * Auth: X-API-Key is the recommended header (default here). Nest also accepts Authorization: Bearer
 *       — set route.config.authScheme="Bearer " (and authHeader="Authorization") to use that instead.
 * Creds: route.auth_token = the nsms_live_ key. route.sender_id = approved Sender ID (optional;
 *        Nest falls back to the account default). Override endpoint via route.api_url / config.api_url.
 * Rate limits: Nest enforces per-key per-second/minute/hour windows; a breach is HTTP 429
 *        RATE_LIMIT_EXCEEDED with retry_after (seconds) — surfaced in the error + rawData.
 */
const axios = require('axios');
const outbound = require('../shared/outbound');

const DEFAULT_SEND = 'https://auth.nestsms.com/api/v1/sms/send';

// Endpoint base ("https://auth.nestsms.com/api/v1/sms") derived from the send URL.
function baseUrl(route) {
  const c = route.config || {};
  const send = c.api_url || route.api_url || DEFAULT_SEND;
  return send.replace(/\/send\/?$/, '');
}

function authHeaders(route) {
  const c = route.config || {};
  const header = c.authHeader || 'X-API-Key';
  const scheme = c.authScheme || ''; // X-API-Key takes the bare key; Bearer would set "Bearer "
  return { [header]: scheme + String(route.auth_token || '').trim() };
}

// Nest wants local Nepali mobiles (98XXXXXXXX / 97XXXXXXXX), optional +977. Strip to 10 digits.
function toLocal(n) {
  let s = String(n).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (s.startsWith('977') && s.length > 10) s = s.slice(3);
  return s;
}

async function send(route, dest, msg, source) {
  const token = String(route.auth_token || '').trim();
  if (!token) return { success: false, providerStatus: 'error', error: 'Nest SMS: no API key (set the route auth_token to the nsms_live_ key)' };

  const c = route.config || {};
  const url = c.api_url || route.api_url || DEFAULT_SEND;
  const sender = source || route.sender_id;

  const body = { to: toLocal(dest), message: msg };
  if (sender) body.sender_id = sender;
  if (c.type) body.type = c.type;                       // 'text' | 'unicode' | 'flash'
  if (c.message_type) body.message_type = c.message_type; // 'promotional' | 'transactional' | 'otp'
  if (c.extra && typeof c.extra === 'object') Object.assign(body, c.extra); // template_id, variables, ...

  try {
    const res = await axios.post(url, body, outbound.cfg(route, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(route)),
      timeout: route.timeout_ms || 20000,
      validateStatus: () => true,
    }));
    const d = res.data || {};

    // Success: 200 (queued) or 202 (large bulk accepted async).
    if ((res.status === 200 || res.status === 202) && d.success) {
      const data = d.data || {};
      const messageId = String(data.message_id || data.batch_id || ('nsms_' + Date.now()));
      // Real status endpoint exists -> mark pending so the engine polls for delivery truth.
      return { success: true, pending: true, messageId, providerStatus: 'queued', rawData: d };
    }

    // Rate limited: surface retry_after so the operator/log shows the back-off window.
    if (res.status === 429 || d.code === 'RATE_LIMIT_EXCEEDED') {
      const ra = d.retry_after != null ? `${d.retry_after}s` : 'unknown';
      return { success: false, providerStatus: 'failed', error: `Nest SMS: rate limit exceeded (retry after ${ra})`, rawData: d };
    }

    const why = d.error || d.message || `HTTP ${res.status}`;
    const code = d.code ? ` [${d.code}]` : '';
    return { success: false, providerStatus: 'failed', error: `Nest SMS${code}: ${why}`, rawData: d };
  } catch (err) {
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// Poll a message_id (or batch_id) -> 'delivered' | 'undelivered' | null (still in flight).
async function pollStatus(route, providerId) {
  if (!providerId || providerId.startsWith('nsms_')) return null; // synthetic id, nothing real to query
  try {
    const res = await axios.get(`${baseUrl(route)}/status/${encodeURIComponent(providerId)}`,
      outbound.cfg(route, { headers: authHeaders(route), timeout: 15000, validateStatus: () => true }));
    if (res.status !== 200) return null;
    const d = res.data || {};
    const data = d.data || {};

    // Batch summary: delivered only once nothing is still pending/queued/sent.
    if (d.type === 'batch' && data.status_summary) {
      const s = data.status_summary;
      const inFlight = (s.pending || 0) + (s.queued || 0) + (s.sent || 0);
      if (inFlight > 0) return null;
      return (s.failed || 0) > 0 && (s.delivered || 0) === 0 ? 'undelivered' : 'delivered';
    }

    const v = String(data.status || '').toUpperCase();
    if (/DELIVER/.test(v)) return 'delivered';
    if (/(FAIL|UNDELIV|REJECT|ERROR|EXPIR|BLOCK)/.test(v)) return 'undelivered';
    return null; // sent / queued / pending -> keep polling
  } catch (_) { return null; }
}

// Admin/CRM "Test" — verifies the key via the balance endpoint, sends NO SMS.
async function testConnection(route) {
  if (!String(route.auth_token || '').trim()) return { success: false, error: 'no API key set' };
  try {
    const res = await axios.get(`${baseUrl(route)}/balance`,
      outbound.cfg(route, { headers: authHeaders(route), timeout: 15000, validateStatus: () => true }));
    const d = res.data || {};
    if (res.status === 200 && d.success) {
      const data = d.data || {};
      return { success: true, messageId: null, rawData: { balance: data.balance, currency: data.currency } };
    }
    return { success: false, error: `Nest SMS ${res.status}: ${d.error || d.code || 'auth failed'}`, rawData: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { send, pollStatus, testConnection, _toLocal: toLocal };
