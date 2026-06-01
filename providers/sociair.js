// Sociair (Nepal) — https://sociair.com  (Bearer JSON API).
// POST {api_url or default}  Authorization: Bearer <token>  { message, mobile }
const axios = require('axios');
const DEFAULT = 'https://api.sociair.com/api/sms';

async function send(route, dest, msg) {
  try {
    const res = await axios.post(route.api_url || DEFAULT, { message: msg, mobile: String(dest) },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + (route.auth_token || '') }, timeout: 15000, validateStatus: () => true });
    if (res.status < 200 || res.status >= 300) return { success: false, error: `Sociair HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`, rawData: res.data };
    const id = (res.data && (res.data.id || res.data.message_id || (res.data.data && res.data.data.id))) || ('' + Date.now());
    return { success: true, messageId: String(id), rawData: res.data };
  } catch (err) { return { success: false, error: err.message }; }
}
module.exports = { send };
