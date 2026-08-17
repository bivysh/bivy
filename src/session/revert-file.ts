// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Safe per-file revert for the review surface. Restores ONE changed file
// to its pre-turn content, so a reviewer can undo a single unwanted edit without
// rewinding the whole turn. The pre-turn content is the diff's own `oldText`
// (computed and sent by the node), passed back with the request; a file the turn
// ADDED reverts to removal (content === null). Path-confined to the worktree — no
// traversal, no absolute escape — and never writes outside it.

import fs from "node:fs";
import path from "node:path";

/** Resolve `relPath` inside `worktreeDir`, rejecting anything that escapes it. */
export function confineToWorktree(worktreeDir: string, relPath: string): string | null {
  const root = path.resolve(worktreeDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export interface RevertFileResult {
  ok: boolean;
  status: "reverted" | "removed" | "rejected";
  error?: string;
}

/**
 * Revert a single changed file to its pre-turn state. `content` is the file's
 * pre-turn text (restore it), or `null` when the turn added the file (remove it).
 * A path outside the worktree is rejected outright.
 */
export function revertFile(
  worktreeDir: string,
  relPath: string,
  content: string | null,
  io: { writeFile?: (p: string, data: string) => void; rm?: (p: string) => void; mkdir?: (p: string) => void } = {},
): RevertFileResult {
  const abs = confineToWorktree(worktreeDir, relPath);
  if (!abs || !relPath) return { ok: false, status: "rejected", error: "path outside the worktree" };
  const writeFile = io.writeFile ?? ((p, data) => fs.writeFileSync(p, data));
  const rm = io.rm ?? ((p) => fs.rmSync(p, { force: true }));
  const mkdir = io.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true }));
  try {
    if (content === null) {
      rm(abs);
      return { ok: true, status: "removed" };
    }
    mkdir(path.dirname(abs));
    writeFile(abs, content);
    return { ok: true, status: "reverted" };
  } catch (error) {
    return { ok: false, status: "rejected", error: error instanceof Error ? error.message : String(error) };
  }
}
