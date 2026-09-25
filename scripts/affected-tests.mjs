// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Change-based test selection for the node suites under test/.
//
// A suite is affected when a changed file is in its dependency closure. The
// closure is built from every repo path a file mentions, not only its imports:
// suites reach code through `import`, through spawned entrypoints
// (`path.join(root, "src", "agent-cli.ts")`, bin/bivy.mjs → "src/server.ts") and
// through files read as text. One generic scan covers all three, so a new suite
// needs no registration. The scan over-approximates: a stray path in a comment
// only runs an extra suite, which is the safe direction.
//
// Anything that can change how every suite runs (dependencies, compiler config,
// the runner itself) selects everything. A change outside every closure (docs,
// services/*, most of packages/web) selects nothing; other CI jobs own those.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Changing any of these can alter every suite's behavior.
export const RUN_ALL_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".npmrc",
  ".github/workflows/ci.yml",
  "scripts/run-tests.mjs",
  "scripts/affected-tests.mjs",
];

// Workspace package names the node suites import by name.
const PACKAGE_ENTRIES = new Map([["@bivy/core", "packages/core/src/index.ts"]]);

const SCANNED = /\.(?:[cm]?[jt]sx?|sh)$/;
const PATH_TOKEN = /[\w@.-]*(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?|sh|json|ya?ml|css|html|md|txt|toml)\b/g;
const QUOTED = /["'`]([^"'`\n]{1,200})["'`]/g;
const JOIN = /\b(?:join|resolve)\(([^()]{0,400})\)/g;
const SPECIFIER_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

// Tracked files and their directories: resolution is set lookups, not stat calls.
function indexRepo(repoRoot) {
  const files = new Set(
    execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean),
  );
  const dirs = new Set();
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  return { files, dirs };
}

// Prose like "see src/server.ts" is not a dependency, and left in it links
// nearly every module to the server. Stripping is approximate (a "//" inside a
// string can end a line early); the merge queue's full run backstops any miss.
function stripComments(text, file) {
  if (file.endsWith(".sh")) return text.replace(/^\s*#.*$/gm, "");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
}

// Candidate repo paths mentioned by one file's code.
function mentionedPaths(text) {
  const found = new Set();
  for (const [, quoted] of text.matchAll(QUOTED)) found.add(quoted);
  for (const [token] of text.matchAll(PATH_TOKEN)) found.add(token);
  // path.join(root, "src", "x.ts") → "src/x.ts"
  for (const [, args] of text.matchAll(JOIN)) {
    const parts = [...args.matchAll(QUOTED)].map((m) => m[1]);
    if (parts.length > 1) found.add(parts.join("/"));
  }
  return found;
}

// Resolve a mention to a repo-relative file, or a "dir/" prefix for directory
// mentions ("packages/web/src" depends on everything below it). Tries the
// mentioning file's directory, then the repo root, with TypeScript's
// ".js" → ".ts" convention.
function resolveMention(index, fromFile, mention) {
  const entry = PACKAGE_ENTRIES.get(mention);
  if (entry) return entry;
  if (!mention || mention.startsWith("node:") || /^[a-z]+:\/\//i.test(mention) || /[*\s$]/.test(mention)) return null;
  const fromDir = path.posix.dirname(fromFile);
  const bases = mention.startsWith(".") ? [fromDir] : [fromDir, "."];
  const stems = [mention, mention.replace(/\.[cm]?js$/, "")];
  for (const base of bases) {
    for (const stem of stems) {
      const joined = path.posix.normalize(path.posix.join(base, stem));
      if (joined.startsWith("..") || joined === ".") continue;
      for (const ext of SPECIFIER_EXTENSIONS) {
        if (index.files.has(joined + ext)) return joined + ext;
      }
      if (mention.includes("/") && index.dirs.has(joined)) return `${joined}/`;
    }
  }
  return null;
}

// Forward edges for every file reachable from the given entries.
function buildGraph(repoRoot, index, entries) {
  const edges = new Map();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (edges.has(file)) continue;
    const deps = new Set();
    edges.set(file, deps);
    if (file.endsWith("/") || !SCANNED.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const mention of mentionedPaths(stripComments(text, file))) {
      const dep = resolveMention(index, file, mention);
      if (dep && dep !== file) {
        deps.add(dep);
        if (!edges.has(dep)) stack.push(dep);
      }
    }
  }
  return edges;
}

/**
 * @param {string} repoRoot
 * @param {string[]} suiteFiles repo-relative suite paths
 * @param {string[]} changedFiles repo-relative changed paths
 * @returns {{ all: boolean, reason?: string, selected: string[] }}
 */
export function selectAffected(repoRoot, suiteFiles, changedFiles) {
  const trigger = changedFiles.find((file) => RUN_ALL_FILES.includes(file));
  if (trigger) return { all: true, reason: trigger, selected: suiteFiles };

  const edges = buildGraph(repoRoot, indexRepo(repoRoot), suiteFiles);
  const dependents = new Map();
  for (const [file, deps] of edges) {
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(file);
    }
  }
  // Walk from each changed file (and each directory mention containing it) back
  // to the suites that reach it.
  const prefixes = [...edges.keys()].filter((node) => node.endsWith("/"));
  const reached = new Set();
  const stack = changedFiles.flatMap((file) => [file, ...prefixes.filter((dir) => file.startsWith(dir))]);
  while (stack.length) {
    const node = stack.pop();
    if (reached.has(node)) continue;
    reached.add(node);
    for (const parent of dependents.get(node) ?? []) stack.push(parent);
  }
  return { all: false, selected: suiteFiles.filter((suite) => reached.has(suite)) };
}

// Committed, uncommitted and untracked changes since the branch left `base`, so
// the same selection works locally before a commit and in CI.
export function changedFilesSince(repoRoot, base) {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const out = git("diff", "--name-only", mergeBase) + git("ls-files", "--others", "--exclude-standard");
  // A deleted file resolves in no closure; typecheck reports its dangling imports.
  return [...new Set(out.split("\n").map((line) => line.trim()).filter(Boolean))];
}
