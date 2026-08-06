// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listGitHubApps } from "./github-apps.js";

/**
 * `bivy github:app-sync [on|off]` (issue #88) — opt this node in or out of
 * cross-node GitHub App private-key sync.
 *
 * Off by default: a GitHub App key is a repo-write credential, so widening
 * which nodes hold it is a deliberate, per-node decision (see the "Design
 * decisions" section of issue #88), not automatic like model/provider auth
 * sync. Turning sync ON on two or more nodes lets a `github:app-connect` done
 * on ONE of them reach the others automatically, E2E-encrypted, without
 * re-uploading the `.pem` anywhere — see docs/credential-sync.md.
 *
 * The flag itself lives in cli.json's env block (BIVY_GITHUB_APP_SYNC), the
 * same place every other node-level feature flag lives (e.g.
 * BIVY_GITHUB_HOSTED_TASKS) — `bin/bivy.mjs` spreads that block into the
 * daemon's environment on start/service-install, so this only takes effect
 * after `bivy restart`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const cliConfigPath = path.join(appDir, "cli.json");

function loadCliConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
  } catch {
    return {};
  }
}

function saveCliConfig(config: Record<string, any>): void {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cliConfigPath, 0o600);
  } catch {
    // best effort
  }
}

function isEnabled(config: Record<string, any>): boolean {
  return String(config.env?.BIVY_GITHUB_APP_SYNC ?? "").trim() === "1";
}

function printStatus(config: Record<string, any>): void {
  const enabled = isEnabled(config);
  console.log(`GitHub App key sync: ${enabled ? "ON" : "OFF"} on this node.`);
  const apps = listGitHubApps(appDir);
  if (apps.length) {
    console.log("\nApps this node holds a key for:");
    for (const app of apps) console.log(`  - ${app.slug ? `@${app.slug}` : app.appId} (${app.appId})`);
  }
  console.log(enabled
    ? "\nThis node pushes the apps above (E2E-encrypted) for other opted-in nodes to pull, and pulls apps connected elsewhere on the account."
    : "\nRun 'bivy github:app-sync on' to let this node send/receive GitHub App keys with the account's other opted-in nodes.");
}

async function main() {
  const arg = (process.argv[2] || "").trim().toLowerCase();
  const config = loadCliConfig();

  if (!arg || arg === "status") {
    printStatus(config);
    return;
  }
  if (arg !== "on" && arg !== "off") {
    console.error(`Usage: bivy github:app-sync [on|off]\n(no argument prints the current status)`);
    process.exit(1);
    return;
  }

  const env = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, string>;
  if (arg === "on") {
    config.env = { ...env, BIVY_GITHUB_APP_SYNC: "1" };
    console.log("✓ GitHub App key sync enabled on this node.");
    console.log("  Every GitHub App connected here (github:app-connect) will be pushed, E2E-encrypted, for the");
    console.log("  account's other opted-in nodes to pull — and this node will pull apps connected elsewhere.");
  } else {
    const { BIVY_GITHUB_APP_SYNC: _drop, ...rest } = env;
    config.env = rest;
    console.log("✓ GitHub App key sync disabled on this node.");
    console.log("  Keys already imported here are NOT deleted; this only stops future pushes/pulls.");
  }
  saveCliConfig(config);
  console.log("\nRestart the node to apply: bivy restart (or bivy start).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
