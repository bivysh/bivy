// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy tui` state and keys, with no I/O: a key press returns the next state and
// at most one effect for the caller to carry out (answer an approval, send a
// prompt, open or stop a session, quit).

export function initialState() {
  return {
    machines: [],
    sessions: [],
    approvals: [],
    selectedKey: null,
    focus: "sessions",
    mode: "normal",
    filter: "",
    input: "",
    scroll: 0,
    notice: "",
  };
}

export const sessionKey = (s) => `${s.machine}/${s.id}`;

const WORKING = new Set(["working", "streaming", "running", "thinking"]);
export const isWorking = (s) => WORKING.has(String(s?.status ?? "").toLowerCase());

/** The first approval still waiting on this session, if any. */
export function pendingApproval(state, session) {
  if (!session) return null;
  return state.approvals.find((a) => a.machine === session.machine && a.sessionId === session.id && a.status === "pending") ?? null;
}

const rank = (state, s) => (pendingApproval(state, s) || s.needsAction ? 0 : isWorking(s) ? 1 : 2);

/** Sessions to list: filtered, those waiting on you first, then working, then newest. */
export function visibleSessions(state) {
  const needle = state.filter.toLowerCase();
  return state.sessions
    .filter((s) => !needle || `${s.name} ${s.agent} ${s.machine} ${s.branch ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => rank(state, a) - rank(state, b) || String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")));
}

export function selectedSession(state) {
  const list = visibleSessions(state);
  return list.find((s) => sessionKey(s) === state.selectedKey) ?? list[0] ?? null;
}

function move(state, delta) {
  const list = visibleSessions(state);
  if (!list.length) return state;
  const current = Math.max(0, list.findIndex((s) => sessionKey(s) === sessionKey(selectedSession(state))));
  const next = Math.min(list.length - 1, Math.max(0, current + delta));
  return { ...state, selectedKey: sessionKey(list[next]), scroll: 0 };
}

/** Replace what the machines reported, keeping the selection on the same session. */
export function withData(state, { machines, sessions, approvals }) {
  const next = { ...state, machines, sessions, approvals };
  const selected = selectedSession(next);
  return { ...next, selectedKey: selected ? sessionKey(selected) : null };
}

/** Handle one key. Returns `[state, effect | null]`. */
export function reduceKey(state, key) {
  if (key === "ctrl-c") return [state, { type: "quit" }];
  const session = selectedSession(state);

  if (state.mode === "help") return [{ ...state, mode: "normal" }, null];

  if (state.mode === "filter" || state.mode === "prompt") {
    if (key === "esc") return [{ ...state, mode: "normal", input: "", ...(state.mode === "filter" ? { filter: "" } : {}) }, null];
    if (key === "enter") {
      if (state.mode === "filter") return [{ ...state, mode: "normal", filter: state.input, input: "" }, null];
      const text = state.input.trim();
      const next = { ...state, mode: "normal", input: "", scroll: 0 };
      return [next, text && session ? { type: "prompt", session, text } : null];
    }
    if (key === "backspace") {
      const input = [...state.input].slice(0, -1).join("");
      return [{ ...state, input, ...(state.mode === "filter" ? { filter: input } : {}) }, null];
    }
    if ([...key].length === 1 || key === "space") {
      const input = state.input + (key === "space" ? " " : key);
      return [{ ...state, input, ...(state.mode === "filter" ? { filter: input } : {}) }, null];
    }
    return [state, null];
  }

  const inTranscript = state.focus === "transcript";
  switch (key) {
    case "q": return [state, { type: "quit" }];
    case "?": return [{ ...state, mode: "help" }, null];
    case "tab": case "left": case "right": case "h": case "l":
      return [{ ...state, focus: key === "h" || key === "left" ? "sessions" : key === "l" || key === "right" ? "transcript" : inTranscript ? "sessions" : "transcript" }, null];
    case "j": case "down": return [inTranscript ? { ...state, scroll: Math.max(0, state.scroll - 1) } : move(state, 1), null];
    case "k": case "up": return [inTranscript ? { ...state, scroll: state.scroll + 1 } : move(state, -1), null];
    case "pagedown": case "ctrl-d": return [inTranscript ? { ...state, scroll: Math.max(0, state.scroll - 10) } : move(state, 10), null];
    case "pageup": case "ctrl-u": return [inTranscript ? { ...state, scroll: state.scroll + 10 } : move(state, -10), null];
    case "g": return [inTranscript ? { ...state, scroll: Number.MAX_SAFE_INTEGER } : move(state, -Infinity), null];
    case "G": return [inTranscript ? { ...state, scroll: 0 } : move(state, Infinity), null];
    case "/": return [{ ...state, mode: "filter", input: state.filter }, null];
    case "esc": return [{ ...state, filter: "", notice: "" }, null];
    case "enter": return [{ ...state, focus: "transcript" }, session && !session.open ? { type: "open", session } : null];
    case "i": case "c": return session ? [{ ...state, mode: "prompt", input: "", focus: "transcript" }, null] : [state, null];
    case "a": case "r": {
      const approval = pendingApproval(state, session);
      return approval ? [state, { type: "answer", approval, approve: key === "a" }] : [{ ...state, notice: "Nothing to approve here." }, null];
    }
    case "x": return session && isWorking(session) ? [state, { type: "stop", session }] : [state, null];
    default: return [state, null];
  }
}
