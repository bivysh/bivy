// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provisionPiAuthJson } from "./runtime/credential-provisioning.js";
import { resolveDataDir } from "./data-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// Honor the same overrides as the daemon so packaged/release builds can point
// at a writable data dir and the bundled pi CLI. Defaults match running from source.
const dataDir = resolveDataDir();
const piDir = path.join(dataDir, "pi");
// The shared, agent-neutral credential vault (not inside any agent's dir).
const credsDir = path.join(dataDir, "credentials");
const piCli =
  process.env.BIVY_PI_CLI ??
  path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const workspace = process.env.BIVY_WORKSPACE ?? repoRoot;
const args = process.argv.slice(2);

// Pi's CLI reads its plaintext auth.json; project Bivy's vault (refreshed) so the
// shared logins are available to the native pi command. Best-effort.
await provisionPiAuthJson(credsDir, piDir).catch(() => {});

const child = spawn(process.execPath, [piCli, ...args], {
  cwd: workspace,
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: piDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("Failed to start terminal agent.", error);
  process.exit(1);
});
