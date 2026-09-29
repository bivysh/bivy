#!/usr/bin/env bash
# Print "true" if a pull-request CI run already passed on exactly this tree.
#
#   scripts/find-ci-receipt.sh <queue-head-ref>
#
# A green PR run uploads a `ci-receipt-<tree>` artifact (see ci-ok in
# .github/workflows/ci.yml), where <tree> is the tree of the merge it tested.
# When main has not moved since, the merge queue builds the identical tree, so
# re-running every lane on it would only repeat the same result.
#
# A receipt counts only if it came from this repository (not a fork) and from a
# run of the PR's current head commit, so no other branch can vouch for the
# code being merged. Any lookup failure prints "false": the queue then runs the
# usual checks, which is always safe.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GH_TOKEN:?}"
queue_ref="${1:?queue head ref}"

found=false
# refs/heads/gh-readonly-queue/<base>/pr-<number>-<base sha>
pr="$(sed -nE 's#^refs/heads/gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$#\1#p' <<<"$queue_ref")"
if [ -n "$pr" ]; then
  tree="$(git rev-parse 'HEAD^{tree}')"
  if head="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$pr" --jq .head.sha 2>/dev/null)" &&
     receipts="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=ci-receipt-$tree" \
       --jq "[.artifacts[] | select(.expired == false
               and .workflow_run.head_sha == \"$head\"
               and .workflow_run.head_repository_id == .workflow_run.repository_id)] | length" 2>/dev/null)" &&
     [ "${receipts:-0}" -gt 0 ]; then
    found=true
  fi
  echo "PR #$pr head ${head:-?}, tree $tree: receipt $found" >&2
fi
echo "$found"
