#!/usr/bin/env bash
#
# restore.sh — restore the smpp_bridge MongoDB from a committed mongodump archive.
#
# Usage:
#   ./restore.sh                                  # restore the newest archive in this folder
#   ./restore.sh smpp_bridge-20260621.archive.gz  # restore a specific archive
#   MONGO_URI=mongodb://host:27017/dbname ./restore.sh [archive]
#
# Notes:
#   - By default restores into the SAME db the dump came from (smpp_bridge).
#   - --drop wipes each target collection before restoring (clean overwrite). The script
#     refuses to run without an explicit "yes" so you don't nuke a live DB by accident.
#   - Requires mongorestore (mongodb-database-tools) on PATH.
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017/smpp_bridge}"

# Pick the archive: first arg, or the newest *.archive.gz in this folder.
ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(ls -1t "$DIR"/*.archive.gz 2>/dev/null | head -1 || true)"
fi
# Allow passing just a filename (resolve relative to this folder).
if [ -n "$ARCHIVE" ] && [ ! -f "$ARCHIVE" ] && [ -f "$DIR/$ARCHIVE" ]; then
  ARCHIVE="$DIR/$ARCHIVE"
fi

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: no archive found. Pass one explicitly, e.g.:" >&2
  echo "  $0 smpp_bridge-YYYYMMDD.archive.gz" >&2
  exit 1
fi

if ! command -v mongorestore >/dev/null 2>&1; then
  echo "ERROR: mongorestore not found. Install mongodb-database-tools." >&2
  exit 1
fi

echo "Archive : $ARCHIVE"
echo "Target  : $MONGO_URI"
echo
echo "This will RESTORE with --drop (each restored collection is wiped first)."
read -r -p "Type 'yes' to proceed: " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }

mongorestore --uri="$MONGO_URI" --archive="$ARCHIVE" --gzip --drop

echo
echo "Done. Restart the services so they reconnect cleanly:"
echo "  systemctl restart smpp-bridge smpp-admin smpp-portal smpp-tgbot smpp-crm"
