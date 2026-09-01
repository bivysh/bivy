#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Discover and run the control-plane's standalone test files concurrently.
// Each file already runs in its own process, so parallelizing files preserves
// their isolation while using the runner's otherwise-idle CPU cores.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const selectors = process.argv.slice(2);
const suites = readdirSync(testDir)
  .filter((file) => file.endsWith(".test.ts"))
  .filter((file) => selectors.length === 0 || selectors.some((selector) => file.includes(selector)))
  .sort();

if (suites.length === 0) {
  console.error(`No control-plane tests matched: ${selectors.join(", ")}`);
  process.exit(2);
}

const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || availableParallelism());
const timeoutMs = Math.max(1000, Number(process.env.TEST_SUITE_TIMEOUT_MS) || 5 * 60_000);
const failures = [];
let next = 0;
let completed = 0;
const startedAt = Date.now();

console.log(`Running ${suites.length} control-plane suites (up to ${concurrency} concurrently)`);

function runSuite(file) {
  return new Promise((resolve) => {
    const suiteStartedAt = Date.now();
    const child = spawn(tsx, [path.join(testDir, file)], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));

    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      completed += 1;
      if (code !== 0) failures.push(file);
      const elapsed = ((Date.now() - suiteStartedAt) / 1000).toFixed(1);
      console.log(`\n── ${code === 0 ? "✓" : "✗"} ${file} (${completed}/${suites.length}, ${elapsed}s)`);
      process.stdout.write(Buffer.concat(output).toString("utf8"));
      resolve();
    };

    child.on("error", (error) => {
      output.push(Buffer.from(`spawn error: ${error.message}\n`));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      output.push(Buffer.from(`TIMEOUT after ${timeoutMs / 1000}s\n`));
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process exited between the timeout and kill.
      }
      finish(124);
    }, timeoutMs);
  });
}

async function worker() {
  while (next < suites.length) {
    const file = suites[next++];
    await runSuite(file);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, () => worker()));
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length}/${suites.length} suite(s) failed (${elapsed}s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ all ${suites.length} control-plane suites passed (${elapsed}s)`);
