import assert from "node:assert/strict";
import os from "node:os";
import { TerminalManager, resolveExecutable } from "../src/terminal.js";

/**
 * Spawns a real shell via node-pty, writes a command, and asserts the output
 * comes back. Skips gracefully on platforms where a PTY can't be allocated.
 */
async function main() {
  const mgr = new TerminalManager();
  let output = "";
  let exited = false;

  let settled = false;
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for terminal output")), 8000);
    const id = mgr.open({
      workspace: os.tmpdir(),
      cols: 80,
      rows: 24,
      onData: (data) => {
        output += data;
        if (!settled && output.includes("bivy-terminal-ok")) {
          settled = true;
          clearTimeout(timeout);
          assert.equal(mgr.size, 1, "one terminal should be live");
          assert.equal(mgr.resize(id, 100, 40), true, "resize should succeed");
          mgr.close(id);
          assert.equal(mgr.has(id), false, "terminal should be gone after close");
          resolve();
        }
      },
      onExit: () => {
        exited = true;
      },
    });

    assert.ok(id.startsWith("term-"), "open returns a term id");
    // Echo a unique marker; works in sh/bash/zsh and powershell.
    mgr.write(id, "echo bivy-terminal-ok\n");
  });

  try {
    await done;
    console.log("terminal: ok (spawn, write, echo, resize, close)");
    await scrollbackReplayCheck();
    await coalescedBurstCheck();
    await customCommandCheck();
    await runTerminalMetaCheck();
    await bellAndInputCheck();
    missingCommandCheck();
  } catch (error) {
    mgr.disposeAll();
    // A sandbox without PTY support shouldn't fail the suite hard.
    if (/posix_openpt|posix_spawnp|openpty|ENXIO|ENOENT/.test(String(error))) {
      console.warn(`terminal: skipped (no PTY in this environment): ${error}`);
      return;
    }
    throw error;
  } finally {
    void exited;
  }
}

/**
 * The reattach path: a live terminal retains a scrollback tail that the server
 * replays to a reconnecting client, and that tail is gone once the shell closes.
 */
