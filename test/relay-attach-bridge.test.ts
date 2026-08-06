// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The relay-attach loopback bridge (src/relay-attach.ts) relies on ONE
// invariant: the `terminal.*` JSON that flows over a local `/ws` socket is
// byte-for-byte the same object that rides the relay — only the encrypted,
// chunked frame envelope differs. This test pins that invariant end to end
// using the exact modules the bridge and the node use:
//
//   node → CLI:  sealFrame(roomKey, event)  →  frameMessages  →
//                FrameReassembler.accept     →  RoomCipher.open  → event
//   CLI → node:  RoomCipher.seal(command)   →  frameMessages  →
//                FrameReassembler.accept     →  openFrame(roomKey) → command
//
// It also covers multi-frame reassembly (a large terminal.output payload split
// across several relay frames), which is what makes big diffs / screen repaints
// survive the tunnel intact.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sealFrame, openFrame } from "../src/e2e.js";
import { RoomCipher } from "../src/relay-cli-crypto.js";
import { frameMessages, FrameReassembler } from "../src/relay-chunk.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

// Reassemble the ws frame strings frameMessages() produces back into the sealed
// payload, exactly as the relay client does on the wire.
function reassemble(frames: string[]): string {
  const re = new FrameReassembler();
  let full: string | null = null;
  for (const s of frames) {
    full = re.accept(JSON.parse(s)) ?? full;
  }
  if (full == null) throw new Error("frames never reassembled to a full payload");
  return full;
}

const roomKey = crypto.randomBytes(32);
const cipher = new RoomCipher(roomKey);

check("node event → frames → reassemble → open === original (identity)", () => {
  const event = { type: "terminal.output", termId: "term-abc", data: "hello\r\n$ " };
  const frames = frameMessages(sealFrame(roomKey, event));
  const opened = cipher.open(reassemble(frames)).data;
  assert.deepEqual(opened, event);
});

check("CLI command → seal → frames → reassemble → openFrame === original", () => {
  const command = { kind: "terminal.input", termId: "term-abc", data: "ls -la\r" };
  const frames = frameMessages(cipher.seal(command));
  const opened = openFrame(roomKey, reassemble(frames)).data;
  assert.deepEqual(opened, command);
});

check("large terminal.output survives multi-frame chunking intact", () => {
  const big = "x".repeat(512 * 1024); // well above any single-frame limit
  const event = { type: "terminal.output", termId: "t", data: big };
  const frames = frameMessages(sealFrame(roomKey, event));
  assert.ok(frames.length > 1, `expected multiple frames, got ${frames.length}`);
  const opened = cipher.open(reassemble(frames)).data as { data: string };
  assert.equal(opened.data.length, big.length);
  assert.equal(opened.data, big);
});

check("open-run spec fields round-trip unchanged", () => {
  const command = {
    kind: "terminal.open.run",
    agent: "claude",
    command: "claude",
    args: ["--session-id", "abc"],
    name: "relay-demo",
    cols: 120,
    rows: 40,
  };
  const opened = cipher.open(reassemble(frameMessages(cipher.seal(command)))).data;
  assert.deepEqual(opened, command);
});

check("a wrong room key cannot open the frame (E2E: relay stays blind)", () => {
  const event = { type: "terminal.output", termId: "t", data: "secret" };
  const frames = frameMessages(sealFrame(roomKey, event));
  const wrong = new RoomCipher(crypto.randomBytes(32));
  assert.throws(() => wrong.open(reassemble(frames)));
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nrelay-attach bridge: all checks passed");
