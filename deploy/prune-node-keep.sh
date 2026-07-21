#!/usr/bin/env bash
# Count-based cleanup of a bivy node's session transcripts and git worktrees:
# keep the newest N of each, remove the rest. Complements deploy/prune.sh, which
# is age-based (older-than-N-days); this one is "keep the last N regardless of
# age", for a co-located / test node whose .bivy has piled up.
#
# Env:
#   BIVY_DATA_DIR   (required) the node data dir, e.g. /home/mesh/.bivy
#   BIVY_KEEP=5     how many of the newest sessions / worktrees to keep
#   DRY_RUN=1       list what WOULD be removed and delete nothing
#
# Safe to run repeatedly. Never touches Docker or named volumes.
set -euo pipefail

DATA_DIR="${BIVY_DATA_DIR:-}"
KEEP="${BIVY_KEEP:-5}"
DRY_RUN="${DRY_RUN:-0}"

case "$KEEP" in
  ''|*[!0-9]*) echo "BIVY_KEEP must be a non-negative integer (got: $KEEP)" >&2; exit 1 ;;
esac

# A bivy node keeps its state in <install-dir>/.bivy (bin/bivy.mjs: appDir =
# repoRoot/.bivy), NOT in ~/.bivy — so the exact path depends on where the node
# was installed. When BIVY_DATA_DIR is unset/missing/empty, search the box for
# candidate data dirs (those containing pi/sessions or */.bivy/worktrees) and
# print them, so the operator can re-run with the right path instead of guessing.
discover() {
  echo "Running as: $(id -un 2>/dev/null)   HOME: ${HOME:-?}"
  echo "Searching for bivy data dirs under /home /opt /root /srv ..."
  local found=0 base sdir ddir wroot cnt sz
  # A data dir is the parent of a pi/sessions directory.
  for base in /home /opt /root /srv; do
    [ -d "$base" ] || continue
    while IFS= read -r -d '' sdir; do
      ddir=$(dirname "$(dirname "$sdir")")
      cnt=$(find "$sdir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
      sz=$(du -sh "$ddir" 2>/dev/null | cut -f1)
      echo "  data dir: $ddir   (sessions: $cnt, size: ${sz:-?})"
      found=1
    done < <(find "$base" -maxdepth 7 -type d -path '*/pi/sessions' -print0 2>/dev/null)
  done
  # Worktree roots may exist independently of pi/sessions.
  for base in /home /opt /root /srv; do
    [ -d "$base" ] || continue
    while IFS= read -r -d '' wroot; do
      cnt=$(find "$wroot" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
      echo "  worktrees: $wroot   (count: $cnt)"
      found=1
    done < <(find "$base" -maxdepth 9 -type d -path '*/.bivy/worktrees' -print0 2>/dev/null)
  done
  [ "$found" = 1 ] || echo "  (nothing found — the path may be outside these roots or not readable by $(id -un 2>/dev/null))"
}

if [ -z "$DATA_DIR" ] || [ ! -d "$DATA_DIR" ]; then
  [ -n "$DATA_DIR" ] && echo "No such data dir: $DATA_DIR" >&2
  echo "-- discovering bivy data dirs on this host --" >&2
  discover >&2
  echo "Re-dispatch with data_dir set to one of the 'data dir:' paths above." >&2
  exit 2
fi

echo "== disk before =="; df -h / 2>/dev/null || true
echo "Data dir: $DATA_DIR   keep newest: $KEEP   dry-run: $DRY_RUN"

# From a NUL-separated stream of "<mtime>\t<path>" on stdin, emit (NUL-separated)
# the paths to REMOVE: sort newest-first by mtime, keep the first $KEEP, print
# the rest.
select_stale() {
  sort -zrn | tail -z -n "+$((KEEP + 1))" | cut -z -f2-
}

# Delete (or, in dry-run, list) the NUL-separated paths on stdin.
remove_list() {
  local label="$1" n=0 p
  while IFS= read -r -d '' p; do
    n=$((n + 1))
    if [ "$DRY_RUN" != "0" ]; then
      echo "  would remove: $p"
    else
      echo "  removing: $p"
      rm -rf -- "$p"
    fi
  done
  if [ "$DRY_RUN" != "0" ]; then
    echo "$label: $n would be removed (dry-run)"
  else
    echo "$label: $n removed"
  fi
}

# --- Sessions: <data>/pi/sessions/* ---
SESSIONS_DIR="$DATA_DIR/pi/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  total=$(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 | wc -l)
  echo "Sessions in $SESSIONS_DIR: $total (keeping newest $KEEP)"
  find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -printf '%T@\t%p\0' \
    | select_stale | remove_list "sessions"
else
  echo "No sessions dir at $SESSIONS_DIR"
fi

# --- Worktrees: every */.bivy/worktrees/* across the tree ---
# Combine candidates from all worktree roots so we keep the newest $KEEP
# worktrees overall (matching "keep the last N worktrees").
mapfile -d '' WT_ROOTS < <(find "$DATA_DIR" -type d -path '*/.bivy/worktrees' -print0 2>/dev/null || true)
if [ "${#WT_ROOTS[@]}" -gt 0 ]; then
  echo "Worktree roots: ${#WT_ROOTS[@]} (keeping newest $KEEP worktrees overall)"
  {
    for wtroot in "${WT_ROOTS[@]}"; do
      find "$wtroot" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\0' 2>/dev/null || true
    done
  } | select_stale | remove_list "worktrees"

  # Drop dangling git worktree registrations so `git worktree list` doesn't keep
  # resurrecting the removed paths. Best-effort per repo.
  if [ -d "$DATA_DIR/repos" ]; then
    for repo in "$DATA_DIR"/repos/*/; do
      [ -e "$repo/.git" ] || continue
      git -C "$repo" worktree prune 2>/dev/null || true
    done
  fi
else
  echo "No worktree roots under $DATA_DIR"
fi

echo "== disk after =="; df -h / 2>/dev/null || true
