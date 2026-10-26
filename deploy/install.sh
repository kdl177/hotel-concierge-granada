#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu/Debian VPS (Hetzner, DigitalOcean, OVH, Contabo…).
#
#   curl -fsSL https://raw.githubusercontent.com/kdl177/hotel-concierge-granada/main/deploy/install.sh | sudo bash
#   # or, inside a clone:  sudo bash deploy/install.sh
#
# What it does: installs Docker, clones (or updates) the project in /opt/concierge,
# writes a .env with a random session secret and admin password, picks the public
# address (your domain if you give one, otherwise <ip>.sslip.io so HTTPS works
# without buying anything), builds and starts the app behind Caddy with HTTPS,
# waits until it answers and prints the URLs and the one-time admin password.
#
# Non-interactive:  sudo env DOMAIN=concierge.hotel.com ADMIN_EMAIL=... bash deploy/install.sh   (also REPO=, DIR=)
set -euo pipefail

REPO="${REPO:-https://github.com/kdl177/hotel-concierge-granada.git}"
DIR="${DIR:-/opt/concierge}"
DRY_RUN="${DRY_RUN:-0}"   # 1 = write files, run no docker/apt (used by the test suite)

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || [ "$DRY_RUN" = 1 ] || die "run as root (sudo bash deploy/install.sh)"

# ---- 1. Docker ----
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  run sh -c 'curl -fsSL https://get.docker.com | sh'
fi
if [ "$DRY_RUN" != 1 ]; then
  docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (apt install docker-compose-plugin)"
fi

# ---- 2. Code ----
if [ -f "$(pwd)/docker-compose.yml" ] && [ -f "$(pwd)/server/app/main.js" ]; then
  DIR="$(pwd)"
  say "Using the project in $DIR"
elif [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  run git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  command -v git >/dev/null 2>&1 || run sh -c 'apt-get update -qq && apt-get install -y -qq git'
  run git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"
mkdir -p data/gtfs

# ---- 3. Address ----
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || curl -fsS -4 https://ifconfig.me 2>/dev/null || true)"
  if [ -t 0 ]; then
    printf '\nDomain pointing to this server (DNS A record), or Enter to use %s.sslip.io: ' "${IP:-<ip>}"
    read -r DOMAIN || true
  fi
  if [ -z "${DOMAIN:-}" ]; then
    [ -n "$IP" ] || die "could not detect the public IP; run again with DOMAIN=..."
    DOMAIN="$IP.sslip.io"
  fi
fi
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"

# ---- 4. .env (kept if it already exists; only missing keys are added) ----
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
[ -f .env ] || { cp .env.example .env; echo >> .env; }
setenv() { # key value — set or replace, uncommenting a "# KEY=" line if present
  if grep -qE "^#? ?$1=" .env; then
    sed -i -E "s|^#? ?$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
getenv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
NEW_PASSWORD=""
setenv DOMAIN "$DOMAIN"
setenv PUBLIC_URL "https://$DOMAIN"
setenv NODE_ENV production
setenv TRUST_PROXY "loopback, uniquelocal"
[ -n "$(getenv CONCIERGE_SECRET)" ] || setenv CONCIERGE_SECRET "$(rand 64)"
[ -n "$(getenv ADMIN_EMAIL)" ] || setenv ADMIN_EMAIL "${ADMIN_EMAIL:-admin@hotel.local}"
if [ -z "$(getenv ADMIN_PASSWORD)" ]; then NEW_PASSWORD="$(rand 14)"; setenv ADMIN_PASSWORD "$NEW_PASSWORD"; fi
chmod 600 .env

# ---- 5. Up ----
say "Building and starting (first time takes 2–4 minutes)"
run docker compose up -d --build
if [ "$DRY_RUN" != 1 ]; then
  for i in $(seq 1 60); do
    if docker compose exec -T concierge wget -qO- http://127.0.0.1:4180/api/h/default/config >/dev/null 2>&1; then break; fi
    sleep 3
    [ "$i" = 60 ] && { docker compose logs --tail=40 concierge; die "the app did not start; logs above"; }
  done
fi

# ---- 6. Backups: daily SQLite copy, 14 days kept ----
run install -m 755 deploy/backup.sh /usr/local/bin/concierge-backup
if [ "$DRY_RUN" != 1 ] && ! grep -q concierge-backup /etc/crontab 2>/dev/null; then
  echo "17 4 * * * root CONCIERGE_DIR=$DIR /usr/local/bin/concierge-backup >/dev/null 2>&1" >> /etc/crontab
fi

cat <<EOF

✓ Concierge is running.

  Guests (room QR codes point here):  https://$DOMAIN
  Reception:                          https://$DOMAIN/reception.html
  Admin:                              https://$DOMAIN/admin.html

  Admin login: $(getenv ADMIN_EMAIL)
EOF
if [ -n "$NEW_PASSWORD" ]; then
  echo "  Temporary password (shown once; you must change it at first sign-in): $NEW_PASSWORD"
else
  echo "  Password: the one already in $DIR/.env (or reset it: docker compose exec concierge npm run reset-password -- <email>)"
fi
cat <<EOF

  Project folder: $DIR      Update: sudo bash deploy/update.sh      Backup now: sudo concierge-backup
  Optional keys (Google, Cesium, SMTP): edit $DIR/.env and run: docker compose up -d
EOF
