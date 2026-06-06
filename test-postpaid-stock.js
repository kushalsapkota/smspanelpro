/* Offline test: postpaid deductCredit + credit-limit alert + route stock alert.
 * Stubs telegram (no real messages), uses throwaway docs, restores everything. */
const assert = require('assert');
const tg = require('./telegram');
const sent = [];
tg.systemAlert = async (m) => { sent.push(['sys', m]); };
tg.userAlert = async (_u, m) => { sent.push(['user', m]); };
const db = require('./db');
const engine = require('./shared/engine');

(async () => {
  await db.connect();
  const U = '_pp_test_' + Math.floor(Math.random() * 1e6);

  // --- postpaid: balance may go negative ---
  await db.User.create({ username: U, password: 'x', role: 'client', credits: 0.005, cost_per_sms: 0.009, billing_mode: 'postpaid', credit_limit: 0.01, pay_day: 1 });
  let r = await db.deductCredit(U, 1);
  assert(r.ok, 'postpaid deduct must succeed at low balance');
  assert.strictEqual(r.balance, -0.004, 'balance should go negative: ' + r.balance);
  r = await db.deductCredit(U, 2);
  assert(r.ok && r.balance === -0.022, 'second deduct: ' + r.balance);
  console.log('✔ postpaid deduct goes negative, 3-decimal grid:', r.balance);

  // credit-limit soft alert fires once (debounced) when debt > limit
  const u = await db.User.findOne({ username: U });
  await engine.maybeLowBalanceAlert(u, u.credits);
  await engine.maybeLowBalanceAlert(u, u.credits); // debounced — no second alert
  const limAlerts = sent.filter(([k, m]) => k === 'sys' && m.includes('Credit limit'));
  assert.strictEqual(limAlerts.length, 1, 'exactly one credit-limit alert, got ' + limAlerts.length);
  assert(limAlerts[0][1].includes(U) && limAlerts[0][1].includes('0.022'), limAlerts[0][1]);
  console.log('✔ soft credit-limit alert fired once:', limAlerts[0][1].replace(/<[^>]+>/g, ''));

  // --- prepaid still blocks ---
  await db.User.updateOne({ username: U }, { $set: { billing_mode: 'prepaid', credits: 0.005 } });
  r = await db.deductCredit(U, 1);
  assert(!r.ok && r.reason === 'insufficient', 'prepaid must still block');
  console.log('✔ prepaid still blocks on insufficient balance');

  // --- route stock alert at 40% ---
  const route = await db.Route.create({ name: '_stock_test', type: 'custom', inventory_total: 20000, route_credits: 8001, inventory_alert_pct: 40 });
  // simulate the dispatch hook: deduct 2 parts -> 7999 = 39.995% -> alert
  const remaining = await db.deductRouteCredit(route._id, 2);
  assert.strictEqual(remaining, 7999);
  sent.length = 0;
  await engine.maybeRouteStockAlert(route._id, remaining);   // 39.995% ≤ 40% → alert
  await engine.maybeRouteStockAlert(route._id, remaining - 5); // already alerted → silent
  const stockAlerts = sent.filter(([k, m]) => k === 'sys' && m.includes('Route stock low'));
  assert.strictEqual(stockAlerts.length, 1, 'exactly one stock alert, got ' + stockAlerts.length);
  assert(stockAlerts[0][1].includes('_stock_test') && stockAlerts[0][1].includes('7,999'), stockAlerts[0][1]);
  console.log('✔ route stock alert fired once at 40%:', stockAlerts[0][1].replace(/<[^>]+>/g, '').split('\n')[1]);

  // top-up re-arms: simulates POST /api/routes/:id/topup
  await db.Route.findByIdAndUpdate(route._id, { $inc: { route_credits: 20000, inventory_total: 20000 }, $set: { inventory_alerted: false } });
  const after = await db.Route.findById(route._id);
  assert.strictEqual(after.route_credits, 27999);
  assert.strictEqual(after.inventory_total, 40000);
  assert.strictEqual(after.inventory_alerted, false);
  console.log('✔ top-up adds stock (27999/40000) and re-arms the alert');

  // cleanup
  await db.User.deleteOne({ username: U });
  await db.CreditTransaction.deleteMany({ username: U });
  await db.Route.deleteOne({ _id: route._id });
  console.log('✔ cleanup done');
  process.exit(0);
})().catch((e) => { console.error('✘ FAIL:', e.message); process.exit(1); });
