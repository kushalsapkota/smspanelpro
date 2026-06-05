/**
 * crm/billing.js — one choke point for "client paid us":
 * Payment row + balance top-up + numbered receipt invoice + Telegram alert.
 * Used by the manual record-payment endpoint AND the crypto auto-confirm watcher.
 */
const db = require('../db');
const telegram = require('../telegram');

async function getCrmSettings() {
  const s = await db.Setting.findOne({ key: 'crm' });
  const v = (s && s.value) || {};
  return {
    company: v.company || {},
    crypto: v.crypto || {},
    reminders: v.reminders || { enabled: true },
    smtp: v.smtp || {},
  };
}

/**
 * Record a confirmed payment.
 * opts: { username, amount (EUR), method, reference, note, by,
 *         credit (default true)  — top up the client's balance,
 *         receipt (default true) — generate a receipt invoice,
 *         crypto — {txid, usdt_amount, rate, wallet, network} for usdt payments }
 * Returns { payment, invoice, balance }
 */
async function recordPayment(opts) {
  const user = await db.User.findOne({ username: String(opts.username || '').toLowerCase() });
  if (!user) throw new Error('client not found: ' + opts.username);
  const amount = db.round3(opts.amount);
  if (!(amount > 0)) throw new Error('amount must be > 0');
  const credit = opts.credit !== false;
  const wantReceipt = opts.receipt !== false;

  let invoice = null;
  if (wantReceipt) {
    invoice = await db.Invoice.create({
      number: await db.nextInvoiceNumber(),
      type: 'receipt',
      client_id: user._id, client_username: user.username,
      items: [{
        description: `Balance top-up (prepaid SMS credit)${opts.method === 'usdt-trc20' ? ' — USDT TRC-20' : ''}`,
        qty: 1, unit_price: amount, amount,
      }],
      subtotal: amount, tax: 0, total: amount, currency: 'EUR',
      status: 'paid', paid: amount, issued_date: new Date(),
      note: opts.note || '', by: opts.by || 'system',
    });
  }

  const payment = await db.Payment.create({
    invoice_id: invoice ? invoice._id : null,
    invoice_number: invoice ? invoice.number : '',
    client_id: user._id, client_username: user.username,
    amount, currency: 'EUR',
    method: opts.method || 'manual', status: 'confirmed',
    credited: false, credited_amount: 0,
    crypto: opts.crypto || {},
    reference: opts.reference || '', note: opts.note || '',
    by: opts.by || 'admin',
  });

  let balance = db.round3(user.credits);
  if (credit) {
    const r = await db.addCredits(user.username, amount, {
      type: 'topup',
      note: `payment ${payment._id}${invoice ? ' / ' + invoice.number : ''} (${payment.method})`,
      by: opts.by || 'crm',
    });
    if (r.ok) {
      balance = r.balance;
      payment.credited = true; payment.credited_amount = amount;
      await payment.save();
    }
  }

  telegram.systemAlert(
    `💶 <b>Payment received</b>\n` +
    `Client: <b>${user.username}</b>\n` +
    `Amount: <b>€${amount.toFixed(2)}</b> via ${payment.method}` +
    (opts.reference ? `\nRef: <code>${opts.reference}</code>` : '') +
    (invoice ? `\nReceipt: ${invoice.number}` : '') +
    (credit ? `\nNew balance: <b>€${balance.toFixed(3)}</b>` : '')
  ).catch(() => {});

  return { payment, invoice, balance };
}

module.exports = { recordPayment, getCrmSettings };
