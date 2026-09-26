#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Work out which unit suites a change can possibly affect.
//
// A one-line fix in one module currently runs all ~300 suites. The suites are
// one-per-module and import what they exercise, so the import graph already
// says which ones could observe a given edit. This walks that graph and returns
// the suites reachable from the changed files.
//
// The safety property that makes this acceptable is not the graph's precision —
// it is WHERE it is used. Only PR pushes narrow the selection. The merge queue,
// nightly and release runs always execute the full suite, so a suite this
// misses still gates the merge; the cost of a miss is later feedback, never a
// regression reaching main. See .github/workflows/ci.yml.
//
// It is also deliberately quick to give up. Anything that could affect suites
// without appearing in their import graph — the lockfile, bin/, scripts/, the
// shared test helpers, CI config — selects everything instead of guessing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A change to any of these can reach a suite without being imported by it, so
// they force the full run. Better a wasted full run than a silent gap.
const RUN_EVERYTHING = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig\.json$/,
  /^\.github\/workflows\//,
  /^bin\//,
  /^scripts\//,
  /^certification\//,
  /^install\.sh$/,
  // Suites spawn the CLI and read fixtures from these by path, not by import.
  /^test\/[^/]*\.sh$/,
  /^test\/fixtures\//,
  /^test\/helpers?\//,
];

function changedFiles(baseRef) {
  // Compare against the merge base so unrelated commits landing on the base
  // branch do not inflate the change set.
  const base = execFileSync("git", ["merge-base", "HEAD", baseRef], { cwd: repoRoot, encoding: "utf8" }).trim();
  const out = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

// Resolve a relative specifier the way the suites are written: TypeScript's
// NodeNext output keeps a `.js` extension that actually refers to a `.ts`
// source. Bare specifiers are dependencies and stop the walk.
function resolveImport(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (stripped !== base) candidates.push(...SOURCE_EXTENSIONS.map((e) => stripped + e));
  candidates.push(...SOURCE_EXTENSIONS.map((e) => base + e));
  candidates.push(...SOURCE_EXTENSIONS.map((e) => path.join(base, "index" + e)));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

const importCache = new Map();
function importsOf(file) {
  let found = importCache.get(file);
  if (found) return found;
  found = [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    importCache.set(file, found);
    return found;
  }
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const resolved = resolveImport(match[1], file);
      if (resolved) found.push(resolved);
    }
  }
  importCache.set(file, found);
  return found;
}

// Every file a suite can reach through static imports, as repo-relative paths.
function reachableFrom(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) if (!seen.has(next)) stack.push(next);
  }
  return new Set([...seen].map((f) => path.relative(repoRoot, f)));
}

export function selectSuites(changed) {
  const forced = changed.find((f) => RUN_EVERYTHING.some((re) => re.test(f)));
  if (forced) return { all: true, reason: `${forced} can affect suites that do not import it`, suites: [] };

  const testDir = path.join(repoRoot, "test");
  const suites = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).sort();
  const changedSet = new Set(changed);
  const selected = suites.filter((name) => {
    const reach = reachableFrom(path.join(testDir, name));
    for (const file of changedSet) if (reach.has(file)) return true;
    return false;
  });
  return { all: false, reason: `${changed.length} changed file(s)`, suites: selected };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const baseRef = process.argv[2] || process.env.TEST_CHANGED_SINCE || "origin/main";
  const changed = changedFiles(baseRef);
  if (changed.length === 0) {
    process.stderr.write(`No files changed against ${baseRef}.\n`);
    process.exit(0);
  }
  const result = selectSuites(changed);
  if (result.all) {
    process.stderr.write(`Running every suite: ${result.reason}.\n`);
    process.stdout.write("ALL\n");
  } else {
    process.stderr.write(`Selected ${result.suites.length} suite(s) from ${result.reason}.\n`);
    process.stdout.write(result.suites.join("\n") + (result.suites.length ? "\n" : ""));
  }
}
