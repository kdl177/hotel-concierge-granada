#!/usr/bin/env bash
# Pulls the latest code and rebuilds without losing data (.env, database, photos stay).
#   sudo bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x /usr/local/bin/concierge-backup ] && CONCIERGE_DIR="$(pwd)" /usr/local/bin/concierge-backup || true
git pull --ff-only
docker compose up -d --build
docker compose ps
