// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectRepoScope, deviceFlowClientId } from "./github-device-auth.js";
import { SecretVault } from "./secrets.js";

/**
 * `bivy github:connect` — staged repo-scope authorization (C3).
 *
 * Runs GitHub's device flow ON THIS NODE to obtain a `repo`-scoped token (only
 * now, when the user is connecting a repo to the work queue — not at sign-in),
 * and stores it in Bivy's node secret vault, with `.bivy/cli.json`
 * `env.BIVY_GITHUB_TOKEN` holding only a `secret://github.repo-token` reference
 * so both foreground runs and the background service pick it up. The control plane is never
 * involved, so it never sees the token.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const cliConfigPath = path.join(appDir, "cli.json");

function openBrowser(target: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [target], { stdio: "ignore", detached: true });
    // spawn reports a missing opener (e.g. no xdg-open on a headless server)
    // asynchronously via an 'error' event, not a throw. Without a listener that
    // becomes an unhandled error that crashes the process. The URL is printed too.
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort — the URL is also printed
  }
}

function loadCliConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
  } catch {
    return {};
  }
}

function saveToken(token: string, repo?: string): void {
  const config = loadCliConfig();
  const env = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, string>;
  new SecretVault(appDir).setLocal("github.repo-token", token, "GitHub repo/work-queue token");
  env.BIVY_GITHUB_TOKEN = "secret://github.repo-token";
  if (repo) env.BIVY_GITHUB_REPO = repo;
  config.env = env;
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cliConfigPath, 0o600);
  } catch {
    // best effort
  }
}

async function main() {
  const clientId = deviceFlowClientId();
  if (!clientId) {
    console.error("Set BIVY_GITHUB_OAUTH_CLIENT_ID to the GitHub OAuth app (with device flow enabled) before connecting a repo.");
    process.exit(1);
  }
  const repoArg = process.argv.slice(2).find((a) => !a.startsWith("-"));

  console.log("Connecting a GitHub repo grants Bivy push + pull-request access on this machine only.\n");
  const token = await connectRepoScope(clientId, {
    openBrowser,
    onPrompt: ({ userCode, verificationUri }) => {
      console.log(`Open ${verificationUri} and enter this code:\n\n    ${userCode}\n`);
      console.log("Waiting for you to authorize…");
    },
  });
  saveToken(token, repoArg);
  console.log(`\n✓ Authorized. Stored a repo-scoped token in Bivy's local secret vault.`);
  console.log(`  ${cliConfigPath} contains only a secret:// reference.`);
  if (repoArg) console.log(`  Issue pickup is set for ${repoArg}. Restart the node to apply.`);
  else console.log("  Set BIVY_GITHUB_REPO (or re-run with owner/repo) to enable issue pickup.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
