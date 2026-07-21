#!/usr/bin/env bash
# Reclaim disk before a deploy writes new images/containers.
#
# Two things fill a box that runs both the docker stack and a co-located node:
#   1. Docker  - every `compose up --build` leaves dangling images + build cache.
#   2. Node    - old .bivy/pi/sessions transcripts and .bivy/worktrees pile up.
#
# This script clears both. It is safe to run repeatedly and never touches
# named docker volumes (postgres_data, caddy_data) or recent session state.
#
# Tunables (env):
#   BIVY_PRUNE_DOCKER=0          skip the docker prune
#   BIVY_PRUNE_DOCKER_ALL=1      aggressive prune: wipe ALL build cache + unused
#                                images (forces a from-scratch rebuild). Default
#                                keeps the reusable build cache warm.
#   BIVY_PRUNE_SESSIONS=0        skip the node session/worktree prune
#   BIVY_PRUNE_RETENTION_DAYS=7  age (days) beyond which node state is removed
#   BIVY_DATA_DIR=/path/.bivy    node data dir (else common locations are probed)
set -euo pipefail

RETENTION_DAYS="${BIVY_PRUNE_RETENTION_DAYS:-7}"

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

# --- Node state: old session transcripts + git worktrees on this host.
prune_bivy_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  echo "Pruning node state older than ${RETENTION_DAYS}d in $dir ..."

  # Session transcripts live in <data>/pi/sessions.
  if [ -d "$dir/pi/sessions" ]; then
    find "$dir/pi/sessions" -mindepth 1 -maxdepth 1 \
      -mtime +"$RETENTION_DAYS" -exec rm -rf {} + || true
  fi

  # Worktrees live in every .bivy/worktrees dir under the tree (the primary
  # workspace plus each cloned repo-backed workspace). Delete stale checkouts...
  find "$dir" -type d -path '*/.bivy/worktrees' 2>/dev/null | while read -r wtroot; do
    find "$wtroot" -mindepth 1 -maxdepth 1 -type d \
      -mtime +"$RETENTION_DAYS" -exec rm -rf {} + || true
  done

  # ...then drop the now-dangling git worktree registrations so `git worktree
  # list` doesn't keep resurrecting the removed paths. Best-effort per repo.
  if [ -d "$dir/repos" ]; then
    for repo in "$dir"/repos/*/; do
      [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || continue
      git -C "$repo" worktree prune 2>/dev/null || true
    done
  fi
}

if [ "${BIVY_PRUNE_SESSIONS:-1}" != "0" ]; then
  if [ -n "${BIVY_DATA_DIR:-}" ]; then
    prune_bivy_dir "$BIVY_DATA_DIR"
  else
    # No explicit data dir: probe the usual spots a co-located node uses.
    prune_bivy_dir "$HOME/.bivy"
    prune_bivy_dir "/opt/bivy/.bivy"
    prune_bivy_dir "$(pwd)/.bivy"
  fi
fi

echo "== disk after prune =="
df -h / 2>/dev/null || true
