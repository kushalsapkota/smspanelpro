/**
 * crm/imap.js — inbound email over IMAP (read / search / attachments) + "save to Sent".
 *
 * Reuses the same mailbox credentials configured for SMTP in Setting key 'crm' → value.smtp.
 * The IMAP host defaults to the SMTP host with the leading "smtp." swapped for "imap."
 * (Hostinger: smtp.hostinger.com → imap.hostinger.com), or set value.smtp.imap_host to override.
 *
 * A fresh connection is opened per operation and closed after — simple and robust for the
 * low volume an operator inbox sees; no long-lived pool to leak or go stale.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../db');

async function imapCfg() {
  const s = await db.Setting.findOne({ key: 'crm' });
  const sm = (s && s.value && s.value.smtp) || {};
  if (!sm.user || !sm.pass) throw new Error('Email not configured — set SMTP/mailbox credentials in Settings → Email');
  const host = sm.imap_host || String(sm.host || '').replace(/^smtp\./, 'imap.') || 'imap.hostinger.com';
  return { host, port: Number(sm.imap_port) || 993, secure: true, user: sm.user, pass: sm.pass };
}

async function withClient(fn, mailbox) {
  const cfg = await imapCfg();
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false, emitLogs: false,
    socketTimeout: 30000, greetingTimeout: 10000, connectionTimeout: 15000,
  });
  await client.connect();
  let lock;
  try {
    if (mailbox) lock = await client.getMailboxLock(mailbox);
    return await fn(client);
  } finally {
    if (lock) lock.release();
    await client.logout().catch(() => {});
  }
}

const addr = (a) => (a && a[0]) ? { name: a[0].name || '', address: a[0].address || '' } : { name: '', address: '' };
const addrs = (a) => (a || []).map((x) => ({ name: x.name || '', address: x.address || '' }));

// Does a bodyStructure tree contain a real attachment (disposition attachment, or a non-text leaf)?
function hasAttachment(node) {
  if (!node) return false;
  if (node.childNodes && node.childNodes.length) return node.childNodes.some(hasAttachment);
  const disp = (node.disposition || '').toLowerCase();
  if (disp === 'attachment') return true;
  const type = (node.type || '').toLowerCase();
  return !!(node.dispositionParameters && node.dispositionParameters.filename) ||
         !!(node.parameters && node.parameters.name) ||
         (type && !type.startsWith('text/') && !type.startsWith('multipart/'));
}

// List mailboxes with a friendly role derived from IMAP special-use flags.
async function folders() {
  return withClient(async (client) => {
    const list = await client.list();
    const roleOf = (b) => {
      const u = (b.specialUse || '').toLowerCase();
      if (u.includes('sent')) return 'sent';
      if (u.includes('draft')) return 'drafts';
      if (u.includes('junk')) return 'junk';
      if (u.includes('trash')) return 'trash';
      if (u.includes('archive')) return 'archive';
      if (b.path.toUpperCase() === 'INBOX') return 'inbox';
      return 'folder';
    };
    return list.filter((b) => !b.flags || !b.flags.has('\\Noselect')).map((b) => ({
      path: b.path, name: b.name, role: roleOf(b), subscribed: b.subscribed !== false,
    }));
  });
}

// Page through a mailbox newest-first. `search` (optional) runs an IMAP TEXT search first.
async function list({ folder = 'INBOX', page = 1, limit = 30, search = '' } = {}) {
  return withClient(async (client) => {
    const exists = client.mailbox.exists;
    let seqs;            // sequence numbers to show, newest first
    let total;
    if (search && search.trim()) {
      const found = await client.search({ or: [{ subject: search }, { from: search }, { body: search }, { to: search }] }, { uid: false });
      const all = (found || []).slice().sort((a, b) => b - a);
      total = all.length;
      seqs = all.slice((page - 1) * limit, (page - 1) * limit + limit);
    } else {
      total = exists;
      const hi = Math.max(0, exists - (page - 1) * limit);
      const lo = Math.max(1, hi - limit + 1);
      seqs = [];
      for (let i = hi; i >= lo; i--) seqs.push(i);
    }
    const messages = [];
    if (seqs.length) {
      for await (const m of client.fetch(seqs, { uid: true, envelope: true, flags: true, bodyStructure: true, size: true })) {
        messages.push({
          uid: m.uid, seq: m.seq,
          from: addr(m.envelope.from), to: addrs(m.envelope.to),
          subject: m.envelope.subject || '(no subject)',
          date: m.envelope.date, size: m.size,
          seen: m.flags.has('\\Seen'), flagged: m.flags.has('\\Flagged'), answered: m.flags.has('\\Answered'),
          hasAttachment: hasAttachment(m.bodyStructure),
          messageId: m.envelope.messageId || '',
        });
      }
      messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    return { folder, page, limit, total, messages };
  }, folder);
}

// Full parsed message; marks it \Seen. Attachments are returned as metadata only (index + meta);
// fetch the bytes via download().
async function message({ folder = 'INBOX', uid }) {
  return withClient(async (client) => {
    const dl = await client.download(String(uid), undefined, { uid: true });
    if (!dl) throw new Error('message not found');
    const parsed = await simpleParser(dl.content);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
    const attachments = (parsed.attachments || []).map((a, i) => ({
      index: i, filename: a.filename || ('attachment-' + (i + 1)),
      contentType: a.contentType, size: a.size, contentId: a.contentId || null,
      inline: a.contentDisposition === 'inline',
    }));
    const oneAddr = (a) => a ? (a.value || []).map((v) => ({ name: v.name || '', address: v.address || '' })) : [];
    return {
      uid: Number(uid), folder,
      from: oneAddr(parsed.from)[0] || { name: '', address: '' },
      to: oneAddr(parsed.to), cc: oneAddr(parsed.cc),
      subject: parsed.subject || '(no subject)',
      date: parsed.date, messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '', references: parsed.references || '',
      html: parsed.html || null, text: parsed.text || '', textAsHtml: parsed.textAsHtml || '',
      attachments,
    };
  }, folder);
}

// Stream one attachment's bytes (re-parses the source; fine at operator volume).
async function download({ folder = 'INBOX', uid, index }) {
  return withClient(async (client) => {
    const dl = await client.download(String(uid), undefined, { uid: true });
    if (!dl) throw new Error('message not found');
    const parsed = await simpleParser(dl.content);
    const a = (parsed.attachments || [])[Number(index)];
    if (!a) throw new Error('attachment not found');
    return { filename: a.filename || ('attachment-' + (Number(index) + 1)), contentType: a.contentType || 'application/octet-stream', content: a.content };
  }, folder);
}

async function setFlag({ folder = 'INBOX', uid, flag, on }) {
  return withClient(async (client) => {
    const fn = on ? 'messageFlagsAdd' : 'messageFlagsRemove';
    await client[fn](String(uid), [flag], { uid: true });
    return { ok: true };
  }, folder);
}

// Move a message to a target folder (default: Trash) — used for delete.
async function moveTo({ folder = 'INBOX', uid, target }) {
  return withClient(async (client) => {
    let dest = target;
    if (!dest) {
      const list = await client.list();
      const trash = list.find((b) => (b.specialUse || '').toLowerCase().includes('trash'));
      dest = trash ? trash.path : 'INBOX.Trash';
    }
    await client.messageMove(String(uid), dest, { uid: true });
    return { ok: true, dest };
  }, folder);
}

// Append a raw RFC822 buffer (a sent copy) to the Sent folder, flagged \Seen.
async function appendToSent(raw) {
  return withClient(async (client) => {
    const list = await client.list();
    const sent = list.find((b) => (b.specialUse || '').toLowerCase().includes('sent'));
    const dest = sent ? sent.path : 'INBOX.Sent';
    await client.append(dest, raw, ['\\Seen']);
    return { ok: true, dest };
  });
}

// Unread count for the INBOX (cheap, for the nav badge).
async function unreadCount(folder = 'INBOX') {
  return withClient(async (client) => {
    const ids = await client.search({ seen: false }, { uid: true });
    return { unread: (ids || []).length };
  }, folder);
}

module.exports = { folders, list, message, download, setFlag, moveTo, appendToSent, unreadCount, imapCfg };
