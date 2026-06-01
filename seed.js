/**
 * seed.js — create an initial admin, a demo route (QuickConnect/mock), and a demo client.
 *   node seed.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function main() {
  await db.connect();

  // admin user (in addition to env admin)
  if (!(await db.User.findOne({ role: 'admin' }))) {
    await db.User.create({ username: process.env.ADMIN_USERNAME || 'admin', password: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10), role: 'admin' });
    console.log('seeded admin user');
  }

  // demo route — QuickConnect. auth_token is a JSON blob with apiToken + login creds.
  const qcAuth = JSON.stringify({
    apiToken: process.env.QC_API_TOKEN || '',
    mobile: process.env.QC_MOBILE || undefined,
    email: process.env.QC_EMAIL || undefined,
    password: process.env.QC_PASSWORD || '',
  });
  let route = await db.Route.findOne({ name: 'QuickConnect' });
  if (!route) {
    route = await db.Route.create({ name: 'QuickConnect', type: 'quickconnect', api_url: 'https://api.quickconnect.biz', auth_token: qcAuth, cost_per_sms: 1, sender_id: '' });
    console.log('seeded QuickConnect route');
  } else {
    await db.Route.findByIdAndUpdate(route._id, { $set: { auth_token: qcAuth } });
    console.log('updated QuickConnect route auth');
  }

  // (no demo client — create real users from the admin panel)
  console.log('done');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
