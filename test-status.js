/**
 * test-status.js — self-cleaning e2e test for the online/offline status feature.
 * Creates a temp user, binds via SMPP (NO SMS sent), checks the heartbeat marks it
 * online, unbinds, checks it goes offline. Run: node test-status.js
 */
require('dotenv').config();
const smpp = require('smpp');
const bcrypt = require('bcryptjs');
const db = require('./db');

const USERNAME = '_status_e2e';
const PASSWORD = 'statTest9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function heartbeat() {
  const s = await db.Setting.findOne({ key: 'smpp_heartbeat' });
  return s && s.value ? s.value : null;
}

async function main() {
  await db.connect();
  await db.User.deleteOne({ username: USERNAME });
  await db.User.create({ username: USERNAME, password: bcrypt.hashSync(PASSWORD, 10), role: 'client', is_active: true, credits: 0 });
  let fails = 0;
  const check = (name, ok) => { console.log(`${ok ? '✓' : '✗ FAIL'} ${name}`); if (!ok) fails++; };

  // bind
  const session = smpp.connect({ url: 'smpp://127.0.0.1:2775' }, () => {
    session.bind_transceiver({ system_id: USERNAME, password: PASSWORD }, async (pdu) => {
      check('bind accepted', pdu.command_status === 0);
      await sleep(7000); // > one heartbeat cycle (5s)
      let hb = await heartbeat();
      check('heartbeat lists user online', !!hb && (hb.online || []).includes(USERNAME));
      check('heartbeat fresh', !!hb && Date.now() - new Date(hb.at).getTime() < 30000);
      const u = await db.User.findOne({ username: USERNAME });
      check('User.is_connected true', !!u.is_connected);
      check('last_bound_ip recorded', u.last_bound_ip === '127.0.0.1');

      session.unbind();
      await sleep(7000);
      hb = await heartbeat();
      check('heartbeat drops user after unbind', !!hb && !(hb.online || []).includes(USERNAME));
      const u2 = await db.User.findOne({ username: USERNAME });
      check('User.is_connected false after unbind', !u2.is_connected);

      // cleanup
      await db.User.deleteOne({ username: USERNAME });
      await db.ActiveConnection.deleteMany({ username: USERNAME });
      console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS (test data cleaned)');
      process.exit(fails ? 1 : 0);
    });
  });
  session.on('error', (e) => { console.error('smpp error', e.message); process.exit(1); });
}

main().catch((e) => { console.error(e); process.exit(1); });
