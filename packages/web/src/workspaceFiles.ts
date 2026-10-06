// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Wire shapes and pure helpers for the Files browser: a read-only view of the
// session's workspace on its machine (`files.list` / `files.read`).

export type WorkspaceFileStatus = "added" | "modified" | "deleted";

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  mtime?: number;
  status?: WorkspaceFileStatus;
  /** For a folder: how many uncommitted files it holds. */
  changed?: number;
  symlink?: boolean;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  git: boolean;
}

export type WorkspaceFile = {
  path: string;
  size: number;
  mtime: number;
  status?: WorkspaceFileStatus;
} & (
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; mimeType: string; data: string }
  | { kind: "binary" }
  | { kind: "too-large" }
);

export const STATUS_LABEL: Record<WorkspaceFileStatus, string> = { added: "New", modified: "Modified", deleted: "Deleted" };
export const STATUS_GLYPH: Record<WorkspaceFileStatus, string> = { added: "+", modified: "~", deleted: "−" };

/** Extension → highlight.js language (the bundled common set). Unknown: auto-detect. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", pl: "perl", lua: "lua", r: "r", sql: "sql", graphql: "graphql",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  diff: "diff", patch: "diff", mk: "makefile",
};
const NAMED: Record<string, string> = { Makefile: "makefile", Dockerfile: "dockerfile", ".bashrc": "bash", ".zshrc": "bash" };

export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (NAMED[name]) return NAMED[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** Highlighting is for reading, not for megabyte dumps: past this, plain text. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/** "Changed only": folders holding changes and the changed files themselves. */
export function visibleEntries(entries: WorkspaceEntry[], changedOnly: boolean): WorkspaceEntry[] {
  return changedOnly ? entries.filter((entry) => entry.status || entry.changed) : entries;
}

