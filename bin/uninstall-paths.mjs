// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Pure(ish) filesystem helper for `bivy uninstall`, extracted so it can be
// unit-tested without executing the CLI (bin/bivy.mjs runs main() on import).
//
// Background: `bivy uninstall --keep-sessions` used to move the raw pi
// transcripts aside to a one-off `~/bivy-sessions-<timestamp>` folder that
// nothing ever restored, and deleted the durable session index
// (`.bivy/metadata.json`) regardless of the flag — so both the CLI and the
// React app showed nothing after a fresh reinstall (issue #461).
// `removeExcept` instead deletes everything under the app's state dir except
// the paths the caller says to keep, leaving them exactly where they already
// are — the path a rerun of a dev checkout, or install.sh's own `.bivy`
// carry-forward on a packaged reinstall, already looks for them.
import fs from "node:fs";
import path from "node:path";

/**
 * Delete everything under `root` except the given absolute paths, pruning
 * (but not removing) the directory chain needed to reach them. With no `keep`
 * entries this is equivalent to `rm -rf root`.
 */
export function removeExcept(root, keep) {
  if (!keep.length) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const keepResolved = keep.map((p) => path.resolve(p));
  const isAncestorOfKept = (dir) => keepResolved.some((k) => k === dir || k.startsWith(dir + path.sep));
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.resolve(path.join(dir, ent.name));
      if (keepResolved.includes(full)) continue;
      if (ent.isDirectory() && isAncestorOfKept(full)) {
        walk(full);
        continue;
      }
      fs.rmSync(full, { recursive: true, force: true });
    }
  };
  walk(root);
}
