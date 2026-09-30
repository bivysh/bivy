// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy tui`: the terminal around model.mjs and render.mjs. It polls each
// machine's node API, keeps the selected session's transcript current, turns
// keys into effects and draws only the lines that changed.

import { initialState, reduceKey, selectedSession, sessionKey, withData, isWorking } from "./model.mjs";
import { renderFrame } from "./render.mjs";
import { transcriptEntries } from "./transcript.mjs";

const POLL_MS = 1500;
const SPIN_MS = 120;

const KEYS = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
  "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
  "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
  "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace",
  "\x1b": "esc", "\x03": "ctrl-c", "\x04": "ctrl-d", "\x15": "ctrl-u", " ": "space",
};

/** Raw terminal input as key names; a paste arrives as its characters. */
export function parseKeys(data) {
  const text = String(data);
  if (KEYS[text]) return [KEYS[text]];
  if (text.startsWith("\x1b")) return [];
  return [...text].map((ch) => KEYS[ch] ?? ch).filter((k) => k.length > 1 || k >= " ");
}

async function call(machine, method, path, body) {
  const res = await fetch(`${machine.base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(machine.token ? { authorization: `Bearer ${machine.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(method === "GET" ? 4000 : 15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Sessions and approvals from every machine; one that doesn't answer is marked offline. */
async function snapshot(machines) {
  const results = await Promise.all(machines.map(async (machine) => {
    try {
      const [sessions, approvals] = await Promise.all([call(machine, "GET", "/api/sessions"), call(machine, "GET", "/api/approvals")]);
      return {
        machine: { name: machine.name, online: true },
        sessions: (Array.isArray(sessions) ? sessions : []).map((s) => ({
          machine: machine.name,
          id: s.id,
          name: s.name || s.firstMessage || "",
          agent: s.agentName || s.agent || "",
          agentName: s.agentName || "",
          status: s.sessionState?.displayStatus ?? s.status ?? "",
          needsAction: Boolean(s.needsAction),
          open: Boolean(s.open),
          branch: s.branch,
          lastActivityAt: s.lastActivityAt || s.updatedAt,
        })),
        approvals: (Array.isArray(approvals) ? approvals : []).map((a) => ({ ...a, machine: machine.name })),
      };
    } catch {
      return { machine: { name: machine.name, online: false }, sessions: [], approvals: [] };
    }
  }));
  return {
    machines: results.map((r) => r.machine),
    sessions: results.flatMap((r) => r.sessions),
    approvals: results.flatMap((r) => r.approvals),
  };
}

export async function runTui({ machines, stdin = process.stdin, stdout = process.stdout }) {
  const byName = new Map(machines.map((m) => [m.name, m]));
  let state = initialState();
  let tick = 0;
  let previous = [];
  // Transcripts by session key: raw messages plus the node's history cursor.
  const histories = new Map();
  let loadingKey = null;

  const view = () => {
    const session = selectedSession(state);
    const key = session ? sessionKey(session) : "";
    const history = histories.get(key);
    return { entries: history ? transcriptEntries(history.messages) : [], loading: loadingKey === key && !history };
  };

  const draw = (full = false) => {
    const lines = renderFrame(state, view(), { width: stdout.columns || 80, height: stdout.rows || 24, tick });
    let out = "";
    lines.forEach((line, i) => { if (full || line !== previous[i]) out += `\x1b[${i + 1};1H${line}\x1b[0m`; });
    previous = lines;
    if (out) stdout.write(out);
  };

  const loadHistory = async (session) => {
    const key = sessionKey(session);
    const machine = byName.get(session.machine);
    const have = histories.get(key);
    const query = new URLSearchParams({ sessionId: session.id, ...(have ? { have: String(have.count), haveToken: have.hash } : {}) });
    try {
      const event = await call(machine, "GET", `/api/session/history?${query}`);
      const messages = event.mode === "append" && have ? [...have.messages, ...(event.messages ?? [])] : event.messages ?? [];
      histories.set(key, { messages, count: event.count ?? messages.length, hash: event.historyHash });
    } catch (error) {
      state = { ...state, notice: `Couldn't load the transcript: ${error.message}` };
    } finally {
      if (loadingKey === key) loadingKey = null;
    }
  };

  const refresh = async () => {
    // Read `state` only after the await: keys pressed meanwhile must survive.
    const data = await snapshot(machines);
    state = withData(state, data);
    const session = selectedSession(state);
    // Only sessions already open on their machine are followed; opening a closed one is a keypress.
    if (session?.open) await loadHistory(session);
    draw();
  };

  const run = async (effect) => {
    const machine = effect.session ? byName.get(effect.session.machine) : effect.approval ? byName.get(effect.approval.machine) : null;
    try {
      if (effect.type === "open") {
        loadingKey = sessionKey(effect.session);
        draw();
        await loadHistory(effect.session);
      } else if (effect.type === "prompt") {
        await call(machine, "POST", "/api/session/prompt", { sessionId: effect.session.id, text: effect.text });
        state = { ...state, notice: "" };
      } else if (effect.type === "answer") {
        await call(machine, "POST", `/api/approvals/${encodeURIComponent(effect.approval.id)}/${effect.approve ? "approve" : "reject"}`, {});
        state = { ...state, notice: effect.approve ? `Approved ${effect.approval.toolName}.` : `Rejected ${effect.approval.toolName}.` };
      } else if (effect.type === "stop") {
        await call(machine, "POST", "/api/session/abort", { sessionId: effect.session.id });
        state = { ...state, notice: "Stopping…" };
      }
    } catch (error) {
      state = { ...state, notice: error.message };
    }
    await refresh();
  };

  return new Promise((resolve) => {
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    stdin.setRawMode?.(true);
    stdin.resume();
    const poll = setInterval(() => { void refresh(); }, POLL_MS);
    const spin = setInterval(() => {
      if (!state.sessions.some(isWorking)) return;
      tick++;
      draw();
    }, SPIN_MS);
    const onResize = () => draw(true);
    const quit = () => {
      clearInterval(poll);
      clearInterval(spin);
      stdout.off("resize", onResize);
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
      resolve();
    };
    const onData = (data) => {
      for (const key of parseKeys(data)) {
        const before = selectedSession(state);
        const [next, effect] = reduceKey(state, key);
        state = next;
        if (effect?.type === "quit") return quit();
        if (effect) void run(effect);
        // Moving onto an open session shows its transcript straight away.
        const after = selectedSession(state);
        if (after && after !== before && after.open && !histories.has(sessionKey(after))) {
          loadingKey = sessionKey(after);
          void loadHistory(after).then(() => draw());
        }
      }
      draw();
    };
    stdin.on("data", onData);
    stdout.on("resize", onResize);
    draw(true);
    void refresh();
  });
}
