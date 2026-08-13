// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Unit tests for the shared automation evaluator (src/automation) — the single
// canonical first-match/overlap/preflight contract shared by config-as-code
// `test`, the control-plane simulate endpoint, and the PWA Test event workflow.
// See test/automation-config.test.ts and services/control-plane/test/
// automation-match.test.ts for the parity tests that check each call site
// delegates here rather than re-implementing the contract.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAutomation, findOverlaps, gateFromChecks, matchFirst, runPreflightChecks } from "../src/automation/index.js";
import type { EvaluableAutomation } from "../src/automation/types.js";

function automation(partial: Partial<EvaluableAutomation> & Pick<EvaluableAutomation, "id" | "trigger">): EvaluableAutomation {
  return { enabled: true, ...partial };
}

test("matchFirst: first enabled candidate in caller order wins", () => {
  const candidates = [
    automation({ id: "a", trigger: "github", repos: ["acme/api"] }),
    automation({ id: "b", trigger: "github" }),
  ];
  const result = matchFirst(candidates, { kind: "github", repo: "acme/api", event: "issues", labels: ["bivy"] });
  assert.equal(result.matched?.id, "a");
  assert.deepEqual(result.trail[0], { id: "a", matched: true, reason: "first matching enabled automation" });
});

test("matchFirst: explains every candidate, not just the winner", () => {
  const candidates = [
    automation({ id: "disabled", trigger: "github", enabled: false }),
    automation({ id: "wrong-trigger", trigger: "linear" }),
    automation({ id: "wrong-repo", trigger: "github", repos: ["acme/other"] }),
    automation({ id: "no-rule", trigger: "github", on: [{ event: "pull_request" }] }),
    automation({ id: "winner", trigger: "github" }),
  ];
  const result = matchFirst(candidates, { kind: "github", repo: "acme/api", event: "issues", labels: ["bivy"] });
  assert.equal(result.matched?.id, "winner");
  assert.deepEqual(result.trail.map((t) => [t.id, t.matched, t.reason]), [
    ["disabled", false, "disabled"],
    ["wrong-trigger", false, "trigger is linear"],
    ["wrong-repo", false, "repository is not allowed"],
    ["no-rule", false, "no event rule matched"],
    ["winner", true, "first matching enabled automation"],
  ]);
});

test("matchFirst: linear labels-only contract", () => {
  const candidates = [automation({ id: "l", trigger: "linear", labels: ["agent"] })];
  assert.equal(matchFirst(candidates, { kind: "linear", labels: ["agent"] }).matched?.id, "l");
  assert.equal(matchFirst(candidates, { kind: "linear", labels: ["other"] }).matched, undefined);
  assert.equal(matchFirst(candidates, { kind: "linear", mention: true, labels: [] }).matched?.id, "l");
});

test("matchFirst: no candidates matches returns an empty trail and no match", () => {
  const result = matchFirst([], { kind: "github", event: "issues", labels: ["bivy"] });
  assert.equal(result.matched, undefined);
  assert.deepEqual(result.trail, []);
});

test("findOverlaps: a broader earlier automation shadows a narrower later one", () => {
  const candidates = [
    automation({ id: "catch-all", trigger: "github", on: [{ event: "issues" }] }),
    automation({ id: "narrow", trigger: "github", on: [{ event: "issues", actions: ["labeled"] }] }),
  ];
  const findings = findOverlaps(candidates);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "shadowed");
  assert.equal(findings[0]?.beforeId, "catch-all");
  assert.equal(findings[0]?.afterId, "narrow");
});

test("findOverlaps: narrower-then-broader is not shadowed (order matters)", () => {
  const candidates = [
    automation({ id: "narrow", trigger: "github", on: [{ event: "issues", actions: ["labeled"] }] }),
    automation({ id: "catch-all", trigger: "github", on: [{ event: "issues" }] }),
  ];
  const findings = findOverlaps(candidates);
  assert.equal(findings.some((f) => f.kind === "shadowed"), false);
  assert.ok(findings.some((f) => f.kind === "overlaps" && f.beforeId === "narrow" && f.afterId === "catch-all"));
});

test("findOverlaps: distinct label filters overlap (not shadowed) because an event can carry both labels", () => {
  const candidates = [
    automation({ id: "bug-triage", trigger: "github", on: [{ event: "issues", labels: ["bug"] }] }),
    automation({ id: "bivy-default", trigger: "github", on: [{ event: "issues" }] }),
  ];
  const findings = findOverlaps(candidates);
  assert.equal(findings.some((f) => f.kind === "shadowed"), false);
  assert.ok(findings.some((f) => f.kind === "overlaps"));
});

test("findOverlaps: disjoint repo scopes never overlap", () => {
  const candidates = [
    automation({ id: "a", trigger: "github", repos: ["acme/api"], on: [{ event: "issues" }] }),
    automation({ id: "b", trigger: "github", repos: ["acme/web"], on: [{ event: "issues" }] }),
  ];
  assert.deepEqual(findOverlaps(candidates), []);
});

test("findOverlaps: disabled automations are excluded from overlap detection", () => {
  const candidates = [
    automation({ id: "a", trigger: "github", enabled: false, on: [{ event: "issues" }] }),
    automation({ id: "b", trigger: "github", on: [{ event: "issues" }] }),
  ];
  assert.deepEqual(findOverlaps(candidates), []);
});

