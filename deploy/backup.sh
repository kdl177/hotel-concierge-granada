#!/usr/bin/env bash
# Copies the live SQLite database (consistent snapshot) and the uploaded photos
# to $CONCIERGE_DIR/backups/<date>/ and keeps the last 14 days.
#   sudo concierge-backup            (installed by deploy/install.sh, runs daily at 04:17)
set -euo pipefail
DIR="${CONCIERGE_DIR:-/opt/concierge}"
cd "$DIR"
stamp="$(date +%Y-%m-%d_%H%M)"
out="backups/$stamp"
mkdir -p "$out"
# sqlite3 .backup inside the container is atomic; the plain copy is the fallback.
docker compose exec -T concierge sh -c 'command -v sqlite3 >/dev/null && sqlite3 /data/concierge.sqlite ".backup /data/backup.tmp" || cp /data/concierge.sqlite /data/backup.tmp'
docker compose cp concierge:/data/backup.tmp "$out/concierge.sqlite"
docker compose exec -T concierge rm -f /data/backup.tmp
docker compose cp concierge:/data/uploads "$out/uploads" 2>/dev/null || true
tar -czf "backups/concierge-$stamp.tar.gz" -C backups "$stamp" && rm -rf "$out"
find backups -name 'concierge-*.tar.gz' -mtime +14 -delete
echo "backup written: $DIR/backups/concierge-$stamp.tar.gz"
