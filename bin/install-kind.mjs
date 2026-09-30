// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

/** The file a system package (pacman, …) writes into the install it owns. */
export const MANAGED_INSTALL_FILE = ".bivy-install.json";

/**
 * `{ manager, update }` when a system package manager owns this install, so
 * Bivy must not replace its files; null otherwise.
 */
export function managedInstall(repoRoot, readFileSync = fs.readFileSync) {
  try {
    const data = JSON.parse(readFileSync(path.join(repoRoot, MANAGED_INSTALL_FILE), "utf8"));
    if (typeof data?.manager === "string" && data.manager) {
      return { manager: data.manager, update: typeof data.update === "string" ? data.update : "" };
    }
  } catch {
    /* not managed */
  }
  return null;
}

/** Classify a Bivy package root without assuming unscoped npm package layout. */
export function detectInstallKind(repoRoot, existsSync = fs.existsSync) {
  if (existsSync(path.join(repoRoot, ".git"))) return "git";
  if (existsSync(path.join(repoRoot, MANAGED_INSTALL_FILE))) return "managed";

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

/**
 * Return the npm prefix that owns a package installed below node_modules.
 * npm uses <prefix>/lib/node_modules on Unix and <prefix>/node_modules on
 * other platforms. The running npm process may have a different configured
 * prefix, so deriving it from the package path is important for user-local
 * installs.
 */
export function npmGlobalPrefix(repoRoot) {
  let current = path.resolve(repoRoot);
  while (true) {
    if (path.basename(current) === "node_modules") {
      const parent = path.dirname(current);
      return path.basename(parent) === "lib" ? path.dirname(parent) : parent;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