test("findOverlaps: schedule/webhook/manual triggers are excluded (no first-match ambiguity)", () => {
  const candidates = [
    automation({ id: "a", trigger: "schedule" }),
    automation({ id: "b", trigger: "webhook" }),
    automation({ id: "c", trigger: "manual" }),
  ];
  assert.deepEqual(findOverlaps(candidates), []);
});

test("preflight: no signals means every check reports skipped, never blocks", () => {
  const results = runPreflightChecks({});
  assert.equal(results.length, 7);
  assert.ok(results.every((r) => r.severity === "skipped"));
  assert.equal(gateFromChecks(results).blocked, false);
});

test("preflight: missing encrypted instructions blocks save", () => {
  const results = runPreflightChecks({ encryptedKeyOwnership: { required: true, hasCiphertext: false } });
  const gate = gateFromChecks(results);
  assert.equal(gate.blocked, true);
  assert.equal(gate.blockingChecks[0]?.id, "encrypted_key_ownership");
});

test("preflight: unsafe autonomous + danger-full-access combo blocks save", () => {
  const results = runPreflightChecks({
    sandboxPolicy: {
      requestedApproval: "autonomous",
      requestedSandbox: "danger-full-access",
      effectiveApproval: "autonomous",
      effectiveSandbox: "danger-full-access",
      unsafeCombo: true,
    },
  });
  assert.equal(gateFromChecks(results).blocked, true);
});

test("preflight: explicitly-requested agent with no credentials blocks; unset agent only warns", () => {
  const explicit = gateFromChecks(runPreflightChecks({ agentModelCredentials: { agent: "codex", ready: false, explicit: true } }));
  assert.equal(explicit.blocked, true);

  const implicit = gateFromChecks(runPreflightChecks({ agentModelCredentials: { ready: false, explicit: false } }));
  assert.equal(implicit.blocked, false);
  assert.equal(implicit.requiresAck, true);
});

test("preflight: offline machine with a fallback warns and requires acknowledgement, does not block", () => {
  const gate = gateFromChecks(runPreflightChecks({
    assignedMachine: { primaryOnline: false, fallbackAvailable: true },
  }));
  assert.equal(gate.blocked, false);
  assert.equal(gate.requiresAck, true);
});

test("preflight: offline machine with no fallback still only warns (queues rather than blocks)", () => {
  const gate = gateFromChecks(runPreflightChecks({
    assignedMachine: { primaryOnline: false, fallbackAvailable: false, sharedQueueHasOnlineNode: false },
  }));
  assert.equal(gate.blocked, false);
  assert.equal(gate.requiresAck, true);
});

test("preflight: exhausted quota reports block severity but is not a save-blocker", () => {
  const results = runPreflightChecks({ quota: { limit: 10, used: 11, exhausted: true } });
  const quotaCheck = results.find((r) => r.id === "quota");
  assert.equal(quotaCheck?.severity, "block");
  assert.equal(quotaCheck?.blocksSave, false);
  assert.equal(gateFromChecks(results).blocked, false);
});

test("preflight: a clean checklist across every signal requires no acknowledgement", () => {
  const results = runPreflightChecks({
    sourceConnection: { required: true, connected: true },
    repoAccess: { required: true, configuredRepos: ["acme/api"], knownInstalled: true },
    encryptedKeyOwnership: { required: true, hasCiphertext: true, ownerNodeOnline: true },
    assignedMachine: { primaryOnline: true },
    agentModelCredentials: { ready: true, explicit: true },
    sandboxPolicy: { requestedApproval: "risky", requestedSandbox: "workspace-write", effectiveApproval: "risky", effectiveSandbox: "workspace-write", unsafeCombo: false },
    quota: { limit: 10, used: 2 },
  });
  const gate = gateFromChecks(results);
  assert.equal(gate.blocked, false);
  assert.equal(gate.requiresAck, false);
});

test("evaluateAutomation composes match, overlaps, and preflight in one call", () => {
  const candidates = [
    automation({ id: "a", trigger: "github", on: [{ event: "issues" }] }),
    automation({ id: "b", trigger: "github", on: [{ event: "issues", actions: ["labeled"] }] }),
  ];
  const result = evaluateAutomation({
    candidates,
    event: { kind: "github", event: "issues", labels: ["bivy"] },
    signals: { quota: { limit: 10, used: 3 } },
  });
  assert.equal(result.match?.matched?.id, "a");
  assert.equal(result.overlaps[0]?.kind, "shadowed");
  assert.equal(result.gate.blocked, false);
});

test("evaluateAutomation without an event still reports overlaps and preflight", () => {
  const candidates = [
    automation({ id: "a", trigger: "github", on: [{ event: "issues" }] }),
    automation({ id: "b", trigger: "github", on: [{ event: "issues", actions: ["labeled"] }] }),
  ];
  const result = evaluateAutomation({ candidates });
  assert.equal(result.match, undefined);
  assert.equal(result.overlaps[0]?.kind, "shadowed");
  assert.equal(result.preflight.length, 7);
});
