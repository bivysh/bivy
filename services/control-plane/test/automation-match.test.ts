// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import {
  effectiveEventRules,
  eventRuleMatches,
  evaluateAccountAutomation,
  findAutomationOverlaps,
  labelsMatch,
  matchSourceAutomation,
  normalizeEventRules,
  repoAllowed,
  sourceAutomationSeedInput,
} from "../src/automation-match.js";
import type { AutomationDefinition } from "../src/store.js";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { findOverlaps as sharedFindOverlaps, matchFirst as sharedMatchFirst, type EvaluableAutomation } from "@bivy/automation-core";

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
  matchSourceAutomation(defs, {
    kind: "github",
    githubEvent: "issues",
    repo: "acme/api",
    labels: ["bivy"],
  })?.id,
  "b",
);
// Other repo falls through to the open allowlist automation.
assert.equal(
  matchSourceAutomation(defs, {
    kind: "github",
    githubEvent: "issues",
    repo: "acme/web",
    labels: ["bivy"],
  })?.id,
  "a",
);
// Disabled-only account → no match.
assert.equal(
  matchSourceAutomation([defs[2]!], {
    kind: "github",
    githubEvent: "issues",
    repo: "acme/api",
    labels: ["bivy"],
  }),
  undefined,
);
// Mentions skip label filter on issue_comment.
assert.equal(
  matchSourceAutomation(defs, {
    kind: "github",
    githubEvent: "issue_comment",
    repo: "acme/web",
    labels: ["bug"],
    mention: true,
  })?.id,
  "a",
);
// Linear only matches linear defs.
assert.equal(
  matchSourceAutomation(defs, { kind: "linear", labels: ["bivy"] })?.id,
  "d",
);

// Legacy github_ci rows match workflow_run deliveries via effective rules.
const ciDefs = [
  def({ id: "ci1", trigger: "github_ci", repos: ["acme/api"], createdAt: "2026-01-01T00:00:00.000Z" }),
  def({ id: "ci2", trigger: "github_ci", labels: ["CI"], createdAt: "2026-01-02T00:00:00.000Z" }),
];
assert.equal(
  matchSourceAutomation(ciDefs, {
    kind: "github",
    githubEvent: "workflow_run",
    action: "completed",
    repo: "acme/api",
    labels: [],
    workflowName: "CI",
    conclusion: "failure",
  })?.id,
  "ci1",
);
assert.equal(
  matchSourceAutomation(ciDefs, {
    kind: "github",
    githubEvent: "workflow_run",
    action: "completed",
    repo: "acme/other",
    labels: [],
    workflowName: "CI",
    conclusion: "failure",
  })?.id,
  "ci2",
);
assert.equal(
  matchSourceAutomation(ciDefs, {
    kind: "github",
    githubEvent: "workflow_run",
    action: "completed",
    repo: "acme/other",
    labels: [],
    workflowName: "Deploy",
    conclusion: "failure",
  }),
  undefined,
);

// Explicit `on` rules: PR labeled + review mention on a modern github row.
const modern = def({
  id: "m1",
  trigger: "github",
  on: [
    { event: "pull_request", labels: ["bivy"] },
    { event: "pull_request_review_comment", mention: true },
    { event: "workflow_run", conclusions: ["failure"] },
  ],
});
assert.ok(eventRuleMatches(modern.on![0]!, {
  kind: "github",
  githubEvent: "pull_request",
  labels: ["bivy"],
}));
assert.equal(
  matchSourceAutomation([modern], {
    kind: "github",
    githubEvent: "pull_request",
    labels: ["bivy"],
    repo: "o/r",
  })?.id,
  "m1",
);
assert.equal(
  matchSourceAutomation([modern], {
    kind: "github",
    githubEvent: "issues",
    labels: ["bivy"],
    repo: "o/r",
  }),
  undefined,
  "explicit on[] does not inherit legacy issues default",
);
assert.equal(
  matchSourceAutomation([modern], {
    kind: "github",
    githubEvent: "workflow_run",
    action: "completed",
    conclusion: "failure",
    labels: [],
    repo: "o/r",
  })?.id,
  "m1",
);

