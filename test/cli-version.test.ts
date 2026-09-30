// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Smoke tests for the top-level `bivy` CLI dispatcher (bin/bivy.mjs): the
// version command, unknown-command exit code, and --help. These guard the
// baseline UX contract users expect from a public CLI at 0.1.
import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "bivy.mjs");
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version as string;

// Isolated, throwaway data dir so these tests never read/write a developer's
// real ~/.bivy (or the repo's own .bivy) — some of the cases below (secrets,
// agents:install) would otherwise touch the local secret vault.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cli-test-"));

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, BIVY_DATA_DIR: dataDir },
  });
}

for (const flag of ["version", "--version", "-v"]) {
  test(`\`bivy ${flag}\` prints the package version and exits 0`, () => {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkgVersion);
  });
}

test("an unknown command exits 2, names the offending command, and suggests close ones", () => {
  const r = runCli(["definitely-not-a-command"]);
  assert.equal(r.status, 2, "unknown command is a usage error");
  assert.match(r.stderr + r.stdout, /Unknown command: definitely-not-a-command/);
  const typo = runCli(["sesions"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /Did you mean: bivy sessions/);
});

test("with --json, session commands fail with a machine-readable error and a specific exit code", () => {
  const r = runCli(["attach", "report.pdf", "--json"], { BIVY_SESSION_ID: "", PI_SESSION_ID: "" });
  assert.equal(r.status, 2);
  const { error } = JSON.parse(r.stderr);
  assert.equal(error.code, "no_session");
  assert.ok(error.hint && error.next, "an agent is told how to recover");
});

test("inside a session, another install's bivy hands the command to the node's own CLI", () => {
  const nodeCli = path.join(dataDir, "node-bivy.mjs");
  fs.writeFileSync(nodeCli, "console.log(`node cli: ${process.argv.slice(2).join(' ')}`); process.exit(7);\n");
  // Installers put the CLI on PATH as a link named `bivy`.
  const onPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-path-")), "bivy");
  fs.symlinkSync(cli, onPath);
  const viaPath = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [onPath, ...args], { encoding: "utf8", env: { ...process.env, ...env, BIVY_DATA_DIR: dataDir } });
  const handed = viaPath(["notify", "done"], { BIVY_NODE_CLI: nodeCli });
  assert.equal(handed.status, 7, "the node CLI's exit code comes back");
  assert.equal(handed.stdout.trim(), "node cli: notify done");
  assert.equal(viaPath(["version"], { BIVY_NODE_CLI: cli }).stdout.trim(), pkgVersion, "the node's own CLI runs itself");
  assert.equal(runCli(["version"], { BIVY_NODE_CLI: nodeCli }).stdout.trim(), pkgVersion, "a file run on purpose is left alone");
});

test("`bivy help --json` describes every visible command with its scope and JSON support", () => {
  const r = runCli(["help", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const cli = JSON.parse(r.stdout);
  const attach = cli.commands.find((command: { name: string }) => command.name === "attach");
  assert.equal(attach.scope, "session");
  assert.equal(attach.json, true);
  assert.equal(cli.exitCodes.notFound, 3);
  assert.ok(!cli.commands.some((command: { name: string }) => command.name === "mcp-serve"), "plumbing stays out of discovery");
});

test("account and model-provider login commands have distinct help", () => {
  const account = runCli(["login", "--help"]);
  assert.equal(account.status, 0);
  assert.match(account.stdout, /Bivy account/);
  assert.match(account.stdout, /GitHub.*email/i);

  const movedProvider = runCli(["login", "anthropic"]);
  assert.notEqual(movedProvider.status, 0);
  assert.match(movedProvider.stderr + movedProvider.stdout, /bivy provider login anthropic/);

  for (const namespace of ["provider", "model"]) {
    const provider = runCli([namespace, "login", "--help"]);
    assert.equal(provider.status, 0);
    assert.match(provider.stdout, /model provider/i);
  }

  for (const command of ["logout", "signout"]) {
    const logout = runCli([command, "--help"]);
    assert.equal(logout.status, 0);
    assert.match(logout.stdout, /Sign this machine out/);
  }
});

test("bare `bivy` shows the command overview without starting setup or an agent", () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /bivy — Bivy node CLI/);
  assert.match(out, /bivy run <agent>/);
  assert.doesNotMatch(out, /Which agent do you want to try first|Installing dependencies/);
});

