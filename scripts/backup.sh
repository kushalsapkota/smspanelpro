#!/usr/bin/env bash
# backup.sh — full-system disaster-recovery backup of the SMS panel.
# Produces ONE tar.gz containing: the Mongo database, all app code (no
# node_modules), .env secrets, the file-based DLR archive, the Caddy + systemd
# config, and a restore.sh that rebuilds the whole stack on a fresh server.
#
#   bash scripts/backup.sh [OUTPUT_DIR]    (default /root/backups)
set -euo pipefail

OUT_DIR="${1:-/root/backups}"
MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017/smpp_bridge}"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="sms-backup-${TS}"
STAGE="$(mktemp -d)/${NAME}"
mkdir -p "$STAGE" "$OUT_DIR"

echo "[backup] staging in $STAGE"

# 1) database (gzip'd archive)
echo "[backup] dumping MongoDB…"
mongodump --uri "$MONGO_URI" --archive="$STAGE/db.archive" --gzip --quiet

# 2) app code (exclude node_modules / .git via a tar pipe — no rsync needed)
echo "[backup] copying app code…"
tar -C /root -cf - --exclude='bridge/node_modules' --exclude='bridge/.git' bridge | tar -C "$STAGE" -xf -
if [ -d /root/reverse-proxy ]; then
  tar -C /root -cf - --exclude='reverse-proxy/node_modules' reverse-proxy | tar -C "$STAGE" -xf -
fi

# 3) system config (Caddy + all systemd units)
mkdir -p "$STAGE/etc/caddy" "$STAGE/etc/systemd/system"
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "$STAGE/etc/caddy/Caddyfile" || true
for u in smpp-bridge smpp-admin smpp-portal smpp-crm smpp-tgbot reverse-proxy caddy smpp-cyd-flasher; do
  [ -f "/etc/systemd/system/${u}.service" ] && cp "/etc/systemd/system/${u}.service" "$STAGE/etc/systemd/system/" || true
done

# 4) manifest
cat > "$STAGE/MANIFEST.txt" <<EOF
SMS panel backup
created:   $(date -u +"%Y-%m-%d %H:%M:%S UTC")
host:      $(hostname)
node:      $(node -v 2>/dev/null || echo '?')
mongo db:  $MONGO_URI
includes:  database (db.archive), app code (bridge + reverse-proxy, no node_modules),
           .env secrets, DLR file archive (bridge/data/dlr), Caddyfile, systemd units
restore:   bash restore.sh   (run as root on a fresh Ubuntu box)
EOF

# 5) the restore script (bundled inside the archive)
cat > "$STAGE/restore.sh" <<'RESTORE'
#!/usr/bin/env bash
# restore.sh — rebuild the SMS panel from this backup. Run as root.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== SMS panel restore ==="

need() { command -v "$1" >/dev/null 2>&1; }
MISSING=""
need node    || MISSING="$MISSING node"
need npm     || MISSING="$MISSING npm"
need mongod  || MISSING="$MISSING mongodb-server"
need mongorestore || MISSING="$MISSING mongodb-database-tools"
need caddy   || MISSING="$MISSING caddy"
if [ -n "$MISSING" ]; then
  echo "!! Please install first:$MISSING"
  echo "   (node 20+, mongodb, mongodb-database-tools, caddy) — then re-run this script."
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
for d in bridge reverse-proxy; do
  if [ -d "/root/$d" ]; then echo "-- backing up existing /root/$d -> /root/$d.pre-restore.$stamp"; mv "/root/$d" "/root/$d.pre-restore.$stamp"; fi
  if [ -d "$HERE/$d" ]; then cp -a "$HERE/$d" "/root/$d"; fi
done

echo "-- installing dependencies…"
( cd /root/bridge && npm install --no-audit --no-fund )
[ -d /root/reverse-proxy ] && ( cd /root/reverse-proxy && npm install --no-audit --no-fund ) || true

echo "-- restoring database…"
mongorestore --drop --gzip --archive="$HERE/db.archive"

echo "-- installing system config…"
mkdir -p /etc/caddy
[ -f "$HERE/etc/caddy/Caddyfile" ] && cp "$HERE/etc/caddy/Caddyfile" /etc/caddy/Caddyfile || true
cp "$HERE"/etc/systemd/system/*.service /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload

echo "-- enabling + starting services…"
systemctl enable --now mongod 2>/dev/null || true
for s in smpp-bridge smpp-admin smpp-portal smpp-crm smpp-tgbot reverse-proxy caddy; do
  systemctl enable --now "$s" 2>/dev/null && echo "   started $s" || echo "   (skipped $s)"
done

echo ""
echo "=== Restore complete. ==="
echo "Check: systemctl status smpp-crm caddy"
echo "Reminder: point your DNS (crm.bhairavsms.org -> this server's IP) and update PUBLIC_HOST in /root/bridge/.env if the IP changed."
RESTORE
chmod +x "$STAGE/restore.sh"

# 6) tar it up
OUT="$OUT_DIR/${NAME}.tar.gz"
tar -C "$(dirname "$STAGE")" -czf "$OUT" "$NAME"
rm -rf "$(dirname "$STAGE")"
chmod 600 "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] done: $OUT ($SIZE)"
echo "$OUT"