// Legacy github without on → issues + issue_comment only (not PR).
const legacyRules = effectiveEventRules(def({ id: "lg", trigger: "github", labels: ["bivy"] }));
assert.deepEqual(legacyRules.map((r) => r.event), ["issues", "issue_comment"]);

// normalizeEventRules validates.
assert.throws(() => normalizeEventRules([{ event: "star" }]));
assert.equal(normalizeEventRules([{ event: "issues", labels: ["bivy"] }])?.[0]?.event, "issues");

// Seed + pause: disabled github automation stops matching after seed path.
const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount("match@example.com");
await store.createInboundHook(account.id, "github_app");
await store.createAutomationDefinition(account.id, sourceAutomationSeedInput("github"));
const seeded = await store.listAutomationDefinitions(account.id);
assert.equal(seeded.length, 1);
assert.equal(seeded[0]?.trigger, "github");
assert.equal(seeded[0]?.templateId, "issue-to-pr");
assert.ok(seeded[0]?.on?.length, "seed writes explicit on[]");
assert.ok(matchSourceAutomation(seeded, {
  kind: "github",
  githubEvent: "issues",
  repo: "o/r",
  labels: ["bivy"],
}));
// Seed includes PR surfaces.
assert.ok(matchSourceAutomation(seeded, {
  kind: "github",
  githubEvent: "pull_request",
  repo: "o/r",
  labels: ["bivy"],
}));

await store.updateAutomationDefinition(account.id, seeded[0]!.id, { enabled: false });
const paused = await store.listAutomationDefinitions(account.id);
assert.equal(
  matchSourceAutomation(paused, {
    kind: "github",
    githubEvent: "issues",
    repo: "o/r",
    labels: ["bivy"],
  }),
  undefined,
);

// Filters round-trip on update (labels / repos / node / on) and gate matching.
await store.updateAutomationDefinition(account.id, seeded[0]!.id, {
  enabled: true,
  labels: ["agent"],
  repos: ["acme/api"],
  nodeLabel: "bivy/macbook",
  on: [{ event: "issues", labels: ["agent"] }],
});
const filtered = await store.listAutomationDefinitions(account.id);
assert.deepEqual(filtered[0]?.labels, ["agent"]);
assert.deepEqual(filtered[0]?.repos, ["acme/api"]);
assert.equal(filtered[0]?.nodeLabel, "bivy/macbook");
assert.equal(filtered[0]?.on?.[0]?.event, "issues");

// Automation-as-code metadata survives storage and becomes the hard ceiling on
// every run created from the definition.
const managed = await store.createAutomationDefinition(account.id, {
  name: "Managed CI",
  configKey: "managed-ci",
  configOrder: 0,
  enabled: true,
  trigger: "manual",
  maxAttempts: 2,
});
assert.equal((await store.listAutomationDefinitions(account.id)).find((d) => d.id === managed.id)?.configKey, "managed-ci");
assert.equal((await store.listAutomationDefinitions(account.id)).find((d) => d.id === managed.id)?.configOrder, 0);
assert.equal((await store.listAutomationDefinitions(account.id)).find((d) => d.id === managed.id)?.maxAttempts, 2);
const managedRun = await store.enqueueAutomationRun(account.id, {
  source: "manual",
  title: "Managed CI",
  definitionId: managed.id,
});
const managedWork = (await store.listWorkItems(account.id)).find((w) => w.id === managedRun.id);
assert.equal(managedWork?.maxAttempts, 2);

assert.equal(
  matchSourceAutomation(filtered, {
    kind: "github",
    githubEvent: "issues",
    repo: "acme/api",
    labels: ["agent"],
  })?.id,
  filtered[0]?.id,
);
assert.equal(
  matchSourceAutomation(filtered, {
    kind: "github",
    githubEvent: "issues",
    repo: "acme/other",
    labels: ["agent"],
  }),
  undefined,
);

