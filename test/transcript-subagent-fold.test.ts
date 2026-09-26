// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Live-stream nesting for the shared transcript reducer
// (packages/core/src/transcript-event-fold.ts): a tool_call carrying a
// parent_tool_use_id (a sub-agent's own step) must land on its ToolActivity as
// parentToolUseId so the PWA can nest it under the delegation card. This drives
// the reducer with the wire shapes the Claude runtime emits and asserts the
// grouping hint survives both the initial call and a later status update.

import assert from "node:assert/strict";
import { foldTranscriptEvent, freshTranscriptDraft, type TranscriptFoldValue } from "../packages/core/src/transcript-event-fold.js";

function fresh(): TranscriptFoldValue {
  return { transcript: [], draft: freshTranscriptDraft(), working: false, workingLabel: "" };
}

function run(events: any[]): TranscriptFoldValue {
  let value = fresh();
  for (const event of events) {
    const result = foldTranscriptEvent(value, event, Date.now());
    value = result.value;
  }
  return value;
}

// A Task delegation, then the sub-agent's own Bash call stamped with the Task's
// tool_use id. The child nests; the parent stays top-level.
{
  const value = run([
    { type: "tool_call", toolName: "Task", toolUseId: "task-1", input: { subagent_type: "Explore" }, detail: { kind: "delegation", label: "Explore", meta: { version: 1, provider: "claude", protocol: "sdk", rawToolName: "Task" } } },
    { type: "tool_call", toolName: "Bash", toolUseId: "bash-1", parentToolUseId: "task-1", input: { command: "ls" }, detail: { kind: "shell", command: "ls", meta: { version: 1, provider: "claude", protocol: "sdk", rawToolName: "Bash" } } },
    // A later progress update for the child must not drop the parent hint.
    { type: "tool_execution_update", toolName: "Bash", toolUseId: "bash-1", parentToolUseId: "task-1", input: { elapsedSeconds: 2 } },
  ]);

  const parent = value.transcript.find((e) => e.tool?.callId === "task-1");
  const child = value.transcript.find((e) => e.tool?.callId === "bash-1");
  assert.ok(parent, "delegation card exists");
  assert.equal(parent!.tool?.parentToolUseId, undefined, "delegation stays top-level");
  assert.ok(child, "sub-agent tool card exists");
  assert.equal(child!.tool?.parentToolUseId, "task-1", "sub-agent tool nests under the delegation");
}

console.log("ok transcript sub-agent fold nesting");
