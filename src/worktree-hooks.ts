// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * What a repository asks for when Bivy cuts it a fresh worktree:
 *
 * - `.worktreeinclude` (gitignore syntax, the convention other agent tools
 *   share) names ignored files — `.env`, local config — to copy from the
 *   checkout the worktree was cut from. Only files git ignores are copied, so a
 *   copy never shows up as a change in the new branch.
 * - `worktree.setup` / `worktree.teardown` in `.bivy/environment.yaml` name a
 *   repository script (`run:`) or package script (`script:`) to run when a
 *   worktree is created (before the agent's first turn) and before Bivy removes
 *   one it owns.
 *
 * Hooks run as the node's OS user, like the repository's own install scripts.
 * `BIVY_WORKTREE_HOOKS=off` turns them off on a machine; include copying stays.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_ENVIRONMENT_PATH, parseProjectEnvironment, type ProjectEnvironmentHookStep } from "./project-environment.js";
import { packageManager } from "./automation-checks.js";

const exec = promisify(execFile);

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDE_FILES = 1000;
const MAX_INCLUDE_BYTES = 200 * 1024 * 1024;
const DEFAULT_HOOK_TIMEOUT_MINUTES = 15;
const OUTPUT_TAIL_BYTES = 4096;

// ── .worktreeinclude ────────────────────────────────────────────────────────

interface IncludeRule { re: RegExp; negate: boolean; dirOnly: boolean; anchored: boolean; prefix: string }

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) { out += "\\["; continue; }
      const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      out += `[${body}]`;
      i = end;
    } else if (c === "\\" && i + 1 < glob.length) { out += glob[++i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }
    else out += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return out;
}

/** Parse gitignore-syntax patterns into ordered rules (last match wins). */
export function parseIncludeRules(text: string): IncludeRule[] {
  const rules: IncludeRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.replace(/\/+$/, "");
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const body = globToRegex(line);
    const re = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
    // The literal directory part before any wildcard: lets an anchored rule
    // reach into an ignored folder without walking every ignored folder.
    const prefix = anchored ? line.slice(0, line.search(/[*?[]|$/)).replace(/[^/]*$/, "") : "";
    rules.push({ re, negate, dirOnly, anchored, prefix });
  }
  return rules;
}

/** Whether `rel` (posix, relative to the repository root) is included: the last
 *  rule matching the path or any of its parent folders decides. */
export function isIncluded(rules: IncludeRule[], rel: string, isDir: boolean): boolean {
  const parts = rel.split("/").filter(Boolean);
  let state = false;
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const subIsDir = i < parts.length || isDir;
    for (const rule of rules) {
      if (rule.dirOnly && !subIsDir) continue;
      if (rule.re.test(sub)) state = !rule.negate;
    }
  }
  return state;
}

export interface IncludeCopyResult { copied: string[]; skipped: string[] }

/**
 * Copy the ignored files `.worktreeinclude` names from `sourceRoot` into a new
 * worktree. Never overwrites, never follows a symlink out (links are recreated
 * as links), and stops at a file and byte budget. Best-effort: a problem is
 * reported in `skipped`, never thrown.
 */
