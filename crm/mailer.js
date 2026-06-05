/**
 * crm/mailer.js — outbound email via SMTP (e.g. Hostinger).
 *
 * Config lives in Setting key 'crm' → value.smtp:
 *   { host, port, secure, user, pass, from, from_name }
 * Hostinger: host smtp.hostinger.com, port 465 secure:true (or 587 secure:false),
 * user = your full mailbox address, pass = mailbox password.
 *
 * Used to email receipts / invoices / statements (PDF attached) and overdue
 * reminders. Safe no-op + clear error when SMTP isn't configured yet.
 */
const nodemailer = require('nodemailer');
const db = require('../db');

async function smtpConfig() {
  const s = await db.Setting.findOne({ key: 'crm' });
  return (s && s.value && s.value.smtp) || {};
}

function buildTransport(cfg) {
  if (!cfg.host || !cfg.user || !cfg.pass) throw new Error('SMTP not configured — set it in CRM Settings → Email');
  const port = Number(cfg.port) || 465;
  return nodemailer.createTransport({
    host: cfg.host,
    port,
    secure: cfg.secure != null ? !!cfg.secure : port === 465, // 465 = implicit TLS
    auth: { user: cfg.user, pass: cfg.pass },
    // Without these nodemailer waits forever on a stalled SMTP server → the
    // "Test connection" button spins indefinitely. Fail fast with a clear error.
    connectionTimeout: 15000, // TCP connect
    greetingTimeout: 10000,   // wait for the server 220 banner
    socketTimeout: 20000,     // inactivity once connected (DATA stalls, greylisting)
  });
}

// Pull a bare email out of whatever was typed (handles "Name <a@b.com>", a bare
// address, or stray spaces) so we never build a malformed MAIL FROM envelope.
function pickAddress(s) {
  const m = String(s || '').match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/);
  return m ? m[0] : '';
}

// Returns nodemailer's structured from ({name, address}) so nodemailer does the
// quoting and the envelope sender is always a clean bare address.
function fromField(cfg) {
  const address = pickAddress(cfg.from) || pickAddress(cfg.user);
  if (!address) throw new Error('No valid From/username email address configured');
  const name = (cfg.from_name || '').trim();
  return name ? { name, address } : { address };
}

// Common message shape → nodemailer mail object (used for both real send and raw build).
function mailObject(cfg, msg) {
  const m = {
    from: fromField(cfg),
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: msg.attachments || [],
  };
  if (msg.cc) m.cc = msg.cc;
  if (msg.replyTo) m.replyTo = msg.replyTo;
  if (msg.inReplyTo) m.inReplyTo = msg.inReplyTo;
  if (msg.references) m.references = msg.references;
  return m;
}

/**
 * send({ to, subject, text, html, attachments, cc, inReplyTo, references, replyTo })
 *   attachments: [{ filename, content(Buffer) }]
 */
async function send(msg) {
  const cfg = await smtpConfig();
  const tx = buildTransport(cfg);
  return tx.sendMail(mailObject(cfg, msg));
}

// Build the raw RFC822 bytes for a message WITHOUT sending — used to save a copy
// to the IMAP "Sent" folder so the worksuite's Sent view stays accurate.
function buildRaw(msg) {
  return smtpConfig().then((cfg) => new Promise((resolve, reject) => {
    const tx = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });
    tx.sendMail(mailObject(cfg, msg), (err, info) => err ? reject(err) : resolve(info.message));
  }));
}

// Verify the SMTP login works (used by the "Test connection" button).
async function verify() {
  const cfg = await smtpConfig();
  const tx = buildTransport(cfg);
  await tx.verify();
  return { ok: true, host: cfg.host, user: cfg.user };
}

async function isConfigured() {
  const cfg = await smtpConfig();
  return !!(cfg.host && cfg.user && cfg.pass);
}

module.exports = { send, verify, isConfigured, smtpConfig, buildRaw, fromField };
