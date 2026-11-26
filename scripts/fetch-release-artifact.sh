#!/usr/bin/env bash
# Consumers can prepare their runners/guests while the producer builds. Wait
# only for this run's named artifact; never substitute a previous run's package.
# The producer's queue wait plus build can pass two minutes on a busy runner.
#
# The artifact is fetched here rather than with actions/download-artifact: its
# lookup can lag the REST listing for a moment, so a download started the
# instant the artifact appears sometimes fails with "Artifact not found". The
# zip is checked against the digest GitHub recorded at upload.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}"
dest=${1:-release-artifact}
api="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=release-package"
query='.artifacts[] | select(.name == "release-package" and .expired == false) | "\(.id) \(.digest // "")"'

found=
for ((i=0; i<150; i++)); do
  # API/auth errors fail immediately; an empty successful result means not ready.
  found=$(gh api "$api" --jq "$query" | head -n 1)
  if [ -n "$found" ]; then break; fi
  sleep 2
done
if [ -z "$found" ]; then
  echo 'Release package was not uploaded within 300 seconds' >&2
  exit 1
fi
read -r id digest <<<"$found"

zip=$(mktemp "${RUNNER_TEMP:-/tmp}/release-package.XXXXXX")
trap 'rm -f "$zip"' EXIT
for ((attempt=1; ; attempt++)); do
  if gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" >"$zip"; then break; fi
  if [ "$attempt" -ge 5 ]; then
    echo "Could not download release package $id" >&2
    exit 1
  fi
  sleep $((attempt * 3))
done

if [ -n "$digest" ]; then
  actual="sha256:$(shasum -a 256 "$zip" | cut -d' ' -f1)"
  if [ "$actual" != "$digest" ]; then
    echo "Release package digest mismatch: expected $digest, got $actual" >&2
    exit 1
  fi
fi
mkdir -p "$dest"
unzip -q -o "$zip" -d "$dest"
