// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Filesystem-sourced slash commands for agents whose "slash commands" are custom
// prompt/command markdown files on disk — Codex's `$CODEX_HOME/prompts/*.md` and
// opencode's `command/*.md` dirs — rather than something learned from a live
// handshake the way Claude (SDK `init`) and Pi (its extension runner) already do.
// This is what gives Codex and opencode a real slash menu in the composer instead
// of the empty state Phase 1 added for them. Two responsibilities:
//
//  1. Discovery — enumerate those files as `AgentCommand[]` so `getCommands()` can
//     advertise them and the composer offers them in autocomplete.
//  2. Local expansion — when the user actually invokes `/name args`, read the file
//     and return its expanded body so the command RUNS, instead of the literal
//     text "/name" being sent to the model. Codex and opencode expand custom
//     prompts only in their interactive TUI, not on the non-interactive
//     run/app-server path Bivy drives, so Bivy expands them itself. Substitution
//     mirrors what those agents document: `$ARGUMENTS` → the whole argument
//     string, `$1`..`$9` → positional words; unused trailing args are appended
//     when the body carries no placeholder (matching Codex's own behaviour). We
//     do NOT emulate opencode's `!shell` / `@file` macros — the expanded body is
//     sent verbatim for those, a documented, graceful partial.
//
// Everything is best-effort and synchronous: an unreadable dir yields no commands
// and `expand()` returns undefined, so the caller falls back to the exact prior
// "forward the raw slash line" behaviour. `expand()` returning undefined for any
// line that isn't a known command means ordinary prompts — and a leading slash
// that happens not to be a command — pass through untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentCommand } from "./types.js";

/** A session's on-disk slash commands: discovery for the menu, expansion for use. */
export interface SlashCommandProvider {
  /** The agent's commands for a session rooted at `cwd` (for project-local dirs). */
  list(cwd: string): AgentCommand[];
  /**
   * If `line` invokes one of those commands, the expanded prompt text to send in
   * its place; otherwise undefined (send `line` unchanged). `line` is the raw
   * composer text, e.g. "/review src/foo.ts".
   */
  expand(cwd: string, line: string): string | undefined;
}

interface MarkdownCommandOptions {
  /**
   * Directories to scan for `*.md`, resolved per session `cwd`. Later entries win
   * a name collision, so a project-local command shadows a global one — list the
   * global dir first, the project dir last.
   */
  dirs: (cwd: string) => string[];
  /** Max files scanned across all dirs (safety bound). Default 300. */
  limit?: number;
  /** Max subdirectory depth; 0 = top level only. Default 3. */
  depth?: number;
}

/** One discovered command file: its canonical "/name", description, and body. */
interface CommandFile {
  name: string;
  description?: string;
  body: string;
}

const DEFAULT_LIMIT = 300;
const DEFAULT_DEPTH = 3;

/**
 * Parse a markdown command file into its display description and prompt body.
 * A leading `---` YAML frontmatter block contributes `description` (the only key
 * we read); its body is everything after the block. With no frontmatter the body
 * is the whole file and the description falls back to the first non-empty line
 * (stripped of leading markdown heading/list markers, truncated for the menu).
 * Exported for unit tests.
 */
export function parseCommandMarkdown(content: string): { description?: string; body: string } {
  let description: string | undefined;
  let body = content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^\s*description\s*:\s*(.+?)\s*$/i.exec(line);
      if (m) {
        description = stripQuotes(m[1]);
        break;
      }
    }
  }
  if (!description) {
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      description = line.replace(/^[#>*\-\s]+/, "").trim() || undefined;
      break;
    }
  }
  if (description && description.length > 80) description = `${description.slice(0, 79)}…`;
  return { description, body: body.trim() };
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Expand a command body against its argument string, mirroring Codex/opencode:
 * `$ARGUMENTS` → the full argument string, `$1`..`$9` → positional words (missing
 * ones → empty). When the body references no placeholder and args were supplied,
 * they're appended (Codex appends unused args rather than dropping them).
 * Exported for unit tests.
 */
export function expandCommandBody(body: string, argString: string): string {
  const args = argString.trim();
  const positional = args ? args.split(/\s+/) : [];
  let used = false;
  let out = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return args;
  });
  out = out.replace(/\$([1-9])/g, (_m, d: string) => {
    used = true;
    return positional[Number(d) - 1] ?? "";
  });
  if (!used && args) out = `${out.replace(/\s+$/, "")}\n\n${args}`;
  return out.trim();
}

