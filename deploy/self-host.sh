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

The script writes deploy/.env if missing and configures the untouched example
Caddyfile for your domains. Production requires either Resend email or GitHub
OAuth sign-in; when neither is configured, the script writes setup files and
stops before Docker. It otherwise starts control-plane + relay + Caddy (plus a
bundled Postgres unless DATABASE_URL points at a managed database).
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

# Allow an operator/secret manager to provide auth on the first run. If these
# are absent, the generated .env intentionally leaves them blank and the auth
# gate below explains how to finish configuration before Docker starts.
RESEND_API_KEY_INPUT="${RESEND_API_KEY:-}"
AUTH_EMAIL_FROM_INPUT="${AUTH_EMAIL_FROM:-}"
GITHUB_OAUTH_CLIENT_ID_INPUT="${GITHUB_OAUTH_CLIENT_ID:-}"
GITHUB_OAUTH_CLIENT_SECRET_INPUT="${GITHUB_OAUTH_CLIENT_SECRET:-}"

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

RELAY_SECRET=${RELAY_SECRET}

# Managed/hosted Postgres. This deploy layers deploy/docker-compose.hosted-db.yml,
# which removes the bundled postgres container and points the control plane here.
DATABASE_URL=${DATABASE_URL}
# Unused in managed mode (kept only to silence the base compose interpolation warning).
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=unused

# Configure at least one sign-in path (Resend email or GitHub OAuth). Web push
# remains optional. Billing is deliberately absent: self-hosted entitlements
# stay unenforced, so every feature is available to every account.
RESEND_API_KEY=${RESEND_API_KEY_INPUT}
AUTH_EMAIL_FROM=${AUTH_EMAIL_FROM_INPUT}
GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID_INPUT}
GITHUB_OAUTH_CLIENT_SECRET=${GITHUB_OAUTH_CLIENT_SECRET_INPUT}
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

RELAY_SECRET=${RELAY_SECRET}
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Configure at least one sign-in path (Resend email or GitHub OAuth). Web push
# remains optional. Billing is deliberately absent: self-hosted entitlements
# stay unenforced, so every feature is available to every account.
RESEND_API_KEY=${RESEND_API_KEY_INPUT}
AUTH_EMAIL_FROM=${AUTH_EMAIL_FROM_INPUT}
GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID_INPUT}
GITHUB_OAUTH_CLIENT_SECRET=${GITHUB_OAUTH_CLIENT_SECRET_INPUT}
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

# Replace the repository's untouched template while preserving any operator
# customization. Compare content directly so template edits do not require a
# checksum update in this script.
CADDY_TEMPLATE="$(cat <<'EOF'
# Replace the domains below with yours. Caddy obtains TLS certificates
# automatically and proxies WebSocket connections without extra configuration.

app.example.com {
  reverse_proxy control-plane:4400
}

relay.example.com {
  reverse_proxy relay:4500
}
EOF
)"
if [[ ! -f deploy/Caddyfile || "$(cat deploy/Caddyfile)" == "${CADDY_TEMPLATE}" ]]; then
  CONFIGURED_CADDY="${CADDY_TEMPLATE//app.example.com/${APP_DOMAIN}}"
  CONFIGURED_CADDY="${CONFIGURED_CADDY//relay.example.com/${RELAY_DOMAIN}}"
  printf '%s\n' "${CONFIGURED_CADDY}" > deploy/Caddyfile
  echo "Wrote deploy/Caddyfile for ${APP_DOMAIN} + ${RELAY_DOMAIN}"
else
  echo "Keeping existing customized deploy/Caddyfile"
fi

# A production control plane deliberately disables the unauthenticated dev
# login. Do not continue into an unusable deployment:
# require at least one real sign-in path before Docker is touched. Parse
# individual keys rather than `source`-ing operator-controlled .env content.
env_value() {
  local key="$1"
  local value
  value="$(grep -E "^[[:space:]]*${key}=" deploy/.env | tail -n1 | cut -d= -f2- | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true)"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] \
      || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "${value}"
}

RESEND_CONFIGURED="$(env_value RESEND_API_KEY)"
AUTH_EMAIL_FROM_CONFIGURED="$(env_value AUTH_EMAIL_FROM)"
GITHUB_CLIENT_ID_CONFIGURED="$(env_value GITHUB_OAUTH_CLIENT_ID)"
GITHUB_CLIENT_SECRET_CONFIGURED="$(env_value GITHUB_OAUTH_CLIENT_SECRET)"
if [[ ( -z "${RESEND_CONFIGURED}" || -z "${AUTH_EMAIL_FROM_CONFIGURED}" ) \
  && ( -z "${GITHUB_CLIENT_ID_CONFIGURED}" || -z "${GITHUB_CLIENT_SECRET_CONFIGURED}" ) ]]; then
  cat >&2 <<EOF

Bivy configuration was written, but the stack was not started because no
production sign-in method is configured.

Choose one, edit deploy/.env, then run this same command again:
  - Email magic links: set RESEND_API_KEY (and a verified AUTH_EMAIL_FROM).
  - GitHub sign-in: set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.
    Setup guide: docs/github-oauth-setup.md

The unauthenticated dev login stays disabled. Refusing to start here prevents a
deployment that nobody can sign into.
EOF
  exit 2
fi

# Test/configuration helper: validate generated files and the auth gate without
# requiring Docker. Normal deployments never set this.
if [[ "${BIVY_SELF_HOST_CONFIG_ONLY:-0}" == "1" ]]; then
  echo "Self-host setup files and auth configuration are valid (Docker not started)."
  exit 0
fi

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

docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env up -d --build

echo
echo "Bivy self-host stack started."
echo "Database:      ${DB_MODE}"
echo "Control plane: https://${APP_DOMAIN}"
echo "Relay:         wss://${RELAY_DOMAIN}"
echo
echo "Connect a node:"
if [[ -n "${GITHUB_CLIENT_ID_CONFIGURED}" && -n "${GITHUB_CLIENT_SECRET_CONFIGURED}" ]]; then
  echo "  bivy relay:setup --control-plane https://${APP_DOMAIN} --relay wss://${RELAY_DOMAIN} --github"
else
  echo "  bivy relay:setup --control-plane https://${APP_DOMAIN} --relay wss://${RELAY_DOMAIN} --email you@example.com"
fi
