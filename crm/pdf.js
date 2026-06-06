/**
 * crm/pdf.js — invoice / receipt / monthly-statement PDFs (pdfkit, streamed to the response).
 *
 * Company branding comes from Setting key 'crm' → value.company:
 *   { name, address, email, phone, vat, footer }
 */
const PDFDocument = require('pdfkit');

const INK = '#111827', MUTE = '#6b7280', LINE = '#e5e7eb', ACCENT = '#0e7490';
const eur = (n) => 'EUR ' + Number(n || 0).toFixed(2);
const eur3 = (n) => 'EUR ' + Number(n || 0).toFixed(3);
const fdate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';

function open(res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

// Company header + document title block. Returns the y where content may start.
// If company.logoPath is set (PNG/JPEG on disk), it renders above the name.
function header(doc, company, title, meta) {
  let y = 50;
  if (company.logoPath) {
    try { doc.image(company.logoPath, 50, y, { fit: [170, 48] }); y += 56; } catch (_) { /* corrupt image → text-only header */ }
  }
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(company.logoPath ? 13 : 20).text(company.name || 'SMS Services', 50, y);
  y += company.logoPath ? 18 : 26;
  doc.fillColor(MUTE).font('Helvetica').fontSize(9);
  const lines = [company.address, [company.email, company.phone].filter(Boolean).join(' · '), company.vat ? 'VAT: ' + company.vat : '']
    .filter(Boolean);
  for (const l of lines) { doc.text(l, 50, y); y += 12; }

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(24).text(title, 320, 50, { width: 225, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTE);
  let my = 82;
  for (const [k, v] of meta) {
    doc.text(k, 320, my, { width: 120, align: 'right' });
    doc.fillColor(INK).text(String(v), 445, my, { width: 100, align: 'right' });
    doc.fillColor(MUTE);
    my += 14;
  }
  const top = Math.max(y, my) + 16;
  doc.moveTo(50, top).lineTo(545, top).strokeColor(LINE).lineWidth(1).stroke();
  return top + 14;
}

function billTo(doc, y, clientName, profile) {
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('BILLED TO', 50, y);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(profile.company || clientName, 50, y + 14);
  doc.font('Helvetica').fontSize(9).fillColor(MUTE);
  let yy = y + 30;
  const lines = [
    profile.contact_name && profile.contact_name !== (profile.company || clientName) ? profile.contact_name : '',
    'Account: ' + clientName,
    profile.address, profile.country, profile.email,
    profile.vat_id ? 'VAT: ' + profile.vat_id : '',
  ].filter(Boolean);
  for (const l of lines) { doc.text(l, 50, yy); yy += 12; }
  return yy + 10;
}

function stamp(doc, text, color) {
  doc.save().rotate(-12, { origin: [460, 150] });
  doc.font('Helvetica-Bold').fontSize(26).fillColor(color).opacity(0.55)
    .text(text, 380, 136, { width: 160, align: 'center' });
  doc.opacity(1).restore();
}

function tableHead(doc, y, cols) {
  doc.rect(50, y, 495, 20).fill('#f3f4f6');
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8.5);
  for (const c of cols) doc.text(c.label, c.x, y + 6, { width: c.w, align: c.align || 'left' });
  return y + 24;
}

function row(doc, y, cols, vals, bold) {
  doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  let h = 14;
  cols.forEach((c, i) => {
    const opts = { width: c.w, align: c.align || 'left' };
    h = Math.max(h, doc.heightOfString(String(vals[i]), opts) + 4);
    doc.text(String(vals[i]), c.x, y, opts);
  });
  return y + h;
}

function footerNote(doc, company) {
  if (company.footer) {
    doc.fontSize(8.5).fillColor(MUTE)
      .text(company.footer, 50, 770, { width: 495, align: 'center' });
  }
}

// ---------------------------------------------------------------------------
// Invoice / receipt
// ---------------------------------------------------------------------------
function invoicePdf(res, inv, profile, company, payments = [], cryptoPay = null) {
  const isReceipt = inv.type === 'receipt';
  const doc = open(res, `${inv.number}.pdf`);
  const meta = [
    ['Number', inv.number],
    ['Issued', fdate(inv.issued_date || inv.createdAt)],
  ];
  if (!isReceipt && inv.due_date) meta.push(['Due', fdate(inv.due_date)]);
  let y = header(doc, company, isReceipt ? 'RECEIPT' : 'INVOICE', meta);
  y = billTo(doc, y, inv.client_username, profile || {});

  if (inv.status === 'paid' || isReceipt) stamp(doc, 'PAID', '#15803d');
  else if (inv.status === 'void') stamp(doc, 'VOID', '#6b7280');
  else if (inv.due_date && new Date(inv.due_date) < new Date()) stamp(doc, 'OVERDUE', '#b91c1c');

  const cols = [
    { label: 'DESCRIPTION', x: 56, w: 270 },
    { label: 'QTY', x: 330, w: 50, align: 'right' },
    { label: 'UNIT PRICE', x: 385, w: 70, align: 'right' },
    { label: 'AMOUNT', x: 460, w: 80, align: 'right' },
  ];
  y = tableHead(doc, y, cols);
  for (const it of (inv.items || [])) {
    y = row(doc, y, cols, [it.description || '', it.qty, eur3(it.unit_price), eur(it.amount)]);
    doc.moveTo(50, y - 2).lineTo(545, y - 2).strokeColor(LINE).lineWidth(0.5).stroke();
    y += 4;
  }

  y += 8;
  const trow = (label, val, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? INK : MUTE).text(label, 330, y, { width: 120, align: 'right' })
      .fillColor(INK).text(val, 455, y, { width: 85, align: 'right' });
    y += bold ? 18 : 15;
  };
  trow('Subtotal', eur(inv.subtotal));
  if (inv.tax) trow('Tax', eur(inv.tax));
  trow('Total', eur(inv.total), true);
  if (!isReceipt) {
    if (inv.paid) trow('Paid', eur(inv.paid));
    if (inv.status !== 'paid' && inv.status !== 'void') trow('Balance due', eur(Math.max(0, inv.total - (inv.paid || 0))), true);
  }

  if (payments.length) {
    y += 12;
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('PAYMENTS RECEIVED', 50, y); y += 14;
    const pcols = [
      { label: 'DATE', x: 56, w: 80 },
      { label: 'METHOD', x: 140, w: 90 },
      { label: 'REFERENCE', x: 235, w: 215 },
      { label: 'AMOUNT', x: 460, w: 80, align: 'right' },
    ];
    y = tableHead(doc, y, pcols);
    for (const p of payments) y = row(doc, y, pcols, [fdate(p.createdAt), p.method, p.reference || '—', eur(p.amount)]);
  }

  // "How to pay" box with the operator's wallet + this invoice's unique USDT amount.
  // The exact amount is what identifies the invoice on-chain (auto-reconciliation).
  if (cryptoPay && inv.status !== 'paid' && inv.status !== 'void') {
    y += 16;
    const boxH = 96;
    const hasQr = !!cryptoPay.qr;
    const textW = hasQr ? 370 : 470;
    doc.roundedRect(50, y, 495, boxH, 8).fillAndStroke('#f0fdfa', '#99f6e4');
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10).text('PAY WITH USDT  (TRC-20 / TRON network)', 64, y + 12);
    doc.fillColor(INK).font('Helvetica').fontSize(9)
      .text('Send exactly', 64, y + 30, { continued: true })
      .font('Helvetica-Bold').text(`  ${cryptoPay.usdt_str} USDT  `, { continued: true })
      .font('Helvetica').text('to:');
    doc.font('Courier-Bold').fontSize(10.5).fillColor(INK).text(cryptoPay.wallet, 64, y + 46);
    doc.font('Helvetica').fontSize(8).fillColor(MUTE)
      .text('Scan the QR with your wallet app (Binance / TronLink) to fill the address, then enter the exact amount above — '
        + 'it identifies this invoice and confirms it automatically within minutes. TRC-20 network only. Valid until '
        + fdate(cryptoPay.expires_at) + '.', 64, y + 64, { width: textW });
    if (hasQr) {
      try { doc.image(cryptoPay.qr, 462, y + 11, { fit: [74, 74] }); } catch (_) {}
    }
    y += boxH;
  }

  if (inv.note) {
    y += 14;
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('Note: ' + inv.note, 50, y, { width: 495 });
  }
  footerNote(doc, company);
  doc.end();
}

