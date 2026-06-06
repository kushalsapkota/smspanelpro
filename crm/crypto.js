/**
 * crm/crypto.js — commission-free USDT (TRC-20) auto payments, direct to YOUR wallet.
 *
 * How it works (no gateway, no middleman, no fees):
 *   1. Operator creates a top-up intent for a client (€ amount).
 *   2. We convert EUR→USDT at the live rate (CoinGecko, free) + optional margin,
 *      then make the amount UNIQUE in the 6-decimal dust digits (e.g. 54.137204).
 *   3. Client sends exactly that amount of USDT to the configured TRC-20 wallet.
 *   4. A watcher polls the free public TronGrid API for confirmed incoming
 *      transfers; an exact amount match after the intent was created = paid →
 *      auto-credit balance + receipt invoice + Telegram alert.
 *
 * Settings (Setting key 'crm' → value.crypto):
 *   { wallet, rate_mode: 'auto'|'fixed', fixed_rate (EUR per USDT),
 *     margin_pct (extra % charged), intent_ttl_min (default 120) }
 */
const axios = require('axios');
const db = require('../db');
const telegram = require('../telegram');
const { CryptoIntent } = require('./models');
const { recordPayment, getCrmSettings } = require('./billing');

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // official Tether (USDT) on Tron
const TRONGRID = 'https://api.trongrid.io';

// ---- EUR per USDT rate (cached 5 min; fixed-rate mode supported) ----
let _rate = { value: null, at: 0 };
async function getRate() {
  const { crypto: cfg } = await getCrmSettings();
  if (cfg.rate_mode === 'fixed' && Number(cfg.fixed_rate) > 0) {
    return { rate: Number(cfg.fixed_rate), source: 'fixed' };
  }
  if (_rate.value && Date.now() - _rate.at < 5 * 60 * 1000) return { rate: _rate.value, source: 'coingecko (cached)' };
  const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'tether', vs_currencies: 'eur' }, timeout: 10000,
  });
  const rate = Number(r.data && r.data.tether && r.data.tether.eur);
  if (!(rate > 0)) throw new Error('could not fetch EUR/USDT rate');
  _rate = { value: rate, at: Date.now() };
  return { rate, source: 'coingecko' };
}

const usdtStr = (n) => n.toFixed(6);

// Make a unique USDT amount: base from the EUR conversion (2 dp), uniqueness in
// the last 4 decimals (0.000001–0.009999 USDT — under a cent) so two open
// intents never collide while the client pays at most ~0.01 USDT extra.
async function uniqueAmount(baseUsdt) {
  const floor = Math.max(0.01, Math.floor(baseUsdt * 100) / 100); // 2-dp base
  for (let i = 0; i < 50; i++) {
    const dust = (Math.floor(Math.random() * 9999) + 1) / 1e6; // 0.000001–0.009999
    const candidate = Math.round((floor + dust) * 1e6) / 1e6;
    const clash = await CryptoIntent.findOne({ status: 'pending', usdt_str: usdtStr(candidate) });
    if (!clash) return candidate;
  }
  throw new Error('could not allocate a unique amount, try again');
}

