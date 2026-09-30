// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy tui` frame: state in, exactly `height` lines of exactly `width` cells
// out. It uses the terminal's own 16 colors, so it follows the terminal theme.

import { fit, truncate, width as cells, wrap } from "./text.mjs";
import { isWorking, pendingApproval, selectedSession, visibleSessions } from "./model.mjs";

const esc = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`;
const bold = esc("1");
const dim = esc("2");
const inverse = esc("7");
const red = esc("31");
const green = esc("32");
const yellow = esc("33");
const blue = esc("34");
const cyan = esc("36");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Status glyphs; each also has a word in the session header for anyone not reading color. */
function glyph(state, session, tick) {
  if (pendingApproval(state, session) || session.needsAction) return yellow("!");
  if (isWorking(session)) return cyan(SPINNER[tick % SPINNER.length]);
  if (/error|failed/i.test(session.status ?? "")) return red("✕");
  // Narrow in every monospace font (unlike ● and ○), so the name never shifts.
  return session.open ? green("•") : dim("·");
}

function statusWord(state, session) {
  if (pendingApproval(state, session) || session.needsAction) return yellow("waiting on you");
  if (isWorking(session)) return cyan("working");
  return dim(session.open ? String(session.status || "idle") : "closed");
}

export function ago(iso, now) {
  const ms = now - Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** A rounded box `w` wide and `h` tall around `body` lines, titled; bright border when focused. */
function box(title, body, w, h, focused) {
  const paint = focused ? green : (text) => text;
  const label = title ? ` ${truncate(title, w - 6)} ` : "";
  const top = paint("╭─") + (focused ? bold(label) : label) + paint(`${"─".repeat(Math.max(0, w - 3 - cells(label)))}╮`);
  const rows = [];
  for (let i = 0; i < h - 2; i++) rows.push(paint("│") + fit(body[i] ?? "", w - 2) + paint("│"));
  return [top, ...rows, paint(`╰${"─".repeat(w - 2)}╯`)];
}

function sessionRows(state, w, h, now, tick) {
  const list = visibleSessions(state);
  if (!list.length) return [dim(state.filter ? " No sessions match." : " No sessions yet. Start one with 'bivy run'.")];
  const selected = selectedSession(state);
  const index = Math.max(0, list.indexOf(selected));
  const start = Math.max(0, Math.min(index - Math.floor(h / 2), list.length - h));
  const multi = state.machines.length > 1;
  return list.slice(start, start + h).map((s) => {
    const right = `${multi ? `${s.machine} ` : ""}${ago(s.lastActivityAt, now)}`;
    const name = fit(` ${glyph(state, s, tick)} ${s.name || s.id}`, Math.max(4, w - cells(right) - 2));
    const row = `${name} ${dim(right)} `;
    return s === selected ? (state.focus === "sessions" ? inverse(fit(row, w)) : bold(fit(row, w))) : row;
  });
}

function transcriptLines(entries, agentName, w) {
  const lines = [];
  for (const entry of entries) {
    if (entry.role === "tool") { lines.push(dim(`  ▸ ${truncate(entry.text, w - 4)}`)); continue; }
    lines.push("");
    lines.push(entry.role === "user" ? bold(blue("you")) : bold(green(agentName)));
    for (const line of wrap(entry.text, w - 2)) lines.push(` ${line}`);
  }
  return lines;
}

function approvalCard(approval, w) {
  const head = `${yellow(bold("! Approve"))} ${bold(approval.toolName)}${approval.risk ? dim(` (${approval.risk})`) : ""}`;
  const reason = wrap(String(approval.reason ?? ""), w - 4).slice(0, 3).map((l) => `  ${l}`);
  return ["", head, ...reason, `  ${bold("a")} approve   ${bold("r")} reject`];
}

function detailRows(state, view, w, h) {
  const session = selectedSession(state);
  if (!session) return [];
  const header = [session.agent, state.machines.length > 1 ? session.machine : "", session.branch].filter(Boolean).join(" · ");
  const top = [`${dim(header)}${header ? dim(" · ") : ""}${statusWord(state, session)}`];
  const approval = pendingApproval(state, session);
  const bottom = approval ? approvalCard(approval, w) : [];
  if (state.mode === "prompt") bottom.push("", `${blue("›")} ${truncate(state.input, w - 4)}${inverse(" ")}`);
  const room = Math.max(0, h - top.length - bottom.length);
  let body;
  if (!session.open && !view.entries?.length) {
    body = ["", dim(" Closed. Press enter to open it.")];
  } else if (view.loading) {
    body = ["", dim(" Loading…")];
  } else {
    const lines = transcriptLines(view.entries ?? [], session.agentName || session.agent || "agent", w);
    const scroll = Math.min(state.scroll, Math.max(0, lines.length - room));
    body = lines.slice(Math.max(0, lines.length - room - scroll), lines.length - scroll);
  }
  return [...top, ...body, ...Array(Math.max(0, room - body.length)).fill(""), ...bottom].slice(0, h);
}

const HELP = [
  ["j/k ↑/↓", "move, or scroll the transcript"],
  ["tab h/l", "switch pane"],
  ["enter", "open the session"],
  ["i", "message the agent"],
  ["a / r", "approve / reject what it's asking"],
  ["x", "stop the current turn"],
  ["/", "filter sessions"],
  ["g / G", "top / bottom"],
  ["q", "quit"],
];

function keyBar(state) {
  if (state.mode === "filter") return `${blue("/")}${state.input}${inverse(" ")}  ${dim("enter keep · esc clear")}`;
  if (state.mode === "prompt") return dim("enter send · esc cancel");
  if (state.notice) return yellow(state.notice);
  const keys = [["enter", "open"], ["i", "message"], ["a/r", "approve/reject"], ["x", "stop"], ["/", "filter"], ["?", "help"], ["q", "quit"]];
  return keys.map(([k, label]) => `${bold(k)} ${dim(label)}`).join("  ");
}

/** The whole screen as `height` lines. `view` is the selected session's transcript: `{ entries, loading }`. */
export function renderFrame(state, view, { width, height, now = Date.now(), tick = 0 }) {
  const waiting = state.sessions.filter((s) => pendingApproval(state, s) || s.needsAction).length;
  const offline = state.machines.filter((m) => !m.online).map((m) => m.name);
  const summary = [
    `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"}`,
    `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`,
    waiting ? yellow(`${waiting} waiting on you`) : "",
    offline.length ? red(`${offline.join(", ")} offline`) : "",
  ].filter(Boolean).join(dim(" · "));
  const title = fit(`${inverse(bold(" bivy "))} ${summary}`, width);

  const left = Math.max(24, Math.min(48, Math.floor(width * 0.36)));
  const right = width - left;
  const paneHeight = Math.max(3, height - 2);
  const sessionsTitle = `Sessions${state.filter ? ` /${state.filter}` : ""}`;
  const leftBox = box(sessionsTitle, sessionRows(state, left - 2, paneHeight - 2, now, tick), left, paneHeight, state.focus === "sessions");
  const selected = selectedSession(state);
  const rightBox = box(selected ? selected.name || selected.id : "", detailRows(state, view, right - 2, paneHeight - 2), right, paneHeight, state.focus === "transcript");

  let lines = [title, ...leftBox.map((l, i) => l + rightBox[i]), fit(` ${keyBar(state)}`, width)];
  if (state.mode === "help") {
    const w = Math.min(width - 4, 52);
    const body = HELP.map(([k, label]) => ` ${bold(k.padEnd(9))} ${label}`);
    const overlay = box("Keys", body, w, body.length + 2, true);
    const top = Math.max(1, Math.floor((height - overlay.length) / 2));
    const x = Math.floor((width - w) / 2);
    lines = lines.map((line, i) => {
      const o = overlay[i - top];
      return o ? fit(" ".repeat(x), x) + o + " ".repeat(Math.max(0, width - x - w)) : line;
    });
  }
  return lines.slice(0, height);
}

