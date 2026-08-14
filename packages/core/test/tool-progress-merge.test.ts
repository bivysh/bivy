// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

/**
 * A running tool's card must not lose its identity to a progress-only ping.
 * Claude's SDK streams `tool_execution_update` keep-alives carrying just
 * `{ elapsedSeconds }` and no `detail`; the live reducer used to REPLACE the
 * card's input with that ping, blanking the `command`/`path` label for any tool
 * the node couldn't classify into a `detail`. The reducer now merges streaming
 * inputs, so the original call survives and the elapsed marker is added on top.
 */
describe("tool progress ping does not clobber a running tool's input", () => {
  function play(events: Array<Record<string, unknown>>): SessionStore {
    const store = new SessionStore();
    for (const e of events) store.apply(e as never);
    return store;
  }

  it("keeps the original command after an elapsedSeconds-only update (no detail)", () => {
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_call", toolName: "some_unclassified_tool", input: { command: "run-the-thing --flag" }, toolCallId: "t1" },
      { type: "tool_execution_update", toolName: "some_unclassified_tool", toolCallId: "t1", input: { elapsedSeconds: 7 } },
    ]);
    const card = store.getState().activeSession.transcript.find((e) => e.tool?.callId === "t1")?.tool;
    expect(card).toBeTruthy();
    expect(card!.status).toBe("running");
    expect(card!.input).toMatchObject({ command: "run-the-thing --flag", elapsedSeconds: 7 });
  });

  it("still lets a later enriching update win per key (e.g. late rawInput)", () => {
    const store = play([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_call", toolName: "bash", input: {}, toolCallId: "t2" },
      { type: "tool_execution_update", toolName: "bash", toolCallId: "t2", input: { command: "npm test" } },
    ]);
    const card = store.getState().activeSession.transcript.find((e) => e.tool?.callId === "t2")?.tool;
    expect(card!.input).toMatchObject({ command: "npm test" });
  });
});
