// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import test from "node:test";
import { buildGithubOn, togglesFromAutomation, type GithubEventToggles } from "../packages/web/src/components/githubAutomationEvents.js";
import { matchFirst } from "../src/automation/match.js";

const mentionsOnly: GithubEventToggles = {
  issuesLabeled: false, issueMention: true, prLabeled: false, prMention: false, workflowFailed: false,
};

test("mention toggle enables bodies and comments without requiring labels", () => {
  const on = buildGithubOn(mentionsOnly, ["bivy"], undefined);
  for (const event of ["issues", "pull_request", "issue_comment"] as const) {
    for (const action of event === "issue_comment" ? ["created", "edited"] : ["opened", "edited", "reopened"]) {
      const definitions = [{ id: "test", enabled: true, trigger: "github" as const, on }];
      assert.ok(matchFirst(definitions, { kind: "github", event, action, labels: [], mention: true }).matched);
      assert.equal(matchFirst(definitions, { kind: "github", event, action, labels: ["bivy"], mention: false }).matched, undefined);
    }
  }
});

test("all checkbox combinations round-trip without enabling label triggers from body rules", () => {
  const keys = Object.keys(mentionsOnly) as (keyof GithubEventToggles)[];
  // Empty on[] has separate legacy-default semantics; test nonempty selections.
  for (let mask = 1; mask < 32; mask++) {
    const toggles = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))])) as GithubEventToggles;
    const on = buildGithubOn(toggles, ["ready"], ["CI"]);
    assert.deepEqual(togglesFromAutomation({ trigger: "github", on }), toggles);
  }
});

test("saving an existing comment-mention automation adds body rules; disabling removes them", () => {
  const toggles = togglesFromAutomation({ trigger: "github", on: [{ event: "issue_comment", mention: true }] });
  assert.deepEqual(toggles, mentionsOnly);
  assert.deepEqual(buildGithubOn(toggles, undefined, undefined).map((rule) => rule.event), ["issues", "pull_request", "issue_comment"]);
  assert.deepEqual(buildGithubOn({ ...toggles, issueMention: false, issuesLabeled: true }, undefined, undefined), [
    { event: "issues", labels: ["bivy"] },
  ]);
});
