#!/usr/bin/env bash
# Restores a backup made by backup.sh:  sudo bash deploy/restore.sh backups/concierge-2026-10-26_0417.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "usage: restore.sh <backups/concierge-*.tar.gz>"; exit 1; }
tmp="$(mktemp -d)"; tar -xzf "$1" -C "$tmp"; src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
docker compose stop concierge
docker compose cp "$src/concierge.sqlite" concierge:/data/concierge.sqlite
[ -d "$src/uploads" ] && docker compose cp "$src/uploads" concierge:/data/uploads || true
docker compose start concierge
rm -rf "$tmp"; echo "restored $1"
