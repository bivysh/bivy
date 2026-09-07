#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DOMAIN="${1:-${CP_DOMAIN:-}}"
RELAY_DOMAIN="${2:-${RELAY_DOMAIN:-${APP_DOMAIN}}}"
umask 077
# Managed/hosted Postgres: set DATABASE_URL in the environment to use an external
# database (DigitalOcean, Render, Neon, Supabase, RDS, ...) instead of the bundled
# postgres container. When set, the installer skips the local DB password, writes
# the URL into deploy/.env, and layers deploy/docker-compose.hosted-db.yml so no
# postgres container is started.
DATABASE_URL="${DATABASE_URL:-}"
# Public service images are immutable when pinned by a full Core commit SHA.
# An explicit release version is also accepted. When omitted, a git checkout
# uses its exact HEAD commit.
BIVY_IMAGE_TAG="${BIVY_IMAGE_TAG:-}"

usage() {
  cat <<'EOF'
Usage: bash deploy/self-host.sh <app-domain> [relay-domain]

Example:
  bash deploy/self-host.sh app.example.com relay.example.com

The public control-plane and relay images are pinned to the checkout's full git
SHA. Override that with a release version or another full SHA when needed:
  BIVY_IMAGE_TAG=0.17.0 bash deploy/self-host.sh app.example.com relay.example.com

Use a managed/hosted Postgres instead of the bundled container by setting
DATABASE_URL in the environment (keep the sslmode your provider gives you):
  DATABASE_URL=postgres://user:pass@host:25060/db?sslmode=require \
    bash deploy/self-host.sh app.example.com relay.example.com

Prereqs:
  - Docker + docker compose plugin (v2.24+ if you use a managed DATABASE_URL)
  - DNS A/AAAA records for the domain(s) pointing at this host
  - ports 80 and 443 open

One domain is enough: the relay is served under /relay. An optional second
argument keeps the separate relay domain layout. New installs enable a local
owner identity and print a private, single-use login link. GitHub/Resend are
optional. Existing configuration is preserved. The script waits for container
and public HTTPS readiness before printing success.
EOF
}

if [[ "${APP_DOMAIN}" == "" || "${RELAY_DOMAIN}" == "" || "${APP_DOMAIN}" == "-h" || "${APP_DOMAIN}" == "--help" ]]; then
  usage
  exit 1
fi

normalize_domain() {
  local domain="${1#https://}"
  domain="${domain#http://}"
  printf '%s' "${domain%/}" | tr '[:upper:]' '[:lower:]'
}

