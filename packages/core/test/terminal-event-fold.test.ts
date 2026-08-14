// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { foldTerminalEvent } from "../src/terminal-event-fold.js";

const initial = {
  runTerminals: [{ termId: "one", name: "First", lastActivityAt: 10 }],
  tuiSessions: ["busy"],
};

describe("foldTerminalEvent", () => {
  it("replaces, upserts, updates and removes terminal rows", () => {
    const listed = foldTerminalEvent(initial, {
      type: "terminal.list",
      terminals: [{ termId: "two", name: "Second" }, null, { nope: true }],
    }, 20);
    expect(listed.handled && listed.value.runTerminals).toEqual([{ termId: "two", name: "Second" }]);

    const created = foldTerminalEvent(initial, {
      type: "terminal.created",
      terminal: { termId: "one", name: "Replacement" },
    }, 20);
    expect(created.handled && created.value.runTerminals).toEqual([{ termId: "one", name: "Replacement" }]);

    const active = foldTerminalEvent(initial, { type: "terminal.activity", termId: "one" }, 42);
    expect(active.handled && active.value.runTerminals[0]?.lastActivityAt).toBe(42);

    const closed = foldTerminalEvent(initial, { type: "terminal.exit", termId: "one" }, 20);
    expect(closed.handled && closed.value.runTerminals).toEqual([]);
  });

  it("tracks TUI ownership idempotently", () => {
    const added = foldTerminalEvent(initial, { type: "terminal.tui", sessionId: "next", active: true }, 20);
    expect(added.handled && added.value.tuiSessions).toEqual(["busy", "next"]);

    const unchanged = foldTerminalEvent(initial, { type: "terminal.tui", sessionId: "busy", active: true }, 20);
    expect(unchanged.handled && unchanged.value).toBe(initial);

    const removed = foldTerminalEvent(initial, { type: "terminal.tui", sessionId: "busy", active: false }, 20);
    expect(removed.handled && removed.value.tuiSessions).toEqual([]);
  });

  it("does not claim unrelated events", () => {
    expect(foldTerminalEvent(initial, { type: "session.created" }, 20)).toEqual({ handled: false, value: initial });
  });
});
