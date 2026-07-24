#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DOMAIN="${1:-${CP_DOMAIN:-}}"
RELAY_DOMAIN="${2:-${RELAY_DOMAIN:-}}"
# Managed/hosted Postgres: set DATABASE_URL in the environment to use an external
# database (DigitalOcean, Render, Neon, Supabase, RDS, ...) instead of the bundled
# postgres container. When set, the installer skips the local DB password, writes
# the URL into deploy/.env, and layers deploy/docker-compose.hosted-db.yml so no
# postgres container is started.
DATABASE_URL="${DATABASE_URL:-}"

usage() {
  cat <<'EOF'
Usage: bash deploy/self-host.sh <app-domain> <relay-domain>

Example:
  bash deploy/self-host.sh app.example.com relay.example.com

Use a managed/hosted Postgres instead of the bundled container by setting
DATABASE_URL in the environment (keep the sslmode your provider gives you):
  DATABASE_URL=postgres://user:pass@host:25060/db?sslmode=require \
    bash deploy/self-host.sh app.example.com relay.example.com

Prereqs:
  - Docker + docker compose plugin (v2.24+ if you use a managed DATABASE_URL)
  - DNS A/AAAA records for both domains pointing at this host
  - ports 80 and 443 open

The script writes deploy/.env and deploy/Caddyfile if they do not already exist,
then starts control-plane + relay + Caddy (plus a bundled Postgres unless
DATABASE_URL points at a managed database).
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

# Re-runs should stay in the same DB mode as the first deploy: if DATABASE_URL
# wasn't passed this time but the existing deploy/.env already pins one, adopt it
# so we still layer the hosted-db overlay (otherwise we'd wrongly start a bundled
# postgres alongside the managed database).
if [[ -z "${DATABASE_URL}" && -f deploy/.env ]] && grep -qE '^[[:space:]]*DATABASE_URL=' deploy/.env; then
  DATABASE_URL="$(grep -E '^[[:space:]]*DATABASE_URL=' deploy/.env | head -n1 | cut -d= -f2-)"
fi

# Compose files to layer, and a human-readable DB mode for the summary.
COMPOSE_ARGS=(-f deploy/docker-compose.yml)
DB_MODE="bundled postgres container"
if [[ -n "${DATABASE_URL}" ]]; then
  COMPOSE_ARGS+=(-f deploy/docker-compose.hosted-db.yml)
  DB_MODE="managed database via DATABASE_URL"
fi

if [[ ! -f deploy/.env ]]; then
  RELAY_SECRET="$(rand 48)"
  if [[ -n "${DATABASE_URL}" ]]; then
    # Managed DB: no local postgres, so no generated password. POSTGRES_* are kept
    # as inert placeholders only so the base compose file doesn't warn about an
    # unset variable while interpolating its (overridden) derived DATABASE_URL.
    cat > deploy/.env <<EOF
NODE_ENV=production
PUBLIC_CONTROL_PLANE_URL=https://${APP_DOMAIN}
RELAY_PUBLIC_URL=wss://${RELAY_DOMAIN}
DISABLE_DEV_LOGIN=1
ENFORCE_ENTITLEMENTS=0

RELAY_SECRET=${RELAY_SECRET}

# Managed/hosted Postgres. This deploy layers deploy/docker-compose.hosted-db.yml,
# which removes the bundled postgres container and points the control plane here.
DATABASE_URL=${DATABASE_URL}
# Unused in managed mode (kept only to silence the base compose interpolation warning).
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=unused

# Optional features. Fill these in when you want login email, GitHub OAuth, or
# web push on this self-hosted deployment. Billing is deliberately not here —
# subscriptions exist to run paid hosting, and entitlements stay unenforced on a
# self-hosted stack, so every feature is already on for every account.
RESEND_API_KEY=
AUTH_EMAIL_FROM=Bivy <login@${APP_DOMAIN}>
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@${APP_DOMAIN}
EOF
  else
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

# Optional features. Fill these in when you want login email, GitHub OAuth, or
# web push on this self-hosted deployment. Billing is deliberately not here —
# subscriptions exist to run paid hosting, and entitlements stay unenforced on a
# self-hosted stack, so every feature is already on for every account.
RESEND_API_KEY=
AUTH_EMAIL_FROM=Bivy <login@${APP_DOMAIN}>
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@${APP_DOMAIN}
EOF
  fi
  chmod 600 deploy/.env || true
  echo "Wrote deploy/.env"
else
  echo "Keeping existing deploy/.env"
  # Managed DB requested via env var but the existing .env doesn't pin it yet —
  # persist it so future re-runs (without the env var) stay in managed mode.
  if [[ -n "${DATABASE_URL}" ]] && ! grep -qE '^[[:space:]]*DATABASE_URL=' deploy/.env; then
    printf '\n# Added by self-host.sh: managed/hosted Postgres.\nDATABASE_URL=%s\n' "${DATABASE_URL}" >> deploy/.env
    echo "Added DATABASE_URL to existing deploy/.env"
  fi
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

# Reclaim disk before the build writes new image layers: prune docker cruft.
# prune.sh runs a host-wide
# `docker system prune -f` (keeps the reusable build cache warm; set
# BIVY_PRUNE_DOCKER_ALL=1 for the aggressive `-af` variant). That still removes
# stopped containers and dangling images from UNRELATED workloads on a shared
# host — so only run it on an update (when a previous Bivy stack already
# exists), never on a first deploy where there is nothing of ours to reclaim.
# Force with BIVY_PRUNE=1, skip with BIVY_PRUNE=0.
# Fail early with a clear hint if the merged compose config is invalid — the most
# likely cause in managed mode is a Docker Compose older than v2.24 (the
# hosted-db overlay uses the `!reset` tag).
if ! docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env config -q 2>/tmp/bivy-compose-config.err; then
  echo "Failed to parse the Docker Compose configuration:" >&2
  cat /tmp/bivy-compose-config.err >&2 || true
  if [[ -n "${DATABASE_URL}" ]]; then
    echo >&2
    echo "Using a managed DATABASE_URL requires Docker Compose v2.24+ (for the '!reset' tag)." >&2
    echo "Check with: docker compose version" >&2
  fi
  exit 1
fi

existing_stack="$(docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env ps -aq 2>/dev/null || true)"
if [ "${BIVY_PRUNE:-auto}" = "0" ]; then
  echo "Skipping pre-deploy prune (BIVY_PRUNE=0)."
elif [ "${BIVY_PRUNE:-auto}" = "1" ] || [ -n "${existing_stack}" ]; then
  bash "${ROOT}/deploy/prune.sh"
else
  echo "First deploy detected (no existing Bivy stack) — skipping the host-wide docker prune."
  echo "It will run automatically on future updates; force it now with BIVY_PRUNE=1."
fi

docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env up -d --build

echo
echo "Bivy self-host stack started."
echo "Database:      ${DB_MODE}"
echo "Control plane: https://${APP_DOMAIN}"
echo "Relay:         wss://${RELAY_DOMAIN}"
echo
echo "Connect a node:"
echo "  bivy relay:setup --control-plane https://${APP_DOMAIN} --relay wss://${RELAY_DOMAIN} --email you@example.com"
