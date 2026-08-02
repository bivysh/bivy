// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #290: `bivy attach` (bin/bivy.mjs) resolves its session from
// $BIVY_SESSION_ID in the agent's own subprocess env. Until this fix only the
// Claude Code adapter injected it (see claude-attach-prompt.test.ts), so the
// universal attach path only worked for Claude. This locks in that the generic
// CLI adapter (ProcessRuntime — Gemini, Aider, Codex non-ACP, any hand-configured
// agent) also carries it, via the shared session-env.ts helper, and that it
// matches the session's own id so `bivy attach` resolves the right chat.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessRuntime } from "../src/runtime/process.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-attach-env-test-"));
const envFile = path.join(tmp, "env.txt");

// A stub agent that dumps its own env to a file (POSIX `env` output: one
// KEY=VALUE per line), then exits 0. Mirrors process-model.test.ts's stub style.
const stub = path.join(tmp, "stub-agent");
fs.writeFileSync(
  stub,
  ["#!/bin/sh", `env > "$STUB_ENV_FILE"`, "printf 'ok\\n'", ""].join("\n"),
  { mode: 0o755 },
);
fs.chmodSync(stub, 0o755);

function parseEnvDump(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function runToEnd(session: { subscribe: (l: (e: RuntimeEvent) => void) => () => void; prompt: (t: string) => Promise<void> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = session.subscribe((e) => {
      if (e.type === "agent_end") { off(); resolve(); }
    });
    session.prompt("hello").catch((err) => { off(); reject(err); });
    setTimeout(() => { off(); reject(new Error("timed out waiting for agent_end")); }, 8000).unref();
  });
}

const runtime = new ProcessRuntime({
  id: "stub-cli",
  displayName: "Stub CLI",
  command: stub,
  promptMode: "argv",
  env: { STUB_ENV_FILE: envFile },
});

const { session } = await runtime.createSession({ workspace: tmp });
await runToEnd(session);

const childEnv = parseEnvDump(fs.readFileSync(envFile, "utf8"));
assert.equal(childEnv.BIVY_SESSION_ID, session.id, "BIVY_SESSION_ID must be in the subprocess env, matching the session id, so `bivy attach` resolves it");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("process-runtime-attach-env: ok");
