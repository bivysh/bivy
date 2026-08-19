#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unit-test runner for the node/core suites under test/.
//
// Replaces the old hand-maintained `&&`-chain in package.json, which (a) had to
// be edited by hand for every new test file — so six suites had silently fallen
// out of CI — and (b) halted at the first failure, hiding every later suite's
// result. This auto-discovers `test/*.test.ts`, runs each independently,
// continues past failures, and prints one summary. Exit code is non-zero if any
// suite (ts or the shell installer tests) fails.
//
// Suites run CONCURRENTLY (a serial `for` loop left 3 of the runner's 4 cores
// idle and made this the slowest job in CI by far). Two things make that safe:
//   1. Output is captured per-suite and printed as a block when the suite
//      finishes, so parallel logs never interleave into noise.
//   2. Several suites bind FIXED ports (e.g. 4711, 4317, 8443) and some share
//      one, so running them at the same time would collide. We parse each
//      suite's fixed ports and never let two suites that share a port run
//      concurrently — every other suite still parallelizes freely. This needs
//      no cooperation from the tests themselves.
//
// Concurrency defaults to the machine's parallelism; override with
// TEST_CONCURRENCY=1 to fall back to fully serial execution for debugging.
// Pass one or more substrings to run only matching suites during development:
//   npm run test:unit -- config-cli plugin-cli
// CI can distribute the suite across machines with TEST_SHARD=1/2, 2/2, etc.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

// Preflight: without tsx every .test.ts suite fails instantly with an opaque
// spawn error, so the summary reads "N/N failed" and hides the real cause. Fail
// loudly with the actual fix instead. (Historically `build:release` could empty
// node_modules and produce exactly this — see issue #11.)
if (!existsSync(tsxBin)) {
  process.stderr.write(
    `\nCannot run tests: ${path.relative(repoRoot, tsxBin)} is missing.\n` +
      `Dependencies are not installed (or were removed). Run \`npm install\` and try again.\n`,
  );
  process.exit(1);
}

// Extract the fixed TCP ports a suite references, so two suites that bind the
// same port never run at once. Over-detection only costs a little parallelism
// (they serialize); under-detection risks a flaky collision, so the patterns
// lean inclusive. The 4–5 digit bare-colon rule (`:4711`) is intentionally
// narrow enough to skip clock values like `10:30:45` (whose fields are 2 digits).
const PORT_PATTERNS = [
  /\blisten\(\s*(\d{2,5})/gi, // listen(8443)
  /\bport\s*[:=]\s*(\d{2,5})/gi, // port: 443 / PORT = 4317
  /:(\d{4,5})\b/g, // localhost:4711, ws://…:8443
];
function portsForFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return new Set();
  }
  const ports = new Set();
  for (const re of PORT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 65535) ports.add(n);
    }
  }
  return ports;
}

const tsSuites = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => ({ name: f, cmd: tsxBin, args: [path.join(testDir, f)], ports: portsForFile(path.join(testDir, f)) }));

// Shell installer tests. Each runs the real install.sh, which mutates global,
// un-sandboxable state a port key can't model — it writes shell rc files, reads
// /dev/tty, and launches setup — so two of them at once race (that's exactly
// what flaked `installer-path.sh` when first parallelized). They stay a SERIAL
// tail, run one at a time after the parallel pool drains, just as they were the
// tail of the old `&&` chain. They're cheap; the ~141s all lived in .test.ts.
const shSuites = ["installer-migration.sh", "installer-path.sh"].map((f) => ({
  name: f,
  cmd: "bash",
  args: [path.join(testDir, f)],
  ports: new Set(),
}));

const allSuites = [...tsSuites, ...shSuites];

const cliArgs = process.argv.slice(2);
const listOnly = cliArgs.includes("--list");
const selectors = cliArgs.filter((arg) => !arg.startsWith("--"));
const shardSpec = process.env.TEST_SHARD;
let shardIndex = 0;
let shardCount = 1;
if (shardSpec) {
  const match = /^(\d+)\/(\d+)$/.exec(shardSpec);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
    process.stderr.write(`Invalid TEST_SHARD=${shardSpec}; expected I/N with 1 <= I <= N.\n`);
    process.exit(2);
  }
  shardIndex = Number(match[1]) - 1;
  shardCount = Number(match[2]);
}