// ---------------------------------------------------------------------------
// Monthly statement
// data: { username, profile, period:'YYYY-MM', opening, closing, payments:[],
//         usage:[{day,count,parts,credits}], usageTotal:{parts,credits,count}, topupTotal }
// ---------------------------------------------------------------------------
function statementPdf(res, data, company) {
  const doc = open(res, `statement-${data.username}-${data.period}.pdf`);
  let y = header(doc, company, 'STATEMENT', [
    ['Period', data.period],
    ['Account', data.username],
    ['Generated', fdate(new Date())],
  ]);
  y = billTo(doc, y, data.username, data.profile || {});

  // summary band
  doc.rect(50, y, 495, 54).fill('#f0fdfa');
  const cell = (label, val, x) => {
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8).text(label, x, y + 10, { width: 115, align: 'center' });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(val, x, y + 26, { width: 115, align: 'center' });
  };
  cell('OPENING BALANCE', eur3(data.opening), 55);
  cell('TOP-UPS', eur(data.topupTotal), 178);
  cell('SMS USAGE', '-' + eur3(data.usageTotal.credits), 301);
  cell('CLOSING BALANCE', eur3(data.closing), 424);
  y += 70;

  if (data.payments.length) {
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('PAYMENTS / TOP-UPS', 50, y); y += 14;
    const pcols = [
      { label: 'DATE', x: 56, w: 80 },
      { label: 'METHOD', x: 140, w: 90 },
      { label: 'REFERENCE', x: 235, w: 215 },
      { label: 'AMOUNT', x: 460, w: 80, align: 'right' },
    ];
    y = tableHead(doc, y, pcols);
    for (const p of data.payments) y = row(doc, y, pcols, [fdate(p.createdAt), p.method, p.reference || '—', eur(p.amount)]);
    y = row(doc, y + 2, pcols, ['', '', 'Total', eur(data.topupTotal)], true) + 10;
  }

  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('SMS USAGE BY DAY', 50, y); y += 14;
  const ucols = [
    { label: 'DATE', x: 56, w: 90 },
    { label: 'MESSAGES', x: 200, w: 90, align: 'right' },
    { label: 'SEGMENTS', x: 300, w: 90, align: 'right' },
    { label: 'CHARGED', x: 430, w: 110, align: 'right' },
  ];
  y = tableHead(doc, y, ucols);
  if (!data.usage.length) {
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('No sends in this period.', 56, y); y += 16;
  }
  for (const u of data.usage) {
    if (y > 720) { doc.addPage(); y = 50; y = tableHead(doc, y, ucols); }
    y = row(doc, y, ucols, [u.day, u.count, u.parts, eur3(u.credits)]);
  }
  y = row(doc, y + 2, ucols, ['Total', data.usageTotal.count, data.usageTotal.parts, eur3(data.usageTotal.credits)], true);

  footerNote(doc, company);
  doc.end();
}

