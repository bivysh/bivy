// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

/** Classify a Bivy package root without assuming unscoped npm package layout. */
export function detectInstallKind(repoRoot, existsSync = fs.existsSync) {
  if (existsSync(path.join(repoRoot, ".git"))) return "git";

  // npm installs an unscoped package at node_modules/name and a scoped package
  // at node_modules/@scope/name. Bivy uses the latter layout.
  const parent = path.dirname(repoRoot);
  const grandparent = path.dirname(parent);
  const inNodeModules = path.basename(parent) === "node_modules"
    || (path.basename(parent).startsWith("@") && path.basename(grandparent) === "node_modules");

  if (inNodeModules && /[\\/]_npx[\\/]/.test(repoRoot)) return "npx";
  if (inNodeModules) return "npm-global";
  return "packaged";
}
