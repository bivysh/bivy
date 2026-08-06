// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Single source of truth for the Bivy data directory.
//
// Several modules independently derived this default and DISAGREED: the daemon
// (src/server.ts) used <install>/.bivy, the git credential helper and the secret
// vault fell back to ~/.bivy, and the agent service to <cwd>/.bivy. A process
// that never sets BIVY_DATA_DIR explicitly could therefore point its git
// credential helper and its secret vault at different roots — the drift behind
// issue #1's test-isolation failure. Everyone resolves the data dir HERE now.
import path from "node:path";
import { fileURLToPath } from "node:url";

// This module ships at src/ (dist/ in a release build), so its parent directory
// is the package root — the same <install>/.bivy the daemon uses. Because the
// path is resolved relative to THIS file, every importer agrees regardless of
// its own location (e.g. src/runtime/*) or the process's cwd.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Bivy data directory: `BIVY_DATA_DIR` if set (resolved to an absolute path),
 * otherwise `<install>/.bivy`. This is the one function that decides the default.
 */
export function defaultDataDir(): string {
  const env = process.env.BIVY_DATA_DIR;
  return env ? path.resolve(env) : path.join(packageRoot, ".bivy");
}
