// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Exercise the CLI's real update orchestration without importing its dispatch
// entrypoint or touching the developer's installation, service, or Git checkout.
const cli = readFileSync("bin/bivy.mjs", "utf8");
const updateSource = cli.slice(cli.indexOf("async function runUpdate("), cli.indexOf("// Show the node's governance audit trail"));

const detachedSource = cli.slice(cli.indexOf("function spawnDetachedUpdateProcess("), cli.indexOf("async function showDetachedUpdateProgress("));

for (const kind of ["systemd", "launchd"]) {
  test(`${kind} detached updater starts outside the installation directory`, () => {
    let spawned = false;
    let unrefed = false;
    const launch = runInNewContext(`(${detachedSource.trim()})`, {
      process: { env: {}, pid: 123 },
      os: { homedir: () => "/test/home" },
      repoRoot: "/test/bivy",
      selfScript: "/test/bivy/bin/bivy.mjs",
      nodeBin: "/usr/bin/node",
      appDir: "/test/data",
      updateLogPath: "/test/data/update.log",
      servicePaths: () => ({ kind }),
      commandExists: () => true,
      systemdUserEnv: () => ({}),
      spawn: (command: string, args: string[], opts: { cwd?: string }) => {
        spawned = true;
        if (kind === "systemd") {
          assert.equal(command, "systemd-run");
          assert.ok(args.includes("--working-directory=/test/home"));
        } else {
          assert.equal(command, "/usr/bin/node");
          assert.equal(opts.cwd, "/test/home");
        }
        return { unref() { unrefed = true; } };
      },
    });
    launch([], 42);
    assert.ok(spawned);
    assert.ok(unrefed);
  });
}

function setup(kind: string, codes: number[]) {
  const calls: string[] = [];
  const output: string[] = [];
  let cwd = "/test/bivy";
  const proc = {
    env: {}, exitCode: 0,
    chdir(dir: string) { cwd = dir; },
    exit(code: number) { throw new Error(`exit:${code}`); },
  };
  const context = {
    process: proc,
    console: { log: (line: string) => output.push(line) },
    c: { dim: String, cyan: String, yellow: String, green: String, red: String },
    repoRoot: "/test/bivy",
    os: { homedir: () => "/test/home" },
    npmGlobalPrefix: () => "/test/prefix",
    detectInstallKind: () => kind,
    resolveUpdateChannel: () => "latest",
    runQuiet: () => ({ code: 0, stdout: "main" }),
    run: async (command: string, args: string[], opts?: { cwd?: string }) => {
      calls.push(command);
      assert.equal(cwd, "/test/home", "updater must leave the replaceable installation directory");
      if (command === "npm" || command === "bash") {
        assert.equal(opts?.cwd ?? cwd, "/test/home", "installer must use a stable cwd");
      }
      if (command === "bash") {
        // Shadow curl in the shell, so this test never downloads or installs.
        const shellArgs = Array.from(args);
        shellArgs[shellArgs.length - 1] = `curl() { return 22; }; ${shellArgs.at(-1)}`;
        return spawnSync(command, shellArgs, { encoding: "utf8" }).status;
      }
      return codes.shift() ?? 0;
    },
    installCommandFor: () => ["pnpm", ["install", "--frozen-lockfile"]],
    ensureKnownAgents: async () => { calls.push("agents"); },
    loadConfig: () => ({}),
    waitForIdleSessions: async () => {},
    hasConfiguredService: () => true,
    restartServiceReconciled: async () => { calls.push("restart"); return true; },
    verifyNodeCameUp: async () => true,
  };
  const update = runInNewContext(`(${updateSource.trim()})`, context) as () => Promise<void>;
  return { update, calls, output, proc };
}

for (const [label, codes, expectedCalls, exitCode] of [
  ["git pull", [1], ["git"], 1],
  ["dependency installation", [0, 17], ["git", "pnpm"], 17],
] as const) {
  test(`checkout update stops on failed ${label} without restarting`, async () => {
    const state = setup("checkout", [...codes]);
    await state.update();
    assert.equal(state.proc.exitCode, exitCode);
    assert.deepEqual(state.calls, expectedCalls);
    assert.ok(!state.output.some((line) => line.includes("Updated")));
  });
}

test("successful checkout update restarts without installing agents", async () => {
  const state = setup("checkout", [0, 0]);
  await state.update();
  assert.equal(state.proc.exitCode, 0);
  assert.deepEqual(state.calls, ["git", "pnpm", "restart"]);
  assert.ok(state.output.some((line) => line.includes("Updated and restarted")));
});

test("npm-global update restarts without installing agents", async () => {
  const state = setup("npm-global", [0]);
  await state.update();
  assert.equal(state.proc.exitCode, 0);
  assert.deepEqual(state.calls, ["npm", "restart"]);
});

test("packaged update propagates a failed download through the shell pipeline", async () => {
  const state = setup("packaged", []);
  await assert.rejects(state.update(), /exit:22/);
  assert.deepEqual(state.calls, ["bash"]);
});
