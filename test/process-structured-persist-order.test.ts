// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Regression: a structured-pipe CLI agent (Grok/Goose/Gemini/… on ProcessRuntime
// + a CliParser) must have its final turn available from getMessages() the
// instant `message_end` fires. The daemon persists the base-transcript snapshot
// synchronously on message_end/turn_end by reading getMessages(); if the parser's
// messages were pushed only AFTER the terminal events were emitted, that snapshot
// saw an empty turn and the agent's answer + paired tool blocks were never
// persisted — they vanished on reload. Driven by a STUB binary that emits a
// Grok-shaped ACP streaming-json turn, so it runs in CI with no real agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessRuntime } from "../src/runtime/process.js";
import { genericStreamJsonParser } from "../src/runtime/cli-parsers.js";
import type { RuntimeEvent, RuntimeMessage } from "../src/runtime/types.js";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-structured-order-"));

// A stub agent that prints a Grok-shaped ACP streaming-json turn: assistant
// preamble text, a tool_call + its tool_call_update result, a final answer, and
// a terminal frame. Mirrors `grok --output-format streaming-json -p`.
const stub = path.join(tmp, "stub-grok");
const FRAMES = [
  `{"type":"text","data":"Let me list the files."}`,
  `{"type":"tool_call","toolCallId":"call-1","toolName":"run_terminal_command","rawInput":{"command":"ls"}}`,
  `{"type":"tool_call_update","toolCallId":"call-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"a\\nb\\n"}}]}`,
  `{"type":"text","data":"There are 2 entries."}`,
  `{"type":"end"}`,
];
fs.writeFileSync(
  stub,
  ["#!/bin/sh", ...FRAMES.map((f) => `printf '%s\\n' '${f}'`), ""].join("\n"),
  { mode: 0o755 },
);
fs.chmodSync(stub, 0o755);

function grokLikeRuntime() {
  return new ProcessRuntime({
    id: "grok",
    displayName: "Grok (stub)",
    command: stub,
    promptMode: "argv",
    args: ["-p"],
    parserFactory: genericStreamJsonParser,
  });
}

await check("getMessages() holds the final turn when message_end fires (structured pipe)", async () => {
  const { session } = await grokLikeRuntime().createSession({ workspace: tmp });
  // Snapshot a COPY the instant message_end fires — exactly like the daemon's
  // persistTranscriptSnapshot, which reads getMessages() synchronously and bails
  // when it is empty. (getMessages() returns the live array by reference, so a
  // reference here would be mutated by the later push and give a false pass.)
  let atMessageEnd: RuntimeMessage[] | undefined;
  const off = session.subscribe((e: RuntimeEvent) => {
    if (e.type === "message_end") atMessageEnd = [...session.getMessages()];
  });
  await new Promise<void>((resolve, reject) => {
    const done = session.subscribe((e) => {
      if (e.type === "agent_end") { done(); resolve(); }
    });
    session.prompt("hello").catch(reject);
    setTimeout(() => reject(new Error("timed out")), 8000).unref();
  });
  off();
  assert.ok(atMessageEnd && atMessageEnd.length > 0, "getMessages() must be populated at message_end, not empty");
  // The assistant answer text and the tool blocks must both be present so the
  // synchronously-persisted base snapshot captures the whole turn.
  const flat = JSON.stringify(atMessageEnd);
  assert.ok(/There are 2 entries\./.test(flat), "final answer text present in the persisted turn");
  assert.ok(/tool_use/.test(flat) && /call-1/.test(flat), "tool_use block with its id present");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
