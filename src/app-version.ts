// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** Resolve the running Bivy package version in source and compiled layouts. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function currentBivyVersion(): string {
  if (cached) return cached;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      cached = parsed.version.trim();
      return cached;
    }
  } catch { /* normalized below */ }
  throw new Error(`Unable to determine the running Bivy version from ${path.join(root, "package.json")}`);
}
