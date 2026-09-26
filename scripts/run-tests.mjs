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
// `--changed-since <ref>` runs only the suites a change can reach through the
// import graph; see scripts/select-tests.mjs for why that is safe and where CI
// applies it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

// Suites run under our own loader (scripts/ts-loader.mjs) rather than tsx. With
// ~300 short-lived processes the loader's fixed startup cost is paid 300 times
// and dominated the run; see that file for the measurements. Set
// BIVY_TEST_LOADER=tsx to fall back if a suite ever disagrees with the two.
const useTsx = process.env.BIVY_TEST_LOADER === "tsx";
const tsLoader = path.join(repoRoot, "scripts", "ts-loader.mjs");
const nodeRunner = { cmd: process.execPath, prefix: ["--import", tsLoader] };

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
  .map((f) => ({
    name: f,
    cmd: useTsx ? tsxBin : nodeRunner.cmd,
    args: useTsx ? [path.join(testDir, f)] : [...nodeRunner.prefix, path.join(testDir, f)],
    ports: portsForFile(path.join(testDir, f)),
  }));

// Shell installer tests. Each runs the real install.sh, which mutates global,
// un-sandboxable state a port key can't model — it writes shell rc files, reads
// /dev/tty, and launches setup — so two of them at once race (that's exactly
// what flaked `installer-path.sh` when first parallelized). They stay a SERIAL
// tail, run one at a time after the parallel pool drains, just as they were the
// tail of the old `&&` chain. They're cheap; the ~141s all lived in .test.ts.
const shSuites = ["installer-bootstrap.sh", "installer-migration.sh", "installer-path.sh"].map((f) => ({
  name: f,
  cmd: "bash",
  args: [path.join(testDir, f)],
  ports: new Set(),
}));

const allSuites = [...tsSuites, ...shSuites];

// Measured wall-clock costs, taken from a real CI run's per-suite log. They are
// not a correctness input; they keep shards balanced and start expensive suites
// first so a long test does not become the final straggler. Unknown suites get a
// small default weight and still run normally.
//
// Now that CI splits the suite across four runners these also decide how even
// that split is, so refresh them from a CI log rather than guessing when they
// drift. Suites under two seconds are omitted: they are all within noise of the
// default weight. Regenerate with:
//   grep -oE '── . [^ ]+ \([0-9]+/[0-9]+, [0-9.]+s\)' <job-log>
const SUITE_DURATION_HINTS = new Map(Object.entries({
  "config-cli.test.ts": 20,
  "app-screenshot.test.ts": 16,
  "plugin-cli.test.ts": 9,
  "acp-adapter.test.ts": 8,
  "automation-filter.test.ts": 6,
  "codex-shim-tool-items.test.ts": 6,
  "self-host-setup.test.ts": 6,
  "setup-isolated-smoke.test.ts": 6,
  "agent-cli.test.ts": 5,
  "background-shell.test.ts": 5,
  "credential-import-command.test.ts": 5,
  "pi-models-all.test.ts": 5,
  "remote-runtime-integration.test.ts": 5,
  "app-preview-tunnel.test.ts": 4,
  "cli-version.test.ts": 4,
  "exec-exit-code.test.ts": 4,
  "fork-standup.test.ts": 4,
  "fork-transport.test.ts": 4,
  "golden-workflow-agents.test.ts": 4,
  "installer-smoke-guest.test.ts": 4,
  "pi-integration-credentials.test.ts": 4,
  "pi-session-discovery.test.ts": 4,
  "relay-reconnect.test.ts": 4,
  "runtime-delete-session.test.ts": 4,
  "runtime-read-messages.test.ts": 4,
  "github-tasks-integration.test.ts": 3,
  "process-group-kill.test.ts": 3,
  "self-host-bundle.test.ts": 3,
  "account-cli.test.ts": 2,
  "app-listeners.test.ts": 2,
  "codex-shim-turn-failed.test.ts": 2,
  "plugin-runtime.test.ts": 2,
  "session-reroute.test.ts": 2,
}));

function durationHint(suite) {
  return SUITE_DURATION_HINTS.get(suite.name) ?? (suite.name.endsWith(".sh") ? 5 : 1);
}

