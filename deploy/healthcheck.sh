#!/usr/bin/env bash
# Lightweight HTTP health probe for the service containers.
# Starting `node -e 'fetch(...)'` every ten seconds briefly consumes most of a
# core during V8 startup, which is significant on a one-vCPU host. Bash's
# built-in /dev/tcp support performs the same check without spawning a runtime.
set -u

port="${1:?port required}"
path="${2:?path required}"

exec 3<>"/dev/tcp/127.0.0.1/${port}" || exit 1
printf 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' "$path" >&3
IFS= read -r status <&3 || exit 1

[[ "$status" =~ ^HTTP/[0-9.]+[[:space:]]+200([[:space:]]|$) ]]
