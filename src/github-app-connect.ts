// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { SecretVault } from "./secrets.js";
import { resolveDataDir } from "./data-dir.js";
import { privateKeyIdFor, upsertGitHubApp } from "./github-apps.js";
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
 * URL + secret to paste into the app (one webhook covers every repo that app is
 * installed on). A node may hold several apps — a private app only installs on
 * the account that owns it, so personal repos and each org need one app each.
 *
 * The private key stays on the node (the node mints its own installation tokens);
 * the control plane only ever holds the webhook signing secret. So a single app
 * install replaces per-repo webhooks without weakening the privacy model.
 *
 * Usage:
 *   bivy github:app-connect --app-id <id> --key <path-to-private-key.pem>
 *                           [--label bivy] [--node-label <name>]
 */

const appDir = resolveDataDir();
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

  // 1) Private key → node vault (never leaves the machine). Keyed per app, so a
  // node can hold several apps' keys side by side (personal account + orgs).
  const keyId = privateKeyIdFor(appId);
  new SecretVault(appDir).setLocal(keyId, privateKeyPem, `GitHub App private key (${appId})`);

  // 2) Reuse this app's existing hook if it has one (so its already-configured
  // webhook keeps working), otherwise ask for a new one. Each app needs its own:
  // the hook's secret is what GitHub signs that app's deliveries with.
  const existing = await fetch(
    `${relay.controlPlaneUrl.replace(/\/$/, "")}/node/hooks/github_app?appId=${encodeURIComponent(appId)}`,
    { headers: { authorization: `Bearer ${relay.enrollmentToken}` } },
  )
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined);
  const res = existing?.id && existing?.url && existing?.secret
    ? new Response(JSON.stringify(existing), { status: 200, headers: { "content-type": "application/json" } })
    : await fetch(`${relay.controlPlaneUrl.replace(/\/$/, "")}/node/hooks`, {
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

  // 3) Record the app in the node's registry (app id + a secret:// reference,
  // never the raw key). The registry is what lets one node serve several apps;
  // the env block below only ever describes one, and is kept for container and
  // ephemeral setups configured purely through the environment.
  upsertGitHubApp(appDir, {
    appId,
    slug: identity?.slug,
    name: identity?.name,
    privateKeyRef: `secret://${keyId}`,
    hookId: hook.id,
  });
  const config = loadCliConfig();
  const env = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, string>;
  config.env = {
    ...env,
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
  console.log("Point the app's webhook at this URL (one webhook covers every repo this app is installed on):");
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
