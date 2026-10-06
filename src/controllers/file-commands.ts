// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Read-only file browser over a session's workspace (its worktree, or the
// directory it runs in): list one directory, read one file. Lets a person look
// at what the agent is working on before anything is committed or pushed. Every
// path is confined to the workspace — `..`, absolute paths and symlinks that
// resolve outside it are refused — and nothing here ever writes.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandEntries } from "../protocol/command-registry.js";

const exec = promisify(execFile);

export type WorkspaceFileStatus = "added" | "modified" | "deleted";

export interface WorkspaceEntry {
  name: string;
  /** Workspace-relative, `/`-separated. */
  path: string;
  type: "dir" | "file";
  size?: number;
  mtime?: number;
  /** Uncommitted git state of a file. */
  status?: WorkspaceFileStatus;
  /** For a directory: how many uncommitted files it holds. */
  changed?: number;
  symlink?: boolean;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  /** Whether the workspace is a git checkout (statuses are meaningful). */
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

/** Text past this is cut (and says so); a viewer, not an editor. */
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** A directory this big is cut so one listing can't flood the link. */
export const MAX_DIR_ENTRIES = 2000;
/** Never listed: git's own store says nothing about the work. */
const HIDDEN = new Set([".git"]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
};

export class WorkspacePathError extends Error {}

/** Normalise a client path to workspace-relative `a/b`, or throw if it climbs out. */
export function relativeWorkspacePath(input: string | undefined): string {
  const raw = (input ?? "").replace(/\\/g, "/").trim();
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new WorkspacePathError("Paths are relative to the workspace.");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new WorkspacePathError("That path is outside the workspace.");
    parts.push(part);
  }
  if (parts.some((part) => HIDDEN.has(part))) throw new WorkspacePathError("That path is not browsable.");
  return parts.join("/");
}

/** Resolve `rel` inside `root`, following symlinks, refusing anything that lands outside. */
async function confined(root: string, rel: string): Promise<{ abs: string; real: string; realRoot: string }> {
  const realRoot = await fs.realpath(root);
  const abs = path.join(realRoot, rel);
  const real = await fs.realpath(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new WorkspacePathError("That file no longer exists.");
    throw error;
  });
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new WorkspacePathError("That path is outside the workspace.");
  return { abs, real, realRoot };
}

/** Uncommitted files by workspace-relative path; null when not a git checkout. */
export async function gitStatus(root: string): Promise<Map<string, WorkspaceFileStatus> | null> {
  try {
    const opts = { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 };
    // Porcelain paths are repo-relative; the workspace may be a subdirectory.
    const [{ stdout: prefix }, { stdout }] = await Promise.all([
      exec("git", ["rev-parse", "--show-prefix"], opts),
      exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], opts),
    ]);
    return parseGitStatus(stdout, prefix.trim());
  } catch {
    return null;
  }
}

/** `git status --porcelain=v1 -z` → path → status. A rename shows as its new path, added. */
export function parseGitStatus(stdout: string, prefix = ""): Map<string, WorkspaceFileStatus> {
  const out = new Map<string, WorkspaceFileStatus>();
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    // Renames and copies carry the source path as the next record.
    if (code.includes("R") || code.includes("C")) i++;
    if (code === "!!" || !file.startsWith(prefix)) continue;
    out.set(file.slice(prefix.length), code === "??" || code.includes("A") || code.includes("R") || code.includes("C") ? "added" : code.includes("D") ? "deleted" : "modified");
  }
  return out;
}

