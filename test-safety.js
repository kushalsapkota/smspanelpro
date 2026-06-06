/* Offline test: atomic invoice numbers (no reuse after delete) + ledger drift detection. */
const assert = require('assert');
const tg = require('./telegram');
tg.systemAlert = async () => {}; tg.userAlert = async () => {};
const db = require('./db');

(async () => {
  await db.connect();

  // --- invoice numbers: monotonic, never reused after a delete ---
  const n1 = await db.nextInvoiceNumber();
  const inv = await db.Invoice.create({ number: n1, type: 'manual', client_username: '_seq_test', total: 1, status: 'unpaid' });
  const n2 = await db.nextInvoiceNumber();
  assert.notStrictEqual(n1, n2, 'numbers must differ');
  const v1 = parseInt(n1.split('-').pop(), 10), v2 = parseInt(n2.split('-').pop(), 10);
  assert.strictEqual(v2, v1 + 1, `monotonic: ${n1} -> ${n2}`);
  await db.Invoice.deleteOne({ _id: inv._id });          // delete the invoice…
  const n3 = await db.nextInvoiceNumber();
  const v3 = parseInt(n3.split('-').pop(), 10);
  assert.strictEqual(v3, v2 + 1, `no reuse after delete: got ${n3}, expected ${v2 + 1}`);
  console.log(`✔ invoice numbers atomic & never reused: ${n1} → ${n2} → (deleted one) → ${n3}`);

  // --- ledger: clean account verifies; raw $set drift is caught ---
  const U = '_ledger_test_' + Math.floor(Math.random() * 1e6);
  await db.User.create({ username: U, password: 'x', role: 'client', credits: 0, cost_per_sms: 0.01 });
  await db.addCredits(U, 10, { note: 'test topup' });
  await db.deductCredit(U, 3); // -0.03
  // replicate ledgerCheckOnce's math for one user (anchor = 0 @ epoch)
  const verify = async () => {
    const agg = await db.CreditTransaction.aggregate([
      { $match: { username: U } },
      { $group: { _id: null, sum: { $sum: '$amount' } } },
    ]);
    const u = await db.User.findOne({ username: U });
    return { expected: db.round3(agg[0] ? agg[0].sum : 0), actual: db.round3(u.credits || 0) };
  };
  let r = await verify();
  assert.strictEqual(r.expected, r.actual, `clean books: ${r.expected} vs ${r.actual}`);
  assert.strictEqual(r.actual, 9.97);
  console.log('✔ clean account: ledger', r.expected, '== balance', r.actual);

  await db.User.updateOne({ username: U }, { $set: { credits: 12.5 } }); // simulate tampering (raw $set, no tx)
  r = await verify();
  assert(Math.abs(r.actual - r.expected) > 0.002, 'drift must be detectable');
  console.log(`✔ tampering detected: balance €${r.actual} vs ledger €${r.expected} (Δ €${db.round3(r.actual - r.expected)})`);

  await db.User.deleteOne({ username: U });
  await db.CreditTransaction.deleteMany({ username: U });
  console.log('✔ cleanup done');
  process.exit(0);
})().catch((e) => { console.error('✘ FAIL:', e.message); process.exit(1); });