async function createIntent({ username, eur, by, invoice, expiresAt, purpose }) {
  const { crypto: cfg } = await getCrmSettings();
  if (!cfg.wallet) throw new Error('No TRC-20 wallet configured — set it in CRM Settings first');
  const user = await db.User.findOne({ username: String(username || '').toLowerCase() });
  if (!user) throw new Error('client not found');
  eur = db.round3(eur);
  if (!(eur > 0)) throw new Error('amount must be > 0');

  const { rate } = await getRate(); // EUR per 1 USDT
  const margin = Number(cfg.margin_pct) || 0;
  const baseUsdt = (eur / rate) * (1 + margin / 100);
  // Exchange deposit minimums (Binance: 5 USDT on TRC-20) — anything below is
  // SWALLOWED by the exchange even though the chain shows it. Refuse to create
  // intents the operator could lose. Set min_usdt to 0 in Settings to disable
  // (e.g. when receiving into a self-custody wallet only).
  const minUsdt = cfg.min_usdt == null ? 5 : Number(cfg.min_usdt) || 0;
  if (minUsdt && baseUsdt < minUsdt) {
    const minEur = Math.ceil(minUsdt * rate * 100) / 100;
    throw new Error(`€${eur.toFixed(2)} ≈ ${baseUsdt.toFixed(2)} USDT — below the ${minUsdt} USDT minimum (exchange deposit limit; smaller transfers get swallowed). Minimum is ~€${minEur.toFixed(2)}, or record this payment manually.`);
  }
  const usdt = await uniqueAmount(baseUsdt);
  const ttlMin = Number(cfg.intent_ttl_min) || 120;
  // Invoice intents live until the invoice's due date (min 14 days) — clients
  // pay invoices on their own schedule, unlike interactive top-ups.
  let expires = new Date(Date.now() + ttlMin * 60 * 1000);
  if (invoice) {
    const floor = new Date(Date.now() + 14 * 864e5);
    expires = invoice.due_date && new Date(invoice.due_date) > floor ? new Date(invoice.due_date) : floor;
  }
  if (expiresAt) expires = new Date(expiresAt); // explicit override (e.g. postpaid settlement: valid until next pay day)

  return CryptoIntent.create({
    username: user.username, user_id: user._id,
    eur, usdt, usdt_str: usdtStr(usdt), rate,
    wallet: cfg.wallet, status: 'pending',
    purpose: invoice ? 'invoice' : (purpose || 'topup'),
    target_invoice_id: invoice ? invoice._id : null,
    target_invoice_number: invoice ? invoice.number : '',
    expires_at: expires,
    by: by || 'admin',
  });
}

// Find-or-refresh the pending intent for an unpaid invoice's outstanding balance.
// Reused on every PDF render so the printed USDT amount is always collectible.
async function intentForInvoice(invoice, by) {
  const outstanding = db.round3(invoice.total - (invoice.paid || 0));
  if (!(outstanding > 0)) return null;
  const { crypto: cfg } = await getCrmSettings();
  const existing = await CryptoIntent.findOne({ status: 'pending', purpose: 'invoice', target_invoice_id: invoice._id });
  if (existing && db.round3(existing.eur) === outstanding && existing.wallet === cfg.wallet) return existing;
  if (existing) { existing.status = 'cancelled'; await existing.save(); } // outstanding or wallet changed
  return createIntent({ username: invoice.client_username, eur: outstanding, by, invoice });
}

// Find-or-refresh the pending settlement intent for a postpaid client's outstanding debt.
// Settlement intents confirm like top-ups (recordPayment → credits the balance → debt cleared).
async function intentForSettlement(username, eur, by, expiresAt) {
  eur = db.round3(eur);
  if (!(eur > 0)) return null;
  const { crypto: cfg } = await getCrmSettings();
  if (!cfg.wallet) return null;
  const existing = await CryptoIntent.findOne({ status: 'pending', purpose: 'settlement', username: String(username).toLowerCase() });
  if (existing && db.round3(existing.eur) === eur && existing.wallet === cfg.wallet) return existing;
  if (existing) { existing.status = 'cancelled'; await existing.save(); } // outstanding or wallet changed
  return createIntent({ username, eur, by, expiresAt, purpose: 'settlement' });
}

// ---- watcher ----
async function fetchIncoming(wallet) {
  const r = await axios.get(`${TRONGRID}/v1/accounts/${wallet}/transactions/trc20`, {
    params: {
      only_confirmed: true, only_to: true, limit: 100,
      contract_address: USDT_TRC20_CONTRACT,
    },
    timeout: 15000,
  });
  return (r.data && r.data.data) || [];
}

