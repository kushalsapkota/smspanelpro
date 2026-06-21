// Offline regression for the INSOFT web-panel multi-account pool. Stubs the ASP.NET login + /BulkSms/Save
// (no real SMS), exercises spread / rotate-on-1006 / relogin-on-401 / disable-bad-creds / bounded-failure /
// legacy single-account, then cleans up.
const axios = require('axios');
const qsl = require('querystring');
const db = require('./db');
const panel = require('./providers/insoftpanel');

let n = 0, f = 0;
const ok = (c, m) => { n++; if (!c) { f++; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); };

// accounts: { username: { password, save } }  save = numeric body status (or fn) returned by /BulkSms/Save
function stub(accounts) {
  axios.get = async (url) => {
    if (/\/Login$/.test(url)) return { status: 200, data: '<input name="__RequestVerificationToken" value="tok123"/>', headers: { 'set-cookie': ['.AspNetCore.Antiforgery=af; path=/'] } };
    if (/\/BulkSms$/.test(url)) return { status: 200, data: 'Balance : Rs . 5000', headers: {} };
    return { status: 200, data: 'OK', headers: {} };
  };
  axios.post = async (url, body, cfg) => {
    if (/\/Login$/.test(url)) {
      const p = qsl.parse(body); const acc = accounts[p.username];
      if (!acc || acc.password !== p.password) return { status: 200, data: '<input name="password"/> please login', headers: {} }; // looksLikeLogin → rejected
      return { status: 302, data: '', headers: { location: '/Dashboard', 'set-cookie': ['.AspNetCore.Session=sess_' + p.username + '; path=/'] } };
    }
    if (/\/BulkSms\/Save$/.test(url)) {
      const ck = String((cfg.headers || {}).Cookie || ''); const m = ck.match(/\.AspNetCore\.Session=sess_(\w+)/);
      const acc = m && accounts[m[1]]; let st = acc ? (typeof acc.save === 'function' ? acc.save() : acc.save) : 200;
      return { status: 200, data: { status: st }, headers: {} };
    }
    return { status: 200, data: {}, headers: {} };
  };
}

(async () => {
  await db.connect();
  const route = await db.Route.create({ name: '__panel_test__', type: 'insoftpanel', api_url: 'https://insoftsms.com', sender_id: 'puspanjali', provides_dlr: true });
  const rid = route._id;
  const lean = async () => db.Route.findById(rid).lean();
  const mk = (user, pass, extra = {}) => db.ProviderKey.create(Object.assign({ route_id: rid, token: user, password: pass, sender_id: 's_' + user, status: 'active' }, extra));
  const get = user => db.ProviderKey.findOne({ route_id: rid, token: user }).lean();
  const clearKeys = () => db.ProviderKey.deleteMany({ route_id: rid });

  try {
    console.log('\n1) spread: concurrent sends fan out across ALL active accounts');
    await mk('a1', 'p1'); await mk('a2', 'p2'); await mk('a3', 'p3');
    stub({ a1: { password: 'p1', save: 200 }, a2: { password: 'p2', save: 200 }, a3: { password: 'p3', save: 200 } });
    let fails = 0; for (let i = 0; i < 30; i++) { const r = await panel.send(await lean(), '9779801234567', 'hi'); if (!r.success) fails++; }
    ok(fails === 0, '30/30 sends succeeded');
    const counts = [await get('a1'), await get('a2'), await get('a3')].map(k => k.sms_sent || 0);
    ok(counts.every(c => c > 0), 'all 3 accounts used (round-robin): ' + JSON.stringify(counts));

    console.log('\n2) status:1006 on one account → rotate to a healthy account (account stays active)');
    await clearKeys(); await mk('bad6', 'p'); await mk('good', 'p');
    stub({ bad6: { password: 'p', save: 1006 }, good: { password: 'p', save: 200 } });
    fails = 0; for (let i = 0; i < 10; i++) { const r = await panel.send(await lean(), '9801234567', 'hi'); if (!r.success) fails++; }
    ok(fails === 0, 'all sends still succeeded by rotating past the 1006 account');
    ok((await get('bad6')).status === 'active', 'the 1006 account is NOT disabled (opaque code → rotate, not blame)');
    ok((await get('good')).sms_sent > 0, 'healthy account carried the traffic');

    console.log('\n3) body status:401 → relogin + retry; persists → fail WITHOUT killing the account');
    await clearKeys(); await mk('sess401', 'p');
    stub({ sess401: { password: 'p', save: 401 } });
    let r = await panel.send(await lean(), '9801234567', 'hi');
    ok(!r.success && /401/.test(r.error || ''), 'send fails with status:401 surfaced: ' + (r.error || '').slice(0, 50));
    ok((await get('sess401')).status === 'active', 'account stays ACTIVE (could be transient session, not bad creds)');

    console.log('\n4) bad credentials → DISABLE that account + fail over to the next');
    await clearKeys(); await mk('wrongpw', 'NOTREAL'); await mk('okacct', 'p');
    stub({ wrongpw: { password: 'realpw', save: 200 }, okacct: { password: 'p', save: 200 } }); // wrongpw login will be rejected
    fails = 0; for (let i = 0; i < 6; i++) { const x = await panel.send(await lean(), '9801234567', 'hi'); if (!x.success) fails++; }
    ok(fails === 0, 'sends succeed by failing over to the good account');
    ok((await get('wrongpw')).status === 'disabled', 'bad-credentials account DISABLED (auth fault)');
    ok((await get('okacct')).sms_sent > 0, 'good account took over');

    console.log('\n5) ALL accounts return 1006 → message fails, bounded (accounts NOT disabled)');
    await clearKeys(); for (const u of ['z1', 'z2', 'z3', 'z4']) await mk(u, 'p');
    stub({ z1: { password: 'p', save: 1006 }, z2: { password: 'p', save: 1006 }, z3: { password: 'p', save: 1006 }, z4: { password: 'p', save: 1006 } });
    r = await panel.send(await lean(), '9801234567', 'hi');
    ok(!r.success && /1006/.test(r.error || ''), 'message fails when every account is unhealthy');
    const stillActive = (await db.ProviderKey.find({ route_id: rid }).lean()).filter(k => k.status === 'active').length;
    ok(stillActive === 4, 'all 4 accounts remain active (rotate never disabled them): ' + stillActive);

    console.log('\n6) legacy single-account (no pool) via route.auth_token still works');
    await clearKeys();
    await db.Route.updateOne({ _id: rid }, { $set: { auth_token: JSON.stringify({ username: 'solo', password: 'sp' }) } });
    stub({ solo: { password: 'sp', save: 200 } });
    r = await panel.send(await lean(), '9779801234567', 'hi');
    ok(r.success, 'legacy single-login send succeeded');

  } finally {
    await clearKeys();
    await db.Route.deleteOne({ _id: rid });
    console.log(`\n${n - f}/${n} assertions passed${f ? ' — ' + f + ' FAILED' : ' ✅'}`);
    process.exit(f ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
