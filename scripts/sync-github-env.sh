#!/usr/bin/env bash
set -euo pipefail

# Sync hosted-deploy config from a local .env file into GitHub Environment
# secrets/variables.
#
# Usage:
#   scripts/sync-github-env.sh                 # reads .env, env=staging
#   scripts/sync-github-env.sh deploy/.env     # reads deploy/.env
#   GH_ENV=production scripts/sync-github-env.sh .env
#
# Requires: gh CLI authenticated with access to this repo.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-$SCRIPT_DIR/../.env}"
GH_ENV="${GH_ENV:-staging}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required. Install it and run: gh auth login" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: env file not found: $ENV_FILE" >&2
  exit 1
fi

# Read KEY=VALUE lines without shell-sourcing, so values like
# AUTH_EMAIL_FROM=Bivy <login@bivy.sh> are handled safely.
ENV_KEYS=()
ENV_VALUES=()
while IFS= read -r line || [ -n "$line" ]; do
  # Trim leading whitespace for comment/blank detection only.
  trimmed="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  # Trim whitespace around key.
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  # Strip optional matching single/double quotes around value.
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
  ENV_KEYS[${#ENV_KEYS[@]}]="$key"
  ENV_VALUES[${#ENV_VALUES[@]}]="$value"
done < "$ENV_FILE"

get() {
  local seek="$1" result="" i
  for ((i = 0; i < ${#ENV_KEYS[@]}; i++)); do
    if [ "${ENV_KEYS[$i]}" = "$seek" ]; then
      result="${ENV_VALUES[$i]}"
    fi
  done
  printf '%s' "$result"
}

# The workflow expects domains. If the env file has full URLs instead, derive
# cp/relay domains from PUBLIC_CONTROL_PLANE_URL and RELAY_PUBLIC_URL.
derive_host() {
  local raw="$1"
  raw="${raw#http://}"; raw="${raw#https://}"; raw="${raw#ws://}"; raw="${raw#wss://}"
  raw="${raw%%/*}"
  raw="${raw%%:*}"
  printf '%s' "$raw"
}

CP_DOMAIN="$(get CP_DOMAIN)"
RELAY_DOMAIN="$(get RELAY_DOMAIN)"
if [ -z "$CP_DOMAIN" ] && [ -n "$(get PUBLIC_CONTROL_PLANE_URL)" ]; then
  CP_DOMAIN="$(derive_host "$(get PUBLIC_CONTROL_PLANE_URL)")"
fi
if [ -z "$RELAY_DOMAIN" ] && [ -n "$(get RELAY_PUBLIC_URL)" ]; then
  RELAY_DOMAIN="$(derive_host "$(get RELAY_PUBLIC_URL)")"
fi

set_secret() {
  local name="$1" value="$2" required="${3:-optional}"
  if [ -z "$value" ]; then
    if [ "$required" = "required" ]; then
      echo "Error: missing required value for $name in $ENV_FILE" >&2
      exit 1
    fi
    echo "skip secret $name (empty)"
    return
  fi
  gh secret set "$name" --env "$GH_ENV" --body "$value" >/dev/null
  echo "set secret $name"
}

set_var() {
  local name="$1" value="$2" default_value="$3"
  if [ -z "$value" ]; then value="$default_value"; fi
  gh variable set "$name" --env "$GH_ENV" --body "$value" >/dev/null
  echo "set variable $name=$value"
}

echo "Syncing GitHub Environment: $GH_ENV"
echo "Source env file: $ENV_FILE"

set_secret CP_DOMAIN "$CP_DOMAIN" required
set_secret RELAY_DOMAIN "$RELAY_DOMAIN" required
set_secret RELAY_SECRET "$(get RELAY_SECRET)" required
set_secret POSTGRES_PASSWORD "$(get POSTGRES_PASSWORD)" required

set_secret RESEND_API_KEY "$(get RESEND_API_KEY)"
set_secret AUTH_EMAIL_FROM "$(get AUTH_EMAIL_FROM)"
set_secret STRIPE_SECRET_KEY "$(get STRIPE_SECRET_KEY)"
set_secret STRIPE_WEBHOOK_SECRET "$(get STRIPE_WEBHOOK_SECRET)"
set_secret STRIPE_PRICE_INDIVIDUAL "$(get STRIPE_PRICE_INDIVIDUAL)"
set_secret STRIPE_PRICE_TEAM "$(get STRIPE_PRICE_TEAM)"

# Web push (VAPID) keys and subject. deploy-staging.yml reads WEB_PUSH_SUBJECT
# from a secret first, so it is stored as a secret here too even though it is
# not sensitive.
set_secret WEB_PUSH_VAPID_PUBLIC_KEY "$(get WEB_PUSH_VAPID_PUBLIC_KEY)"
set_secret WEB_PUSH_VAPID_PRIVATE_KEY "$(get WEB_PUSH_VAPID_PRIVATE_KEY)"
set_secret WEB_PUSH_SUBJECT "$(get WEB_PUSH_SUBJECT)"

# GitHub OAuth App credentials. GitHub reserves the GITHUB_ prefix for secret
# names, so the .env's GITHUB_OAUTH_* values are stored under BIVY_GITHUB_OAUTH_*
# secrets — which is exactly what deploy-staging.yml reads.
set_secret BIVY_GITHUB_OAUTH_CLIENT_ID "$(get GITHUB_OAUTH_CLIENT_ID)"
set_secret BIVY_GITHUB_OAUTH_CLIENT_SECRET "$(get GITHUB_OAUTH_CLIENT_SECRET)"

# Keep booleans as GitHub Environment variables, not secrets.
set_var DISABLE_DEV_LOGIN "$(get DISABLE_DEV_LOGIN)" 0
set_var ENFORCE_ENTITLEMENTS "$(get ENFORCE_ENTITLEMENTS)" 0

echo "Done. Verify with:"
echo "  gh secret list --env $GH_ENV"
echo "  gh variable list --env $GH_ENV"