// Settle a manual invoice from a confirmed on-chain payment (same logic as the
// manual /invoices/:id/pay endpoint: paid/status transition + credits_on_pay once).
async function settleInvoice(intent, tx, eurOverride) {
  const inv = await db.Invoice.findById(intent.target_invoice_id);
  if (!inv || inv.status === 'void') return null;
  const amount = db.round3(eurOverride != null ? eurOverride : intent.eur);
  const payment = await db.Payment.create({
    invoice_id: inv._id, invoice_number: inv.number, client_id: inv.client_id, client_username: inv.client_username,
    amount, currency: 'EUR', method: 'usdt-trc20', status: 'confirmed',
    crypto: { txid: tx.transaction_id, usdt_amount: intent.usdt, rate: intent.rate, wallet: intent.wallet, network: 'TRC20', from: tx.from },
    reference: tx.transaction_id, note: `auto-confirmed on-chain for ${inv.number}`, by: 'crypto-watcher',
  });
  inv.paid = +((inv.paid || 0) + amount).toFixed(2);
  inv.status = inv.paid >= inv.total ? 'paid' : 'partial';
  if (inv.status === 'paid' && inv.credits_on_pay > 0 && !inv.credits_applied) {
    await db.addCredits(inv.client_username, inv.credits_on_pay, { type: 'topup', note: `invoice ${inv.number} paid (crypto)`, by: 'crypto-watcher' });
    inv.credits_applied = true;
  }
  await inv.save();
  telegram.systemAlert(
    `💶 <b>Invoice paid on-chain</b>\n${inv.number} (${inv.client_username}): <b>€${amount.toFixed(2)}</b> in USDT → ${inv.status}\nTx: <code>${tx.transaction_id}</code>`
  ).catch(() => {});
  return { payment, invoice: inv };
}

async function confirmIntent(intent, tx, eurOverride) {
  // double-check this txid hasn't already been consumed
  const dup = await CryptoIntent.findOne({ txid: tx.transaction_id, status: 'paid' });
  if (dup) return null;
  if (intent.purpose === 'invoice') {
    const r = await settleInvoice(intent, tx, eurOverride);
    if (!r) return null;
    intent.status = 'paid';
    intent.txid = tx.transaction_id;
    intent.paid_at = new Date(tx.block_timestamp || Date.now());
    intent.payment_id = r.payment._id;
    intent.invoice_number = r.invoice.number;
    await intent.save();
    console.log(`[crypto] invoice intent ${intent._id} PAID — ${r.invoice.number} via ${tx.transaction_id}`);
    return r;
  }
  const { payment, invoice, balance } = await recordPayment({
    username: intent.username, amount: eurOverride != null ? eurOverride : intent.eur,
    method: 'usdt-trc20', reference: tx.transaction_id,
    note: `auto-confirmed on-chain: ${tx.value ? (Number(tx.value) / 1e6).toFixed(6) : intent.usdt_str} USDT @ ${intent.rate} EUR/USDT`,
    by: 'crypto-watcher',
    crypto: {
      txid: tx.transaction_id, usdt_amount: tx.value ? Number(tx.value) / 1e6 : intent.usdt, rate: intent.rate,
      wallet: intent.wallet, network: 'TRC20', from: tx.from,
    },
  });
  intent.status = 'paid';
  intent.txid = tx.transaction_id;
  intent.paid_at = new Date(tx.block_timestamp || Date.now());
  intent.payment_id = payment._id;
  intent.invoice_number = invoice ? invoice.number : '';
  await intent.save();
  console.log(`[crypto] intent ${intent._id} PAID — ${intent.usdt_str} USDT from ${tx.from} (${tx.transaction_id})`);
  return { payment, invoice, balance };
}

