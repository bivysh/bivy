// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { mergeTranscript, type SidecarMessage } from "../src/session/transcript-merge.js";

const msg = (role: string, text: string, timestamp: number) => ({ role, content: [{ type: "text", text }], timestamp });
const tool = (id: string, afterMessageCount: number, createdAt: number): SidecarMessage => ({
  role: "assistant",
  bivyKind: "tool",
  afterMessageCount,
  createdAt,
  id,
  content: [{ type: "tool_use", id, name: "bash", input: { command: "ls" } }],
});

test("compacted base: overflow afterMessageCount is placed by TIME, not clumped at the end", () => {
  // Mirrors the real bug: the message list was ~937 long, got compacted to 4,
  // and the sidecar still holds absolute counts far past the end. The tools'
  // createdAt times, though, fall EARLY in the surviving transcript.
  const base = [
    msg("user", "q1", 100),
    msg("assistant", "a1", 200),
    msg("user", "q2", 300),
    msg("assistant", "final answer", 400),
  ];
  const early = tool("t-early", 900, 150); // count says "end", time says between msg0 and msg1
  const mid = tool("t-mid", 937, 350); // count says "end", time says between msg2 and msg3

  const merged = mergeTranscript(base, [early, mid]);
  const order = merged.map((m: any) => (m.bivyKind === "tool" ? m.id : (m.content?.[0]?.text ?? m.role)));

  // Correct chronological placement — NOT both piled after "final answer".
  assert.deepEqual(order, ["q1", "t-early", "a1", "q2", "t-mid", "final answer"]);
  // The regression guard: the last entry must be the final assistant answer.
  assert.equal(order[order.length - 1], "final answer");
});

test("without compaction the count and time agree (normal placement)", () => {
  const base = [msg("user", "q", 100), msg("assistant", "a", 200)];
  const t = tool("t1", 1, 150); // after the first message
  const merged = mergeTranscript(base, [t]);
  assert.deepEqual(merged.map((m: any) => (m.bivyKind === "tool" ? m.id : m.content[0].text)), ["q", "t1", "a"]);
});

test("falls back to clamped afterMessageCount when the base has no timestamps", () => {
  const base = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }];
  const t = tool("t1", 99, 12345); // no base timestamps → clamp 99 -> end (2)
  const merged = mergeTranscript(base as any, [t]);
  assert.equal((merged[merged.length - 1] as any).id, "t1");
});

test("empty extras returns the base unchanged", () => {
  const base = [msg("user", "q", 1)];
  assert.equal(mergeTranscript(base, []), base);
});

test("intermediate reasoning already present in an adjacent message is deduped", () => {
  const base = [
    { role: "user", content: [{ type: "text", text: "q" }], timestamp: 100 },
    { role: "assistant", content: [{ type: "thinking", thinking: "let me think" }], timestamp: 200 },
  ];
  const dup: SidecarMessage = { role: "assistant", bivyKind: "intermediate", afterMessageCount: 2, createdAt: 200, content: [{ type: "thinking", thinking: "let me think" }] };
  const merged = mergeTranscript(base, [dup]);
  assert.equal(merged.length, 2); // the duplicate reasoning card is dropped
});