// FNV-1a gives every shard the same stable assignment without a coordination
// file. Unlike contiguous chunks, it also spreads alphabetically clustered CLI
// and integration suites, which tend to be the expensive ones.
function shardFor(name) {
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

const selectedSuites = allSuites.filter((suite) =>
  (selectors.length === 0 || selectors.some((selector) => suite.name.includes(selector)))
  && shardFor(suite.name) === shardIndex,
);
if (selectedSuites.length === 0) {
  process.stderr.write(`No test suites matched${selectors.length ? `: ${selectors.join(", ")}` : ""}.\n`);
  process.exit(2);
}
if (listOnly) {
  const output = selectedSuites.map((suite) => suite.name).join("\n") + "\n";
  if (!process.stdout.write(output)) await new Promise((resolve) => process.stdout.once("drain", resolve));
  process.exit(0);
}

const suites = selectedSuites;
const parallelSuites = suites.filter((suite) => suite.name.endsWith(".test.ts"));
const serialSuites = suites.filter((suite) => !suite.name.endsWith(".test.ts"));

const parallelism = availableParallelism?.() ?? cpus().length ?? 1;
const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || parallelism);

const failures = [];
const start = Date.now();
const activePorts = new Set(); // ports held by currently-running suites
let running = 0;
let done = 0;

process.stdout.write(
  `Running ${suites.length} suites: ${parallelSuites.length} in parallel ` +
    `(up to ${concurrency}), then ${serialSuites.length} serial` +
    (concurrency === 1 ? " — parallel phase capped to 1\n" : "\n"),
);

// A suite that never exits (a stalled network call, an orphaned server holding
// the pipe open) must fail loudly with its name, not hang the whole run until
// the CI job's timeout. The slowest healthy suite is well under a minute, so
// this only ever fires on a genuine hang. Override with TEST_SUITE_TIMEOUT_MS.
const suiteTimeoutMs = Math.max(1000, Number(process.env.TEST_SUITE_TIMEOUT_MS) || 5 * 60_000);

// Suites run in their own process groups (see runSuite), which also means a
// Ctrl-C on the runner would no longer reach them — so forward it ourselves.
const activeChildren = new Set();
function killGroup(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // already gone
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of activeChildren) killGroup(child);
    process.exit(130);
  });
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const suiteStart = Date.now();
    // detached → own process group, so a timeout can kill grandchildren (a
    // suite's spawned servers) too, not just the tsx/bash wrapper.
    const child = spawn(suite.cmd, suite.args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    activeChildren.add(child);
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`spawn error: ${err.message}\n`));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      chunks.push(Buffer.from(`\nTIMEOUT: ${suite.name} did not finish within ${suiteTimeoutMs / 1000}s; killing it.\n`));
      killGroup(child);
      finish(124);
    }, suiteTimeoutMs);
    let finished = false;
    function finish(code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      const ok = code === 0;
      if (!ok) failures.push(suite.name);
      done += 1;
      const tag = ok ? "✓" : "✗";
      const suiteElapsed = ((Date.now() - suiteStart) / 1000).toFixed(1);
      process.stdout.write(`\n── ${tag} ${suite.name} (${done}/${suites.length}, ${suiteElapsed}s)\n`);
      process.stdout.write(Buffer.concat(chunks).toString("utf8"));
      resolve();
    }
  });
}

// Greedy, port-aware scheduler for the parallel phase. On every free slot we
// scan the pending list for the first suite whose fixed ports are all currently
// free, start it, and mark its ports busy until it exits. A suite blocked only
// by a port (not the slot limit) simply waits for the holder to finish — no
// deadlock, because a suite can conflict only with one that is actively running,
// and running suites always make progress.
async function runParallel(list) {
  const pending = [...list];
  let completed = 0;
  await new Promise((resolveAll) => {
    const pump = () => {
      if (completed === list.length) {
        resolveAll();
        return;
      }
      for (let i = 0; i < pending.length && running < concurrency; ) {
        const suite = pending[i];
        const portClash = [...suite.ports].some((p) => activePorts.has(p));
        if (portClash) {
          i += 1;
          continue;
        }
        pending.splice(i, 1);
        running += 1;
        for (const p of suite.ports) activePorts.add(p);
        runSuite(suite).then(() => {
          running -= 1;
          for (const p of suite.ports) activePorts.delete(p);
          completed += 1;
          pump();
        });
        // don't advance i: the list shifted; re-scan from the same index
      }
    };
    pump();
  });
}

await runParallel(parallelSuites);
// Serial tail: one installer suite at a time, never overlapping anything else.
for (const suite of serialSuites) {
  await runSuite(suite);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
process.stdout.write(`\n${"=".repeat(48)}\n`);
if (failures.length === 0) {
  process.stdout.write(`✓ all ${suites.length} suites passed (${elapsed}s)\n`);
  process.exit(0);
}
process.stdout.write(`✗ ${failures.length}/${suites.length} suite(s) failed (${elapsed}s):\n`);
for (const name of failures.sort()) process.stdout.write(`    ${name}\n`);
process.exit(1);
