// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { parseGithubCommentEvent, parseGithubReviewCommentEvent } from "../src/webhooks.js";

for (const [surface, parse, itemKey] of [
  ["issue conversation", parseGithubCommentEvent, "issue"],
  ["review thread", parseGithubReviewCommentEvent, "pull_request"],
] as const) {
  const payload = (body: string, login: string, action = "created") => ({
    action,
    repository: { full_name: "acme/api" },
    [itemKey]: { number: 183, title: "Test", labels: [{ name: "custom-label" }] },
    comment: { body, user: { login }, author_association: "OWNER" },
  });

  test(`${surface}: Bivy continuation instructions cannot feed back into intake`, () => {
    // The real outcome from #183; the marker survives either bot or user auth,
    // and must also suppress cross-node echoes and edits to an existing comment.
    const body = "🤖 Pushed `bivy/issue-183` but didn't open a pull request. Comment `@bivy` again to continue, or open one from the session's chat (`/pr`).\n\n<!-- bivy:comment:pushed:bivy/issue-183 -->";
    for (const login of ["owner", "bivy-test[bot]", "bivy-staging[bot]"]) {
      for (const action of ["created", "edited"]) {
        assert.equal(parse(payload(body, login, action), "bivy"), undefined);
      }
    }
  });

  test(`${surface}: real follow-ups still work with custom labels and handles`, () => {
    for (const action of ["created", "edited"]) {
      const body = "@custom-agent please continue";
      const parsed = parse(payload(body, "owner", action), "custom-agent");
      assert.equal(parsed?.instruction, body);
    }
    // Do not blacklist an owner's identity or every external bot.
    assert.ok(parse(payload("@bivy please continue", "other-tool[bot]"), "bivy"));
  });
}

test("PR conversation comments use the same output suppression as issue comments", () => {
  const payload = {
    action: "created", repository: { full_name: "acme/api" },
    issue: { number: 184, pull_request: {} },
    comment: { body: "@bivy continue\n\n<!-- bivy:comment:pickup -->" },
  };
  assert.equal(parseGithubCommentEvent(payload, "bivy"), undefined);
});
