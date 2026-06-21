// Offline regression for the INSOFT key-pool failover. Stubs axios (no real SMS), exercises the
// rotation/consume/exhaust/failover paths against a throwaway route in Mongo, then cleans up.
const axios = require('axios');
const db = require('./db');
const insoft = require('./providers/insoft');

let assertN = 0, fail = 0;
function ok(cond, msg) { assertN++; if (!cond) { fail++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); }

// axios stub: decide the gateway reply from the posted token.
function stub(map) {
  axios.post = async (url, data) => {
    const tok = (data && data.token) || '';
    const r = map[tok] || { response_code: 200, response: 'success', message_count: 1, balance_deducted: 3 };
    return { status: 200, data: r };
  };
  axios.get = async () => ({ status: 200, data: 'OK' }); // testConnection reachability
}

(async () => {
  await db.connect();
  // key_strategy 'highest' keeps the deterministic drain-the-highest ordering these sections assert;
  // the new spread (round-robin) default is exercised separately in section 8.
  const route = await db.Route.create({ name: '__insoft_test__', type: 'insoft', api_url: 'https://sms.insoftsms.com', sender_id: 'insoft', provides_dlr: false, config: { key_strategy: 'highest' } });
  const rid = route._id;
  const lean = async () => (await db.Route.findById(rid).lean());
  const mk = (token, credit, extra = {}) => db.ProviderKey.create(Object.assign({ route_id: rid, token, sender_id: 's_' + token, credit_initial: credit, credit_remaining: credit, status: 'active' }, extra));
  const get = token => db.ProviderKey.findOne({ route_id: rid, token }).lean();
  const onlyActive = async tokens => { await db.ProviderKey.updateMany({ route_id: rid }, { $set: { status: 'disabled' } }); await db.ProviderKey.updateMany({ route_id: rid, token: { $in: tokens } }, { $set: { status: 'active' } }); };

  try {
    stub({});

    console.log('\n1) highest-remaining-first selection + credit consume');
    await mk('tA', 6); await mk('tB', 50); await mk('tC', 5);
    let r = await insoft.send(await lean(), '9779704500025', 'hi');
    ok(r.success, 'send succeeded');
    ok(r.rawData && r.rawData.key_label === 's_tB' || (await get('tB')).credit_remaining === 47, 'used tB (highest=50)');
    ok((await get('tB')).credit_remaining === 47, 'tB credit 50 → 47 (deducted 3)');
    ok((await get('tB')).sms_sent === 1, 'tB sms_sent = 1');
    ok((await get('tA')).credit_remaining === 6, 'tA untouched');

    console.log('\n2) key crosses zero → flips exhausted');
    await mk('tD', 2); await onlyActive(['tD']);
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(r.success, 'send on near-empty key still succeeds');
    const D = await get('tD');
    ok(D.credit_remaining === -1, 'tD 2 → -1 after deducting 3');
    ok(D.status === 'exhausted', 'tD flipped to exhausted');

    console.log('\n3) balance error on a key → exhaust + auto-failover to next key');
    await mk('tEMPTY', 100); await mk('tF', 90);
    await onlyActive(['tEMPTY', 'tF']);
    stub({ tEMPTY: { response_code: 203, body: 'Insufficient balance to send' } });
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(r.success, 'failover send succeeded');
    ok((await get('tEMPTY')).status === 'exhausted', 'tEMPTY marked exhausted on balance error');
    ok((await get('tF')).credit_remaining === 87, 'tF (next highest) took over: 90 → 87');

    console.log('\n4) generic gateway error (bad message) → do NOT blame the key, stop');
    await db.ProviderKey.updateOne({ route_id: rid, token: 'tF' }, { $set: { status: 'active', credit_remaining: 87 } });
    await onlyActive(['tF']);
    stub({ tF: { response_code: 402, response: 'Something is wrong.' } });
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(!r.success, 'send failed');
    ok(/402/.test(r.error || ''), 'error surfaces gateway 402: ' + r.error);
    ok((await get('tF')).status === 'active', 'tF stays ACTIVE (message fault, not key fault)');

    console.log('\n5) all keys dry → clear pool-exhausted error');
    await db.ProviderKey.updateMany({ route_id: rid }, { $set: { status: 'exhausted' } });
    stub({});
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(!r.success && /exhausted/i.test(r.error || ''), 'reports pool exhausted: ' + r.error);

    console.log('\n6) auth error (bad token) → disable that key, fail over');
    await mk('tBAD', 100); await mk('tGOOD', 80); await onlyActive(['tBAD', 'tGOOD']);
    stub({ tBAD: { response_code: 203, body: 'Authentication Failed. Request Token Not Found.' } });
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(r.success, 'failover past bad token succeeded');
    ok((await get('tBAD')).status === 'disabled', 'tBAD disabled (auth failure)');
    ok((await get('tGOOD')).credit_remaining === 77, 'tGOOD took over: 80 → 77');

    console.log('\n7) REGRESSION: a network timeout must NOT exhaust a key with credit');
    await db.ProviderKey.updateMany({ route_id: rid }, { $set: { status: 'disabled' } });
    await mk('tTimeout', 500); await onlyActive(['tTimeout']);
    axios.post = async () => { throw new Error('timeout of 20000ms exceeded'); }; // simulate slow gateway
    r = await insoft.send(await lean(), '9704500025', 'hi');
    ok(!r.success, 'send fails on timeout');
    ok((await get('tTimeout')).status === 'active', 'key STAYS ACTIVE after a timeout (not exhausted)');
    ok((await get('tTimeout')).credit_remaining === 500, 'key credit untouched (500)');
    stub({}); // restore

    console.log('\n8) spread strategy (default): concurrent sends fan out across ALL active keys');
    // Fresh route WITHOUT key_strategy:'highest' → default round-robin spread.
    const sroute = await db.Route.create({ name: '__insoft_spread__', type: 'insoft', api_url: 'https://sms.insoftsms.com', sender_id: 'insoft', provides_dlr: false });
    const srid = sroute._id;
    const smk = (token, credit) => db.ProviderKey.create({ route_id: srid, token, sender_id: 's_' + token, credit_initial: credit, credit_remaining: credit, status: 'active' });
    await smk('s1', 1000); await smk('s2', 1000); await smk('s3', 1000); await smk('s4', 1000);
    const sLean = await db.Route.findById(srid).lean();
    for (let i = 0; i < 40; i++) await insoft.send(sLean, '9704500025', 'hi'); // 40 sends, 1 seg each
    const used = await db.ProviderKey.find({ route_id: srid }).lean();
    const counts = used.map(k => k.sms_sent || 0);
    const usedKeys = counts.filter(c => c > 0).length;
    const maxShare = Math.max(...counts) / 40;
    ok(usedKeys === 4, 'all 4 keys were used (round-robin), got counts ' + JSON.stringify(counts));
    ok(maxShare <= 0.35, 'no single key carried >35% of traffic (max share ' + (maxShare * 100).toFixed(0) + '%)');
    await db.ProviderKey.deleteMany({ route_id: srid });
    await db.Route.deleteOne({ _id: srid });

  } finally {
    await db.ProviderKey.deleteMany({ route_id: rid });
    await db.Route.deleteOne({ _id: rid });
    console.log(`\n${assertN - fail}/${assertN} assertions passed${fail ? ' — ' + fail + ' FAILED' : ' ✅'}`);
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
