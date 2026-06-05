/**
 * dlrlog.js — permanent, file-based DLR / sending archive.
 *
 * Every dispatched message is appended as one JSON line to a monthly file:
 *   /root/bridge/data/dlr/YYYY-MM.jsonl
 *
 * Why files, not Mongo: this log grows unbounded (one line per SMS forever).
 * Keeping it out of MongoDB keeps the DB small + fast, and the plain-text
 * monthly files are trivially backed up (they're just included in the backup zip).
 *
 * append(rec)            — fire-and-forget, never throws into the hot path
 * query({from,to,username}) — read matching lines across the month files in range
 * months()               — list available YYYY-MM archives
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'dlr');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}

const fileFor = (d) => path.join(DIR, `${d.toISOString().slice(0, 7)}.jsonl`);

// Append one record. `at` is an ISO instant; the rest is compact on purpose.
function append(rec) {
  try {
    const at = rec.at ? new Date(rec.at) : new Date();
    const line = JSON.stringify({
      at: at.toISOString(),
      u: rec.username || '',
      to: rec.destination || '',
      mid: rec.message_id || '',
      parts: rec.parts || 1,
      cr: rec.credits || 0,
      rt: rec.route_name || '',
      st: rec.status || '',          // sent | failed
      dlr: rec.dlr_status || '',     // delivered | accepted | undelivered | rejected | expired | unknown | pending
      ps: rec.provider_status || '',
    }) + '\n';
    fs.appendFile(fileFor(at), line, () => {});
  } catch (_) { /* never break dispatch */ }
}

function monthsInRange(from, to) {
  const out = [];
  const a = new Date(from.getFullYear(), from.getMonth(), 1);
  const b = new Date(to.getFullYear(), to.getMonth(), 1);
  for (let d = a; d <= b; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Read + filter. Returns the raw records (expanded keys). Streams line-by-line
// so a huge month file never loads fully into memory at once.
async function query({ from, to, username } = {}) {
  const readline = require('readline');
  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to) : new Date();
  const uname = username ? String(username).toLowerCase() : null;
  const out = [];
  for (const m of monthsInRange(fromD, toD)) {
    const fp = path.join(DIR, `${m}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line) return;
        let r; try { r = JSON.parse(line); } catch (_) { return; }
        const t = new Date(r.at);
        if (t < fromD || t > toD) return;
        if (uname && (r.u || '').toLowerCase() !== uname) return;
        out.push({ at: r.at, username: r.u, destination: r.to, message_id: r.mid, parts: r.parts, credits: r.cr, route_name: r.rt, status: r.st, dlr_status: r.dlr, provider_status: r.ps });
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });
  }
  return out;
}

function months() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort(); }
  catch (_) { return []; }
}

module.exports = { append, query, months, DIR };