test("redirected help output contains no ANSI control sequences", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok(!(r.stdout + r.stderr).includes("\u001b["), "redirected output should not contain ANSI escapes");
});

test("NO_COLOR wins even when FORCE_COLOR is set", () => {
  const r = runCli(["--help"], { NO_COLOR: "1", FORCE_COLOR: "1" });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok(!(r.stdout + r.stderr).includes("\u001b["), "NO_COLOR output should not contain ANSI escapes");
});

test("`bivy --help` lists every known 'bivy run' integration, not a stale subset", () => {
  // Regression test for #113: this line used to be a hand-maintained string
  // that fell out of sync with BUILTIN_TERMINAL_AGENTS as agents were added.
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  for (const agent of ["pi", "claude", "codex", "opencode", "aider", "hermes", "openclaw", "goose", "gemini", "qwen", "cline", "crush"]) {
    assert.ok(out.includes(agent), `help should mention agent "${agent}"`);
  }
});

// --- #113: subcommand --help must not run the live action ------------------

test("`bivy doctor --help` exits 0 and does not run the health check", () => {
  const r = runCli(["doctor", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /Usage: bivy doctor/);
  assert.doesNotMatch(out, /[✓✗]/, "--help must not run the live health check");
});

test("`bivy status --help` exits 0 and does not check node reachability", () => {
  const r = runCli(["status", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /Usage: bivy status/);
  assert.doesNotMatch(out, /Bivy node\b/, "--help must not print the live status header");
});

test("`bivy nodes --help` exits 0 and does not list nodes", () => {
  const r = runCli(["nodes", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /Usage: bivy nodes/);
  assert.doesNotMatch(out, /Direct nodes/, "--help must not print the live nodes listing");
});

test("`bivy secrets list --help` exits 0 and does not list secrets", () => {
  const r = runCli(["secrets", "list", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /Usage: bivy secrets/);
  assert.doesNotMatch(out, /\tlocal\t/, "--help must not run the live 'list' action");
});

test("`bivy agents:install --help` exits 0 and does not install anything", () => {
  const r = runCli(["agents:install", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /Usage: bivy agents:install/);
  assert.doesNotMatch(out, /Ensuring known agent integrations/, "--help must not install agent integrations");
});

test("`bivy run --help` (no agent) shows bivy's own help, not an agent's", () => {
  const r = runCli(["run", "--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /Usage: bivy run <agent>/);
});

// --- #113: invalid subcommands must exit non-zero, not silently succeed ----

test("`bivy nodes bogus` exits non-zero instead of silently listing nodes", () => {
  const r = runCli(["nodes", "bogus"]);
  assert.notEqual(r.status, 0, "an unrecognized nodes subcommand must exit non-zero");
  assert.match(r.stderr + r.stdout, /Unknown nodes subcommand: bogus/);
});

test("`bivy shim bogus` exits non-zero instead of silently listing shims", () => {
  const r = runCli(["shim", "bogus"]);
  assert.notEqual(r.status, 0, "an unrecognized shim subcommand must exit non-zero");
  assert.match(r.stderr + r.stdout, /Unknown shim subcommand: bogus/);
});

test("`bivy service bogus` exits non-zero instead of printing usage and exiting 0", () => {
  const r = runCli(["service", "bogus"]);
  assert.notEqual(r.status, 0, "an unrecognized service action must exit non-zero");
  assert.match(r.stderr + r.stdout, /Usage: bivy service/);
});

test("`bivy secrets bogus` exits non-zero (the delegated script's exit code must propagate)", () => {
  const r = runCli(["secrets", "bogus"]);
  assert.notEqual(r.status, 0, "an unrecognized secrets subcommand must exit non-zero");
});

