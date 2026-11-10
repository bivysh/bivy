// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Terminal status signals: what a program running in a PTY says about itself
// through escape sequences, read the way a terminal emulator would. Bivy's
// node is the terminal for every PTY it opens (the browser's xterm.js only
// draws), so it is the one that answers the protocol query and keeps the state.
//
// Agents' TUIs already speak these. OSC 7501 (Program Status Protocol) is
// reported by Claude Code, Codex, Grok and Pi: working / blocked on you
// (permission, question, sign-in) / done / error / idle. OSC 9;4 progress
// (OpenCode and others) is mapped onto the same states until a program sends
// OSC 7501. OSC 9 / 777 / 99 are desktop notifications. A BEL outside an
// escape sequence is the bell; the BEL that ends an OSC is not.
//
// Adding a protocol is adding a row to OSC_READERS, not another branch.

export type ProgramState = "idle" | "working" | "blocked" | "done" | "error";
export type BlockedKind = "permission" | "question" | "auth";

export interface ProgramStatus {
  state: ProgramState;
  /** What the program waits on; only with `blocked`. */
  kind?: BlockedKind;
  /** Stable program id, e.g. "claude-code", "codex". */
  app?: string;
  /** One line from the program (decoded). Display only. */
  msg?: string;
  title?: string;
  /** 0–100 when the program knows; only with working/blocked. */
  progress?: number;
}

export type TerminalSignal =
  | { type: "status"; id: string; status: ProgramStatus }
  | { type: "clear"; id?: string }
  /** OSC 9;4 progress, already mapped to a state ("clear" removes it). */
  | { type: "progress"; state: ProgramState | "clear"; progress?: number }
  /** OSC 133;A: a shell prompt started, so whatever ran before is over. */
  | { type: "prompt" }
  | { type: "notify"; title?: string; body: string }
  | { type: "bell" };

/** Our answer to `OSC 7501 ; ?`: this terminal shows program status. */
export const PROGRAM_STATUS_REPLY = "\x1b]7501;?\x1b\\";

const STATES: readonly ProgramState[] = ["idle", "working", "blocked", "done", "error"];
const KINDS: readonly BlockedKind[] = ["permission", "question", "auth"];
const MAX_SEQUENCE = 4096;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const ID = /^[A-Za-z0-9_.+-]{1,32}(\/[A-Za-z0-9_.+-]{1,32}){0,7}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

interface Out { signals: TerminalSignal[]; replies: string[] }

function decodeText(value: string, maxBytes: number): string | null {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBytes) return null;
  const text = bytes.toString("utf8");
  return CONTROL.test(text) ? null : text;
}

/** OSC 7501 ; pairs — one report, or the `?` support query. */
function readProgramStatus(body: string, out: Out): void {
  if (body === "?" || body.startsWith("?:")) { out.replies.push(PROGRAM_STATUS_REPLY); return; }
  const pairs = new Map<string, string>();
  for (const pair of body.split(":")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!/^[a-z]{1,16}$/.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value);
  }
  const id = pairs.get("id");
  if (id !== undefined && !ID.test(id)) return;
  const state = pairs.get("state");
  if (state === "clear") { out.signals.push({ type: "clear", id }); return; }
  if (!state || !STATES.includes(state as ProgramState)) return;
  const status: ProgramStatus = { state: state as ProgramState };
  const kind = pairs.get("kind");
  if (state === "blocked" && KINDS.includes(kind as BlockedKind)) status.kind = kind as BlockedKind;
  const app = pairs.get("app");
  if (app && APP.test(app)) status.app = app;
  const progress = pairs.get("progress");
  if ((state === "working" || state === "blocked") && progress && /^\d{1,3}$/.test(progress) && Number(progress) <= 100) status.progress = Number(progress);
  for (const [key, max] of [["msg", 2048], ["title", 192]] as const) {
    const raw = pairs.get(key);
    if (raw === undefined) continue;
    const text = decodeText(raw, max);
    if (text === null) return; // a bad msg/title discards the whole report
    if (text) status[key] = text;
  }
  out.signals.push({ type: "status", id: id ?? "", status });
}

