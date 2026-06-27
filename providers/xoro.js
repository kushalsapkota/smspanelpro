// Xoro SMS gateway (xoro.leosainamaina.org) — direct JSON API (FastAPI backend).
// POST {api_url}/api/v1/invoke   header  x-api-token: <token>   body { msg, num }
// Synchronous verdict: response { status:"success", message, number, quota_used }.
//
// HONEST DLR — report exactly what upstream tells us, never fabricate:
//   • 2xx + status:"success"  -> delivered  (upstream's real positive ack)
//   • clean rejection (4xx, or 2xx with a non-"success" body) -> failed. Xoro VALIDATES the
//     request (422 bad number/content, 401/403 auth) BEFORE it dispatches, so a <500 error means
//     the SMS was genuinely NOT sent.
//   • 5xx / timeout -> 'unknown'. Xoro dispatches to the carrier, then frequently 500s / times out
//     AFTER the send while building its response (quota update / serialization) — the SMS already
//     reached the handset. Xoro exposes no per-message id and no delivery-poll endpoint, so we
//     genuinely cannot confirm. We report the HONEST 'unknown' (submitted, no verdict) instead of a
//     false 'failed' that would refund the client + push UNDELIV + trip the circuit breaker — and
//     without fabricating a 'delivered' we can't actually prove.
//   • connection failure (DNS/refused/unreachable — the request never reached Xoro) -> failed.
const axios = require('axios');
const outbound = require('../shared/outbound');

const DEFAULT_URL = 'https://xoro.leosainamaina.org/api/v1/invoke';

// Xoro wants the local 10-digit number. Strip non-digits, drop a 977 country code / leading
// zeros, keep the last 10. Mirrors what the operator's proxy did (config.keepNumber to skip).
function toLocal(dest, route) {
  if (route && route.config && route.config.keepNumber) return String(dest);
  let n = String(dest).replace(/\D/g, '');
  n = n.replace(/^(00)?977/, '').replace(/^0+/, '');
  if (n.length > 10) n = n.slice(-10);
  return n;
}

async function send(route, dest, msg) {
  const url = route.api_url || DEFAULT_URL;
  const num = toLocal(dest, route);
  const headers = {
    accept: 'application/json',
    'x-api-token': route.auth_token || '',
    'Content-Type': 'application/json',
  };
  try {
    const res = await axios.post(url, { msg: String(msg), num },
      outbound.cfg(route, { headers, timeout: (route.config && route.config.timeout_ms) || route.timeout_ms || 40000, validateStatus: () => true }));
    const d = res.data || {};
    const status = String(d.status || '').toLowerCase();
    // Clean positive ack: Xoro confirmed acceptance -> honest 'delivered'.
    if (res.status >= 200 && res.status < 300 && status === 'success') {
      return { success: true, messageId: `xoro_${num}_${Date.now()}`, rawData: d, providerStatus: 'success', dlr: 'delivered' };
    }
    // <500: a real, pre-dispatch rejection (422 bad number/content, 401/403 auth, or a non-success
    // body). The SMS was NOT sent -> honest failure (engine refunds + reports UNDELIV).
    if (res.status < 500) {
      return { success: false, error: `Xoro HTTP ${res.status}: ${JSON.stringify(d).slice(0, 200)}`, rawData: d, providerStatus: status || 'failed' };
    }
    // 5xx: Xoro already dispatched to the carrier, then crashed building its response. We can't
    // confirm delivery (no msg-id / no poll API) -> honest 'unknown'. success:true so the engine
    // commits the send (no false UNDELIV, no refund, no double-send via failover, no breaker trip).
    return { success: true, messageId: `xoro_${num}_${Date.now()}`, providerStatus: 'unknown', dlr: 'unknown',
      rawData: { unconfirmed: true, http_status: res.status, note: 'upstream 5xx after dispatch — delivery unconfirmed', body: d } };
  } catch (err) {
    // A timeout means Xoro RECEIVED the request and is just slow to answer (it still dispatches) ->
    // honest 'unknown'. A true connection failure never reached Xoro -> honest failure (not sent).
    const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
    if (timedOut) {
      return { success: true, messageId: `xoro_${num}_${Date.now()}`, providerStatus: 'unknown', dlr: 'unknown',
        rawData: { unconfirmed: true, http_status: 'timeout', note: 'no ack within timeout — delivery unconfirmed' } };
    }
    return { success: false, providerStatus: 'error', error: err.message };
  }
}

// No-send credential/reachability check: POST with an empty num. Xoro answers (non-success)
// without dispatching, which still proves the token + endpoint are valid.
async function testConnection(route) {
  const url = route.api_url || DEFAULT_URL;
  try {
    const res = await axios.post(url, { msg: 'test', num: '' },
      outbound.cfg(route, { headers: { accept: 'application/json', 'x-api-token': route.auth_token || '', 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true }));
    if (res.status === 401 || res.status === 403) return { ok: false, note: `auth rejected (HTTP ${res.status})` };
    return { ok: true, note: `reachable (HTTP ${res.status}): ${JSON.stringify(res.data).slice(0, 120)}` };
  } catch (err) {
    return { ok: false, note: err.message };
  }
}

module.exports = { send, testConnection, _toLocal: toLocal };
