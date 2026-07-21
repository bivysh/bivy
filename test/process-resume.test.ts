// Tests the opt-in resume path on ProcessRuntime (the Codex Tier-1 mechanism):
// openSession(sessionFile) binds an agent session id, each prompt continues it via
// resumeArgs, prior history preloads via loadHistory, and the CLI's structured
// stdout is parsed into normalized messages. Driven by a STUB `codex`-like binary
// that records its argv and emits recorded `exec --json` lines — so it runs in CI
// with no real Codex.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessRuntime } from "../src/runtime/process.js";
import { codexJsonParser } from "../src/runtime/cli-parsers.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-resume-test-"));
const argsFile = path.join(tmp, "args.txt");

// A stub agent: records the argv it was launched with, then emits a codex-json
// turn (turn.started → agent_message → turn.completed).
const stub = path.join(tmp, "stub-codex");
fs.writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `[ -n "$STUB_ARGS_FILE" ] && printf '%s' "$*" > "$STUB_ARGS_FILE"`,
    `printf '%s\\n' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"resumed reply"}}' '{"type":"turn.completed"}'`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
fs.chmodSync(stub, 0o755);

function makeRuntime() {
  return new ProcessRuntime({
    id: "codex",
    displayName: "Codex (stub)",
    command: stub,
    promptMode: "argv",
    args: ["exec", "--json"],
    resumable: true,
    resumeArgs: (id) => ["exec", "resume", id, "--json"],
    loadHistory: (id) => [{ role: "user", content: `prior for ${id}` }],
    parserFactory: () => codexJsonParser(),
    env: { STUB_ARGS_FILE: argsFile },
  });
}

function runToEnd(session: { subscribe: (l: (e: RuntimeEvent) => void) => () => void; prompt: (t: string) => Promise<void> }): Promise<RuntimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RuntimeEvent[] = [];
    const off = session.subscribe((e) => {
      events.push(e);
      if (e.type === "agent_end") {
        off();
        resolve(events);
      }
    });
    session.prompt("hello").catch((err) => {
      off();
      reject(err);
    });
    setTimeout(() => {
      off();
      reject(new Error("timed out waiting for agent_end"));
    }, 8000).unref();
  });
}

await check("runtime advertises resume when configured", () => {
  assert.equal(makeRuntime().capabilities.resume, true);
  // A non-resumable ProcessRuntime stays resume:false.
  const plain = new ProcessRuntime({ id: "x", command: stub, promptMode: "argv" });
  assert.equal(plain.capabilities.resume, false);
});

await check("openSession binds the session id and preloads history", async () => {
  const { session } = await makeRuntime().openSession({ workspace: tmp, sessionFile: "sess-123" });
  assert.equal(session.sessionFile, "sess-123", "sessionFile round-trips the resume id");
  const msgs = session.getMessages() as Array<{ role: string; content: string }>;
  assert.deepEqual(msgs, [{ role: "user", content: "prior for sess-123" }], "history preloaded");
});

await check("prompt threads `resume <id>` and parses the structured reply", async () => {
  const { session } = await makeRuntime().openSession({ workspace: tmp, sessionFile: "sess-abc" });
  const events = await runToEnd(session);

  // The stub was launched to resume the bound session id.
  const launched = fs.readFileSync(argsFile, "utf8");
  assert.ok(/(^|\s)resume sess-abc(\s|$)/.test(launched), `expected 'resume sess-abc' in argv, got: ${launched}`);

  // The codex-json stream was parsed into a normalized assistant turn.
  const text = events.filter((e) => e.type === "message_update").pop() as { message?: { content?: string } } | undefined;
  assert.ok(text?.message?.content?.includes("resumed reply"), "assistant text streamed from the parser");

  // History = preloaded user turn + the new user prompt + the parsed assistant turn.
  const msgs = session.getMessages() as Array<{ role: string; content: unknown }>;
  assert.equal(msgs[0]?.role, "user");
  assert.ok(msgs.some((m) => m.role === "assistant" && String(m.content).includes("resumed reply")), "assistant turn recorded in history");
});

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} process-resume test(s) failed.`);
  process.exit(1);
}
console.log("\nAll process-resume tests passed.");
