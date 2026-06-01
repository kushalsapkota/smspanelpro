// Diagnostic: log in to QuickConnect and inspect the FULL send response to find why
// {"message":"success"} comes back with no batch_id / no delivery.
require('dotenv').config();
const axios = require('axios');
const db = require('../db');

const TO = process.argv[2] || '9704500025';

(async () => {
  await db.connect();
  const route = await db.Route.findOne({ type: 'quickconnect' });
  const cfg = JSON.parse(route.auth_token);
  console.log('apiToken len:', (cfg.apiToken || '').length, '| mobile:', cfg.mobile, '| password:', cfg.password ? 'SET' : 'MISSING');

  // 1) login
  const loginBody = { source: cfg.mobile ? 'mobile' : 'email', password: cfg.password };
  if (cfg.mobile) loginBody.mobile = String(cfg.mobile); else loginBody.email = cfg.email;
  const lr = await axios.post('https://app.quickconnect.biz/api/api/v1/login', loginBody, { validateStatus: () => true });
  console.log('\n=== LOGIN', lr.status, '===');
  console.log('keys:', Object.keys(lr.data || {}));
  console.log('full:', JSON.stringify(lr.data).slice(0, 600));
  const jwt = lr.data.token || (lr.data.data && (lr.data.data.token || lr.data.data.access_token)) || lr.data.access_token;
  if (!jwt) { console.log('NO JWT — stop'); process.exit(1); }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Token': cfg.apiToken, Authorization: 'Bearer ' + jwt };
  const dump = async (label, url, body) => {
    const r = await axios.post(url, body, { headers, validateStatus: () => true });
    console.log(`\n=== ${label} -> ${url}`);
    console.log('HTTP', r.status, '| body:', JSON.stringify(r.data).slice(0, 800));
  };

  const msg = 'QuickConnect diagnostic ' + Date.now();
  await dump('A /messaging local-10digit', 'https://api.quickconnect.biz/messaging', { message: msg, recipients: [{ mobile: TO }] });
  await dump('B /messaging +postData', 'https://api.quickconnect.biz/messaging', { message: 'Hi {{name}}', recipients: [{ mobile: TO, postData: { name: 'Test' } }] });
  await dump('C /v2/messaging', 'https://api.quickconnect.biz/v2/messaging', { message: msg, recipients: [{ mobile: TO }] });
  await dump('D /messaging with 977', 'https://api.quickconnect.biz/messaging', { message: msg, recipients: [{ mobile: '977' + TO }] });

  // try a balance/profile endpoint if any clue
  try { const b = await axios.get('https://api.quickconnect.biz/balance', { headers, validateStatus: () => true }); console.log('\n=== /balance', b.status, JSON.stringify(b.data).slice(0, 300)); } catch (e) { console.log('balance err', e.message); }
  process.exit(0);
})();
