// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cliInstallSpec } from "../src/runtime/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "python-agent-"));
try {
  const spec = cliInstallSpec("aider", path.join(dir, "prefix with spaces"))!;
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.display, "uv tool install --python 3.12 aider-chat");
  const env = { ...process.env, PATH: dir };
  const missing = spawnSync(spec.command, spec.args, { env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires uv/);
  fs.writeFileSync(path.join(dir, "uv"), `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$UV_TOOL_BIN_DIR" "$@"
exit "\${TEST_UV_EXIT:-0}"
`, { mode: 0o755 });
  const installed = spawnSync(spec.command, spec.args, { env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(installed.stdout.trim().split("\n"), [path.join(dir, "prefix with spaces", "bin"), "tool", "install", "--python", "3.12", "aider-chat"]);
  const failed = spawnSync(spec.command, spec.args, { env: { ...env, TEST_UV_EXIT: "7" } });
  assert.equal(failed.status, 7);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("python-agent-install: all tests passed");
