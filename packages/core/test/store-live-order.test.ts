// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

/**
 * Live-stream ordering (slice 5, deep). #501 fixed history render: renderHistory
 * walks content blocks so an assistant turn shaped `prose → tool → prose` shows
 * the tool card BETWEEN the two prose runs, not hoisted above them and not
 * merged into one bubble. The live reducer (applyStreamEvent) committed all prose
 * in one lump at message_end while tool cards applied live, so the SAME turn drew
 * as `tool → merged-prose` while it streamed — diverging from what a reopen
 * showed. These lock the live path to the same order as the reopened history.
 *
 * The node streams tools as their OWN `tool_call`/`tool_result` events (applied
 * live) while message_update/message_end carry only accumulated text. Codex
 * accumulates text cumulatively into a single message_end; Claude resets text per
 * assistant segment and emits one message_end per segment. Both are covered.
 */
type Ev = Record<string, unknown>;

function play(events: Ev[]): SessionStore {
  const store = new SessionStore();
  for (const e of events) store.apply(e as never);
  return store;
}

/** Just the prose text / tool callId of each transcript entry, in order. */
function shape(store: SessionStore): Array<{ role: string; text?: string; tool?: string }> {
  return store.getState().transcript.map((e) => (e.tool ? { role: "tool", tool: e.tool.callId } : { role: e.role, text: e.text }));
}

describe("live-stream reasoning/tool order (reducer)", () => {
  it("Codex shape: one cumulative message, tool card sits BETWEEN the two prose runs", () => {
    // Codex: a single growing `text` accumulator per turn; tool as a separate
    // tool_call event; one message_end carrying the full cumulative text.
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "I'll create the file." } },
      { type: "tool_call", toolName: "bash", input: { command: "touch x" }, toolCallId: "t1" },
      { type: "tool_result", toolCallId: "t1", result: "" },
      // cumulative text grows to include the trailing prose:
      { type: "message_update", message: { role: "assistant", content: "I'll create the file.\nDone." } },
      { type: "message_end", message: { role: "assistant", content: "I'll create the file.\nDone." } },
      { type: "turn_end" },
      { type: "agent_end" },
    ]);

    expect(shape(store)).toEqual([
      { role: "assistant", text: "I'll create the file." },
      { role: "tool", tool: "t1" },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("Claude shape: text resets per segment, tool_call precedes the segment's message_end", () => {
    // Claude: content_block_delta text deltas → message_update; the final
    // `assistant` message emits tool_call(s) BEFORE message_end; currentText
    // resets, so segment 2 arrives as its own message_start…message_end.
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "Let me check the file." } },
      { type: "tool_call", toolName: "bash", input: { command: "cat x" }, toolUseId: "t1" },
      { type: "message_update", message: { role: "assistant", content: "Let me check the file." } },
      { type: "message_end", message: { role: "assistant", content: "Let me check the file." } },
      { type: "tool_result", toolUseId: "t1", result: "contents", isError: false },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "All good." } },
      { type: "message_end", message: { role: "assistant", content: "All good." } },
      { type: "turn_end" },
      { type: "agent_end" },
    ]);

    expect(shape(store)).toEqual([
      { role: "assistant", text: "Let me check the file." },
      { role: "tool", tool: "t1" },
      { role: "assistant", text: "All good." },
    ]);
  });

  it("no-tool turn is unchanged: a single prose bubble at message_end", () => {
    const store = play([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "hello" } },
      { type: "message_end", message: { role: "assistant", content: "hello there" } },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([{ role: "assistant", text: "hello there" }]);
  });

  it("two tools in a row keep both cards between the surrounding prose (no empty bubble between them)", () => {
    const store = play([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "Working on it." } },
      { type: "tool_call", toolName: "bash", input: {}, toolCallId: "a" },
      { type: "tool_call", toolName: "bash", input: {}, toolCallId: "b" },
      { type: "message_update", message: { role: "assistant", content: "Working on it.\nFinished." } },
      { type: "message_end", message: { role: "assistant", content: "Working on it.\nFinished." } },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([
      { role: "assistant", text: "Working on it." },
      { role: "tool", tool: "a" },
      { role: "tool", tool: "b" },
      { role: "assistant", text: "Finished." },
    ]);
  });

  it("reasoning before a tool: the thinking bubble lands ABOVE the tool card, not below it", () => {
    // Claude streams a `thinking` block (no text) then emits the tool_call before
    // the segment's message_end. Thinking used to commit only at message_end —
    // AFTER the tool card had already applied live — so a `think → tool → answer`
    // turn drew as `tool → think → answer` while streaming, diverging from the
    // reopened history (which interleaves reasoning/tools by time).
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me look." }] } },
      { type: "tool_call", toolName: "bash", input: { command: "cat x" }, toolUseId: "t1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me look." }] } },
      { type: "tool_result", toolUseId: "t1", result: "contents", isError: false },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "All done." } },
      { type: "message_end", message: { role: "assistant", content: "All done." } },
      { type: "turn_end" },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([
      { role: "thinking", text: "Let me look." },
      { role: "tool", tool: "t1" },
      { role: "assistant", text: "All done." },
    ]);
  });

  it("interleaved reasoning: think → tool → think → tool → answer keeps each reasoning run above its tool", () => {
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan A" }] } },
      { type: "tool_call", toolName: "bash", input: {}, toolUseId: "t1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan A" }] } },
      { type: "tool_result", toolUseId: "t1", result: "" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan B" }] } },
      { type: "tool_call", toolName: "bash", input: {}, toolUseId: "t2" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan B" }] } },
      { type: "tool_result", toolUseId: "t2", result: "" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: "Answer." } },
      { type: "message_end", message: { role: "assistant", content: "Answer." } },
      { type: "turn_end" },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([
      { role: "thinking", text: "Plan A" },
      { role: "tool", tool: "t1" },
      { role: "thinking", text: "Plan B" },
      { role: "tool", tool: "t2" },
      { role: "assistant", text: "Answer." },
    ]);
  });

  it("no-tool reasoning turn is unchanged: one thinking bubble then the answer", () => {
    const store = play([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hmm." }] } },
      { type: "message_end", message: { role: "assistant", content: "The answer." } },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([
      { role: "thinking", text: "Hmm." },
      { role: "assistant", text: "The answer." },
    ]);
  });

  it("does not carry prose across turns when the next turn opens with a tool", () => {
    // Regression guard for the accumulator reset: turn 1 leaves prose in the
    // draft; turn 2 fires a tool before any new prose. The old prose must not be
    // re-committed above turn 2's tool card.
    const store = play([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "First turn answer." } },
      { type: "agent_end" },
      // turn 2 starts straight into a tool, no message_start/prose first:
      { type: "tool_call", toolName: "bash", input: {}, toolCallId: "z" },
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "Second turn answer." } },
      { type: "agent_end" },
    ]);
    expect(shape(store)).toEqual([
      { role: "assistant", text: "First turn answer." },
      { role: "tool", tool: "z" },
      { role: "assistant", text: "Second turn answer." },
    ]);
  });
});
