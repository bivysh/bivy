#!/usr/bin/env bash
# Consumers can prepare their runners/guests while the producer builds. Wait
# only for this run's named artifact; never substitute a previous run's package.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}"
for ((i=0; i<60; i++)); do
  # API/auth errors fail immediately; an empty successful result means not ready.
  id=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts" \
    --jq '.artifacts[] | select(.name == "release-package" and .expired == false) | .id')
  if [ -n "$id" ]; then exit 0; fi
  sleep 2
done
echo 'Release package was not uploaded within 120 seconds' >&2
exit 1
