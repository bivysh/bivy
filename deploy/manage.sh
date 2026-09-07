#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f deploy/.env ]] || { echo "Run deploy/self-host.sh first." >&2; exit 1; }
source deploy/common.sh
COMPOSE_ARGS=(-f deploy/docker-compose.yml)
if [[ -n "$(env_value DATABASE_URL)" ]]; then
  COMPOSE_ARGS+=(-f deploy/docker-compose.hosted-db.yml)
fi
compose() { docker compose "${COMPOSE_ARGS[@]}" --env-file deploy/.env "$@"; }

case "${1:-help}" in
  login)
    [[ -n "$(env_value SELF_HOST_OWNER_EMAIL)" ]] || {
      echo "Server-shell login is not configured. Set SELF_HOST_OWNER_EMAIL in deploy/.env and rerun setup." >&2; exit 1;
    }
    compose exec -T control-plane ./node_modules/.bin/tsx src/operator-login-cli.ts
    ;;
  status) compose ps ;;
  logs) compose logs --tail 100 ;;
  check)
    cp_url="$(env_value PUBLIC_CONTROL_PLANE_URL)"
    relay_url="$(env_value RELAY_PUBLIC_URL)"
    [[ "$cp_url" == https://* && "$relay_url" == wss://* ]] || { echo "Public checks require HTTPS/WSS endpoints." >&2; exit 1; }
    for url in "${cp_url%/}/readyz" "https://${relay_url#wss://}/healthz" "${cp_url%/}/"; do
      echo "Checking $url"
      # Bounded retries give ACME time to issue a certificate. TLS verification
      # stays enabled; a bad certificate is a setup failure, not a warning.
      if ! curl --fail --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 \
        --retry 12 --retry-delay 5 --retry-max-time 90 --retry-all-errors "$url"; then
        echo "Public HTTPS check failed. Check DNS (including AAAA), inbound ports 80/443, and Caddy logs: bash deploy/manage.sh logs" >&2
        exit 1
      fi
    done
    ;;
  backup)
    if [[ -n "$(env_value DATABASE_URL)" ]]; then
      echo "Managed database: use your provider's snapshot/PITR and securely back up deploy/.env and deploy/Caddyfile." >&2
      exit 1
    fi
    mkdir -p backups
    tmp="$(mktemp -d "$ROOT/backups/.backup.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$tmp/database.dump"
    cp deploy/.env deploy/Caddyfile "$tmp/"
    printf '%s\n' "$(env_value BIVY_IMAGE_TAG)" > "$tmp/IMAGE_TAG"
    archive="$ROOT/backups/bivy-$(date -u +%Y%m%dT%H%M%SZ)-${tmp##*.}.tar.gz"
    tar -czf "$archive" -C "$tmp" .
    echo "Backup: $archive"
    echo "Contains secrets. Copy it to secure off-server storage and test restoration (docs/self-host.md)."
    ;;
  update)
    [[ -f deploy/RELEASE_IMAGE_TAG ]] || {
      echo "Source checkout: check out the desired release and rerun deploy/self-host.sh (do not overwrite source with a bundle)." >&2; exit 1;
    }
    if [[ -z "$(env_value DATABASE_URL)" ]]; then
      bash deploy/manage.sh backup
    elif [[ "${BIVY_MANAGED_BACKUP_CONFIRMED:-0}" != 1 ]]; then
      echo "Take a managed DB snapshot and back up .env/Caddyfile first, then rerun with BIVY_MANAGED_BACKUP_CONFIRMED=1." >&2
      exit 1
    fi
    cp_domain="$(env_value PUBLIC_CONTROL_PLANE_URL)"; cp_domain="${cp_domain#https://}"
    relay_domain="$(env_value RELAY_PUBLIC_URL)"; relay_domain="${relay_domain#wss://}"
    relay_domain="${relay_domain%/relay}"
    BIVY_SELF_HOST_DIR="$ROOT" bash deploy/install.sh "$cp_domain" "$relay_domain"
    ;;
  *) echo "Usage: bash deploy/manage.sh {login|status|logs|check|backup|update}"; exit 1 ;;
esac
