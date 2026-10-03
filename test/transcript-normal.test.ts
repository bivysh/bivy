import assert from "node:assert/strict";
import { normalizeMessages, buildSeedPrompt, buildForkHistory, lastTranscriptModel, relocateTranscript, renderForkTranscript } from "../src/session/transcript-normal.js";
import type { NormalizedTranscriptHeader } from "../src/session/transcript-normal.js";

// Unit tests for the runtime-neutral transcript used by session fork.
// normalizeMessages flattens the shared `{ role, content }` runtime message
// shape (string OR Anthropic-style block
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

test("image blocks are preserved as a placeholder so the turn is never silently dropped", () => {
  // Two runtime image shapes: Claude ({source:{…}}) and the protocol runtime
  // ({data, mimeType}). Both tag the block type "image" and carry no portable
  // text, so before this they were dropped — an image-only turn vanished whole.
  const msgs = [
    // image-only user turn (Claude shape)
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    // text + image user turn (protocol shape)
    { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }] },
  ];
  const t = normalizeMessages(msgs as never, header);
  assert.equal(t.turns.length, 2, "the image-only turn survives instead of being dropped");
  assert.equal(t.turns[0].role, "user");
  assert.ok(/1 image attachment omitted/.test(t.turns[0].text), "the image-only turn discloses the attachment");
  assert.ok(t.turns[1].text.includes("what is this?"), "the accompanying text is kept");
  assert.ok(/1 image attachment omitted/.test(t.turns[1].text), "the image is disclosed alongside the text");
  // And it carries through a replayed (true) fork rather than being lost there too.
  const history = buildForkHistory(t);
  assert.ok(history.some((m) => /image attachment/.test(m.text)), "the image note replays into the forked history");
});

test("a tool_result carrying an image is summarized without leaking base64", () => {
  // A screenshot/Playwright tool returns text + a base64 image part. The image
  // bytes must not be JSON-dumped into the (200-char) tool summary; keep the
  // text and mark the image so the tool result reads cleanly across runtimes.
  const bigData = "A".repeat(4000);
  const msgs = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "screenshot captured" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: bigData } },
          ],
        },
      ],
    },
  ];
  const t = normalizeMessages(msgs as never, header);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].role, "tool");
  assert.ok(t.turns[0].toolSummary?.includes("screenshot captured"), "the readable tool text is kept");
  assert.ok(t.turns[0].toolSummary?.includes("[image]"), "the image is disclosed as a marker");
  assert.ok(!t.turns[0].toolSummary?.includes("AAAA"), "no base64 blob leaks into the transcript");
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
  assert.ok(!seed.includes(`turn 27 ${"y".repeat(1000)}`), "per-turn text is truncated");
  assert.ok(seed.includes(`The user's latest request, in full:\nturn 28 ${"y".repeat(2000)}`), "the latest request is repeated in full");
});

test("buildSeedPrompt without a transcript URL still yields a usable prompt", () => {
  const seed = buildSeedPrompt({ header, turns: [{ role: "user", text: "hello" }] }, {});
  assert.ok(seed.includes("Continue from here."));
  assert.ok(!seed.includes("Full original transcript"));
});

test("buildSeedPrompt: adaptive budget carries far more than the old fixed 12 short turns", () => {
  // 40 short turns — under the default char budget they should ALL be inlined,
  // where the old fixed 12-turn tail would have dropped the first 28.
  const turns = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as const,
    text: `turn ${i}`,
  }));
  const seed = buildSeedPrompt({ header, turns }, {});
  assert.ok(seed.includes("turn 0"), "the earliest short turn fits within budget");
  assert.ok(seed.includes("turn 39"), "the latest turn is kept");
  assert.ok(!/\d+ earlier turns? omitted/.test(seed), "nothing omitted when the whole history fits the budget");
});

test("buildSeedPrompt: a tight char budget keeps the newest turns and notes the omission", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as const,
    text: `turn ${i} ${"z".repeat(300)}`,
  }));
  const seed = buildSeedPrompt({ header, turns }, { charBudget: 700, transcriptUrl: "https://app.example/s/1" });
  assert.ok(seed.includes("turn 9"), "the most recent turn is always kept");
  assert.ok(!seed.includes("turn 0"), "the oldest turn is dropped under a tight budget");
  assert.ok(/\d+ earlier turns? omitted/.test(seed), "the omitted count is surfaced");
  assert.ok(seed.includes("linked above"), "points at the full transcript for the rest");
});

test("buildSeedPrompt: the most recent turn is kept even when it alone exceeds the budget", () => {
  const seed = buildSeedPrompt(
    { header, turns: [{ role: "user", text: "x".repeat(5000) }] },
    { charBudget: 100 },
  );
  assert.ok(seed.includes("- user: x"), "never emits an empty seed");
  assert.ok(!/earlier turns? omitted/.test(seed), "a single kept turn is not reported as an omission");
});

test("buildForkHistory: keeps EVERY turn as real roles for a true replay fork", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as const,
    text: `turn ${i}`,
  }));
  const history = buildForkHistory({ header, turns });
  // Unlike buildSeedPrompt, nothing is dropped — the whole conversation carries.
  assert.ok(history.some((m) => m.text.includes("turn 0")), "the earliest turn survives (not just the tail)");
  assert.ok(history.some((m) => m.text.includes("turn 29")), "the latest turn survives");
  assert.deepEqual([...new Set(history.map((m) => m.role))].sort(), ["assistant", "user"], "roles are preserved, not flattened into one user prompt");
});

