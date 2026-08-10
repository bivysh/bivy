// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

function run(args: string[], env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(tsx, [path.join(root, "src", "plugin-cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("plugin CLI validates, installs, lists, and removes a manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-cli-"));
  const file = path.join(dir, "bivy.plugin.yaml");
  fs.writeFileSync(file, `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: cli-fixture
  name: CLI Fixture
  version: 1.0.0
contributes:
  agents:
    - id: cli-fixture
      name: CLI Fixture
      adapter:
        kind: acp
        command: fixture-agent
        args: [acp]
`);
  const env = { BIVY_DATA_DIR: dir };
  try {
    const validated = run(["validate", file, "--json"], env);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).plugin.id, "cli-fixture");

    const installed = run(["install", file, "--json"], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).restartRequired, true);

    const listed = run(["list", "--json"], env);
    assert.equal(listed.status, 0, listed.stderr);
    const body = JSON.parse(listed.stdout);
    assert.equal(body.plugins[0].id, "cli-fixture");
    assert.equal(body.plugins[0].agents[0].adapter, "acp");

    const agents = spawnSync(process.execPath, [path.join(root, "bin", "bivy.mjs"), "agents", "--json"], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(agents.status, 0, agents.stderr);
    assert.equal(JSON.parse(agents.stdout).agents.some((agent: { id: string }) => agent.id === "cli-fixture"), true);

    const removed = run(["remove", "cli-fixture", "--json"], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).removed, "cli-fixture");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