// ---------------------------------------------------------------------------
// Postpaid settlement statement (pay-day): period usage + payments + AMOUNT DUE,
// with the optional USDT pay box (exact-amount auto-confirm, like invoices).
// data: { username, profile, from, to, opening, closing, due,
//         usage:[{day,count,parts,credits}], usageTotal:{...}, payments:[], topupTotal }
// ---------------------------------------------------------------------------
function settlementPdf(res, data, company, cryptoPay = null) {
  const doc = open(res, `settlement-${data.username}-${fdate(data.to)}.pdf`);
  let y = header(doc, company, 'SETTLEMENT', [
    ['From', fdate(data.from)],
    ['To', fdate(data.to)],
    ['Account', data.username],
  ]);
  y = billTo(doc, y, data.username, data.profile || {});

  if (!(data.due > 0)) stamp(doc, 'SETTLED', '#15803d');

  // summary band — AMOUNT DUE is the number that matters
  doc.rect(50, y, 495, 54).fill(data.due > 0 ? '#fef2f2' : '#f0fdfa');
  const cell = (label, val, x, hot) => {
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8).text(label, x, y + 10, { width: 115, align: 'center' });
    doc.fillColor(hot ? '#b91c1c' : INK).font('Helvetica-Bold').fontSize(12).text(val, x, y + 26, { width: 115, align: 'center' });
  };
  cell('OPENING BALANCE', eur3(data.opening), 55);
  cell('SMS CHARGES', '-' + eur3(data.usageTotal.credits), 178);
  cell('PAYMENTS', eur(data.topupTotal), 301);
  cell('AMOUNT DUE', eur(data.due), 424, data.due > 0);
  y += 70;

  if (data.payments.length) {
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('PAYMENTS RECEIVED', 50, y); y += 14;
    const pcols = [
      { label: 'DATE', x: 56, w: 80 },
      { label: 'METHOD', x: 140, w: 90 },
      { label: 'REFERENCE', x: 235, w: 215 },
      { label: 'AMOUNT', x: 460, w: 80, align: 'right' },
    ];
    y = tableHead(doc, y, pcols);
    for (const p of data.payments) y = row(doc, y, pcols, [fdate(p.createdAt), p.method, p.reference || '—', eur(p.amount)]);
    y += 8;
  }

  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9).text('SMS USAGE BY DAY', 50, y); y += 14;
  const ucols = [
    { label: 'DATE', x: 56, w: 90 },
    { label: 'MESSAGES', x: 200, w: 90, align: 'right' },
    { label: 'SEGMENTS', x: 300, w: 90, align: 'right' },
    { label: 'CHARGED', x: 430, w: 110, align: 'right' },
  ];
  y = tableHead(doc, y, ucols);
  if (!data.usage.length) {
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('No sends in this period.', 56, y); y += 16;
  }
  for (const u of data.usage) {
    if (y > 700) { doc.addPage(); y = 50; y = tableHead(doc, y, ucols); }
    y = row(doc, y, ucols, [u.day, u.count, u.parts, eur3(u.credits)]);
  }
  y = row(doc, y + 2, ucols, ['Total', data.usageTotal.count, data.usageTotal.parts, eur3(data.usageTotal.credits)], true) + 10;

  // USDT pay box (same auto-confirm mechanism as invoices)
  if (cryptoPay && data.due > 0) {
    if (y > 650) { doc.addPage(); y = 50; }
    const boxH = 96;
    const hasQr = !!cryptoPay.qr;
    const textW = hasQr ? 370 : 470;
    doc.roundedRect(50, y, 495, boxH, 8).fillAndStroke('#f0fdfa', '#99f6e4');
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10).text('PAY WITH USDT  (TRC-20 / TRON network)', 64, y + 12);
    doc.fillColor(INK).font('Helvetica').fontSize(9)
      .text('Send exactly', 64, y + 30, { continued: true })
      .font('Helvetica-Bold').text(`  ${cryptoPay.usdt_str} USDT  `, { continued: true })
      .font('Helvetica').text('to:');
    doc.font('Courier-Bold').fontSize(10.5).fillColor(INK).text(cryptoPay.wallet, 64, y + 46);
    doc.font('Helvetica').fontSize(8).fillColor(MUTE)
      .text('Scan the QR with your wallet app (Binance / TronLink) to fill the address, then enter the exact amount above — '
        + 'it identifies your account and confirms automatically within minutes. TRC-20 network only. Valid until '
        + fdate(cryptoPay.expires_at) + '.', 64, y + 64, { width: textW });
    if (hasQr) {
      try { doc.image(cryptoPay.qr, 462, y + 11, { fit: [74, 74] }); } catch (_) {}
    }
  }

  footerNote(doc, company);
  doc.end();
}

module.exports = { invoicePdf, statementPdf, settlementPdf };