export async function copyWorktreeIncludes(opts: { sourceRoot: string; worktreePath: string }): Promise<IncludeCopyResult> {
  const result: IncludeCopyResult = { copied: [], skipped: [] };
  let text: string;
  try { text = fs.readFileSync(path.join(opts.sourceRoot, WORKTREE_INCLUDE_FILE), "utf8"); }
  catch { return result; }
  const rules = parseIncludeRules(text);
  if (!rules.some((rule) => !rule.negate)) return result;

  let listing: string;
  try {
    ({ stdout: listing } = await exec("git", ["-C", opts.sourceRoot, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    result.skipped.push(`could not list ignored files: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  const budget = { files: 0, bytes: 0 };
  const copyOne = (rel: string): void => {
    const from = path.join(opts.sourceRoot, rel);
    const to = path.join(opts.worktreePath, rel);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(from); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(from)) copyOne(path.posix.join(rel, name));
      return;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    if (fs.existsSync(to) || isSymlinkAt(to)) return;
    if (budget.files + 1 > MAX_INCLUDE_FILES || budget.bytes + stat.size > MAX_INCLUDE_BYTES) {
      result.skipped.push(`${rel}: over the ${MAX_INCLUDE_FILES}-file / ${MAX_INCLUDE_BYTES / 1024 / 1024} MB copy budget`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      budget.files += 1;
      budget.bytes += stat.size;
      result.copied.push(rel);
    } catch (error) {
      result.skipped.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Walk only the parts of an ignored folder an anchored rule names.
  const walkMatching = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(opts.sourceRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.posix.join(rel, entry.name);
      const isDir = entry.isDirectory();
      if (isIncluded(rules, child, isDir)) copyOne(child);
      else if (isDir && reachesInto(rules, `${child}/`)) walkMatching(child);
    }
  };

  for (const entry of listing.split("\0").filter(Boolean)) {
    const isDir = entry.endsWith("/");
    const rel = entry.replace(/\/$/, "");
    if (rel === ".bivy" || rel.startsWith(".bivy/") || rel === ".git") continue;
    if (isIncluded(rules, rel, isDir)) copyOne(rel);
    else if (isDir && reachesInto(rules, `${rel}/`)) walkMatching(rel);
  }
  return result;
}

function reachesInto(rules: IncludeRule[], dir: string): boolean {
  return rules.some((rule) => !rule.negate && rule.anchored && rule.prefix.length > 0 && (rule.prefix.startsWith(dir) || dir.startsWith(rule.prefix)));
}

function isSymlinkAt(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ── setup / teardown hooks ──────────────────────────────────────────────────

export type WorktreeHookKind = "setup" | "teardown";
export interface WorktreeHookResult {
  kind: WorktreeHookKind;
  /** What ran, e.g. `scripts/setup.sh` or `pnpm run setup`. */
  command: string;
  ok: boolean;
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
  /** The last few KB of combined output. */
  output: string;
  error?: string;
}

export function worktreeHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.BIVY_WORKTREE_HOOKS?.trim() ?? "");
}

/** The hook the worktree's own `.bivy/environment.yaml` declares, if any. Reads
 *  only the worktree's copy, so a branch runs the hook it was committed with. */
export function worktreeHook(worktreePath: string, kind: WorktreeHookKind): { step?: ProjectEnvironmentHookStep; error?: string } {
  let text: string;
  try { text = fs.readFileSync(path.join(worktreePath, PROJECT_ENVIRONMENT_PATH), "utf8"); }
  catch { return {}; }
  const parsed = parseProjectEnvironment(text);
  if (!parsed.ok) return { error: `${PROJECT_ENVIRONMENT_PATH} is invalid: ${parsed.errors.join("; ")}` };
  return { step: parsed.environment?.worktree?.[kind] };
}

function hookCommand(worktreePath: string, step: ProjectEnvironmentHookStep): { command: string; args: string[]; label: string } | { error: string } {
  if (step.run) {
    const file = path.resolve(worktreePath, step.run);
    if (!fs.existsSync(file)) return { error: `${step.run} does not exist in this worktree` };
    return { command: "bash", args: [file], label: step.run };
  }
  const manager = packageManager(worktreePath);
  const args = manager.args(step.script!);
  return { command: manager.command, args, label: [manager.command, ...args].join(" ") };
}

/**
 * Run the worktree's declared setup or teardown hook in the worktree, stdin
 * closed, killed (with its process group) at the timeout. Resolves to
 * undefined when nothing is declared or hooks are off; never rejects.
 */
export async function runWorktreeHook(
  kind: WorktreeHookKind,
  opts: { worktreePath: string; sourcePath?: string; env?: NodeJS.ProcessEnv },
): Promise<WorktreeHookResult | undefined> {
  const env = opts.env ?? process.env;
  if (!worktreeHooksEnabled(env)) return undefined;
  const { step, error } = worktreeHook(opts.worktreePath, kind);
  if (error) return { kind, command: PROJECT_ENVIRONMENT_PATH, ok: false, durationMs: 0, output: "", error };
  if (!step) return undefined;
  const resolved = hookCommand(opts.worktreePath, step);
  if ("error" in resolved) return { kind, command: step.run ?? step.script ?? "", ok: false, durationMs: 0, output: "", error: resolved.error };

  const timeoutMs = (step.timeoutMinutes ?? DEFAULT_HOOK_TIMEOUT_MINUTES) * 60_000;
  const startedAt = Date.now();
  return new Promise<WorktreeHookResult>((resolve) => {
    let tail = "";
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES); };
    const child = spawn(resolved.command, resolved.args, {
      cwd: opts.worktreePath,
      env: { ...env, BIVY_WORKTREE_HOOK: kind, BIVY_WORKTREE_PATH: opts.worktreePath, ...(opts.sourcePath ? { BIVY_WORKTREE_SOURCE: opts.sourcePath } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const finish = (exitCode: number | undefined, spawnError?: string) => {
      clearTimeout(timer);
      resolve({
        kind,
        command: resolved.label,
        ok: !timedOut && !spawnError && exitCode === 0,
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - startedAt,
        output: tail.trim(),
        ...(spawnError ? { error: spawnError } : timedOut ? { error: `timed out after ${Math.round(timeoutMs / 60_000)} min` } : {}),
      });
    };
    child.once("error", (err) => finish(undefined, err.message));
    child.once("close", (code) => finish(code ?? undefined));
  });
}

/** One line a person can read in the session, e.g. "Worktree setup (scripts/setup.sh) finished in 12s." */
export function describeWorktreeHook(result: WorktreeHookResult): string {
  const name = result.kind === "setup" ? "Worktree setup" : "Worktree teardown";
  const secs = Math.max(1, Math.round(result.durationMs / 1000));
  if (result.ok) return `${name} (${result.command}) finished in ${secs}s.`;
  const why = result.error ?? `exited with code ${result.exitCode}`;
  const lastLines = result.output.split("\n").slice(-12).join("\n");
  return `${name} (${result.command}) failed: ${why}.${lastLines ? `\n\n${lastLines}` : ""}`;
}

// The setup each new worktree is running, keyed by its path, so every prompt
// to a session there waits for it, and the first one reports it.
interface PendingSetup { promise: Promise<WorktreeHookResult | undefined>; settled: boolean; reported: boolean }
const pendingSetups = new Map<string, PendingSetup>();

export function startWorktreeSetup(opts: { worktreePath: string; sourcePath?: string; env?: NodeJS.ProcessEnv }): void {
  if (!worktreeHooksEnabled(opts.env ?? process.env)) return;
  const declared = worktreeHook(opts.worktreePath, "setup");
  if (!declared.step && !declared.error) return;
  const entry: PendingSetup = { settled: false, reported: false, promise: Promise.resolve(undefined) };
  entry.promise = runWorktreeHook("setup", opts).finally(() => { entry.settled = true; });
  pendingSetups.set(path.resolve(opts.worktreePath), entry);
}

/**
 * The setup a prompt in this worktree must wait for. `report` is true for the
 * one caller that should tell the person how it went; an entry is forgotten
 * once it has finished and been reported.
 */
export function worktreeSetupGate(worktreePath: string): { running: boolean; report: boolean; result: Promise<WorktreeHookResult | undefined> } | undefined {
  const key = path.resolve(worktreePath);
  const entry = pendingSetups.get(key);
  if (!entry) return undefined;
  const report = !entry.reported;
  entry.reported = true;
  if (entry.settled) pendingSetups.delete(key);
  return { running: !entry.settled, report, result: entry.promise };
}

export function forgetWorktreeSetup(worktreePath: string): void {
  pendingSetups.delete(path.resolve(worktreePath));
}
