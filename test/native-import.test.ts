// Unit tests for the seeded-continuation prompt builder backing native session
// import (src/session/native-import.ts, issue #156's "fall back to a seeded
// continuation only with explicit user disclosure"). Pure/no side effects, so
// this is tested directly against synthetic RuntimeMessage transcripts rather
// than a live runtime.

import assert from "node:assert/strict";
import { buildNativeImportSeedPrompt, buildNativeImportSeedFromMessages } from "../src/session/native-import.js";
import { normalizeMessages } from "../src/session/transcript-normal.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const header = { sourceRuntimeId: "codex-approvals", title: "Fix the flaky test", createdAt: "2026-07-11T10:00:00.000Z" };

check("names the provider and is explicit this is a seeded continuation, not a resume", () => {
  const transcript = normalizeMessages(
    [
      { role: "user", content: "add a retry to the flaky test" },
      { role: "assistant", content: [{ type: "text", text: "Done — added a retry." }] },
    ],
    header,
  );
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Codex" });
  assert.match(prompt, /Codex session/);
  assert.match(prompt, /Native resume wasn't available/i);
  assert.match(prompt, /not the original session itself/i);
  assert.match(prompt, /add a retry to the flaky test/);
  assert.match(prompt, /Done — added a retry\./);
});

check("includes the session title and cwd when known", () => {
  const transcript = normalizeMessages([{ role: "user", content: "hi" }], header);
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Claude Code SDK", title: "Fix the flaky test", cwd: "/work/repo" });
  assert.match(prompt, /Session: Fix the flaky test/);
  assert.match(prompt, /Working directory: \/work\/repo/);
});

check("omits the working-directory line when cwd is unknown", () => {
  const transcript = normalizeMessages([{ role: "user", content: "hi" }], header);
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Codex" });
  assert.ok(!prompt.includes("Working directory:"));
});

check("says so when there are no prior turns to summarize", () => {
  const transcript = normalizeMessages([], header);
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Codex" });
  assert.match(prompt, /no prior turns were available/i);
});

check("only inlines the most recent N turns (bounded, never the full transcript)", () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}` }));
  const transcript = normalizeMessages(messages, header);
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Codex", recentTurns: 4 });
  assert.ok(!prompt.includes("turn 0"), "an old turn beyond the window must not appear");
  assert.ok(prompt.includes("turn 19"), "the most recent turn must appear");
  const turnLines = prompt.split("\n").filter((l) => /^- (user|assistant):/.test(l));
  assert.equal(turnLines.length, 4);
});

check("truncates an oversized turn to perTurnChars", () => {
  const longText = "x".repeat(2000);
  const transcript = normalizeMessages([{ role: "user", content: longText }], header);
  const prompt = buildNativeImportSeedPrompt(transcript, { provider: "Codex", perTurnChars: 50 });
  const line = prompt.split("\n").find((l) => l.startsWith("- user:"))!;
  assert.ok(line.length < 80, `expected a truncated line, got ${line.length} chars`);
  assert.ok(line.endsWith("…"));
});

check("buildNativeImportSeedFromMessages normalizes and seeds in one call", () => {
  const prompt = buildNativeImportSeedFromMessages(
    [{ role: "user", content: "hello" }],
    header,
    { provider: "Codex" },
  );
  assert.match(prompt, /hello/);
  assert.match(prompt, /Codex session/);
});

check("handles undefined messages (no transcript could be read) without throwing", () => {
  const prompt = buildNativeImportSeedFromMessages(undefined, header, { provider: "Codex" });
  assert.match(prompt, /no prior turns were available/i);
});

if (failures > 0) {
  console.error(`\n${failures} native-import test(s) failed.`);
  process.exit(1);
}
console.log("\nAll native-import tests passed.");