// One pass: expire stale intents, then match pending ones against the chain.
// Returns {checked, paid, expired}. Safe to call from an endpoint or the loop.
let _running = false;
async function checkIntents() {
  if (_running) return { checked: 0, paid: 0, expired: 0, skipped: true };
  _running = true;
  try {
    const expired = await CryptoIntent.updateMany(
      { status: 'pending', expires_at: { $lt: new Date() } },
      { $set: { status: 'expired' } }
    );
    const pending = await CryptoIntent.find({ status: 'pending' }).sort({ createdAt: 1 });
    if (!pending.length) return { checked: 0, paid: 0, expired: expired.modifiedCount || 0 };

    let paid = 0;
    const wallets = [...new Set(pending.map((i) => i.wallet))];
    for (const wallet of wallets) {
      let txs;
      try { txs = await fetchIncoming(wallet); }
      catch (e) { console.error('[crypto] trongrid fetch failed:', e.message); continue; }
      const byAmount = new Map(); // micro-USDT string -> tx (newest first from API; keep first seen)
      for (const tx of txs) {
        if (tx.type && tx.type !== 'Transfer') continue;
        if (!byAmount.has(tx.value)) byAmount.set(tx.value, tx);
      }
      const walletIntents = pending.filter((i) => i.wallet === wallet);
      const matchedTx = new Set();
      for (const intent of walletIntents) {
        const micro = String(Math.round(intent.usdt * 1e6));
        const tx = byAmount.get(micro);
        if (!tx) continue;
        // must have landed after the intent was created (60s clock slack)
        if (Number(tx.block_timestamp) < new Date(intent.createdAt).getTime() - 60000) continue;
        const r = await confirmIntent(intent, tx);
        if (r) { paid++; matchedTx.add(tx.transaction_id); }
      }
      // Near-miss pass: client sent the wrong amount (over/under). If a fresh,
      // unconsumed tx lands within ±2% of EXACTLY ONE still-pending intent,
      // flag it + alert the operator — never auto-credit an inexact amount.
      const usedTx = new Set((await CryptoIntent.find({ status: 'paid', wallet }).select('txid')).map((i) => i.txid));
      for (const tx of txs) {
        if (tx.type && tx.type !== 'Transfer') continue;
        if (matchedTx.has(tx.transaction_id) || usedTx.has(tx.transaction_id)) continue;
        const v = Number(tx.value);
        const candidates = walletIntents.filter((i) => i.status === 'pending'
          && Number(tx.block_timestamp) >= new Date(i.createdAt).getTime() - 60000
          && Math.abs(v - i.usdt * 1e6) / (i.usdt * 1e6) <= 0.02
          && v !== Math.round(i.usdt * 1e6));
        if (candidates.length !== 1) continue;
        const intent = candidates[0];
        if (intent.suspect_txid === tx.transaction_id) continue; // already flagged & alerted
        intent.suspect_txid = tx.transaction_id;
        intent.suspect_usdt = v / 1e6;
        intent.suspect_at = new Date();
        await intent.save();
        telegram.systemAlert(
          `⚠️ <b>Crypto amount mismatch</b>\nClient <b>${intent.username}</b>${intent.target_invoice_number ? ' (' + intent.target_invoice_number + ')' : ''} — expected <b>${intent.usdt_str}</b> USDT, received <b>${(v / 1e6).toFixed(6)}</b> USDT.\nNot auto-credited. Review it in CRM → Crypto → "Accept tx", or it stays pending.\nTx: <code>${tx.transaction_id}</code>`
        ).catch(() => {});
        console.log(`[crypto] near-miss flagged on intent ${intent._id}: got ${(v / 1e6).toFixed(6)}, wanted ${intent.usdt_str}`);
      }
    }
    return { checked: pending.length, paid, expired: expired.modifiedCount || 0 };
  } finally {
    _running = false;
  }
}

// Operator accepts a flagged near-miss tx: verify it on-chain, then confirm the
// intent at the EUR value of what was actually received (proportional to rate).
async function acceptTx(intentId, txid) {
  const intent = await CryptoIntent.findById(intentId);
  if (!intent) throw new Error('intent not found');
  if (intent.status !== 'pending') throw new Error('intent is ' + intent.status);
  txid = String(txid || intent.suspect_txid || '').trim();
  if (!txid) throw new Error('no transaction to accept');
  const dup = await CryptoIntent.findOne({ txid, status: 'paid' });
  if (dup) throw new Error('this tx already paid another intent');
  const txs = await fetchIncoming(intent.wallet);
  const tx = txs.find((t) => t.transaction_id === txid);
  if (!tx) throw new Error('tx not found among confirmed incoming USDT transfers to this wallet');
  const usdtActual = Number(tx.value) / 1e6;
  const eurActual = db.round3(intent.eur * (usdtActual / intent.usdt)); // same effective rate the intent was priced at
  const r = await confirmIntent(intent, tx, eurActual);
  if (!r) throw new Error('could not confirm (invoice void or tx consumed)');
  return { ok: true, usdt_received: usdtActual, eur_recorded: eurActual };
}

function startWatcher(intervalMs = 30000) {
  const tick = () => checkIntents().catch((e) => console.error('[crypto] watcher:', e.message));
  setInterval(tick, intervalMs);
  setTimeout(tick, 5000); // first pass shortly after boot
  console.log(`[crypto] USDT TRC-20 watcher started (every ${intervalMs / 1000}s)`);
}

module.exports = { getRate, createIntent, intentForInvoice, intentForSettlement, checkIntents, acceptTx, startWatcher, USDT_TRC20_CONTRACT };
