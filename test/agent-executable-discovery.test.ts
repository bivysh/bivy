// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExecutable } from "../src/executable.js";
import { piCommandAvailable } from "../src/agents/pi/integration.js";
import { codexCommandAvailable } from "../src/agents/codex/integration.js";
import { claudeCliAvailable } from "../src/agents/claude-code/runtime.js";
import { listRuntimes } from "../src/runtime/index.js";
import { RuntimeHost } from "../src/runtime/host.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy discovery "));
const saved = { ...process.env };
try {
  // A literal name containing spaces must work without shell interpolation.
  const name = process.platform === "win32" ? "test agent.cmd" : "test agent";
  const binary = path.join(dir, name);
  process.env.PATH = dir;
  for (const key of ["BIVY_PI_COMMAND", "BIVY_CODEX_BIN", "BIVY_CLAUDE_COMMAND", "BIVY_OPENCLAW_COMMAND"]) {
    process.env[key] = name;
  }
  const probes = [piCommandAvailable, codexCommandAvailable, claudeCliAvailable,
    () => listRuntimes("openclaw").find((agent) => agent.id === "openclaw")?.status === "available"];
  for (const probe of probes) assert.equal(probe(), false);
  const host = new RuntimeHost({ credsDir: dir, piDir: dir, sessionsDir: dir });
  assert.throws(() => host.resolveRuntimeId("openclaw", "pi"), /was not found on PATH/);

  // Installation outside Bivy must take effect without cache invalidation/restart.
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const probe of probes) assert.equal(probe(), true);
  assert.equal(host.resolveRuntimeId("openclaw", "pi"), "openclaw");
  assert.equal(resolveExecutable(binary), binary);
  assert.equal(resolveExecutable(`./${name}`, {}, dir), binary);

  process.env.PATH = "";
  for (const probe of probes) assert.equal(probe(), false);
  process.env.PATH = dir;
  fs.unlinkSync(binary);
  for (const probe of probes) assert.equal(probe(), false);

  fs.mkdirSync(binary);
  assert.equal(resolveExecutable(name), null, "directories are not executable commands");
  fs.rmdirSync(binary);
  if (process.platform !== "win32") {
    fs.writeFileSync(binary, "not executable", { mode: 0o644 });
    assert.equal(resolveExecutable(name), null);
  }
  assert.equal(resolveExecutable(""), null);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("agent executable discovery: passed");
