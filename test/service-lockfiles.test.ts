// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Release version bumps must not relabel third-party dependency artifacts.
for (const service of ["control-plane", "relay"]) {
  const lock = JSON.parse(readFileSync(new URL(`../services/${service}/package-lock.json`, import.meta.url), "utf8"));
  for (const [name, entry] of Object.entries(lock.packages) as [string, { version?: string; resolved?: string }][]) {
    if (!entry.version || !entry.resolved?.startsWith("https://registry.npmjs.org/")) continue;
    const artifact = decodeURIComponent(new URL(entry.resolved).pathname);
    assert.ok(artifact.endsWith(`-${entry.version}.tgz`), `${service}: ${name} version ${entry.version} must match its pinned tarball`);
  }
}
console.log("✓ service lockfile dependency versions match their pinned registry artifacts");
