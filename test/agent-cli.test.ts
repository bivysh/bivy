// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readNodeConfig } from "../src/node-config.js";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

function run(args: string[], dataDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(tsx, [path.join(root, "src", "agent-cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, BIVY_DATA_DIR: dataDir },
    encoding: "utf8",
  });
}

test("agent add writes an adapter entry to config.yaml", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-agent-add-"));
  try {
    const added = run([
      "add", "company-agent", "--command", "company-agent", "--transport", "process",
      "--args", '["run"]', "--prompt-mode", "argv", "--json",
    ], dir);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).id, "company-agent");

    const stored = readNodeConfig(dir)?.agents?.["company-agent"];
    assert.ok(stored && "adapter" in stored);
    assert.equal(stored.adapter.kind, "process");
    assert.deepEqual(stored.adapter.args, ["run"]);

    const listed = run(["list", "--json"], dir);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).agents.map((agent: { id: string }) => agent.id), ["company-agent"]);

    const removed = run(["remove", "company-agent", "--json"], dir);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).removed, true);

    const conflict = run(["add", "pi", "--command", "other-pi", "--json"], dir);
    assert.equal(conflict.status, 1);
    assert.match(JSON.parse(conflict.stdout).error, /conflicts with pi/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
