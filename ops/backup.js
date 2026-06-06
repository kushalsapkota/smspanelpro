#!/usr/bin/env node
/**
 * ops/backup.js — nightly money-data backup, run by smpp-backup.timer (03:00 Nepal).
 *
 *   1. mongodump smpp_bridge → /root/backups/mongo/ (gzip archive)
 *   2. restore-verify the dump into smpp_bridge_verify and compare key counts
 *   3. tar the config that can't be re-derived (.env, routes.json, Caddyfile, crm/data, units)
 *   4. rotate (keep newest KEEP of each)
 *   5. write Setting 'backup_status' (shown in the nightly 🛡️ Telegram report) and
 *      send a Telegram alert IMMEDIATELY on failure.
 *
 * Run by hand any time:  node /root/bridge/ops/backup.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const telegram = require('../telegram');

const ROOT = '/root/backups';
const KEEP = 14;
const DB_NAME = 'smpp_bridge';
const VERIFY_DB = 'smpp_bridge_verify';

const human = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);

function rotate(dir, keep) {
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(keep)) fs.unlinkSync(f);
  return files.length;
}

(async () => {
  const status = { at: new Date(), ok: false, verified: false };
  try {
    await db.connect();
    fs.mkdirSync(path.join(ROOT, 'mongo'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
    fs.chmodSync(ROOT, 0o700);

    // 1. dump
    const dumpFile = path.join(ROOT, 'mongo', `${DB_NAME}-${stamp()}.gz`);
    execFileSync('mongodump', ['--db', DB_NAME, '--archive=' + dumpFile, '--gzip', '--quiet'], { timeout: 300000 });
    const size = fs.statSync(dumpFile).size;
    if (size < 10240) throw new Error('dump suspiciously small: ' + size + ' bytes');
    status.file = dumpFile; status.size = size; status.size_h = human(size);

    // 2. restore-verify into a scratch DB and compare the collections that ARE the money
    execFileSync('mongorestore', ['--archive=' + dumpFile, '--gzip', '--quiet', '--drop',
      `--nsFrom=${DB_NAME}.*`, `--nsTo=${VERIFY_DB}.*`], { timeout: 300000 });
    const vdb = db.mongoose.connection.useDb(VERIFY_DB);
    const counts = {};
    for (const col of ['users', 'credittransactions', 'payments', 'invoices', 'usageevents']) {
      const live = await db.mongoose.connection.db.collection(col).countDocuments();
      const dump = await vdb.collection(col).countDocuments();
      counts[col] = { live, dump };
      // usage/transactions keep flowing while we dump — allow drift; users/invoices barely move
      const tol = (col === 'users' || col === 'invoices') ? 2 : Math.max(20, live * 0.01);
      if (Math.abs(live - dump) > tol) throw new Error(`restore-verify mismatch on ${col}: live ${live} vs dump ${dump}`);
    }
    await vdb.dropDatabase();
    status.verified = true; status.counts = counts;

    // 3. config tar (everything not in Mongo that a rebuild would need)
    const cfgFile = path.join(ROOT, 'config', `config-${stamp()}.tgz`);
    const items = [
      '/root/bridge/.env', '/root/bridge/.admin-password.txt', '/root/bridge/crm/data',
      '/root/reverse-proxy/routes.json', '/root/reverse-proxy/admin-password.txt',
      '/etc/caddy/Caddyfile', '/etc/systemd/system/smpp-bridge.service', '/etc/systemd/system/smpp-admin.service',
      '/etc/systemd/system/smpp-portal.service', '/etc/systemd/system/smpp-crm.service',
      '/etc/systemd/system/smpp-tgbot.service', '/etc/systemd/system/smpp-backup.service',
      '/etc/systemd/system/smpp-backup.timer', '/etc/systemd/system/reverse-proxy.service',
    ].filter((p) => fs.existsSync(p));
    execFileSync('tar', ['czf', cfgFile, '--absolute-names', ...items], { timeout: 60000 });
    fs.chmodSync(cfgFile, 0o600);
    fs.chmodSync(dumpFile, 0o600);

    // 4. rotate
    rotate(path.join(ROOT, 'mongo'), KEEP);
    rotate(path.join(ROOT, 'config'), KEEP);

    status.ok = true;
    console.log(`[backup] OK ${dumpFile} (${status.size_h}, restore-verified) + ${path.basename(cfgFile)}`);
  } catch (e) {
    status.error = e.message;
    console.error('[backup] FAILED:', e.message);
    await telegram.systemAlert(`🚨 <b>BACKUP FAILED</b>\n${e.message}\nFix this — the money data is unprotected until backups work.`).catch(() => {});
  }
  try {
    await db.Setting.findOneAndUpdate({ key: 'backup_status' }, { $set: { value: status } }, { upsert: true });
  } catch (_) {}
  process.exit(status.ok ? 0 : 1);
})();