async function scrollbackReplayCheck() {
  const mgr = new TerminalManager();
  const id = mgr.open({ workspace: os.tmpdir(), cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
  const marker = "bivy-scrollback-marker";
  mgr.write(id, `echo ${marker}\n`);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const snap = mgr.snapshot(id);
    if (snap && snap.includes(marker)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const snap = mgr.snapshot(id);
  assert.ok(snap != null && snap.includes(marker), "snapshot replays buffered output");

  mgr.close(id);
  assert.equal(mgr.snapshot(id), null, "snapshot is null after the terminal closes");
  assert.equal(mgr.snapshot("term-does-not-exist"), null, "snapshot is null for an unknown id");
  console.log("terminal: ok (scrollback snapshot + reattach)");
}

/**
 * The two signals the server uses to turn a terminal bell into a call-me-back
 * push: a BEL in the PTY stream fires the onBell hook, and client input bumps
 * lastInput() (so "a bell while you were away" is distinguishable from a
 * keystroke echo while you're actively typing).
 */
async function bellAndInputCheck() {
  const mgr = new TerminalManager();
  let bells = 0;
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for bell")), 10000);
    mgr.open({
      workspace: os.tmpdir(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('\\x07');process.stdout.write('BELL-DONE\\n')"],
      onData: (data) => {
        if (data.includes("BELL-DONE")) {
          clearTimeout(timeout);
          resolve();
        }
      },
      onBell: () => { bells++; },
      onExit: () => {},
    });
  });
  await done;
  assert.ok(bells >= 1, "onBell fires when the PTY emits a BEL");
  mgr.disposeAll();

  const mgr2 = new TerminalManager();
  const id = mgr2.open({ workspace: os.tmpdir(), onData: () => {}, onExit: () => {} });
  const before = mgr2.lastInput(id);
  assert.equal(typeof before, "number", "lastInput starts as a number");
  await new Promise((r) => setTimeout(r, 12));
  mgr2.write(id, "x");
  const after = mgr2.lastInput(id);
  assert.ok(after != null && before != null && after > before, "write bumps lastInput");
  assert.equal(mgr2.lastInput("term-does-not-exist"), null, "lastInput is null for an unknown id");
  mgr2.disposeAll();
  console.log("terminal: ok (bell hook + input tracking)");
}

/**
 * Output is coalesced (batched on a short timer) before delivery to cut
 * transport frames under load. This guards the correctness property that matters
 * across that batching: a large burst is delivered in full and in order, with no
 * dropped or duplicated bytes — and fewer onData calls than raw PTY chunks.
 */
async function coalescedBurstCheck() {
  const mgr = new TerminalManager();
  const count = 500;
  let received = "";
  let calls = 0;
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out: got ${calls} calls, tail=${received.slice(-40)}`)), 10000);
    const id = mgr.open({
      workspace: os.tmpdir(),
      command: process.execPath,
      // Print 500 numbered lines back-to-back, then a sentinel.
      args: ["-e", `for(let i=0;i<${count};i++)process.stdout.write('L'+i+'\\n');process.stdout.write('BURST-DONE\\n')`],
      onData: (data) => {
        calls++;
        received += data;
        if (received.includes("BURST-DONE")) {
          clearTimeout(timeout);
          resolve();
        }
      },
      onExit: () => {},
    });
    void id;
  });
  await done;
  mgr.disposeAll();
  // Every line arrived, in order. (A PTY rewrites \n as \r\n, so match the
  // token followed by a carriage return / newline rather than a bare \n.)
  for (let i = 0; i < count; i++) {
    assert.ok(new RegExp(`L${i}\\r?\\n`).test(received), `line L${i} present`);
  }
  const firstIdx = received.search(/L0\r?\n/);
  const lastIdx = received.search(new RegExp(`L${count - 1}\\r?\\n`));
  assert.ok(firstIdx >= 0 && lastIdx > firstIdx, "output preserved in order");
  // Coalescing collapsed the many PTY chunks into far fewer delivered batches.
  assert.ok(calls < count, `coalesced into fewer batches than lines (${calls} < ${count})`);
  console.log(`terminal: ok (coalesced burst: ${count} lines in ${calls} batches, in order)`);
}

/**
 * A terminal can run a custom command instead of the login shell — the
 * mechanism the daemon uses to launch an agent's interactive TUI (e.g.
 * `claude --resume <id>`) in the session's worktree.
 */
async function customCommandCheck() {
  const mgr = new TerminalManager();
  const marker = "bivy-tui-launch-ok";
  let output = "";
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for custom command output")), 8000);
    const id = mgr.open({
      workspace: os.tmpdir(),
      command: process.execPath, // node
      args: ["-e", `process.stdout.write(${JSON.stringify(marker)})`],
      onData: (data) => {
        output += data;
        if (output.includes(marker)) { clearTimeout(timeout); resolve(); }
      },
      onExit: () => {
        if (!output.includes(marker)) { clearTimeout(timeout); reject(new Error(`custom command exited without marker: ${output}`)); }
      },
    });
    assert.ok(id.startsWith("term-"), "custom-command open returns a term id");
  });
  await done;
  mgr.disposeAll();
  console.log("terminal: ok (custom command / TUI launch path)");
}

/**
 * Run-terminal metadata + listing: the registry backing `bivy run` / `bivy
 * attach`. A terminal tagged `kind:"run"` is listable with its agent metadata
 * and can be filtered apart from a plain shell.
 */
async function runTerminalMetaCheck() {
  const mgr = new TerminalManager();
  const runId = mgr.open({
    workspace: os.tmpdir(),
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 3000)"],
    meta: { kind: "run", agent: "claude", model: "opus", label: "Claude Code", name: "claude · mesh", command: "claude" },
    onData: () => {},
    onExit: () => {},
  });
  const shellId = mgr.open({ workspace: os.tmpdir(), meta: { kind: "shell" }, onData: () => {}, onExit: () => {} });

  const runOnly = mgr.list((m) => m.kind === "run");
  assert.equal(runOnly.length, 1, "only the run-terminal matches the kind filter");
  assert.equal(runOnly[0].id, runId, "list surfaces the run-terminal id");
  assert.equal(runOnly[0].meta.agent, "claude", "list carries agent metadata");
  assert.equal(runOnly[0].meta.label, "Claude Code", "list carries the label");
  assert.equal(runOnly[0].meta.name, "claude · mesh", "list carries the session name");
  assert.equal(runOnly[0].meta.model, "opus", "list carries the model");
  assert.ok(typeof runOnly[0].createdAt === "number", "list carries a createdAt");
  assert.ok(typeof runOnly[0].lastActivityAt === "number", "list carries lastActivityAt");

  assert.equal(mgr.meta(runId)?.agent, "claude", "meta() returns agent for a live terminal");
  assert.equal(mgr.meta("term-nope"), null, "meta() is null for an unknown id");
  assert.ok(typeof mgr.lastActivity(runId) === "number", "lastActivity() returns a timestamp for a live terminal");
  assert.equal(mgr.lastActivity("term-nope"), null, "lastActivity() is null for an unknown id");
  assert.equal(mgr.list().length, 2, "unfiltered list includes the plain shell too");

  mgr.disposeAll();
  assert.equal(mgr.list().length, 0, "disposeAll clears the registry");
  void shellId;
  console.log("terminal: ok (run-terminal metadata + listing)");
}

/**
 * A run-terminal for a command that isn't installed must fail loudly. node-pty
 * doesn't throw for an unexecutable target — it prints "posix_spawnp failed."
 * into the PTY and exits — so open() resolves the command first and throws a
 * clear error the daemon can relay (instead of the user seeing that message).
 */
function missingCommandCheck() {
  const bogus = "bivy-definitely-not-a-real-command-xyz";
  assert.equal(resolveExecutable(bogus, process.env, os.tmpdir()), null, "bogus command resolves to null");
  assert.ok(resolveExecutable(process.execPath, process.env, os.tmpdir()), "an absolute executable resolves");

  const mgr = new TerminalManager();
  assert.throws(
    () => mgr.open({ workspace: os.tmpdir(), command: bogus, onData: () => {}, onExit: () => {} }),
    /not found or not executable/,
    "open() throws a clear error for an unresolvable command",
  );
  assert.equal(mgr.size, 0, "no terminal is registered when the command can't be resolved");
  console.log("terminal: ok (missing command surfaces a clear error, not posix_spawnp)");
}

main().catch((error) => {
  console.error("terminal: FAILED\n", error);
  process.exit(1);
});
