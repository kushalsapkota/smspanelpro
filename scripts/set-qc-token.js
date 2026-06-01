// Apply QuickConnect auth (apiToken + login creds) from .env onto the QuickConnect route.
require('dotenv').config();
const db = require('../db');
(async () => {
  await db.connect();
  const auth = JSON.stringify({
    apiToken: process.env.QC_API_TOKEN || '',
    mobile: process.env.QC_MOBILE || undefined,
    email: process.env.QC_EMAIL || undefined,
    password: process.env.QC_PASSWORD || '',
  });
  const r = await db.Route.findOneAndUpdate({ type: 'quickconnect' }, { $set: { auth_token: auth } }, { new: true });
  console.log(r ? `QuickConnect auth set (apiToken len ${(process.env.QC_API_TOKEN || '').length}, mobile ${process.env.QC_MOBILE || '-'}, password ${process.env.QC_PASSWORD ? 'SET' : 'MISSING'})` : 'no quickconnect route');
  process.exit(0);
})();
