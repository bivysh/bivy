// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "bivy.mjs");
function run(dataDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, "config", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BIVY_DATA_DIR: dataDir, NO_COLOR: "1", ...extraEnv },
  });
}

test("config CLI migrates, validates, edits, explains precedence, and updates compatibility projections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-config-cli-"));
  try {
    fs.writeFileSync(path.join(dir, "cli.json"), JSON.stringify({ workspace: "/tmp/work", port: 4319, service: true, env: {} }));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultAgent: "pi", defaultSandbox: "workspace-write" }));
    let result = run(dir, ["init"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, "config.yaml")));

    result = run(dir, ["set", "defaults.agent", "codex"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /codex/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).defaultAgent, "codex");

    result = run(dir, ["set", "automation.checks", "[test, lint]"]);
    assert.equal(result.status, 0, result.stderr);
    result = run(dir, ["validate"]);
    assert.equal(result.status, 0, result.stderr);

    result = run(dir, ["explain", "defaults.agent"], { BIVY_RUNTIME: "claude-code-sdk" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude-code-sdk/);
    assert.match(result.stdout, /environment BIVY_RUNTIME/);
    assert.match(result.stdout, /codex.*overridden/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("config explain composes repository safety monotonically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-config-explain-"));
  const dataDir = path.join(dir, "data");
  try {
    fs.mkdirSync(path.join(dir, ".bivy"), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "cli.json"), JSON.stringify({ workspace: dir, port: 4317, env: {} }), { flag: "a" });
    let result = spawnSync(process.execPath, [cli, "config", "init"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, BIVY_DATA_DIR: dataDir, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(path.join(dir, ".bivy", "policy.yaml"), "version: 1\nsafety:\n  maxSandbox: read-only\n  approvalFloor: always\n");
    result = spawnSync(process.execPath, [cli, "config", "explain", "defaults.sandbox"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, BIVY_DATA_DIR: dataDir, BIVY_SANDBOX: "danger-full-access", NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /defaults\.sandbox = read-only/);
    assert.match(result.stdout, /restricted by repository policy/);
    assert.match(result.stdout, /BIVY_SANDBOX.*restricted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("project policy init and validation do not require node configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-project-config-"));
  try {
    let result = spawnSync(process.execPath, [cli, "config", "init", "--project"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, BIVY_DATA_DIR: path.join(dir, "data"), NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, ".bivy", "policy.yaml")));
    result = spawnSync(process.execPath, [cli, "config", "validate", "--project"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, BIVY_DATA_DIR: path.join(dir, "data"), NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
