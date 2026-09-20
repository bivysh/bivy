// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A protocol/ACP agent turn that streams partial output and then fails mid-turn
// (a provider 4xx, an opencode ACP prompt rejection, an expired credential) must:
//   1. surface the failure LIVE via a session.error event, and
//   2. PRESERVE the partial assistant reply in the persisted transcript, and
//   3. persist a terminal error marker (stopReason "error" + errorMessage) so a
//      reopened session renders the failure inline instead of a blank
//      "looks done, no reply" turn.
// The old session.error handler wiped the turn's content and persisted nothing,
// so both the partial work and the error itself vanished on reload — a dataloss
// bug shared by every protocol agent (opencode, grok, cursor, amp, gemini, …).
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

const runtime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  env: { FIXTURE_ERROR_MIDTURN: "1", FIXTURE_NO_INTERCEPTION: "1" },
  displayName: "Failing Fixture",
});

const { session } = await runtime.createSession({ workspace: process.cwd() });
const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));

await session.prompt("do something that fails");
const errorEvent = (await waitFor(events, (event) => event.type === "session.error")) as RuntimeEvent & { error?: string };
await waitFor(events, (event) => event.type === "agent_end");

// (1) The failure surfaced live.
assert.match(String(errorEvent.error), /insufficient funds/, "the live session.error carried the upstream error text");

// (2) + (3) The persisted transcript keeps the partial reply AND a terminal error marker.
const messages = session.getMessages() as Array<Record<string, unknown>>;
const flat = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : "")).join("")
      : "";

const preserved = messages.some((m) => m.role === "assistant" && flat(m.content).includes("partial answer before the failure"));
assert.ok(preserved, "the partial assistant reply streamed before the failure was preserved in the transcript");

const errored = messages.find((m) => m.role === "assistant" && m.stopReason === "error");
assert.ok(errored, "a terminal error marker was persisted so the turn doesn't reopen blank");
assert.match(String(errored!.errorMessage), /insufficient funds/, "the persisted error marker carries the failure text");

// The error marker must be the LAST assistant message (terminalTurnError only
// trusts the final assistant message to decide a turn's outcome).
const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
assert.equal(lastAssistant!.stopReason, "error", "the terminal error marker is the last assistant message");

session.dispose();
console.log("protocol-runtime-turn-error: ok");
