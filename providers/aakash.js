// Aakash SMS (Nepal) — https://aakashsms.com  (form-encoded API).
// POST {api_url or default}/sms/v3/send  with auth_token, to, text
const axios = require('axios');
const DEFAULT = 'https://sms.aakashsms.com/sms/v3/send';

async function send(route, dest, msg) {
  try {
    const params = new URLSearchParams({ auth_token: route.auth_token || '', to: String(dest), text: msg });
    const res = await axios.post(route.api_url || DEFAULT, params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, validateStatus: () => true });
    const ok = res.status === 200 && !(res.data && res.data.error === true);
    if (!ok) return { success: false, error: `Aakash HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`, rawData: res.data };
    const id = (res.data && (res.data.data && (res.data.data.id || res.data.data.message_id))) || ('' + Date.now());
    return { success: true, messageId: String(id), rawData: res.data };
  } catch (err) { return { success: false, error: err.message }; }
}
module.exports = { send };
