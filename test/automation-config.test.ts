// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { parseAutomationConfig, parseSimulationEvent, simulateAutomation } from "../src/automation-config.js";

const valid = `
version: 1
automations:
  - id: fix-ci
    name: Fix CI
    trigger: github
    instructions: Fix the failure, run tests, and open a PR. Never deploy.
    repos: [acme/api]
    on:
      - event: workflow_run
        actions: [completed]
        conclusions: [failure]
        workflows: [CI]
    routing:
      node: buildbox
      agent: codex
    safety:
      approval: risky
      sandbox: workspace-write
      maxAttempts: 2
`;

test("automation config normalizes safe defaults and routing", () => {
  const result = parseAutomationConfig(valid);
  assert.equal(result.ok, true, result.errors.join("\n"));
  const item = result.config!.automations[0];
  assert.equal(item.id, "fix-ci");
  assert.equal(item.enabled, true);
  assert.equal(item.safety.maxAttempts, 2);
  assert.equal(item.routing.node, "buildbox");
});

test("danger-full-access plus autonomous requires explicit acknowledgement", () => {
  const result = parseAutomationConfig(`
version: 1
automations:
  - id: dangerous-job
    name: Dangerous job
    trigger: manual
    instructions: Do something.
    safety:
      approval: autonomous
      sandbox: danger-full-access
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /allowDangerous/);
});

test("unknown keys and duplicate ids fail closed", () => {
  const result = parseAutomationConfig(`
version: 1
automations:
  - id: same-id
    name: One
    trigger: manual
    instructions: One
    typo: ignored-no-more
  - id: same-id
    name: Two
    trigger: manual
    instructions: Two
`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /typo is not supported/);
  assert.match(result.errors.join("\n"), /duplicated/);
});

test("event simulation explains the first matching automation without running it", () => {
  const config = parseAutomationConfig(valid).config!;
  const fixture = parseSimulationEvent(`
kind: github
repo: acme/api
event: workflow_run
action: completed
conclusion: failure
workflow: CI
`);
  const result = simulateAutomation(config, fixture);
  assert.equal(result.matched?.id, "fix-ci");
  assert.deepEqual(result.reasons, [{ id: "fix-ci", matched: true, reason: "first matching enabled automation" }]);
});

test("event simulation reports why a fixture did not match", () => {
  const config = parseAutomationConfig(valid).config!;
  const fixture = parseSimulationEvent(`
kind: github
repo: other/repo
event: workflow_run
action: completed
conclusion: success
workflow: CI
`);
  const result = simulateAutomation(config, fixture);
  assert.equal(result.matched, undefined);
  assert.match(result.reasons[0].reason, /repository/);
});