export async function listWorkspaceDir(root: string, input?: string): Promise<WorkspaceListing> {
  const rel = relativeWorkspacePath(input);
  const { real } = await confined(root, rel);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new WorkspacePathError("That path is not a folder.");
  const [dirents, status] = await Promise.all([fs.readdir(real, { withFileTypes: true }), gitStatus(root)]);
  const prefix = rel ? `${rel}/` : "";
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (HIDDEN.has(dirent.name)) continue;
    const entryPath = prefix + dirent.name;
    let isDir = dirent.isDirectory();
    let size: number | undefined;
    let mtime: number | undefined;
    try {
      const s = await fs.stat(path.join(real, dirent.name));
      isDir = s.isDirectory();
      size = isDir ? undefined : s.size;
      mtime = s.mtimeMs;
    } catch { /* a dangling symlink: list it, reading it says why */ }
    entries.push({
      name: dirent.name,
      path: entryPath,
      type: isDir ? "dir" : "file",
      ...(size !== undefined ? { size } : {}),
      ...(mtime !== undefined ? { mtime: Math.round(mtime) } : {}),
      ...(dirent.isSymbolicLink() ? { symlink: true } : {}),
    });
  }
  // Deleted files are gone from disk but are part of what changed: show them here.
  const present = new Set(entries.map((entry) => entry.name));
  for (const [file, state] of status ?? []) {
    if (state !== "deleted" || !file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (!name.includes("/") && !present.has(name)) entries.push({ name, path: file, type: "file", status: "deleted" });
  }
  for (const entry of entries) {
    if (!status) break;
    if (entry.type === "file") {
      const state = status.get(entry.path);
      if (state) entry.status = state;
    } else {
      let changed = 0;
      for (const file of status.keys()) if (file.startsWith(`${entry.path}/`)) changed++;
      if (changed) entry.changed = changed;
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel, entries: entries.slice(0, MAX_DIR_ENTRIES), git: status !== null };
}

function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8000);
  return head.includes(0);
}

export async function readWorkspaceFile(root: string, input: string): Promise<WorkspaceFile> {
  const rel = relativeWorkspacePath(input);
  if (!rel) throw new WorkspacePathError("Choose a file.");
  const { real } = await confined(root, rel);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new WorkspacePathError("That path is not a file.");
  const status = (await gitStatus(root))?.get(rel);
  const base = { path: rel, size: stat.size, mtime: Math.round(stat.mtimeMs), ...(status ? { status } : {}) };
  const mimeType = IMAGE_TYPES[path.extname(rel).toLowerCase()];
  if (mimeType) {
    if (stat.size > MAX_IMAGE_BYTES) return { ...base, kind: "too-large" };
    return { ...base, kind: "image", mimeType, data: (await fs.readFile(real)).toString("base64") };
  }
  const handle = await fs.open(real, "r");
  try {
    const length = Math.min(stat.size, MAX_TEXT_BYTES);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    if (looksBinary(bytes)) return { ...base, kind: "binary" };
    return { ...base, kind: "text", content: bytes.toString("utf8"), truncated: stat.size > MAX_TEXT_BYTES };
  } finally {
    await handle.close();
  }
}

interface FileCommand { kind: string; requestId?: unknown; sessionId?: unknown; path?: unknown; [key: string]: unknown }

/** `workspaceFor`: the directory a session works in, if this machine has it. */
export function createFileCommands(workspaceFor: (sessionId: string) => string | undefined): CommandEntries<FileCommand> {
  const operations: Record<string, (root: string, msg: FileCommand) => Promise<object>> = {
    "files.list": (root, msg) => listWorkspaceDir(root, typeof msg.path === "string" ? msg.path : undefined),
    "files.read": async (root, msg) => ({ file: await readWorkspaceFile(root, String(msg.path ?? "")) }),
  };
  return Object.fromEntries(Object.entries(operations).map(([kind, run]) => [kind, async (msg, ctx) => {
    try {
      const root = workspaceFor(String(msg.sessionId ?? ""));
      if (!root) throw new WorkspacePathError("This session's workspace isn't on this machine.");
      ctx.reply({ type: `${kind}.ok`, requestId: msg.requestId, ...await run(root, msg) });
    } catch (error) {
      // Raw filesystem errors carry host paths; say what happened without them.
      const code = (error as NodeJS.ErrnoException)?.code;
      const message = error instanceof WorkspacePathError ? error.message
        : code === "ENOENT" ? "That file no longer exists."
        : code === "EACCES" || code === "EPERM" ? "Permission denied."
        : "Could not read that path.";
      ctx.reply({ type: `${kind}.error`, requestId: msg.requestId, httpStatus: 400, error: message });
    }
  }]));
}
