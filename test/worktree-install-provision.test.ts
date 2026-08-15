// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planInstallProvision, provisionDepsByInstall, type InstallProvisionRunner, type InstallPlanItem } from "../src/worktree-provision.js";

function tmpWorktree(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-wt-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("plan detects pnpm over npm (precedence) for node_modules", () => {
  const wt = tmpWorktree({ "pnpm-lock.yaml": "x", "package-lock.json": "y" });
  const plan = planInstallProvision(wt);
  const nm = plan.filter((p) => p.dir === "node_modules");
  assert.equal(nm.length, 1, "one manager wins per dir");
  assert.equal(nm[0].command, "pnpm");
  assert.deepEqual(nm[0].args, ["install", "--frozen-lockfile"]);
});

test("plan covers multiple ecosystems at once", () => {
  const wt = tmpWorktree({ "package-lock.json": "x", "Cargo.lock": "y", "requirements.txt": "z", "go.mod": "module m" });
  const cmds = planInstallProvision(wt).map((p) => p.command).sort();
  assert.deepEqual(cmds, ["cargo", "go", "npm", "pip"]);
});

test("plan skips an ecosystem whose install dir already exists", () => {
  const wt = tmpWorktree({ "pnpm-lock.yaml": "x" });
  fs.mkdirSync(path.join(wt, "node_modules"));
  assert.deepEqual(planInstallProvision(wt), [], "already-provisioned node_modules is skipped");
});

test("plan is empty with no lockfiles", () => {
  assert.deepEqual(planInstallProvision(tmpWorktree()), []);
});

function fakeRunner(over: Partial<InstallProvisionRunner> = {}): { runner: InstallProvisionRunner; ran: InstallPlanItem[] } {
  const ran: InstallPlanItem[] = [];
  const runner: InstallProvisionRunner = {
    has: () => true,
    run: async (item) => { ran.push(item); },
    ...over,
  };
  return { runner, ran };
}

test("provision is disabled unless BIVY_WORKTREE_AUTO_INSTALL is set", async () => {
  const prev = process.env.BIVY_WORKTREE_AUTO_INSTALL;
  delete process.env.BIVY_WORKTREE_AUTO_INSTALL;
  try {
    const wt = tmpWorktree({ "pnpm-lock.yaml": "x" });
    const { runner, ran } = fakeRunner();
    const res = await provisionDepsByInstall({ worktreePath: wt }, runner);
    assert.equal(res.strategy, "disabled");
    assert.deepEqual(ran, [], "no installs run while opted out");
  } finally {
    if (prev === undefined) delete process.env.BIVY_WORKTREE_AUTO_INSTALL; else process.env.BIVY_WORKTREE_AUTO_INSTALL = prev;
  }
});

test("provision runs the plan when enabled, skipping missing managers, best-effort past failures", async () => {
  const prev = process.env.BIVY_WORKTREE_AUTO_INSTALL;
  process.env.BIVY_WORKTREE_AUTO_INSTALL = "1";
  try {
    const wt = tmpWorktree({ "pnpm-lock.yaml": "x", "Cargo.lock": "y", "requirements.txt": "z" });
    // pnpm present + succeeds; cargo present but fails; pip not on PATH.
    const { runner, ran } = fakeRunner({
      has: (cmd) => cmd !== "pip",
      run: async (item) => { if (item.command === "cargo") throw new Error("boom"); ran.push(item); },
    });
    const res = await provisionDepsByInstall({ worktreePath: wt }, runner);
    assert.equal(res.strategy, "ran");
    assert.deepEqual(res.ran, ["pnpm"], "successful installs recorded");
    const skippedCmds = res.skipped.map((s) => s.command).sort();
    assert.deepEqual(skippedCmds, ["cargo", "pip"], "a failing install and a missing manager are both skipped, not fatal");
    assert.equal(res.skipped.find((s) => s.command === "pip")?.reason, "not on PATH");
  } finally {
    if (prev === undefined) delete process.env.BIVY_WORKTREE_AUTO_INSTALL; else process.env.BIVY_WORKTREE_AUTO_INSTALL = prev;
  }
});
