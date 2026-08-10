// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configToLegacySettings, mergeLegacyIntoNodeConfig, parseNodeConfig, readNodeConfig, setConfigValue, writeNodeConfig } from "../src/node-config.js";
import { parseProjectPolicy, resolveProjectSafety } from "../src/project-policy.js";

const valid = `
version: 1
node:
  workspace: /srv/code
  port: 4317
  maxConcurrentAutomations: 2
defaults:
  agent: codex
  sandbox: workspace-write
  approval: risky
safety:
  maxSandbox: workspace-write
  approvalFloor: risky
sessions:
  sync: true
  worktreeSync: true
automation:
  checks: [test, lint, typecheck]
  checkTimeoutMinutes: 10
agents:
  company-codex:
    extends: codex
    command: company-codex
    args: [exec]
environment:
  BIVY_GITHUB_TOKEN: secret://github.repo-token
`;

test("typed node config parses and projects to legacy settings", () => {
  const result = parseNodeConfig(valid);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.config?.node?.maxConcurrentAutomations, 2);
  assert.equal(result.config?.agents?.["company-codex"]?.extends, "codex");
  assert.equal(result.config?.safety?.maxSandbox, "workspace-write");
  assert.deepEqual(configToLegacySettings(result.config!), {
    defaultAgent: "codex",
    defaultSandbox: "workspace-write",
    approvalMode: "risky",
    githubMaxConcurrent: 2,
    sessionSync: true,
    worktreeSync: true,
  });
});

test("unknown fields, ambiguous booleans, and plaintext secrets fail closed", () => {
  const result = parseNodeConfig(`
version: 1
defaults:
  sandbox: writable
sessions:
  sync: "false"
environment:
  OPENAI_API_KEY: plaintext-secret
mystery: true
`);
  assert.equal(result.ok, false);
  const errors = result.errors.join("\n");
  assert.match(errors, /mystery/);
  assert.match(errors, /defaults\.sandbox/);
  assert.match(errors, /sessions\.sync/);
  assert.match(errors, /looks sensitive/);
});

test("legacy config migrates once and typed set remains validated", () => {
  const migrated = mergeLegacyIntoNodeConfig(
    { workspace: "/tmp/repo", port: 4318, env: { BIVY_RUNTIME: "claude-code-sdk", BIVY_AUTOMATION_CHECKS: "test,lint" } },
    { defaultSandbox: "read-only", approvalMode: "always", sessionSync: true },
  );
  assert.equal(migrated.defaults?.agent, "claude-code-sdk");
  assert.deepEqual(migrated.automation?.checks, ["test", "lint"]);
  const changed = setConfigValue(migrated, "node.maxConcurrentAutomations", 3);
  assert.equal(changed.node?.maxConcurrentAutomations, 3);
  assert.throws(() => setConfigValue(changed, "defaults.sandbox", "unconfined"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-node-config-"));
  try {
    writeNodeConfig(dir, changed);
    assert.deepEqual(readNodeConfig(dir), changed);
    assert.equal(fs.statSync(path.join(dir, "config.yaml")).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sessions.wedgedTurnMinutes is a validated typed knob", () => {
  const ok = parseNodeConfig(`
version: 1
sessions:
  wedgedTurnMinutes: 15
`);
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.equal(ok.config?.sessions?.wedgedTurnMinutes, 15);

  // 0 disables the band; the upper bound is the wall-clock turn cap (60 min).
  assert.equal(setConfigValue(ok.config!, "sessions.wedgedTurnMinutes", 0).sessions?.wedgedTurnMinutes, 0);
  assert.throws(() => setConfigValue(ok.config!, "sessions.wedgedTurnMinutes", 90), /wedgedTurnMinutes/);

  const bad = parseNodeConfig(`
version: 1
sessions:
  wedgedTurnMinutes: 90
`);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /sessions\.wedgedTurnMinutes/);
});

test("project policy validates safety floors, checks, and a queue ruleset", () => {
  const result = parseProjectPolicy(`
version: 1
safety:
  maxSandbox: workspace-write
  approvalFloor: risky
checks:
  scripts: [test, lint]
  timeoutMinutes: 5
routing:
  allowedAgents: [pi, codex]
  allowedModels: [gpt-5]
ruleset:
  version: 1
  name: repository
  appliesTo: [queue]
  rules:
    - when: [transport_error]
      action: retry
      maxAttempts: 2
`);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.policy?.safety?.maxSandbox, "workspace-write");
  assert.equal(result.policy?.ruleset?.name, "repository");
  assert.deepEqual(result.policy?.routing?.allowedAgents, ["pi", "codex"]);
  assert.deepEqual(resolveProjectSafety(result.policy?.safety, "danger-full-access", "autonomous"), {
    sandbox: "workspace-write",
    approval: "risky",
  });
  assert.deepEqual(resolveProjectSafety(result.policy?.safety, "read-only", "always"), {
    sandbox: "read-only",
    approval: "always",
  });
});
