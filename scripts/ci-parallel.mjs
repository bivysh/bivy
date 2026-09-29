#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Run independent CI checks at the same time on one runner.
//
//   node scripts/ci-parallel.mjs "pnpm run lint" "pnpm run typecheck"
//
// On the free plan a workflow can run 20 jobs at once, and each job pays its own
// setup, so several short checks share one lane. Each command runs through the
// shell with its output buffered, and that output is printed as one collapsible
// group when the command exits, so parallel logs never interleave. Exits non-zero
// if any command failed, after all of them have finished.
import { spawn } from "node:child_process";

const commands = process.argv.slice(2);
if (commands.length === 0) {
  process.stderr.write("usage: ci-parallel.mjs <command> [<command> ...]\n");
  process.exit(2);
}

const run = (command) =>
  new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code, signal) => {
      const ok = code === 0;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`::group::${ok ? "✓" : "✗"} ${command} (${seconds}s)\n`);
      process.stdout.write(Buffer.concat(chunks));
      process.stdout.write("::endgroup::\n");
      if (!ok) process.stdout.write(`::error::${command} failed (${signal ?? `exit ${code}`})\n`);
      resolve(ok);
    });
  });

const results = await Promise.all(commands.map(run));
process.exit(results.every(Boolean) ? 0 : 1);
