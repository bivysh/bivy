#!/usr/bin/env bash
set -euo pipefail

# Apply branch + tag protection rulesets to this repo.
#
# Rulesets require a public repo or a paid org plan. While bivysh is on the free
# plan and bivy is private, the API returns 403 and there is no way to protect
# main at all -- this script exists so that protection is one command at the
# moment the repo goes public, instead of a set of settings-page clicks nobody
# remembers the shape of.
#
# Usage:
#   scripts/protect-repo.sh              # apply
#   DRY_RUN=1 scripts/protect-repo.sh    # print payloads, change nothing
#
# Idempotent: an existing ruleset of the same name is updated in place, so
# re-running after an edit is safe.
#
# Requires: gh CLI authenticated with admin on this repo.

REPO="${REPO:-bivysh/bivy}"
DRY_RUN="${DRY_RUN:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required. Install it and run: gh auth login" >&2
  exit 1
fi

# Fail early with the real reason rather than a bare 403 from the first POST.
# Skipped under DRY_RUN: the main reason to dry-run is to review the payloads
# while the repo is still private, which is exactly when this check fails.
if [ -z "$DRY_RUN" ]; then
  visibility="$(gh api "repos/$REPO" --jq .visibility 2>/dev/null || true)"
  if [ -z "$visibility" ]; then
    echo "Error: cannot read $REPO -- check gh auth status." >&2
    exit 1
  fi
  if ! gh api "repos/$REPO/rulesets" >/dev/null 2>&1; then
    echo "Error: rulesets unavailable for $REPO (visibility: $visibility)." >&2
    echo "       Make the repo public, or upgrade the org to GitHub Team." >&2
    exit 1
  fi
fi

# The single required status check is ci-ok, the always() aggregate job at the
# end of ci.yml. Requiring the individual jobs instead would deadlock every PR:
# they are gated on path filters, so a docs-only change leaves most of them
# skipped, and a required check that never reports blocks the merge forever.
# ci-ok collapses that into one honest pass/fail.
#
# required_approving_review_count is 0 on purpose. GitHub forbids approving your
# own PR, so any higher number makes a solo maintainer unable to merge at all.
# The protection here is "changes arrive via PR with green CI", not peer review.
# Raise this to 1 -- and flip require_code_owner_review -- when there is a second
# maintainer to do the approving.
read -r -d '' BRANCH_RULESET <<'JSON' || true
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 0,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": false,
      "require_last_push_approval": false,
      "required_review_thread_resolution": true,
      "allowed_merge_methods": ["squash"]}},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [{"context": "ci-ok"}]}}
  ],
  "bypass_actors": []
}
JSON

# release.yml's production job publishes to npm and then pushes a v* tag for the
# release. npm trusted publishing already pins the publisher to this repo and this
# workflow file, so nothing else can impersonate the release path -- but that says
# nothing about *which commit* a tag points at. Without this, anyone with write
# access could move or delete a release tag. Tags become append-only.
read -r -d '' TAG_RULESET <<'JSON' || true
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "update"}
  ],
  "bypass_actors": []
}
JSON

apply() {
  local name="$1" payload="$2" id

  if [ -n "$DRY_RUN" ]; then
    echo "--- would apply ruleset: $name ---"
    echo "$payload"
    return
  fi

  # Match on name so a re-run updates rather than creating a duplicate; GitHub
  # happily accepts two rulesets with the same name and ANDs their rules, which
  # is confusing to unpick later.
  id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null | head -1)"

  if [ -n "$id" ]; then
    echo "$payload" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null
    echo "updated ruleset: $name (id $id)"
  else
    echo "$payload" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null
    echo "created ruleset: $name"
  fi
}

apply "main" "$BRANCH_RULESET"
apply "release-tags" "$TAG_RULESET"

if [ -z "$DRY_RUN" ]; then
  echo
  echo "Done. Remaining steps are not API-automatable on a free plan:"
  echo "  - Settings > Code security: enable secret scanning + PUSH PROTECTION"
  echo "  - Settings > Code security: enable CodeQL default setup"
  echo "  - Settings > Actions > Fork pull request workflows:"
  echo "      set approval to 'Require approval for all external contributors'"
  echo "  - Settings > Environments: add 'release' with yourself as a required"
  echo "    reviewer, then reference it from the publish job in release.yml"
fi
