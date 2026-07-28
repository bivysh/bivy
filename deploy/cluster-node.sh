#!/usr/bin/env bash
# Start/update one role on a server in a multi-host Bivy fleet.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE="${1:-}"
ENV_FILE="${2:-${BIVY_CLUSTER_ENV_FILE:-${ROOT}/deploy/.env.cluster}}"
COMPOSE_FILE="${ROOT}/deploy/docker-compose.cluster.yml"

case "${ROLE}" in
  control-plane|relay) ;;
  *) echo "Usage: bash deploy/cluster-node.sh <control-plane|relay> [env-file]" >&2; exit 2 ;;
esac

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "Cannot read cluster environment file: ${ENV_FILE}" >&2
  echo "Start from deploy/.env.cluster.example and keep it in your secret manager." >&2
  exit 1
fi

# Read a key without sourcing the file: values such as AUTH_EMAIL_FROM contain
# spaces and are valid Compose env-file syntax but not shell syntax.
env_value() {
  grep -E "^[[:space:]]*$1=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true
}
require_env() {
  local value
  value="$(env_value "$1")"
  if [[ -z "${value}" ]]; then echo "${ROLE}: $1 must be set in ${ENV_FILE}" >&2; exit 1; fi
}

require_env RELAY_SECRET
if [[ "${ROLE}" == "control-plane" ]]; then
  require_env DATABASE_URL
  require_env PUBLIC_CONTROL_PLANE_URL
  require_env RELAY_SHARD_URLS
  require_env CONTROL_PLANE_IMAGE
else
  require_env CONTROL_PLANE_URL
  require_env RELAY_SHARD_ID
  require_env RELAY_IMAGE
fi

export BIVY_CLUSTER_ENV_FILE="${ENV_FILE}"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" config -q
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" pull "${ROLE}"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --no-build --remove-orphans "${ROLE}"

echo "Started ${ROLE} from ${ENV_FILE}."
