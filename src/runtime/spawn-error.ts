// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { existsSync } from "node:fs";

/**
 * Explain an agent spawn failure. Node reports a missing working directory as
 * ENOENT on the *command* ("spawn /usr/bin/node ENOENT"), which reads as a
 * missing agent install. When the folder is what's gone (a session whose
 * worktree was removed to free disk), say so instead.
 */
export function spawnFailure(error: Error, cwd: string | undefined): Error {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !cwd || existsSync(cwd)) return error;
  return new Error(`This session's folder no longer exists, so its agent can't start. Start a new session to keep working. (Missing folder: ${cwd})`);
}
