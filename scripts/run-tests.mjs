#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
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

// Shell installer tests (previously the tail of the chain).
const shSuites = ["installer-migration.sh", "installer-path.sh"].map((f) => ({
  name: f,
  cmd: "bash",
  args: [path.join(testDir, f)],
  ports: portsForFile(path.join(testDir, f)),
}));

const suites = [...tsSuites, ...shSuites];

const parallelism = availableParallelism?.() ?? cpus().length ?? 1;
const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || parallelism);

const failures = [];
const start = Date.now();
const activePorts = new Set(); // ports held by currently-running suites
const pending = [...suites];
let running = 0;
let done = 0;

process.stdout.write(
  `Running ${suites.length} suites, up to ${concurrency} at a time` +
    (concurrency === 1 ? " (serial)\n" : "\n"),
);

function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(suite.cmd, suite.args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`spawn error: ${err.message}\n`));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    let finished = false;
    function finish(code) {
      if (finished) return;
      finished = true;
      const ok = code === 0;
      if (!ok) failures.push(suite.name);
      done += 1;
      const tag = ok ? "✓" : "✗";
      process.stdout.write(`\n── ${tag} ${suite.name} (${done}/${suites.length})\n`);
      process.stdout.write(Buffer.concat(chunks).toString("utf8"));
      resolve();
    }
  });
}

// Greedy, port-aware scheduler. On every free slot we scan the pending list for
// the first suite whose fixed ports are all currently free, start it, and mark
// its ports busy until it exits. A suite blocked only by a port (not the slot
// limit) simply waits for the holder to finish — no deadlock, because a suite
// can conflict only with one that is actively running, and running suites always
// make progress.
async function schedule() {
  await new Promise((resolveAll) => {
    const pump = () => {
      if (done === suites.length) {
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
          pump();
        });
        // don't advance i: the list shifted; re-scan from the same index
      }
    };
    pump();
  });
}

await schedule();

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
process.stdout.write(`\n${"=".repeat(48)}\n`);
if (failures.length === 0) {
  process.stdout.write(`✓ all ${suites.length} suites passed (${elapsed}s)\n`);
  process.exit(0);
}
process.stdout.write(`✗ ${failures.length}/${suites.length} suite(s) failed (${elapsed}s):\n`);
for (const name of failures.sort()) process.stdout.write(`    ${name}\n`);
process.exit(1);