valid_domain() {
  local domain="$1" label
  [[ ${#domain} -le 253 && "$domain" =~ ^[a-z0-9.-]+$ && "$domain" == *.* && "$domain" != *..* && "$domain" != *. ]] || return 1
  local labels
  IFS='.' read -r -a labels <<< "$domain"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

APP_DOMAIN="$(normalize_domain "${APP_DOMAIN}")"
RELAY_DOMAIN="$(normalize_domain "${RELAY_DOMAIN}")"

if ! valid_domain "$APP_DOMAIN" || ! valid_domain "$RELAY_DOMAIN"; then
  echo "Use DNS hostnames only (no paths, ports, wildcards, or credentials)." >&2
  exit 1
fi
RELAY_PUBLIC_URL="wss://${RELAY_DOMAIN}"
if [[ "$APP_DOMAIN" == "$RELAY_DOMAIN" ]]; then
  RELAY_PUBLIC_URL="wss://${APP_DOMAIN}/relay"
fi

# Optional external auth can be provided on the first run. Otherwise the local
# owner identity below gives the administrator a secure shell-only login path.
RESEND_API_KEY_INPUT="${RESEND_API_KEY:-}"
AUTH_EMAIL_FROM_INPUT="${AUTH_EMAIL_FROM:-}"
GITHUB_OAUTH_CLIENT_ID_INPUT="${GITHUB_OAUTH_CLIENT_ID:-}"
GITHUB_OAUTH_CLIENT_SECRET_INPUT="${GITHUB_OAUTH_CLIENT_SECRET:-}"
# A local identity, not a claim that an external email address was verified.
SELF_HOST_OWNER_EMAIL_INPUT="${SELF_HOST_OWNER_EMAIL-owner@self-host.invalid}"
SELF_HOST_SETUP_TOKEN_INPUT="${SELF_HOST_SETUP_TOKEN:-}"

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else node -e "console.log(require('node:crypto').randomBytes(Number(process.argv[1])).toString('base64'))" "$1"
  fi
}

cd "${ROOT}"
mkdir -p deploy
source deploy/common.sh
EXISTING_CONFIG=0
if [[ -f deploy/.env ]]; then EXISTING_CONFIG=1; fi
# Reject a domain change before touching the existing image pin or any config.
if [[ -f deploy/.env ]] && [[ "$(env_value PUBLIC_CONTROL_PLANE_URL)" != "https://${APP_DOMAIN}" || "$(env_value RELAY_PUBLIC_URL)" != "$RELAY_PUBLIC_URL" ]]; then
  echo "These domains differ from deploy/.env. Use the existing domains, or explicitly update .env and Caddyfile together." >&2
  exit 1
fi

if [[ -z "${BIVY_IMAGE_TAG}" ]]; then
  if [[ -f deploy/RELEASE_IMAGE_TAG ]]; then
    BIVY_IMAGE_TAG="$(< deploy/RELEASE_IMAGE_TAG)"
  elif ! BIVY_IMAGE_TAG="$(git rev-parse 'HEAD^{commit}' 2>/dev/null)"; then
    echo "Cannot resolve this checkout's image tag. Set BIVY_IMAGE_TAG to a release version or full Core commit SHA." >&2
    exit 1
  fi
fi
if [[ ! "${BIVY_IMAGE_TAG}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "BIVY_IMAGE_TAG is not a valid container tag: ${BIVY_IMAGE_TAG}" >&2
  exit 1
fi
export BIVY_IMAGE_TAG
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Warning: using published image ${BIVY_IMAGE_TAG}; local tracked source changes are not included." >&2
  echo "Use deploy/docker-compose.build.yml when you intend to run modified source." >&2
fi

# Re-runs should stay in the same DB mode as the first deploy: if DATABASE_URL
# wasn't passed this time but the existing deploy/.env already pins one, adopt it
# so we still layer the hosted-db overlay (otherwise we'd wrongly start a bundled
# postgres alongside the managed database).
if [[ -z "${DATABASE_URL}" && -f deploy/.env ]] && grep -qE '^[[:space:]]*DATABASE_URL=' deploy/.env; then
  DATABASE_URL="$(env_value DATABASE_URL)"
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
BIVY_IMAGE_TAG=${BIVY_IMAGE_TAG}
PUBLIC_CONTROL_PLANE_URL=https://${APP_DOMAIN}
RELAY_PUBLIC_URL=${RELAY_PUBLIC_URL}
DISABLE_DEV_LOGIN=1

RELAY_SECRET=${RELAY_SECRET}

# Managed/hosted Postgres. This deploy layers deploy/docker-compose.hosted-db.yml,
# which removes the bundled postgres container and points the control plane here.
DATABASE_URL=${DATABASE_URL}
# Unused in managed mode (kept only to silence the base compose interpolation warning).
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=unused

# Optional external sign-in. Push keys are generated on first successful startup.
RESEND_API_KEY=${RESEND_API_KEY_INPUT}
AUTH_EMAIL_FROM=${AUTH_EMAIL_FROM_INPUT}
GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID_INPUT}
GITHUB_OAUTH_CLIENT_SECRET=${GITHUB_OAUTH_CLIENT_SECRET_INPUT}
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@${APP_DOMAIN}

# Optional: encrypted credential storage for offline automations. Off while
# empty. Generate with: openssl rand -base64 32  (docs/self-host.md → "Offline automations")
HOSTED_CREDENTIAL_KEY=
EOF
  else
    # URL-safe random password for the derived Postgres connection URI.
    POSTGRES_PASSWORD="$(rand 32 | tr '+/' '-_' | tr -d '=\n')"
    cat > deploy/.env <<EOF
NODE_ENV=production
BIVY_IMAGE_TAG=${BIVY_IMAGE_TAG}
PUBLIC_CONTROL_PLANE_URL=https://${APP_DOMAIN}
RELAY_PUBLIC_URL=${RELAY_PUBLIC_URL}
DISABLE_DEV_LOGIN=1

RELAY_SECRET=${RELAY_SECRET}
POSTGRES_DB=bivy_control_plane
POSTGRES_USER=bivy
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Optional external sign-in. Push keys are generated on first successful startup.
RESEND_API_KEY=${RESEND_API_KEY_INPUT}
AUTH_EMAIL_FROM=${AUTH_EMAIL_FROM_INPUT}
GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID_INPUT}
GITHUB_OAUTH_CLIENT_SECRET=${GITHUB_OAUTH_CLIENT_SECRET_INPUT}
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@${APP_DOMAIN}

# Optional: encrypted credential storage for offline automations. Off while
# empty. Generate with: openssl rand -base64 32  (docs/self-host.md → "Offline automations")
HOSTED_CREDENTIAL_KEY=
EOF
  fi
  printf '\n# Local owner identity; this is not a verified external email.\nSELF_HOST_OWNER_EMAIL=%s\n' "$SELF_HOST_OWNER_EMAIL_INPUT" >> deploy/.env
  printf '# Optional browser setup secret (generate with openssl rand -hex 32).\nSELF_HOST_SETUP_TOKEN=%s\n' "$SELF_HOST_SETUP_TOKEN_INPUT" >> deploy/.env
  chmod 600 deploy/.env
  echo "Wrote deploy/.env"
else
  echo "Keeping existing deploy/.env"
  # Refresh the immutable image pin when the checked-out Core commit changes, or
  # persist an explicit BIVY_IMAGE_TAG supplied by the operator.
  if grep -qE '^[[:space:]]*BIVY_IMAGE_TAG=' deploy/.env; then
    sed -i -E "s/^[[:space:]]*BIVY_IMAGE_TAG=.*/BIVY_IMAGE_TAG=${BIVY_IMAGE_TAG}/" deploy/.env
  else
    printf '\n# Public control-plane and relay image pin.\nBIVY_IMAGE_TAG=%s\n' "${BIVY_IMAGE_TAG}" >> deploy/.env
  fi
  echo "Pinned public service images to ${BIVY_IMAGE_TAG}"
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
  if [[ "$APP_DOMAIN" == "$RELAY_DOMAIN" ]]; then
    CONFIGURED_CADDY="${APP_DOMAIN} {
  handle_path /relay/* {
    reverse_proxy relay:4500
  }
  handle {
    reverse_proxy control-plane:4400
  }
}"
  else
    CONFIGURED_CADDY="${CADDY_TEMPLATE//app.example.com/${APP_DOMAIN}}"
    CONFIGURED_CADDY="${CONFIGURED_CADDY//relay.example.com/${RELAY_DOMAIN}}"
  fi
  printf '%s\n' "${CONFIGURED_CADDY}" > deploy/Caddyfile
  echo "Wrote deploy/Caddyfile for ${APP_DOMAIN} + ${RELAY_DOMAIN}"
else
  echo "Keeping existing customized deploy/Caddyfile"
fi

# A production control plane deliberately disables the unauthenticated dev
# login. Fresh installs need an explicit sign-in path. Existing installs may
# instead have a password in Postgres after removing the setup token: verify
# that through the private control plane before bringing up the public proxy.
# Parse individual keys rather than sourcing operator-controlled .env content.

RESEND_CONFIGURED="$(env_value RESEND_API_KEY)"
AUTH_EMAIL_FROM_CONFIGURED="$(env_value AUTH_EMAIL_FROM)"
GITHUB_CLIENT_ID_CONFIGURED="$(env_value GITHUB_OAUTH_CLIENT_ID)"
GITHUB_CLIENT_SECRET_CONFIGURED="$(env_value GITHUB_OAUTH_CLIENT_SECRET)"
OWNER_EMAIL_CONFIGURED="$(env_value SELF_HOST_OWNER_EMAIL)"
OWNER_SETUP_CONFIGURED="$(env_value SELF_HOST_SETUP_TOKEN)"
if [[ -n "$OWNER_SETUP_CONFIGURED" && ! "$OWNER_SETUP_CONFIGURED" =~ ^[A-Za-z0-9_+/=-]{32,256}$ ]]; then
  echo "SELF_HOST_SETUP_TOKEN must be a random secret of 32–256 URL/base64-safe characters." >&2
  exit 1
fi
if [[ -n "$OWNER_EMAIL_CONFIGURED" && ! "$OWNER_EMAIL_CONFIGURED" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Invalid SELF_HOST_OWNER_EMAIL in deploy/.env." >&2
  exit 1
fi
no_auth_configured() {
  cat >&2 <<EOF

Bivy configuration was written, but setup cannot finish because no
production sign-in method could be confirmed.

Choose one, edit deploy/.env, then run this same command again:
  - Browser owner setup: set SELF_HOST_SETUP_TOKEN (generate with openssl rand -hex 32).
  - Private server-shell login: set SELF_HOST_OWNER_EMAIL=owner@self-host.invalid.
  - Email magic links: set RESEND_API_KEY (and a verified AUTH_EMAIL_FROM).
  - GitHub sign-in: set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.
    Setup guide: docs/github-oauth-setup.md

The unauthenticated dev login stays disabled. Refusing to finish setup prevents a
deployment that nobody can sign into.
EOF
  exit 2
}
CHECK_OWNER_PASSWORD=0
if [[ -z "$OWNER_EMAIL_CONFIGURED" && -z "$OWNER_SETUP_CONFIGURED" \
  && ( -z "${RESEND_CONFIGURED}" || -z "${AUTH_EMAIL_FROM_CONFIGURED}" ) \
  && ( -z "${GITHUB_CLIENT_ID_CONFIGURED}" || -z "${GITHUB_CLIENT_SECRET_CONFIGURED}" ) ]]; then
  if [[ "$EXISTING_CONFIG" == 0 ]]; then no_auth_configured; fi
  CHECK_OWNER_PASSWORD=1
fi

# Tests exercise generation without requiring Docker. Do not claim to have
# verified a database-backed password when Docker is deliberately skipped.
if [[ "${BIVY_SELF_HOST_CONFIG_ONLY:-0}" == "1" ]]; then
  if [[ "$CHECK_OWNER_PASSWORD" == 1 ]]; then
    echo "Stored owner access needs a database check. Rerun without BIVY_SELF_HOST_CONFIG_ONLY." >&2
    exit 2
  fi
  echo "Self-host setup files and auth configuration are valid (Docker not started)."
  exit 0
fi
for tool in docker curl; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Use deploy/install.sh or install prerequisites first." >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Cannot access Docker. Start Docker and run with Docker administrative access." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Install the Docker Compose v2 plugin." >&2; exit 1; }

# Fail early with a clear hint if the merged compose config is invalid — the most
# likely cause in managed mode is a Docker Compose older than v2.24 (the
# hosted-db overlay uses the `!reset` tag). Use a private temporary file rather
# than a predictable shared /tmp path, which can collide across users or runs.
COMPOSE_CONFIG_ERROR="$(mktemp "${TMPDIR:-/tmp}/bivy-compose-config.XXXXXX")"
trap 'rm -f "${COMPOSE_CONFIG_ERROR}"' EXIT
if ! docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env config -q 2>"${COMPOSE_CONFIG_ERROR}"; then
  echo "Failed to parse the Docker Compose configuration:" >&2
  cat "${COMPOSE_CONFIG_ERROR}" >&2 || true
  if [[ -n "${DATABASE_URL}" ]]; then
    echo >&2
    echo "Using a managed DATABASE_URL requires Docker Compose v2.24+ (for the '!reset' tag)." >&2
    echo "Check with: docker compose version" >&2
  fi
  exit 1
fi

docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env pull control-plane relay
if [[ "$CHECK_OWNER_PASSWORD" == 1 ]]; then
  # This also starts the bundled DB dependency on a cold host; managed mode
  # uses the same readiness gate. No login/session is minted by the check.
  if ! docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env up -d --wait --wait-timeout 180 control-plane; then
    echo "Cannot verify stored owner access: control plane is not healthy. Run: bash deploy/manage.sh logs" >&2
    exit 1
  fi
  if ! docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env exec -T control-plane node -e \
    'fetch("http://127.0.0.1:4400/auth/owner/status", {signal: AbortSignal.timeout(10000)}).then(async r => { if (!r.ok) throw new Error("Owner status unavailable"); const status = await r.json(); process.exit(status.passwordConfigured === true ? 0 : 2); }).catch(() => process.exit(1))'; then
    echo "Could not confirm a stored owner password. Check control-plane logs or configure a sign-in method." >&2
    no_auth_configured
  fi
  echo "Verified existing owner password sign-in."
fi
if ! docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env up -d --wait --wait-timeout 180; then
  echo "Services did not become healthy. Run: bash deploy/manage.sh status" >&2
  exit 1
fi

# Generate push keys once, on the server, using the dependency already in the
# image. Never silently regenerate half-configured or existing subscriptions.
if [[ -z "$(env_value WEB_PUSH_VAPID_PUBLIC_KEY)" && -z "$(env_value WEB_PUSH_VAPID_PRIVATE_KEY)" ]]; then
  PUSH_KEYS="$(docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env exec -T control-plane node --input-type=module -e \
    'import webpush from "web-push"; const k = webpush.generateVAPIDKeys(); console.log(k.publicKey + ":" + k.privateKey)')"
  if [[ "$PUSH_KEYS" =~ ^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$ ]]; then
    sed -i -e "s/^WEB_PUSH_VAPID_PUBLIC_KEY=.*/WEB_PUSH_VAPID_PUBLIC_KEY=${PUSH_KEYS%%:*}/" \
      -e "s/^WEB_PUSH_VAPID_PRIVATE_KEY=.*/WEB_PUSH_VAPID_PRIVATE_KEY=${PUSH_KEYS#*:}/" deploy/.env
    docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env up -d --wait --wait-timeout 180 control-plane
  else
    echo "Could not generate push keys; inspect the control-plane logs." >&2
    exit 1
  fi
fi

bash deploy/manage.sh check

echo
echo "Bivy self-host stack is ready."
echo "Database:      ${DB_MODE}"
echo "Control plane: https://${APP_DOMAIN}"
echo "Relay:         ${RELAY_PUBLIC_URL}"
if [[ -n "$OWNER_EMAIL_CONFIGURED" ]]; then
  bash deploy/manage.sh login
elif [[ -n "$OWNER_SETUP_CONFIGURED" ]]; then
  echo "Open https://${APP_DOMAIN} and enter your deployment setup secret to choose an owner password."
elif [[ "$CHECK_OWNER_PASSWORD" == 1 ]]; then
  echo "Open https://${APP_DOMAIN} and sign in with your owner password."
else
  echo "Open https://${APP_DOMAIN} and sign in with your configured provider."
fi
echo
echo "In the web app, choose Connect a Machine and copy its authenticated install command."
echo "Later: bash deploy/manage.sh login | status | backup | update"
