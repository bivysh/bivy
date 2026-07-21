import assert from "node:assert/strict";
import { normalizeMessages, buildSeedPrompt } from "../src/session/transcript-normal.js";
import type { NormalizedTranscriptHeader } from "../src/session/transcript-normal.js";

// Unit tests for the runtime-neutral transcript used by session fork
// (docs/session-fork-plan.md). normalizeMessages flattens the shared
// `{ role, content }` runtime message shape (string OR Anthropic-style block
// array — the form both pi and Claude Code return from readMessages()) into
// portable turns; buildSeedPrompt renders the compact cross-runtime seed.

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const header: NormalizedTranscriptHeader = {
  sourceRuntimeId: "pi",
  model: "claude-sonnet",
  title: "Fix the parser",
  createdAt: "2026-01-01T00:00:00Z",
};

test("pi-shape: string + text-block content normalize to turns", () => {
  // Exactly the shape test/runtime-read-messages.test.ts persists for pi.
  const msgs = [
    { role: "user", content: "resume me fast" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const t = normalizeMessages(msgs, header);
  assert.equal(t.turns.length, 2);
  assert.deepEqual(t.turns.map((x) => x.role), ["user", "assistant"]);
  assert.equal(t.turns[0].text, "resume me fast");
  assert.equal(t.turns[1].text, "done");
  assert.equal(t.header.sourceRuntimeId, "pi");
});

test("claude-shape: tool_use annotates the assistant turn without raw payload", () => {
  const msgs = [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal — must be dropped" },
        { type: "text", text: "Reading it now." },
        { type: "tool_use", name: "Read", input: { path: "/etc/passwd", secret: "x".repeat(500) } },
      ],
      timestamp: "2026-01-01T00:00:01Z",
    },
  ];
  const t = normalizeMessages(msgs, header);
  assert.equal(t.turns.length, 2);
  const asst = t.turns[1];
  assert.equal(asst.role, "assistant");
  assert.equal(asst.text, "Reading it now."); // thinking dropped, text kept
  assert.equal(asst.toolName, "Read");
  assert.ok(asst.toolSummary?.startsWith("Read("));
  assert.ok((asst.toolSummary?.length ?? 0) < 260, "tool payload is compacted, not inlined whole");
  assert.equal(asst.ts, Date.parse("2026-01-01T00:00:01Z"));
});

test("a user message that is purely tool_result becomes a 'tool' turn", () => {
  const msgs = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents here" }] },
  ];
  const t = normalizeMessages(msgs, header);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].role, "tool");
  assert.ok(t.turns[0].toolSummary?.includes("file contents here"));
});

test("empty / unknown-shape turns are dropped, never thrown on", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "thinking", thinking: "only reasoning" }] }, // -> nothing usable
    { role: "user", content: 42 as unknown }, // unknown shape
    { role: "user", content: "real" },
  ];
  const t = normalizeMessages(msgs as never, header);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].text, "real");
});

test("undefined messages normalize to an empty transcript", () => {
  const t = normalizeMessages(undefined, header);
  assert.deepEqual(t.turns, []);
});

test("buildSeedPrompt: recent turns + transcript link, capped", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as const,
    text: `turn ${i} ${"y".repeat(2000)}`,
  }));
  const seed = buildSeedPrompt(
    { header, turns },
    { transcriptUrl: "https://app.example/sessions/abc", targetAgent: "Claude Code", recentTurns: 5, context: { branch: "bivy/x" } },
  );
  assert.ok(seed.includes("Full original transcript: https://app.example/sessions/abc"));
  assert.ok(seed.includes("Claude Code"));
  assert.ok(seed.includes("Branch: bivy/x"));
  assert.ok(seed.includes("turn 29"), "keeps the most recent turn");
  assert.ok(!seed.includes("turn 24"), "only the last 5 turns are inlined");
  assert.ok(!seed.includes("y".repeat(1000)), "per-turn text is truncated");
});

test("buildSeedPrompt without a transcript URL still yields a usable prompt", () => {
  const seed = buildSeedPrompt({ header, turns: [{ role: "user", text: "hello" }] }, {});
  assert.ok(seed.includes("Continue from here."));
  assert.ok(!seed.includes("Full original transcript"));
});

console.log(`transcript-normal: all ${passed} tests passed`);
