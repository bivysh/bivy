// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy tui`: keys become the right effects on the right session, transcripts
// read the shapes agents store, and every frame fits the terminal exactly.
import { strict as assert } from "node:assert";
import test from "node:test";
import { initialState, reduceKey, selectedSession, visibleSessions, withData } from "../bin/tui/model.mjs";
import { renderFrame } from "../bin/tui/render.mjs";
import { transcriptEntries } from "../bin/tui/transcript.mjs";
import { truncate, width, wrap } from "../bin/tui/text.mjs";
import { parseKeys } from "../bin/tui/app.mjs";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function twoMachines() {
  return withData(initialState(), {
    machines: [{ name: "studio", online: true }, { name: "omarchy", online: false }],
    sessions: [
      { machine: "studio", id: "old", name: "Tidy the README", status: "idle", open: true, lastActivityAt: at(1) },
      { machine: "studio", id: "busy", name: "Port the relay", status: "working", open: true, lastActivityAt: at(30) },
      { machine: "omarchy", id: "ask", name: "Fix the flaky test", status: "idle", open: true, lastActivityAt: at(90) },
    ],
    approvals: [
      { machine: "omarchy", id: "ap1", sessionId: "ask", toolName: "Bash", reason: "Run the tests", status: "pending" },
      { machine: "studio", id: "done", sessionId: "old", toolName: "Bash", reason: "", status: "approved" },
    ],
  });
}

function press(state: ReturnType<typeof initialState>, keys: string[]) {
  let effect = null;
  for (const key of keys) [state, effect] = reduceKey(state, key);
  return { state, effect };
}

test("sessions waiting on you come first, then working ones, then the newest", () => {
  assert.deepEqual(visibleSessions(twoMachines()).map((s: { id: string }) => s.id), ["ask", "busy", "old"]);
});

test("a answers the selected session's pending approval on its own machine", () => {
  const { effect } = press(twoMachines(), ["a"]);
  assert.deepEqual(effect, { type: "answer", approval: twoMachines().approvals[0], approve: true });
  assert.equal(press(twoMachines(), ["j", "j", "a"]).effect, null, "an already-answered approval is not answered again");
});

test("typing a message sends it to the selected session, and esc drops it", () => {
  const typed = press(twoMachines(), ["j", "i", ..."Ship it", "enter"]);
  assert.equal(typed.effect?.type, "prompt");
  assert.equal(typed.effect?.session.id, "busy");
  assert.equal(typed.effect?.text, "Ship it");
  assert.equal(press(twoMachines(), ["i", "x", "esc"]).effect, null);
});

test("the selection stays on the same session when fresh data reorders the list", () => {
  const { state } = press(twoMachines(), ["j", "j"]);
  assert.equal(selectedSession(state)?.id, "old");
  const refreshed = withData(state, { ...state, approvals: [] });
  assert.equal(selectedSession(refreshed)?.id, "old");
});

test("the filter matches machine names too", () => {
  const { state } = press(twoMachines(), ["/", ..."omar", "enter"]);
  assert.deepEqual(visibleSessions(state).map((s: { id: string }) => s.id), ["ask"]);
});

test("a transcript shows words and one line per tool call, once, without harness notes", () => {
  const call = { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } };
  const entries = transcriptEntries([
    { role: "user", content: "Run the tests" },
    { role: "user", content: [{ type: "text", text: "<system-reminder>internal</system-reminder>" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Running them." }, call] },
    { role: "assistant", content: [call] },
    { role: "toolResult", content: "ok" },
  ]);
  assert.deepEqual(entries, [
    { role: "user", text: "Run the tests" },
    { role: "agent", text: "Running them." },
    { role: "tool", text: "Bash pnpm test" },
  ]);
});

test("a turn's plan is one progress line, updated in place", () => {
  const plan = (id: string, input: object) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "todo_write", input }] });
  const entries = transcriptEntries([
    { role: "user", content: "Go" },
    plan("p1", { todos: [{ content: "Read", status: "in_progress" }, { content: "Edit", status: "pending" }] }),
    plan("p2", { merge: true, todos: [{ id: "1", status: "completed" }] }),
    plan("p3", { todos: [{ content: "Read", status: "completed" }, { content: "Edit", status: "in_progress" }] }),
  ]);
  assert.deepEqual(entries.map((e: { text: string }) => e.text), ["Go", "plan · 1 of 2 done · Edit"]);
});

test("styled and wide text is measured, cut and wrapped by terminal cells", () => {
  assert.equal(width("\x1b[1mbivy\x1b[0m 日本"), 9);
  assert.equal(width(truncate("\x1b[32mhello world\x1b[0m", 6)), 6);
  assert.deepEqual(wrap("a quick brown fox", 7), ["a quick", "brown", "fox"]);
});

test("every frame is exactly the terminal's size, with the help open or not", () => {
  const state = twoMachines();
  const view = { entries: [{ role: "agent", text: "A long reply ".repeat(40) }, { role: "tool", text: "Bash ".repeat(50) }] };
  for (const [cols, rows] of [[80, 24], [124, 34], [40, 10]]) {
    for (const s of [state, press(state, ["?"]).state]) {
      const lines = renderFrame(s, view, { width: cols, height: rows });
      assert.equal(lines.length, rows);
      for (const line of lines) assert.equal(width(line), cols);
    }
  }
});

test("terminal input becomes keys; a paste becomes its characters", () => {
  assert.deepEqual(parseKeys("\x1b[A"), ["up"]);
  assert.deepEqual(parseKeys("hi there"), ["h", "i", "space", "t", "h", "e", "r", "e"]);
});
