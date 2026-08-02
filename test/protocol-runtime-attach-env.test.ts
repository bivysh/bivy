// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #290: `bivy attach` (bin/bivy.mjs) resolves its session from
// $BIVY_SESSION_ID in the agent's own subprocess env. Until this fix only the
// Claude Code adapter injected it (see claude-attach-prompt.test.ts), so the
// universal attach path only worked for Claude. This locks in that ACP-style
// protocol agents (ProtocolRuntime — e.g. a Codex app-server shim) also carry
// it, via the shared session-env.ts helper, and that it matches the session's
// own id so `bivy attach` resolves the right chat. The fixture (see
// test/fixtures/protocol-agent.mjs) echoes back what it actually saw in its own
// env as an `env.info` event.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 3000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for protocol event")); }
    }, 10);
  });
}

const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol" });
const { session } = await runtime.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
// Triggers session.create over the wire (ProtocolSession.open()), which is when
// the fixture echoes back its env.
await session.prompt("say hello");

const envInfo = await waitFor(events, (event) => event.type === "env.info");
assert.equal(
  (envInfo as { bivySessionId?: string | null }).bivySessionId,
  session.id,
  "BIVY_SESSION_ID must be in the protocol agent's subprocess env, matching the session id, so `bivy attach` resolves it",
);

session.dispose();
console.log("protocol-runtime-attach-env: ok");
