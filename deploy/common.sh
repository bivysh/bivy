#!/usr/bin/env bash
# Source from the deployment root. Never execute operator-controlled .env files.
env_value() {
  local key="$1" value
  value="$(grep -E "^[[:space:]]*${key}=" deploy/.env | tail -n1 | cut -d= -f2- | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true)"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}