/** ConEmu OSC 9;4;state;progress: 0 remove, 1 value, 2 error, 3 indeterminate, 4 paused. */
const PROGRESS_STATES: Record<string, ProgramState | "clear"> = { 0: "clear", 1: "working", 2: "error", 3: "working", 4: "working" };

/** OSC 9 — ConEmu commands (`9;<n>;…`) or an iTerm2-style notification. */
function readOsc9(body: string, out: Out): void {
  const conemu = /^(\d+)(?:;(.*))?$/.exec(body);
  if (!conemu) { if (body.trim()) out.signals.push({ type: "notify", body: body.trim() }); return; }
  if (conemu[1] !== "4") return;
  const [st = "0", pct] = (conemu[2] ?? "").split(";");
  const state = PROGRESS_STATES[st];
  if (!state) return;
  const progress = Number(pct);
  out.signals.push(state === "working" && st === "1" && Number.isInteger(progress) && progress >= 0 && progress <= 100
    ? { type: "progress", state, progress }
    : { type: "progress", state });
}

/** OSC 777 ; notify ; title ; body (urxvt, Ghostty, foot). */
function readOsc777(body: string, out: Out): void {
  const [verb, title, ...rest] = body.split(";");
  const text = rest.join(";").trim();
  if (verb === "notify" && (text || title?.trim())) out.signals.push({ type: "notify", title: title?.trim() || undefined, body: text || title!.trim() });
}

/** OSC 99 ; metadata ; payload (kitty). Chunks with d=0 build up one notification. */
function readOsc99(body: string, out: Out, kitty: Map<string, { title?: string; body?: string }>): void {
  const semi = body.indexOf(";");
  if (semi < 0) return;
  const meta = new Map(body.slice(0, semi).split(":").map((kv) => { const eq = kv.indexOf("="); return [kv.slice(0, eq), kv.slice(eq + 1)] as [string, string]; }));
  const part = meta.get("p") ?? "title";
  if (part !== "title" && part !== "body") return; // queries, icons, buttons
  let payload = body.slice(semi + 1);
  if (meta.get("e") === "1") payload = decodeText(payload, MAX_SEQUENCE) ?? "";
  if (CONTROL.test(payload)) return;
  const key = meta.get("i") ?? "";
  const draft = kitty.get(key) ?? {};
  draft[part] = (draft[part] ?? "") + payload;
  if (meta.get("d") === "0") { kitty.set(key, draft); return; }
  kitty.delete(key);
  const text = (draft.body || draft.title || "").trim();
  if (text) out.signals.push({ type: "notify", title: draft.body ? draft.title?.trim() || undefined : undefined, body: text });
}

/** OSC 133 ; A — FinalTerm/iTerm2 shell integration "prompt start". */
function readOsc133(body: string, out: Out): void {
  if (body === "A" || body.startsWith("A;")) out.signals.push({ type: "prompt" });
}

type OscReader = (body: string, out: Out, kitty: Map<string, { title?: string; body?: string }>) => void;
const OSC_READERS: Record<string, OscReader> = {
  "7501": readProgramStatus,
  "9": readOsc9,
  "777": readOsc777,
  "99": readOsc99,
  "133": readOsc133,
};

/**
 * Reads signals out of a PTY's raw output, chunk by chunk. A sequence split
 * across chunks is held until its terminator arrives (bounded by the spec's
 * 4096-byte cap). Output itself is never changed.
 */
export class TerminalSignalReader {
  private partial = "";
  private readonly kitty = new Map<string, { title?: string; body?: string }>();