function compareByDurationDesc(a, b) {
  // Most suites have no hint and so tie on weight, which makes the tiebreak
  // decide almost the whole shard layout. localeCompare is locale-dependent, so
  // it produced a different split on CI than locally; compare by code point so
  // every machine assigns the same suites to the same shard.
  return durationHint(b) - durationHint(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const cliArgs = process.argv.slice(2);
const listOnly = cliArgs.includes("--list");
const changedSinceIndex = cliArgs.indexOf("--changed-since");
// --changed-since takes a git ref, which must not be mistaken for a name filter.
// Guard on the flag being present: indexOf returns -1 when it is not, and
// `i !== -1 + 1` would then silently drop the first real selector.
const refArgIndex = changedSinceIndex === -1 ? -1 : changedSinceIndex + 1;
const selectors = cliArgs.filter((arg, i) => !arg.startsWith("--") && i !== refArgIndex);
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

function assignShards(suites, count) {
  const loads = Array.from({ length: count }, () => 0);
  const assignments = new Map();
  for (const suite of [...suites].sort(compareByDurationDesc)) {
    let best = 0;
    for (let i = 1; i < loads.length; i++) {
      if (loads[i] < loads[best]) best = i;
    }
    assignments.set(suite.name, best);
    loads[best] += durationHint(suite);
  }
  return assignments;
}

// --changed-since <ref> narrows the run to the suites a change can reach, via
// the import graph (scripts/select-tests.mjs). Only PR pushes use it; the merge
// queue and nightly always run everything, so a suite it misses still gates the
// merge. The shell suites are not in the graph, so they only run in a full run.
let changedSinceSuites = null;
if (changedSinceIndex !== -1) {
  const baseRef = cliArgs[changedSinceIndex + 1];
  if (!baseRef || baseRef.startsWith("--")) {
    process.stderr.write("--changed-since needs a git ref, e.g. --changed-since origin/main\n");
    process.exit(2);
  }
  const { selectSuites } = await import("./select-tests.mjs");
  const { execFileSync } = await import("node:child_process");
  const base = execFileSync("git", ["merge-base", "HEAD", baseRef], { cwd: repoRoot, encoding: "utf8" }).trim();
  const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const result = selectSuites(changed);
  if (result.all) {
    process.stdout.write(`Change selection: running every suite (${result.reason}).\n`);
  } else {
    changedSinceSuites = new Set(result.suites);
    process.stdout.write(
      `Change selection: ${result.suites.length} of ${tsSuites.length} suites reachable from ${result.reason}.\n`,
    );
    if (result.suites.length === 0) {
      process.stdout.write("Nothing to run.\n");
      process.exit(0);
    }
  }
}

const selectorMatchedSuites = allSuites.filter((suite) =>
  (selectors.length === 0 || selectors.some((selector) => suite.name.includes(selector))) &&
  (changedSinceSuites === null || changedSinceSuites.has(suite.name)),
);
const shardAssignments = assignShards(selectorMatchedSuites, shardCount);
const selectedSuites = selectorMatchedSuites.filter((suite) => shardAssignments.get(suite.name) === shardIndex);
// A small change can select fewer suites than there are shards. The shards
// left over have nothing to run, which is success; only a selection that
// matched nothing at all (a mistyped suite name) is an error.
if (selectedSuites.length === 0 && selectorMatchedSuites.length > 0) {
  if (!listOnly) process.stdout.write(`Nothing to run in shard ${shardIndex + 1}/${shardCount}.\n`);
  process.exit(0);
}
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
const parallelSuites = suites.filter((suite) => suite.name.endsWith(".test.ts")).sort(compareByDurationDesc);
const serialSuites = suites.filter((suite) => !suite.name.endsWith(".test.ts")).sort(compareByDurationDesc);

const parallelism = availableParallelism?.() ?? cpus().length ?? 1;
const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || parallelism);

// Put node_modules/.bin on PATH for the suites, exactly as `pnpm run` does.
//
// Several agents are detected by probing PATH (Pi's availability runs
// `command -v pi`, which resolves to node_modules/.bin/pi from its optional
// dependency). That made the suite's result depend on how the runner itself was
// launched: `pnpm run test:unit` passed and a direct `node scripts/run-tests.mjs`
// failed, because only the former exports .bin. Normalise it here so both agree
// — CI invoking the script directly is otherwise an invisible behaviour change.
const binDir = path.join(repoRoot, "node_modules", ".bin");
if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDir)) {
  process.env.PATH = binDir + path.delimiter + (process.env.PATH ?? "");
}

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
