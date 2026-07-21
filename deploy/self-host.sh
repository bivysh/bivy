#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DOMAIN="${1:-${CP_DOMAIN:-}}"
RELAY_DOMAIN="${2:-${RELAY_DOMAIN:-}}"

usage() {
  cat <<'EOF'
Usage: bash deploy/self-host.sh <app-domain> <relay-domain>

Example:
  bash deploy/self-host.sh app.example.com relay.example.com

Prereqs:
  - Docker + docker compose plugin
  - DNS A/AAAA records for both domains pointing at this host
  - ports 80 and 443 open

The script writes deploy/.env and deploy/Caddyfile if they do not already exist,
then starts Postgres + control-plane + relay + Caddy.
EOF
}

if [[ "${APP_DOMAIN}" == "" || "${RELAY_DOMAIN}" == "" || "${APP_DOMAIN}" == "-h" || "${APP_DOMAIN}" == "--help" ]]; then
  usage
  exit 1
fi

normalize_domain() {
  printf '%s' "$1" | perl -pe 's#^https?://##i; s#/.*$##; s#\s+##g#'
}

APP_DOMAIN="$(normalize_domain "${APP_DOMAIN}")"
RELAY_DOMAIN="$(normalize_domain "${RELAY_DOMAIN}")"

if [[ "${APP_DOMAIN}" == "" || "${RELAY_DOMAIN}" == "" ]]; then
  echo "Both domains must be non-empty after normalization." >&2
  exit 1
fi

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else node -e "console.log(require('node:crypto').randomBytes(Number(process.argv[1])).toString('base64'))" "$1"
  fi
}

cd "${ROOT}"
mkdir -p deploy

if [[ ! -f deploy/.env ]]; then
  RELAY_SECRET="$(rand 48)"
  POSTGRES_PASSWORD="$(rand 32)"
  cat > deploy/.env <<EOF
NODE_ENV=production
PUBLIC_CONTROL_PLANE_URL=https://${APP_DOMAIN}
RELAY_PUBLIC_URL=wss://${RELAY_DOMAIN}
DISABLE_DEV_LOGIN=1
ENFORCE_ENTITLEMENTS=0

RELAY_SECRET=${RELAY_SECRET}
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Optional hosted features. Fill these in when you want login email, GitHub OAuth,
# Stripe billing, or web push on this self-hosted deployment.
RESEND_API_KEY=
AUTH_EMAIL_FROM=Bivy <login@${APP_DOMAIN}>
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_INDIVIDUAL=
STRIPE_PRICE_TEAM=
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@${APP_DOMAIN}
EOF
  chmod 600 deploy/.env || true
  echo "Wrote deploy/.env"
else
  echo "Keeping existing deploy/.env"
fi

if [[ ! -f deploy/Caddyfile ]]; then
  cat > deploy/Caddyfile <<EOF
${APP_DOMAIN} {
  reverse_proxy control-plane:4400
}

${RELAY_DOMAIN} {
  reverse_proxy relay:4500
}
EOF
  echo "Wrote deploy/Caddyfile"
else
  echo "Keeping existing deploy/Caddyfile"
fi

# Reclaim disk before the build writes new image layers: prune docker cruft and
# stale co-located node sessions/worktrees. prune.sh runs a host-wide
# `docker system prune -f` (keeps the reusable build cache warm; set
# BIVY_PRUNE_DOCKER_ALL=1 for the aggressive `-af` variant). That still removes
# stopped containers and dangling images from UNRELATED workloads on a shared
# host — so only run it on an update (when a previous Bivy stack already
# exists), never on a first deploy where there is nothing of ours to reclaim.
# Force with BIVY_PRUNE=1, skip with BIVY_PRUNE=0.
existing_stack="$(docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps -aq 2>/dev/null || true)"
if [ "${BIVY_PRUNE:-auto}" = "0" ]; then
  echo "Skipping pre-deploy prune (BIVY_PRUNE=0)."
elif [ "${BIVY_PRUNE:-auto}" = "1" ] || [ -n "${existing_stack}" ]; then
  bash "${ROOT}/deploy/prune.sh"
else
  echo "First deploy detected (no existing Bivy stack) — skipping the host-wide docker prune."
  echo "It will run automatically on future updates; force it now with BIVY_PRUNE=1."
fi

docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

echo
echo "Bivy self-host stack started."
echo "Control plane: https://${APP_DOMAIN}"
echo "Relay:         wss://${RELAY_DOMAIN}"
echo
echo "Connect a node:"
echo "  bivy relay:setup --control-plane https://${APP_DOMAIN} --relay wss://${RELAY_DOMAIN} --email you@example.com"
