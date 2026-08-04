import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runRequiredAutomationChecks } from "../src/automation-checks.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-checks-"));
try {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "secret command", lint: "another secret", build: "not selected" } }));
  const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
  const fakeRun = ((command: string, args: string[], options: { timeout?: number }) => {
    calls.push({ command, args, timeout: options.timeout });
    return { status: args.at(-1) === "test" ? 0 : 2 };
  }) as unknown as typeof spawnSync;

  const results = runRequiredAutomationChecks(dir, {}, fakeRun);
  assert.deepEqual(results.map((r) => ({ name: r.name, status: r.status, exitCode: r.exitCode })), [
    { name: "test", status: "passed", exitCode: 0 },
    { name: "lint", status: "failed", exitCode: 2 },
  ]);
  assert.ok(results.every((r) => /^sha256:[a-f0-9]{64}$/.test(r.commandHash)));
  assert.ok(results.every((r) => Number.isFinite(r.durationMs) && r.durationMs >= 0));
  assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [["npm", "run", "test"], ["npm", "run", "lint"]]);
  assert.equal(JSON.stringify(results).includes("secret command"), false, "hosted evidence must not contain command text");

  calls.length = 0;
  const selected = runRequiredAutomationChecks(dir, { BIVY_AUTOMATION_CHECKS: '["lint","build","bad shell ;"]', BIVY_AUTOMATION_CHECK_TIMEOUT_MS: "250" }, fakeRun);
  assert.deepEqual(selected.map((r) => r.name), ["lint", "build"]);
  assert.ok(calls.every((c) => c.timeout === 1_000), "check timeouts have a safe minimum");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("automation-checks: all tests passed");
