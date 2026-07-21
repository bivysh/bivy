// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "./secrets.js";
import { createAppJwt } from "./github-app-auth.js";

/**
 * Fetch the app's slug + name from GitHub with an app JWT. The slug is the
 * unique `@`-mention handle; failure is non-fatal (we just skip registration).
 */
async function fetchAppIdentity(appId: string, privateKeyPem: string): Promise<{ slug: string; name: string } | undefined> {
  try {
    const jwt = createAppJwt(appId, privateKeyPem, Math.floor(Date.now() / 1000));
    const res = await fetch("https://api.github.com/app", {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
    });
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => ({}))) as { slug?: string; name?: string };
    return { slug: String(data.slug ?? ""), name: String(data.name ?? data.slug ?? "") };
  } catch {
    return undefined;
  }
}

/**
 * `bivy github:app-connect` — connect a user-owned GitHub App (M2, flavor A).
 *
 * Stores the app's private key in the node vault and the app id in cli.json, then
 * asks the control plane for a `github_app` inbound hook and prints the webhook
 * URL + secret to paste into the app (one webhook covers every installed repo).
 *
 * The private key stays on the node (the node mints its own installation tokens);
 * the control plane only ever holds the webhook signing secret. So a single app
 * install replaces per-repo webhooks without weakening the privacy model.
 *
 * Usage:
 *   bivy github:app-connect --app-id <id> --key <path-to-private-key.pem>
 *                           [--label bivy] [--node-label <name>]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const cliConfigPath = path.join(appDir, "cli.json");
const relayConfigPath = path.join(appDir, "relay.json");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function loadCliConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
  } catch {
    return {};
  }
}

function loadRelayConfig(): { controlPlaneUrl?: string; enrollmentToken?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(relayConfigPath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const appId = (argValue(args, "app-id") || process.env.BIVY_GITHUB_APP_ID || "").trim();
  const keyPath = (argValue(args, "key") || "").trim();
  const baseLabel = (argValue(args, "label") || "bivy").trim();
  const nodeLabelArg = (argValue(args, "node-label") || "").trim();
  const nodeLabel = nodeLabelArg ? (nodeLabelArg.includes("/") ? nodeLabelArg : `bivy/${nodeLabelArg}`) : "";

  if (!appId) throw new Error("Missing --app-id (the GitHub App's numeric App ID).");
  if (!keyPath) throw new Error("Missing --key (path to the app's .pem private key).");
  const privateKeyPem = fs.readFileSync(keyPath, "utf8");
  if (!privateKeyPem.includes("PRIVATE KEY")) throw new Error(`${keyPath} does not look like a PEM private key.`);

  const relay = loadRelayConfig();
  if (!relay?.controlPlaneUrl || !relay?.enrollmentToken) {
    throw new Error("This node isn't enrolled with a control plane. Run 'bivy relay:setup' first.");
  }

  // 1) Private key → node vault (never leaves the machine).
  new SecretVault(appDir).setLocal("github.app-private-key", privateKeyPem, "GitHub App private key");

  // 2) Ask the control plane for an account-scoped github_app inbound hook.
  const res = await fetch(`${relay.controlPlaneUrl.replace(/\/$/, "")}/node/hooks`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.enrollmentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "github_app" }),
  });
  const hook = (await res.json().catch(() => ({}))) as { id?: string; url?: string; secret?: string; error?: string };
  if (!res.ok || !hook.url || !hook.secret) {
    throw new Error(hook.error || `Control plane did not return a hook (${res.status}).`);
  }

  // 2b) Resolve the app's slug (its unique `@`-mention handle) + name and
  // register them so mentions route correctly and the UI shows what's connected.
  const identity = await fetchAppIdentity(appId, privateKeyPem);
  if (hook.id && identity?.slug) {
    await fetch(`${relay.controlPlaneUrl.replace(/\/$/, "")}/node/hooks/${encodeURIComponent(hook.id)}/app-meta`, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.enrollmentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ mention: identity.slug, name: identity.name, appId }),
    }).catch(() => {});
  }

  // 3) Persist config: app id + a secret:// reference (never the raw key).
  const config = loadCliConfig();
  const env = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, string>;
  config.env = {
    ...env,
    BIVY_GITHUB_APP_ID: appId,
    BIVY_GITHUB_APP_PRIVATE_KEY: "secret://github.app-private-key",
    BIVY_GITHUB_HOSTED_TASKS: "1",
    BIVY_GITHUB_LABEL: baseLabel,
    ...(identity?.slug ? { BIVY_GITHUB_APP_SLUG: identity.slug } : {}),
    ...(nodeLabel ? { BIVY_NODE_LABEL: nodeLabel } : {}),
  };
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cliConfigPath, 0o600);
  } catch {
    // best effort
  }

  console.log("\n✓ GitHub App connected. Private key stored in this node's vault (cli.json holds only a secret:// ref).\n");
  console.log("Point the app's webhook at this URL (one webhook covers every installed repo):");
  console.log(`  Payload URL:  ${hook.url}`);
  console.log(`  Secret:       ${hook.secret}`);
  console.log("  Content type: application/json");
  console.log("  Events:       Issues, Issue comment");
  console.log("\nApp permissions needed: Issues (RW), Contents (RW), Pull requests (RW).");
  console.log(`Then install the app on your repos. Work routes to label ${baseLabel}${nodeLabel ? ` / ${nodeLabel}` : ""}.`);
  if (identity?.slug) console.log(`Trigger it from an issue comment with: @${identity.slug} <instruction>`);
  console.log("Restart the node to apply: bivy restart (or bivy start).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