/** The command name (without leading slash) a "/name args" line invokes, or null. */
function parseInvocation(line: string): { name: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const ws = trimmed.search(/\s/);
  const name = (ws === -1 ? trimmed.slice(1) : trimmed.slice(1, ws)).trim();
  if (!name) return null;
  const args = ws === -1 ? "" : trimmed.slice(ws + 1).trim();
  return { name, args };
}

/**
 * Recursively collect `*.md` under `dir` as `relativePath (no .md)` → absolute
 * path, where the relative path is POSIX-joined ("/") from the top `dir` so a
 * subdirectory file namespaces (opencode's `git/commit.md` → `git/commit`).
 */
function collectMarkdown(dir: string, prefix: string, depth: number, limit: number, out: Map<string, string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable dir — no commands from here
  }
  for (const entry of entries) {
    if (out.size >= limit) return;
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) collectMarkdown(abs, prefix ? `${prefix}/${entry.name}` : entry.name, depth - 1, limit, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const rel = entry.name.slice(0, -3);
      out.set(prefix ? `${prefix}/${rel}` : rel, abs);
    }
  }
}

/**
 * Build the `/name` → file map for a session: scan each dir (later dirs win a
 * collision), namespacing subdirectory files with "/" (opencode's convention;
 * Codex prompts are flat). Best-effort — unreadable dirs contribute nothing.
 */
function indexCommands(dirs: string[], depth: number, limit: number): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    const found = new Map<string, string>();
    collectMarkdown(dir, "", depth, limit, found);
    for (const [rel, abs] of found) {
      byName.set(`/${rel}`, abs);
    }
  }
  return byName;
}

function readCommandFile(name: string, abs: string): CommandFile | undefined {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const { description, body } = parseCommandMarkdown(content);
  return { name, description, body };
}

/**
 * A `SlashCommandProvider` backed by markdown files in `opts.dirs(cwd)`. Used to
 * give Codex (`$CODEX_HOME/prompts`) and opencode (global + project `command`
 * dirs) their slash menus — see `codexSlashCommands` / `opencodeSlashCommands`.
 */
export function markdownSlashCommands(opts: MarkdownCommandOptions): SlashCommandProvider {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return {
    list(cwd: string): AgentCommand[] {
      const index = indexCommands(opts.dirs(cwd), depth, limit);
      const out: AgentCommand[] = [];
      for (const [name, abs] of index) {
        const file = readCommandFile(name, abs);
        if (!file) continue;
        const command: AgentCommand = { name };
        if (file.description) command.description = file.description;
        out.push(command);
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },
    expand(cwd: string, line: string): string | undefined {
      const invocation = parseInvocation(line);
      if (!invocation) return undefined;
      const index = indexCommands(opts.dirs(cwd), depth, limit);
      const abs = index.get(`/${invocation.name}`);
      if (!abs) return undefined;
      const file = readCommandFile(`/${invocation.name}`, abs);
      if (!file) return undefined;
      return expandCommandBody(file.body, invocation.args);
    },
  };
}

/** Codex's home dir, exactly as the CLI resolves it (`$CODEX_HOME` or `~/.codex`). */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** The user's global opencode config dir (`$XDG_CONFIG_HOME` or `~/.config`). */
function opencodeConfigDir(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
}

/** Codex custom prompts (`$CODEX_HOME/prompts/*.md`) → `/name` commands. */
export function codexSlashCommands(): SlashCommandProvider {
  return markdownSlashCommands({ dirs: () => [path.join(codexHome(), "prompts")] });
}

/**
 * opencode custom commands — the global `command` dir plus the project-local
 * `.opencode/command` (which shadows the global on a name collision). See
 * opencode.ai/docs/commands.
 */
export function opencodeSlashCommands(): SlashCommandProvider {
  return markdownSlashCommands({
    dirs: (cwd) => [path.join(opencodeConfigDir(), "opencode", "command"), path.join(cwd, ".opencode", "command")],
  });
}

/**
 * Merge disk-sourced commands with any the runtime already advertised (e.g. a
 * protocol shim's hello), disk winning a name collision. Used by ProtocolSession
 * so hello-advertised commands and on-disk prompts coexist. First occurrence of
 * each name (disk first) wins; input order is otherwise preserved.
 */
export function mergeAgentCommands(...groups: (AgentCommand[] | undefined)[]): AgentCommand[] {
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  for (const group of groups) {
    for (const command of group ?? []) {
      if (!command?.name || seen.has(command.name)) continue;
      seen.add(command.name);
      out.push(command);
    }
  }
  return out;
}
