// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { launchCommand, type CommandHandle } from "../src/command-launch.js";

interface Run {
  handle: CommandHandle;
  stdout: () => string;
  stderr: () => string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
}

function run(command: string, args: string[], requiresTty: boolean): Run {
  let stdout = "";
  let stderr = "";
  let settle!: (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => (settle = resolve));
  const handle = launchCommand({ command, args, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } }, requiresTty, {
    onOutput: (stream, text) => (stream === "stdout" ? (stdout += text) : (stderr += text)),
    onError: (error) => settle({ code: null, signal: null, error }),
    onExit: (code, signal) => settle({ code, signal }),
  });
  return { handle, stdout: () => stdout, stderr: () => stderr, done };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("ordinary commands use plain pipes with separate stderr", async () => {
  const r = run("sh", ["-c", "echo out; echo err >&2; test -t 1 || echo no-tty"], false);
  assert.equal(r.handle.usesPty, false);
  assert.deepEqual(await r.done, { code: 0, signal: null });
  assert.match(r.stdout(), /out\n[\s\S]*no-tty/);
  assert.equal(r.stderr(), "err\n");
});

test("requiresTty commands get a real terminal and their exit code", { skip: process.platform === "win32" }, async () => {
  const r = run("sh", ["-c", "test -t 0 && test -t 1 && echo tty-yes; exit 3"], true);
  assert.equal(r.handle.usesPty, true);
  assert.deepEqual(await r.done, { code: 3, signal: null });
  assert.match(r.stdout(), /tty-yes/);
});

test("input written to a PTY command reaches it", { skip: process.platform === "win32" }, async () => {
  const r = run("sh", ["-c", "read line; echo \"got:$line\""], true);
  r.handle.write("hello\n");
  assert.deepEqual(await r.done, { code: 0, signal: null });
  assert.match(r.stdout(), /got:hello/);
});

test("interrupt SIGINTs the PTY command's whole process group", { skip: process.platform === "win32" }, async () => {
  // The inner shell prints its pid and execs sleep: a grandchild of the launch.
  const r = run("sh", ["-c", "sh -c 'echo pid:$$; exec sleep 30'; echo after"], true);
  await waitFor(() => /pid:\d+/.test(r.stdout()), "grandchild pid");
  const grandchild = Number(/pid:(\d+)/.exec(r.stdout())![1]);
  r.handle.interrupt();
  const result = await r.done;
  assert.equal(result.signal, "SIGINT");
  assert.doesNotMatch(r.stdout(), /after/);
  assert.throws(() => process.kill(grandchild, 0), "the grandchild got the SIGINT too");
});

test("a missing PTY command reports failure instead of hanging", { skip: process.platform === "win32" }, async () => {
  const r = run("bivy-definitely-not-a-command", [], true);
  const result = await r.done;
  assert.ok(result.error || (result.code ?? 0) !== 0, `expected an error or non-zero exit, got ${JSON.stringify(result)}`);
});
