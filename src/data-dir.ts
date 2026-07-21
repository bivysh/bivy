// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Single source of truth for Bivy's default writable data dir. Several
// independent subsystems need this default when BIVY_DATA_DIR is unset — the
// daemon itself (src/server.ts), the git credential helper (src/git-auth.ts),
// the secret vault (src/secrets.ts), and the standalone agent-service process
// (src/runtime/agent-service-bin.ts). If each re-derived its own fallback they
// can silently drift apart (this happened: git-auth.ts fell back to
// `~/.bivy`, secrets.ts and agent-service-bin.ts fell back to `<cwd>/.bivy`,
// while everything else used `<install>/.bivy`) — two processes, or two
// modules in the same process, then disagree on where the data dir is and
// each thinks it owns an empty one. Route every fallback through here instead
// of re-deriving it per module so that can't happen again.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One level above this file. This module lives at the top of src/ (dev, run
// via tsx) or dist/ (prod, compiled by tsc), so that's the installation root —
// NOT the process's cwd or the invoking user's home directory. Computing it
// here (rather than via each caller's own __dirname) means callers nested
// deeper in the tree (e.g. src/runtime/agent-service-bin.ts) get the same
// answer as top-level ones (src/server.ts) without re-deriving it themselves.
const installRoot = path.resolve(__dirname, "..");

/** The data dir to use when BIVY_DATA_DIR is unset: `<install>/.bivy`. */
export function defaultDataDir(): string {
  return path.join(installRoot, ".bivy");
}

/**
 * The effective data dir: `BIVY_DATA_DIR` (resolved to an absolute path) if
 * set, else the shared default. Every module that needs "the" data dir absent
 * an explicit override should call this instead of reading
 * `process.env.BIVY_DATA_DIR` itself.
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.BIVY_DATA_DIR;
  return fromEnv ? path.resolve(fromEnv) : defaultDataDir();
}
