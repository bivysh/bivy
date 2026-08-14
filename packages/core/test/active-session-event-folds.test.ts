// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  foldActiveSessionEvent,
  foldAttentionEvent,
  foldTranscriptEvent,
  freshTranscriptDraft,
  type TranscriptFoldValue,
} from "../src/index.js";

function transcriptValue(): TranscriptFoldValue {
  return { transcript: [], draft: freshTranscriptDraft(), pendingAgentAttachments: [], working: false, workingLabel: "" };
}

describe("active-session pure event folds", () => {
  it("keeps attention queues coordinated without mutating their input", () => {
    const initial = { approvals: [], questions: [], turnAttentions: [] };
    const approval = foldAttentionEvent(initial, { type: "approval.created", approval: { id: "a1", sessionId: "s1" } }, 100);
    const question = foldAttentionEvent(approval.value, {
      type: "session.question", requestId: "q1", sessionId: "s1",
      questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
    }, 101);
    const resolved = foldAttentionEvent(question.value, { type: "approval.resolved", id: "a1" }, 102);

    expect(initial.approvals).toEqual([]);
    expect(question.row).toEqual({ sessionId: "s1", status: "needs_action", needsAction: true, updatedAt: 101 });
    expect(resolved.row).toBeUndefined(); // the question still needs a response
    expect(resolved.value.questions).toHaveLength(1);
  });

  it("focus-gates usage and returns lifecycle commands", () => {
    const input = {
      activeSessionId: "open", working: true, workingLabel: "Running", opening: true,
      usage: null, changes: null, changesHistory: [], checkpoints: [], activeTitle: "Before", github: { branch: null },
    };
    expect(foldActiveSessionEvent(input, { type: "session.usage", sessionId: "other", usage: { inputTokens: 4 } }, 1).patch).toBeUndefined();
    const closed = foldActiveSessionEvent(input, { type: "session.closed", sessionId: "open" }, 2);
    expect(closed.patch).toMatchObject({ working: false, workingLabel: "", opening: false });
    expect(closed.commands[0]).toMatchObject({ kind: "row", sessionId: "open", patch: { status: "saved" } });
    expect(input.working).toBe(true);
  });

  it("interleaves prose and tools immutably", () => {
    const initial = transcriptValue();
    const update = foldTranscriptEvent(initial, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "First" }] } }, 10);
    const tool = foldTranscriptEvent(update.value, { type: "tool_start", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } }, 11);
    const end = foldTranscriptEvent(tool.value, { type: "agent_end" }, 12);

    expect(initial.transcript).toEqual([]);
    expect(tool.value.transcript.map((entry) => entry.tool ? entry.tool.name : entry.text)).toEqual(["First", "bash"]);
    expect(end.value.transcript[1]?.tool?.status).toBe("done");
    expect(end.value.working).toBe(false);
    expect(end.commands).toContainEqual({ kind: "turn-settled" });
  });

  it("buffers attachments and groups them under final prose", () => {
    const withProse: TranscriptFoldValue = { ...transcriptValue(), transcript: [{ id: "reply", role: "assistant", text: "Done" }] };
    const buffered = foldTranscriptEvent(withProse, { type: "attachment", ref: { kind: "file", hash: "abc", name: "report.txt", size: 3 }, caption: "report" }, 50);
    const ended = foldTranscriptEvent(buffered.value, { type: "turn_end" }, 51);

    expect(withProse.transcript[0]?.attachments).toBeUndefined();
    expect(ended.value.transcript[0]?.attachments?.[0]).toMatchObject({ hash: "abc", createdAt: 50 });
    expect(ended.commands).toContainEqual({ kind: "remember-agent-attachments" });
  });
});
