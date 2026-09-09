// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Shared by terminal setup/update and the daemon's agent installer.
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const [pkg, python, prefix] = process.argv.slice(2);
if (!pkg || !prefix) {
  console.error("Usage: install-python-agent.mjs <package> <python-or-empty> <prefix>");
  process.exit(1);
}
const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.error("Python agent installation requires uv. Install it from https://docs.astral.sh/uv/getting-started/installation/ then re-run 'bivy agents:install'.");
  process.exit(1);
}
const resolvedPrefix = prefix === "~" ? os.homedir() : prefix.startsWith("~/") ? path.join(os.homedir(), prefix.slice(2)) : prefix;
const result = spawnSync("uv", ["tool", "install", ...(python ? ["--python", python] : []), pkg], {
  stdio: "inherit",
  env: { ...process.env, UV_TOOL_BIN_DIR: path.join(resolvedPrefix, "bin") },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
