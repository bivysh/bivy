#!/usr/bin/env bash
# CI-owned disposable guest. Prepare only curl while the release is built;
# Node, native build tools and Bivy are still installed by the candidate.
set -euo pipefail
name=bivy-installer-smoke
case "${1:-}" in
  start)
    mkdir -p "$HOME/.cache/bivy-installer-npm" "$HOME/.cache/bivy-installer-apt"
    docker run --detach --init --name "$name" \
      -e BIVY_INSTALL_SMOKE=1 -e BIVY_INSTALL_SMOKE_CACHE=1 \
      -v "$HOME/.cache/bivy-installer-npm:/root/.npm" \
      -v "$HOME/.cache/bivy-installer-apt:/var/cache/apt/archives" \
      -v "$PWD:/candidate:ro" ubuntu:24.04 \
      bash -euc 'export DEBIAN_FRONTEND=noninteractive
        rm -f /etc/apt/apt.conf.d/docker-clean
        # Public Ubuntu mirrors can stall in hosted runners. Bound individual
        # requests and retry transient failures instead of consuming the entire
        # readiness budget on one connection. Fail on incomplete index updates.
        printf "%s\n" \
          "Acquire::Retries \"3\";" \
          "Acquire::http::Timeout \"30\";" \
          "Acquire::https::Timeout \"30\";" \
          "Acquire::ForceIPv4 \"true\";" > /etc/apt/apt.conf.d/80bivy-smoke-network
        apt-get update -o APT::Update::Error-Mode=any
        apt-get install -y --no-install-recommends curl ca-certificates
        touch /tmp/curl-ready
        exec sleep infinity'
    ;;
  test)
    # Bounded readiness: failed preparation must fail the gate, not silently
    # skip the installer or hang until the job timeout.
    ready=0
    # Allow five minutes for cold mirror downloads (the job still has its
    # independent 20-minute deadline). This does not skip any installer checks.
    for ((i=0; i<300; i++)); do
      if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
        echo "Installer guest exited before curl was ready." >&2
        docker logs "$name"
        docker inspect --format '{{json .State}}' "$name" >&2
        exit 1
      fi
      if docker exec "$name" test -f /tmp/curl-ready; then ready=1; break; fi
      sleep 1
    done
    if [ "$ready" != 1 ]; then
      echo "Installer guest did not finish apt/curl preparation within 300 seconds." >&2
      docker logs "$name"
      docker inspect --format '{{json .State}}' "$name" >&2
      exit 1
    fi
    docker exec "$name" bash /candidate/scripts/smoke-installer.sh /candidate/release-artifact/bivy-npm.tgz
    ;;
  cleanup)
    if docker container inspect "$name" >/dev/null 2>&1; then docker rm --force "$name"; fi
    for dir in "$HOME/.cache/bivy-installer-npm" "$HOME/.cache/bivy-installer-apt"; do
      if [ -d "$dir" ]; then sudo chown -R "$(id -u):$(id -g)" "$dir"; fi
    done
    ;;
  *) echo 'Usage: installer-smoke-guest.sh start|test|cleanup' >&2; exit 2 ;;
esac
