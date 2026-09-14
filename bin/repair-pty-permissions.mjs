#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// node-pty 1.1.0's npm tarball ships the Darwin spawn-helper with mode 0644.
// Loading pty.node succeeds, but opening any terminal fails with posix_spawnp.
// Restore executable bits at install time, until upstream fixes the archive.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function repairPtyPermissions(root, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return;
  // resolve() handles both nested global installs and npm's hoisted layout.
  const require = createRequire(path.join(root, "package.json"));
  const ptyRoot = path.dirname(require.resolve("node-pty/package.json"));
  // node-pty can load a source build or a shipped prebuild. Only change its
  // known helper files, never recurse through arbitrary dependency executables.
  for (const dir of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(ptyRoot, dir, "spawn-helper");
    let stat;
    try { stat = fs.lstatSync(helper); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || (stat.mode & 0o111) === 0o111) continue;
    fs.chmodSync(helper, (stat.mode & 0o777) | 0o111);
    console.log(`Restored executable permissions on node-pty/${dir}/spawn-helper`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repairPtyPermissions(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
