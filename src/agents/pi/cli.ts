#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Compatibility launcher for npm scripts and older service configurations.
// It delegates to the operator-installed Pi command without replacing Pi's
// auth/config directory or selecting a bundled private executable.
import { spawn } from "node:child_process";

const command = process.env.BIVY_PI_COMMAND?.trim() || "pi";
const child = spawn(command, process.argv.slice(2), {
  cwd: process.env.BIVY_WORKSPACE || process.cwd(),
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
child.on("error", (error) => {
  console.error(`Failed to start the operator-installed Pi command (${command}).`, error);
  process.exit(1);
});