test("buildForkHistory: inlines tool activity as text and merges consecutive same-role turns", () => {
  const history = buildForkHistory({
    header,
    turns: [
      { role: "user", text: "read the file" },
      { role: "assistant", text: "Reading it now.", toolName: "Read", toolSummary: "Read(/etc/hosts)" },
      { role: "tool", text: "", toolSummary: "→ 127.0.0.1 localhost" },
    ],
  });
  // The assistant text turn and the following tool-result turn merge into one
  // assistant message (tool result is the agent's own work, not the user's).
  assert.equal(history.length, 2, "user turn, then a merged assistant turn");
  assert.equal(history[0].role, "user");
  assert.equal(history[1].role, "assistant");
  assert.ok(history[1].text.includes("Reading it now."), "assistant prose kept");
  assert.ok(history[1].text.includes("[ran Read] Read(/etc/hosts)"), "the tool call is inlined as readable text");
  assert.ok(history[1].text.includes("[tool result] → 127.0.0.1 localhost"), "the tool result is inlined as readable text");
  assert.ok(!/tool_use|tool_result/.test(history[1].text), "no provider-specific structured blocks leak in");
});

test("relocateTranscript: a fork's history points at its own copy of the workspace", () => {
  const moved = relocateTranscript({
    header,
    turns: [
      { role: "user", text: "fix /work/repo/calc.py" },
      { role: "assistant", text: "Edited it.", toolName: "Edit", toolSummary: 'Edit({"file_path":"/work/repo/calc.py"})' },
      { role: "assistant", text: "Left /work/repo-other alone." },
    ],
  }, "/work/repo", "/work/repo/.bivy/worktrees/fork-1");
  const history = buildForkHistory(moved);
  assert.equal(history[0].text, "fix /work/repo/.bivy/worktrees/fork-1/calc.py");
  assert.ok(history[1].text.includes('"/work/repo/.bivy/worktrees/fork-1/calc.py"'), "tool activity is relocated too");
  assert.ok(history[1].text.includes("/work/repo-other"), "a sibling path that merely shares the prefix is untouched");
  assert.ok(history[1].text.includes("[workspace] This conversation now continues in /work/repo/.bivy/worktrees/fork-1"), "the agent is told where the work lives");
  assert.match(buildSeedPrompt(moved), /now continues in \/work\/repo\/\.bivy\/worktrees\/fork-1/, "a seeded fork says so too");
  const same = { header, turns: [{ role: "user" as const, text: "x" }] };
  assert.equal(relocateTranscript(same, "/a", "/a"), same, "an unmoved fork is unchanged");
});

test("lastTranscriptModel: the model the agent last answered with, skipping Bivy's overlay records", () => {
  assert.deepEqual(lastTranscriptModel([
    { role: "assistant", content: "a", model: "claude-opus-4-8" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c", model: "gpt-5.6-sol", provider: "openai-codex" },
    { role: "assistant", bivyKind: "tool", content: [], model: "ignored" },
  ]), { provider: "openai-codex", id: "gpt-5.6-sol" });
  assert.equal(lastTranscriptModel([{ role: "assistant", content: "x" }]), undefined);
});

test("buildForkHistory: a system/error notice folds into the assistant voice", () => {
  const history = buildForkHistory({
    header,
    turns: [
      { role: "user", text: "go" },
      { role: "error", text: "session was interrupted" },
    ],
  });
  assert.equal(history[1].role, "assistant", "only the human's turns ever carry the user role");
  assert.ok(history[1].text.includes("[system] session was interrupted"));
});


test("buildSeedPrompt: a readable conversation file replaces the app link for the agent", () => {
  const seed = buildSeedPrompt({ header, turns: [{ role: "user", text: "hi" }] }, { transcriptUrl: "https://app.example/s/1", transcriptFile: "/data/fork-transcripts/a.md" });
  assert.ok(seed.includes("/data/fork-transcripts/a.md"), "points the agent at the file");
  assert.doesNotMatch(seed, /Full original transcript:/, "no unreadable app link for the agent to chase");
});

test("renderForkTranscript: every turn, in order, as Markdown", () => {
  const md = renderForkTranscript({ header, turns: [{ role: "user", text: "first ask" }, { role: "assistant", text: "first answer" }, { role: "user", text: "second ask" }] });
  assert.ok(md.indexOf("first ask") < md.indexOf("first answer") && md.indexOf("first answer") < md.indexOf("second ask"));
  assert.match(md, /## User\n\nfirst ask/);
});

test("a plan kept by the agent reaches the seed and the replayed history, merges applied", () => {
  const t = normalizeMessages([
    { role: "user", content: "do the steps" },
    { role: "assistant", content: [{ type: "tool_use", id: "p1", name: "todo_write", input: { todos: [{ id: "1", content: "Read", status: "in_progress" }, { id: "2", content: "Edit", status: "pending" }] } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "p2", name: "todo_write", input: { merge: true, todos: [{ id: "1", content: null, status: "completed" }] } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "todo_write", parentToolUseId: "task-1", input: { todos: [{ content: "sub-agent step", status: "pending" }] } }] },
    { role: "assistant", content: "Read it; editing next." },
    { role: "user", content: "keep going" },
  ] as never, header);
  assert.deepEqual(t.plan?.map((e) => [e.text, e.status]), [["Read", "completed"], ["Edit", "pending"]], "a sub-agent's plan is not the session's");
  assert.match(buildSeedPrompt(t), /plan so far[^\n]*\n- \[x\] Read\n- \[ \] Edit/);
  const history = buildForkHistory(t);
  assert.equal(history.at(-1)?.text, "keep going", "the open request stays last");
  assert.match(history.at(-2)!.text, /\[plan\][^\n]*\n- \[x\] Read\n- \[ \] Edit$/, "the plan closes the agent's last reply");
});
console.log(`transcript-normal: all ${passed} tests passed`);
