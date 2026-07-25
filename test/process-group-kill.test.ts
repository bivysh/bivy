// ProcessSession.abort() used to SIGTERM/SIGKILL only the direct child, so a
// forking CLI agent (one that shells out to git/npm/build tools, or forks its
// own worker processes) left orphaned grandchildren running after abort.
// Regression coverage for the fix: the child is spawned `detached` (its own
// process-group leader on POSIX) and abort() signals the whole group via
// `process.kill(-pid, sig)`, mirroring `pty-runner.py`'s `os.killpg`. Also
// covers the "capture the child before the 2s SIGKILL timer" fix — a fast
// re-spawn between abort() and the delayed SIGKILL must not be caught by it.
//
// POSIX-only (process groups / negative-pid kill); skips on Windows.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessRuntime } from "../src/runtime/process.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

if (process.platform === "win32") {
  console.log("process-group-kill: skipped on win32 (POSIX process-group kill only)");
  process.exit(0);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, intervalMs));
}

function waitForEvent(
  session: { subscribe: (l: (e: RuntimeEvent) => void) => () => void },
  pred: (e: RuntimeEvent) => boolean,
  timeoutMs = 5000,
): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const off = session.subscribe((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
    setTimeout(() => {
      off();
      reject(new Error("timed out waiting for event"));
    }, timeoutMs).unref();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-group-kill-test-"));

await check("abort() kills the whole process group, not just the direct child", async () => {
  const pidFile = path.join(tmp, "grandchild.pid");
  const stub = path.join(tmp, "forking-agent.sh");
  // A stub "forking CLI agent": backgrounds a grandchild (long sleep), records
  // its pid, then waits on it — mimicking a coding agent that shells out to a
  // long-running subprocess. In a non-interactive shell (no job control) the
  // background job stays in the script's own process group.
  fs.writeFileSync(
    stub,
    ["#!/bin/sh", "sleep 30 &", "gc=$!", 'echo "$gc" > "$GRANDCHILD_PID_FILE"', "wait $gc", ""].join("\n"),
    { mode: 0o755 },
  );

  const runtime = new ProcessRuntime({ id: "forking-stub", command: "/bin/sh", args: [stub], promptMode: "stdin", env: { GRANDCHILD_PID_FILE: pidFile } });
  const { session } = await runtime.createSession({ workspace: tmp });

  const ended = waitForEvent(session, (e) => e.type === "agent_end", 10_000);
  void session.prompt("go");

  await waitUntil(() => fs.existsSync(pidFile), 5000);
  assert.ok(fs.existsSync(pidFile), "stub never recorded its grandchild pid");
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `bad grandchild pid: ${grandchildPid}`);
  assert.ok(alive(grandchildPid), "grandchild should be running before abort");

  await session.abort();
  await ended;

  await waitUntil(() => !alive(grandchildPid), 3000);
  assert.ok(!alive(grandchildPid), `grandchild pid ${grandchildPid} should have been killed via process-group kill, but is still running`);
});

await check("the delayed SIGKILL from an earlier abort() does not reach a fast re-spawn", async () => {
  const runtime = new ProcessRuntime({ id: "sleep-runtime", command: "/bin/sh", args: ["-c", "sleep 30"], promptMode: "stdin" });
  const { session } = await runtime.createSession({ workspace: tmp });

  // Turn 1: starts, then is aborted. `sleep` has no SIGTERM trap, so it (and
  // the shell wrapping it, both in the same detached process group) exit
  // promptly — well before the 2s delayed-SIGKILL fallback would fire.
  const firstEnded = waitForEvent(session, (e) => e.type === "agent_end", 10_000);
  void session.prompt("first");
  await waitUntil(() => session.activePid() !== undefined, 2000);
  const firstPid = session.activePid();
  assert.ok(firstPid, "turn 1 should have a live pid");

  const abortStartedAt = Date.now();
  await session.abort();
  await firstEnded;

  // Turn 2: re-spawned right away — well inside turn 1's abort() 2s window.
  const secondEnded = waitForEvent(session, (e) => e.type === "agent_end", 15_000);
  void session.prompt("second");
  await waitUntil(() => session.activePid() !== undefined, 2000);
  const secondPid = session.activePid();
  assert.ok(secondPid, "turn 2 should have a live pid");
  assert.notEqual(secondPid, firstPid, "turn 2 must be a different process than turn 1");

  // Wait until we're past turn 1's 2s delayed-SIGKILL point, then confirm
  // turn 2's process is still alive — the old timer must not have reached it.
  const remaining = 2000 - (Date.now() - abortStartedAt) + 300;
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  assert.ok(alive(secondPid!), `turn 2's process (pid ${secondPid}) should still be alive — a stale SIGKILL from turn 1's abort() reached it`);

  await session.abort();
  await secondEnded;
});

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} process-group-kill test(s) failed.`);
  process.exit(1);
}
console.log("\nAll process-group-kill tests passed.");
