// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import test from "node:test";
import { matchGithubItemTrigger } from "../src/github-item-trigger.js";
import type { AutomationDefinition } from "../src/store.js";

for (const event of ["issues", "pull_request"] as const) {
  const automation = (patch: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
    id: "custom", accountId: "account", name: "Custom label automation", trigger: "github", enabled: true,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    on: [{ event, actions: ["labeled"], labels: ["ready for review", "🤖 fix-it"] }],
    ...patch,
  });
  const payload = (label: string, existing: string[] = []) => ({
    action: "labeled", label: { name: label }, repository: { full_name: "acme/api" },
    [event === "issues" ? "issue" : "pull_request"]: {
      number: 7, title: "Fix it", body: "", labels: [...existing, label].map((name) => ({ name })), author_association: "NONE",
    },
  });

  test(`${event}: arbitrary configured labels trigger without a bivy label or mention`, () => {
    for (const appId of ["hosted-app", "custom-app"]) {
      for (const label of ["ready for review", "🤖 fix-it"]) {
        const selected = matchGithubItemTrigger([automation({ appId })], { appId, triggerAccess: "collaborator" }, event, payload(label), "bivy-sh");
        assert.equal(selected.matched, true);
        if (selected.matched) {
          assert.equal(selected.automation.id, "custom");
          assert.equal(selected.routingLabel, "bivy", "trigger labels do not become machine routing labels");
        }
      }
    }
  });

  test(`${event}: only the newly applied label triggers; unrelated additions do not re-fire`, () => {
    assert.equal(matchGithubItemTrigger([automation()], {}, event, payload("unrelated", ["ready for review"]), "bivy-sh").matched, false);
    assert.equal(matchGithubItemTrigger([automation()], {}, event, payload("bivy"), "bivy-sh").matched, false);
  });

  test(`${event}: pause, repository, app, and event filters remain authoritative`, () => {
    for (const definition of [
      automation({ enabled: false }), automation({ repos: ["acme/other"] }), automation({ appId: "other-app" }),
      automation({ on: [{ event, actions: ["opened"], labels: ["ready for review"] }] }),
    ]) {
      assert.equal(matchGithubItemTrigger([definition], { appId: "this-app" }, event, payload("ready for review"), "bivy-sh").matched, false);
    }
  });

  test(`${event}: bivy remains the default and legacy machine routing still works`, () => {
    const definition = automation({ on: [{ event, actions: ["labeled"] }] });
    assert.equal(matchGithubItemTrigger([definition], {}, event, payload("unrelated"), "bivy-sh").matched, false);
    const selected = matchGithubItemTrigger([definition], {}, event, payload("bivy/laptop"), "bivy-sh");
    assert.equal(selected.matched, true);
    if (selected.matched) assert.equal(selected.routingLabel, "bivy/laptop");
  });

  test(`${event}: custom labels do not fabricate a mention or bypass mention permissions`, () => {
    const definition = automation({ on: [{ event, mention: true }] });
    const value = payload("ready for review");
    assert.equal(matchGithubItemTrigger([definition], {}, event, value, "bivy-sh").matched, false);
    const item = value[event === "issues" ? "issue" : "pull_request"]!;
    item.body = "@bivy-sh on laptop fix it";
    const denied = matchGithubItemTrigger([definition], { triggerAccess: "collaborator" }, event, value, "bivy-sh");
    assert.deepEqual(denied, { matched: false, reason: "access" });
    item.author_association = "COLLABORATOR";
    item.labels = [];
    const allowed = matchGithubItemTrigger([definition], { triggerAccess: "collaborator" }, event, { ...value, action: "edited" }, "bivy-sh");
    assert.equal(allowed.matched, true);
    if (allowed.matched) assert.equal(allowed.routingLabel, "bivy/laptop");
  });
}
