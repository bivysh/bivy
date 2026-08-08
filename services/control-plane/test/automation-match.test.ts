// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import {
  labelsMatch,
  matchSourceAutomation,
  repoAllowed,
  sourceAutomationSeedInput,
} from "../src/automation-match.js";
import type { AutomationDefinition } from "../src/store.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

function def(partial: Partial<AutomationDefinition> & Pick<AutomationDefinition, "id" | "trigger">): AutomationDefinition {
  return {
    accountId: "acc",
    name: partial.name || "Test",
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt || "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt || "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

assert.equal(labelsMatch(undefined, ["bivy"]), true);
assert.equal(labelsMatch(undefined, ["bivy/macbook"]), true);
assert.equal(labelsMatch(undefined, ["bug"]), false);
assert.equal(labelsMatch(["agent"], ["agent/linux"]), true);
assert.equal(labelsMatch(["agent"], ["bivy"]), false);

assert.equal(repoAllowed(undefined, "acme/api"), true);
assert.equal(repoAllowed(["acme/api"], "acme/api"), true);
assert.equal(repoAllowed(["acme/api"], "acme/other"), false);
assert.equal(repoAllowed(["acme/api"], undefined), false);

const defs = [
  def({ id: "a", trigger: "github", labels: ["bivy"], createdAt: "2026-01-02T00:00:00.000Z" }),
  def({ id: "b", trigger: "github", labels: ["bivy"], repos: ["acme/api"], createdAt: "2026-01-01T00:00:00.000Z" }),
  def({ id: "c", trigger: "github", enabled: false, createdAt: "2026-01-01T00:00:00.000Z" }),
  def({ id: "d", trigger: "linear", createdAt: "2026-01-01T00:00:00.000Z" }),
];

// Earlier createdAt wins among matches — b is older and repo-specific.
assert.equal(
  matchSourceAutomation(defs, { kind: "github", repo: "acme/api", labels: ["bivy"] })?.id,
  "b",
);
// Other repo falls through to the open allowlist automation.
assert.equal(
  matchSourceAutomation(defs, { kind: "github", repo: "acme/web", labels: ["bivy"] })?.id,
  "a",
);
// Disabled-only account → no match.
assert.equal(
  matchSourceAutomation([defs[2]!], { kind: "github", repo: "acme/api", labels: ["bivy"] }),
  undefined,
);
// Mentions skip label filter.
assert.equal(
  matchSourceAutomation(defs, { kind: "github", repo: "acme/web", labels: ["bug"], mention: true })?.id,
  "a",
);
// Linear only matches linear defs.
assert.equal(
  matchSourceAutomation(defs, { kind: "linear", labels: ["bivy"] })?.id,
  "d",
);

// CI failures match github_ci by repo (+ optional workflow name via labels).
const ciDefs = [
  def({ id: "ci1", trigger: "github_ci", repos: ["acme/api"], createdAt: "2026-01-01T00:00:00.000Z" }),
  def({ id: "ci2", trigger: "github_ci", labels: ["CI"], createdAt: "2026-01-02T00:00:00.000Z" }),
];
assert.equal(
  matchSourceAutomation(ciDefs, { kind: "github_ci", repo: "acme/api", labels: [], workflowName: "CI" })?.id,
  "ci1",
);
assert.equal(
  matchSourceAutomation(ciDefs, { kind: "github_ci", repo: "acme/other", labels: [], workflowName: "CI" })?.id,
  "ci2",
);
assert.equal(
  matchSourceAutomation(ciDefs, { kind: "github_ci", repo: "acme/other", labels: [], workflowName: "Deploy" }),
  undefined,
);

// Seed + pause: disabled github automation stops matching after seed path.
const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("match@example.com");
await store.createInboundHook(account.id, "github_app");
// No automation yet — create seed as the list endpoint would.
await store.createAutomationDefinition(account.id, sourceAutomationSeedInput("github"));
const seeded = await store.listAutomationDefinitions(account.id);
assert.equal(seeded.length, 1);
assert.equal(seeded[0]?.trigger, "github");
assert.equal(seeded[0]?.templateId, "issue-to-pr");
assert.ok(matchSourceAutomation(seeded, { kind: "github", repo: "o/r", labels: ["bivy"] }));

await store.updateAutomationDefinition(account.id, seeded[0]!.id, { enabled: false });
const paused = await store.listAutomationDefinitions(account.id);
assert.equal(
  matchSourceAutomation(paused, { kind: "github", repo: "o/r", labels: ["bivy"] }),
  undefined,
);

console.log("automation-match tests passed");
