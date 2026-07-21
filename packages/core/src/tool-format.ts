// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Tool-activity formatting: friendly verbs, per-tool targets, and a real
// line-by-line diff for Edit/Write, plus the plain-language batch summary.
//
// Ported from the legacy client (public/app/remote-app.js: friendlyVerb,
// toolStats, editHunks, diffOps, compactDiffOps, diffViewerHtml, toolGroupSummary).
// Kept framework-agnostic and pure so the React view (and later Expo) render
// from the same computed shape, and so the diff engine is unit-testable.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ToolGlyph = "terminal" | "pencil" | "create" | "search" | "list" | "globe" | "eye";

export interface DiffHunk {
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  label?: string;
}

export interface ToolFormat {
  /** Human verb: Read, Edited, Created, Searched, Ran, Fetched, Listed… */
  verb: string;
  /** Icon key the view maps to an SVG. */
  glyph: ToolGlyph;
  /** Detail-header title (bash/shell → "Bash"). */
  title: string;
  path?: string;
  /** Basename of `path`, for the compact row label. */
  target?: string;
  command?: string;
  query?: string;
  added: number;
  removed: number;
  diffs: DiffHunk[];
  /** Number of edits when there are several but no rendered diff. */
  edits?: number;
}

export type DiffOp =
  | { type: "ctx" | "add" | "del"; text: string }
  | { type: "skip"; count: number };

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function clip(v: unknown, max = 120): string {
  const s = str(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function friendlyVerb(name: string): string {
  const n = String(name || "").toLowerCase();
  if (n.includes("read")) return "Read";
  if (n.includes("write")) return "Created";
  if (n.includes("edit")) return "Edited";
  if (n.includes("grep") || n.includes("search") || n.includes("find")) return "Searched";
  if (n.includes("ls") || n.includes("list")) return "Listed";
  if (n.includes("web") || n.includes("fetch")) return "Fetched";
  if (n.includes("bash") || n.includes("shell")) return "Ran";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Tool";
}

function glyphFor(verb: string, hasCommand: boolean): ToolGlyph {
  if (hasCommand || verb === "Ran") return "terminal";
  if (verb === "Edited") return "pencil";
  if (verb === "Created") return "create";
  if (verb === "Searched") return "search";
  if (verb === "Listed") return "list";
  if (verb === "Fetched") return "globe";
  return "eye";
}

// --- diff engine ---------------------------------------------------------

function splitLines(text: string): string[] {
  const s = String(text ?? "").replace(/\r\n/g, "\n");
  return s === "" ? [] : s.split("\n");
}

/** LCS length table for two line arrays (capped so a huge file can't hang). */
function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

const DIFF_LINE_CAP = 900;

/** Produce ordered ctx/add/del ops from old→new text via LCS backtrace. */
export function diffOps(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Degrade gracefully on very large inputs: whole-block delete then add.
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) {
    const ops: DiffOp[] = [];
    if (oldText) for (const t of a) ops.push({ type: "del", text: t });
    if (newText) for (const t of b) ops.push({ type: "add", text: t });
    return ops;
  }
  const dp = lcs(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: "del", text: a[i++]! });
  while (j < b.length) ops.push({ type: "add", text: b[j++]! });
  return ops;
}

/** Collapse long unchanged runs (>8 lines) to first 3 + skip + last 3. */
export function compactDiffOps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let run: DiffOp[] = [];
  const flush = () => {
    if (run.length > 8) {
      out.push(run[0]!, run[1]!, run[2]!);
      out.push({ type: "skip", count: run.length - 6 });
      out.push(run[run.length - 3]!, run[run.length - 2]!, run[run.length - 1]!);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const op of ops) {
    if (op.type === "ctx") run.push(op);
    else {
      flush();
      out.push(op);
    }
  }
  flush();
  return out;
}

function countOps(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}

function pick(input: any, keys: string[]): string | undefined {
  for (const k of keys) {
    if (input?.[k] != null && input[k] !== "") return str(input[k]);
  }
  return undefined;
}

const OLD_KEYS = ["oldText", "oldString", "old_string", "old", "before"];
const NEW_KEYS = ["newText", "newString", "new_string", "new", "after"];

/** Normalize an Edit tool input (single pair or array) into diff hunks. */
export function editHunks(input: any): DiffHunk[] {
  const list: any[] = Array.isArray(input?.edits)
    ? input.edits
    : Array.isArray(input?.replacements)
      ? input.replacements
      : Array.isArray(input?.changes)
        ? input.changes
        : [input];
  const hunks: DiffHunk[] = [];
  for (const e of list) {
    const oldText = pick(e, OLD_KEYS) ?? "";
    const newText = pick(e, NEW_KEYS) ?? "";
    if (!oldText && !newText) continue;
    const { added, removed } = countOps(diffOps(oldText, newText));
    hunks.push({ oldText, newText, added, removed });
  }
  return hunks;
}

/** Full formatted view of a tool call: verb, target, and any diff. */
export function formatTool(name: string, input: unknown): ToolFormat {
  const n = String(name || "").toLowerCase();
  const inp: any = input && typeof input === "object" ? input : {};
  const verb = friendlyVerb(n);
  const path = pick(inp, ["path", "file", "filePath", "file_path", "pathname"]);
  const command = pick(inp, ["command", "cmd", "shell"]);
  const query = clip(pick(inp, ["query", "q", "pattern", "search"]), 120);
  const title = command || n.includes("bash") || n.includes("shell") ? "Bash" : verb === "Tool" ? String(name || "Tool") : friendlyVerb(n);

  let diffs: DiffHunk[] = [];
  let edits: number | undefined;
  if (n.includes("write")) {
    const content = pick(inp, ["content", "text", "contents", "data"]) ?? "";
    if (content) diffs = [{ oldText: "", newText: content, added: splitLines(content).length, removed: 0, label: "New file" }];
  } else if (n.includes("edit")) {
    const hunks = editHunks(inp);
    diffs = hunks;
    if (hunks.length > 1) edits = hunks.length;
  }
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    added += d.added;
    removed += d.removed;
  }
  return {
    verb,
    glyph: glyphFor(verb, Boolean(command)),
    title,
    path,
    target: path ? basename(path) : undefined,
    command,
    query: query || undefined,
    added,
    removed,
    diffs,
    edits,
  };
}

/** One-line label for a tool row: command, else path/target, else query. */
export function toolRowLabel(f: ToolFormat): string {
  return f.command || f.path || f.target || f.query || "";
}

/** Plain-language summary of a batch of tools, e.g. "Read 2 files, ran a command". */
export function toolGroupSummary(tools: Array<{ name: string; input: unknown }>): string {
  let edited = 0;
  let ran = 0;
  let read = 0;
  for (const t of tools) {
    const f = formatTool(t.name, t.input);
    if (f.command) ran++;
    else if (f.verb === "Edited" || f.verb === "Created" || f.diffs.length) edited++;
    else read++;
  }
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n === 1 ? "a" : n} ${n === 1 ? one : many}`;
  if (read) parts.push(`Read ${plural(read, "file", "files")}`);
  if (ran) parts.push(`ran ${plural(ran, "command", "commands")}`);
  if (edited) parts.push(`edited ${plural(edited, "file", "files")}`);
  if (!parts.length) return tools.length === 1 ? "1 tool call" : `${tools.length} tool calls`;
  // Capitalize the first fragment; join with commas.
  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