// github_ci seed is paused by default.
await store.createAutomationDefinition(account.id, sourceAutomationSeedInput("github_ci"));
const withCi = await store.listAutomationDefinitions(account.id);
const ci = withCi.find((d) => d.trigger === "github_ci");
assert.ok(ci);
assert.equal(ci.enabled, false);
assert.equal(ci.templateId, "fix-ci");
assert.equal(
  matchSourceAutomation(withCi, {
    kind: "github",
    githubEvent: "workflow_run",
    action: "completed",
    conclusion: "failure",
    repo: "acme/api",
    labels: [],
  }),
  undefined,
);
await store.updateAutomationDefinition(account.id, ci.id, { enabled: true });
const ciOn = await store.listAutomationDefinitions(account.id);
assert.ok(matchSourceAutomation(ciOn, {
  kind: "github",
  githubEvent: "workflow_run",
  action: "completed",
  conclusion: "failure",
  repo: "acme/api",
  labels: [],
}));

// Parity: the control-plane adapters (matchSourceAutomation,
// findAutomationOverlaps) and the shared core they delegate to
// (@bivy/automation-core) produce IDENTICAL results for equivalent input —
// not just "the same rules", the same code path. This is what
// docs/automation-evaluator.md's "literally the same code" claim rests on;
// a regression here means the control plane silently forked behavior from
// config-as-code's `bivy automation test`.
const parityDefs: AutomationDefinition[] = [
  def({ id: "wide", trigger: "github", createdAt: "2026-01-01T00:00:00.000Z", on: [{ event: "issues" }] }),
  def({ id: "narrow", trigger: "github", createdAt: "2026-01-02T00:00:00.000Z", on: [{ event: "issues", actions: ["labeled"] }] }),
];
const parityEvaluable: EvaluableAutomation[] = [
  { id: "wide", enabled: true, trigger: "github", on: [{ event: "issues" }] },
  { id: "narrow", enabled: true, trigger: "github", on: [{ event: "issues", actions: ["labeled"] }] },
];
const viaAdapter = matchSourceAutomation(parityDefs, { kind: "github", githubEvent: "issues", action: "labeled", repo: undefined, labels: ["bivy"] });
const viaShared = sharedMatchFirst(parityEvaluable, { kind: "github", event: "issues", action: "labeled", labels: ["bivy"] }).matched;
assert.equal(viaAdapter?.id, "wide", "the adapter's first-match winner is the earlier, broader automation");
assert.equal(viaAdapter?.id, viaShared?.id, "the control-plane adapter and the shared core agree on the winner");

const overlapsAdapter = findAutomationOverlaps(parityDefs);
const overlapsShared = sharedFindOverlaps(parityEvaluable);
assert.deepEqual(overlapsAdapter, overlapsShared, "overlap findings are identical, not just similarly-shaped");
assert.equal(overlapsAdapter[0]?.kind, "shadowed");

const priorityDefs: AutomationDefinition[] = [
  def({ id: "old", trigger: "github", createdAt: "2026-01-01T00:00:00.000Z", configOrder: 2, on: [{ event: "issues" }] }),
  def({ id: "new", trigger: "github", createdAt: "2026-01-02T00:00:00.000Z", configOrder: 1, on: [{ event: "issues" }] }),
];
assert.equal(
  matchSourceAutomation(priorityDefs, { kind: "github", githubEvent: "issues", repo: undefined, labels: ["bivy"] })?.id,
  "new",
  "explicit configOrder controls first-match priority for UI-managed automations too",
);
assert.equal(
  evaluateAccountAutomation(
    priorityDefs[0]!,
    priorityDefs,
    { kind: "github", event: "issues", labels: ["bivy"] },
    { hooks: [], nodes: [] },
  ).match?.matched?.id,
  "new",
  "simulate/preflight evaluation uses the same configOrder priority as live intake",
);


const appScopedDefs: AutomationDefinition[] = [
  def({ id: "hosted", trigger: "github", appId: "hosted-app", createdAt: "2026-01-01T00:00:00.000Z", on: [{ event: "issues" }] }),
  def({ id: "custom", trigger: "github", appId: "custom-app", createdAt: "2026-01-02T00:00:00.000Z", on: [{ event: "issues" }] }),
];
assert.equal(
  matchSourceAutomation(appScopedDefs, { kind: "github", appId: "custom-app", githubEvent: "issues", labels: ["bivy"] })?.id,
  "custom",
  "GitHub source automations can be scoped to a specific hosted or custom app",
);


console.log("automation-match tests passed");
