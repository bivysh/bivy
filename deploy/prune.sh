#!/usr/bin/env bash
# Reclaim disk before a deploy writes new images/containers.
#
# Every `compose up --build` leaves dangling images + build cache behind. This
# script clears that Docker cruft. It is safe to run repeatedly and never
# touches named docker volumes (postgres_data, caddy_data).
#
# (Node session/worktree cleanup lives elsewhere — use `bivy prune` on the node,
# which reclaims old .bivy/pi/sessions transcripts and .bivy/worktrees.)
#
# Tunables (env):
#   BIVY_PRUNE_DOCKER=0          skip the docker prune
#   BIVY_PRUNE_DOCKER_ALL=1      aggressive prune: wipe ALL build cache + unused
#                                images (forces a from-scratch rebuild). Default
#                                keeps the reusable build cache warm.
set -euo pipefail

echo "== disk before prune =="
df -h / 2>/dev/null || true

# --- Docker: stopped containers, unused networks, dangling images, dangling
# build cache. Deliberately NOT --all, so the REUSABLE build cache (and tagged
# images) survive — the following `compose up --build` can then reuse cached
# layers instead of rebuilding every image from scratch. Also NOT --volumes, so
# postgres_data / caddy_data survive. Set BIVY_PRUNE_DOCKER_ALL=1 to reclaim
# maximum disk at the cost of a cold, from-scratch rebuild.
if [ "${BIVY_PRUNE_DOCKER:-1}" != "0" ] && command -v docker >/dev/null 2>&1; then
  if [ "${BIVY_PRUNE_DOCKER_ALL:-0}" = "1" ]; then
    echo "Pruning Docker aggressively (all unused images + ALL build cache; volumes kept)..."
    docker system prune -af || true
  else
    echo "Pruning Docker (stopped containers, unused networks, dangling images + build cache; reusable cache & tagged images kept; volumes kept)..."
    docker system prune -f || true
  fi
fi

echo "== disk after prune =="
df -h / 2>/dev/null || true
