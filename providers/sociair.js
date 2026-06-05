// Sociair SMS (Nepal) — https://sms.sociair.com  (Bearer JSON API).
// Docs: POST /api/sms  Authorization: Bearer <token>  body { message, mobile }
//   mobile = single number or comma-separated list.
//
// DLR honesty: Sociair has NO message id and NO delivery-report/status endpoint,
// so there is nothing to poll (no pollStatus export). Delivery truth is whatever
// the SEND response says — and Sociair returns HTTP 200 even when it rejects the
// SMS ("Sorry! SMS could not be sent ..."). So we must trust the body, not the
// status code, otherwise a rejected message gets billed + marked accepted.
// Configure the route with provides_dlr = FALSE (a good send -> 'accepted').
const axios = require('axios');
const DEFAULT = 'https://sms.sociair.com/api/sms';

async function send(route, dest, msg) {
  try {
    const res = await axios.post(
      route.api_url || DEFAULT,
      { message: msg, mobile: String(dest) },
      { headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: 'Bearer ' + (route.auth_token || ''),
        },
        timeout: 15000,
        validateStatus: () => true });

    const data = res.data || {};
    const verdict = String(data.message || '');

    // Bad/expired token.
    if (res.status === 401 || /unauthenticated/i.test(verdict)) {
      return { success: false, error: 'Sociair: unauthenticated (bad/expired token)', rawData: data, providerStatus: verdict };
    }
    // Transport / unexpected HTTP error.
    if (res.status < 200 || res.status >= 300) {
      return { success: false, error: `Sociair HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`, rawData: data };
    }

    // HTTP 200 does NOT mean sent. Trust the body.
    const invalid = Array.isArray(data.invalid_number) ? data.invalid_number : [];
    const ok = /success/i.test(verdict) && invalid.length === 0;
    if (!ok) {
      const why = invalid.length ? `invalid number(s): ${invalid.join(', ')}` : (verdict || 'send rejected');
      return { success: false, error: `Sociair: ${why}`, rawData: data, providerStatus: verdict };
    }

    // No real provider id exists — mint a synthetic, traceable one.
    return { success: true, messageId: 'sc_' + Date.now(), rawData: data, providerStatus: verdict };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { send };