  read(chunk: string): Out {
    const out: Out = { signals: [], replies: [] };
    // Fast path: plain output with nothing pending can't hold a signal.
    if (!this.partial && !chunk.includes("\x07") && !chunk.includes("\x1b]") && !chunk.endsWith("\x1b")) return out;
    const s = this.partial + chunk;
    this.partial = "";
    let i = 0;
    while (i < s.length) {
      const osc = s.indexOf("\x1b]", i);
      const bel = s.indexOf("\x07", i);
      if (bel >= 0 && (osc < 0 || bel < osc)) {
        if (!out.signals.some((sig) => sig.type === "bell")) out.signals.push({ type: "bell" });
        i = bel + 1;
        continue;
      }
      if (osc < 0) {
        if (s.endsWith("\x1b")) this.partial = "\x1b";
        break;
      }
      const start = osc + 2;
      const belEnd = s.indexOf("\x07", start);
      const stEnd = s.indexOf("\x1b\\", start);
      const end = belEnd < 0 ? stEnd : stEnd < 0 ? belEnd : Math.min(belEnd, stEnd);
      if (end < 0) {
        if (s.length - osc <= MAX_SEQUENCE) this.partial = s.slice(osc);
        break;
      }
      if (end - osc <= MAX_SEQUENCE) {
        const body = s.slice(start, end);
        const semi = body.indexOf(";");
        const reader = semi > 0 ? OSC_READERS[body.slice(0, semi)] : undefined;
        if (reader) reader(body.slice(semi + 1), out, this.kitty);
      }
      i = end + (end === belEnd ? 1 : 2);
    }
    return out;
  }
}

/** Urgency when several records exist: what needs the person wins. */
const URGENCY: Record<ProgramState, number> = { blocked: 4, error: 3, working: 2, done: 1, idle: 0 };
/** Records that end when the process's turn ends (process exit, next prompt). */
const TRANSIENT: ReadonlySet<ProgramState> = new Set(["working", "blocked"]);
const MAX_RECORDS = 64;

/**
 * The status records one terminal holds (OSC 7501 semantics: one record per
 * id, each report replaces its record, `/` nests ids). `current()` is the one
 * to show. OSC 9;4 progress drives the root record only until the program
 * sends any OSC 7501 report.
 */
export class ProgramStatusBoard {
  private readonly records = new Map<string, ProgramStatus>();
  private spoken = false;

  /** Apply a signal; true when `current()` may have changed. */
  apply(signal: TerminalSignal): boolean {
    switch (signal.type) {
      case "status": {
        this.spoken = true;
        const parentApp = signal.status.app ?? this.inheritedApp(signal.id);
        this.records.delete(signal.id);
        this.records.set(signal.id, parentApp ? { ...signal.status, app: parentApp } : signal.status);
        while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
        return true;
      }
      case "clear":
        this.spoken = true;
        if (signal.id === undefined) { this.records.clear(); return true; }
        for (const id of [...this.records.keys()]) if (id === signal.id || id.startsWith(`${signal.id}/`)) this.records.delete(id);
        return true;
      case "progress":
        if (this.spoken) return false;
        if (signal.state === "clear") return this.records.delete("");
        this.records.set("", signal.progress === undefined ? { state: signal.state } : { state: signal.state, progress: signal.progress });
        return true;
      case "prompt": {
        let changed = false;
        for (const [id, record] of this.records) if (TRANSIENT.has(record.state)) { this.records.delete(id); changed = true; }
        return changed;
      }
      default:
        return false;
    }
  }

  /** True once the program has used OSC 7501 itself. */
  get reportsStatus(): boolean {
    return this.spoken;
  }

  current(): ProgramStatus | undefined {
    let best: ProgramStatus | undefined;
    for (const record of this.records.values()) {
      if (!best || URGENCY[record.state] >= URGENCY[best.state]) best = record;
    }
    return best;
  }

  private inheritedApp(id: string): string | undefined {
    let parent = id;
    while (parent) {
      const at = parent.lastIndexOf("/");
      parent = at < 0 ? "" : parent.slice(0, at);
      const app = this.records.get(parent)?.app;
      if (app) return app;
    }
    return undefined;
  }
}

/** Same status for display/notification purposes (ignores progress ticks). */
export function sameProgramStatus(a: ProgramStatus | undefined, b: ProgramStatus | undefined): boolean {
  return a?.state === b?.state && a?.kind === b?.kind && a?.msg === b?.msg && a?.app === b?.app;
}
