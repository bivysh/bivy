#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Cap the test loader's transform cache (see scripts/ts-loader.mjs).
//
// Entries are content-addressed, so editing a file adds one and never replaces
// the old one. Left alone the directory grows with every edit — which matters
// most in CI, where it is saved and restored as a cache entry between runs.
//
// Dropping the least-recently-used entries is safe by construction: a missing
// entry is a cache miss, which costs one esbuild transform. Run it after the
// suites, not before, so the run itself always sees a warm cache.
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cacheDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".cache",
  "bivy-ts",
);

// Generous enough that a normal run is entirely warm: the whole src+test graph
// transpiles to a few megabytes, so this holds many revisions of it.
const MAX_BYTES = Number(process.env.TS_CACHE_MAX_BYTES) || 200 * 1024 * 1024;

let entries;
try {
  entries = readdirSync(cacheDir);
} catch {
  process.exit(0); // never created; nothing to do
}

const files = [];
let total = 0;
for (const name of entries) {
  const file = path.join(cacheDir, name);
  try {
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    files.push({ file, size: stat.size, atime: stat.atimeMs });
    total += stat.size;
  } catch {
    // vanished under us; ignore
  }
}

if (total <= MAX_BYTES) {
  process.stdout.write(`ts cache ${(total / 1e6).toFixed(1)}MB, under the ${(MAX_BYTES / 1e6).toFixed(0)}MB cap\n`);
  process.exit(0);
}

files.sort((a, b) => a.atime - b.atime); // least recently used first
let removed = 0;
for (const entry of files) {
  if (total <= MAX_BYTES) break;
  try {
    rmSync(entry.file);
    total -= entry.size;
    removed += 1;
  } catch {
    // ignore
  }
}
process.stdout.write(`ts cache pruned ${removed} entries, now ${(total / 1e6).toFixed(1)}MB\n`);
