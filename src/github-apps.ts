// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { resolveSecret } from "./secrets.js";
import type { GitHubAppConfig } from "./github-app-auth.js";

/**
 * Registry of the GitHub Apps this node serves.
 *
 * A GitHub App that is *private* can only be installed on the account that owns
 * it, so one app cannot cover a user's personal repos and their organizations.
 * Making the app public would fix that but hands anyone the ability to enqueue
 * work against the owner's account, so instead a node serves several apps: one
 * private app per GitHub account/org (personal + each org).
 *
 * Every app's private key stays on the node, in the secret vault. The control
 * plane still never holds a repo-capable credential — it only knows each app's
 * id, slug, and webhook secret.
 *
 * Stored at `<dataDir>/github-apps.json`:
 *
 *   { "version": 1, "apps": [ { appId, slug, owner, privateKeyRef, hookId } ] }
 *
 * Private keys are referenced, never inlined: `secret://github.app.<appId>`.
 */

export interface GitHubAppRecord {
  /** Numeric App ID. Primary key. */
  appId: string;
  /** The app's unique slug — its `@`-mention handle. */
  slug?: string;
  /** Human-facing app name. */
  name?: string;
  /** Login of the account that owns the app (a user or an org). */
  owner?: string;
  ownerType?: "User" | "Organization";
  /** `secret://` / `op://` / `env://` reference to the PEM. Never the key itself. */
  privateKeyRef: string;
  /** The control-plane inbound hook carrying this app's webhook secret. */
  hookId?: string;
  addedAt?: string;
}

interface RegistryFile {
  version: number;
  apps: GitHubAppRecord[];
}

const EMPTY: RegistryFile = { version: 1, apps: [] };

function registryPath(dataDir: string): string {
  return path.join(dataDir, "github-apps.json");
}

/** The conventional vault id for an app's private key. */
export function privateKeyIdFor(appId: string): string {
  return `github.app.${appId}`;
}

function readRegistry(dataDir: string): RegistryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), "utf8")) as Partial<RegistryFile>;
    const apps = Array.isArray(raw.apps) ? raw.apps.filter((a) => a && typeof a.appId === "string" && a.appId) : [];
    return { version: typeof raw.version === "number" ? raw.version : 1, apps };
  } catch {
    return { ...EMPTY, apps: [] };
  }
}

function writeRegistry(dataDir: string, file: RegistryFile): void {
  const target = registryPath(dataDir);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Single-app installs configured the node through the environment
 * (`BIVY_GITHUB_APP_ID` + `BIVY_GITHUB_APP_PRIVATE_KEY`). Surface that as a
 * registry entry so the rest of the code only ever deals with a list.
 *
 * Not written to disk: the env vars remain the source of truth for containers
 * and ephemeral runners that are configured purely through the environment.
 */
function recordFromEnv(env: NodeJS.ProcessEnv): GitHubAppRecord | undefined {
  const appId = env.BIVY_GITHUB_APP_ID?.trim();
  if (!appId) return undefined;
  return {
    appId,
    slug: env.BIVY_GITHUB_APP_SLUG?.trim() || undefined,
    privateKeyRef: env.BIVY_GITHUB_APP_PRIVATE_KEY?.trim() || "secret://github.app-private-key",
  };
}

/**
 * Every app this node serves, the registry first and then any env-configured app
 * that isn't already in it. Deduplicated by app id, registry wins.
 */
export function listGitHubApps(dataDir: string, env: NodeJS.ProcessEnv = process.env): GitHubAppRecord[] {
  const apps = readRegistry(dataDir).apps.slice();
  const fromEnv = recordFromEnv(env);
  if (fromEnv && !apps.some((a) => a.appId === fromEnv.appId)) apps.push(fromEnv);
  return apps;
}

/** Add or update an app by id, preserving fields the caller didn't supply. */
export function upsertGitHubApp(dataDir: string, record: GitHubAppRecord): GitHubAppRecord[] {
  const file = readRegistry(dataDir);
  const i = file.apps.findIndex((a) => a.appId === record.appId);
  if (i >= 0) {
    file.apps[i] = { ...file.apps[i], ...record };
  } else {
    file.apps.push({ addedAt: new Date().toISOString(), ...record });
  }
  writeRegistry(dataDir, file);
  return file.apps;
}

/** Remove an app by id. Returns true when something was removed. */
export function removeGitHubApp(dataDir: string, appId: string): boolean {
  const file = readRegistry(dataDir);
  const before = file.apps.length;
  file.apps = file.apps.filter((a) => a.appId !== appId);
  if (file.apps.length === before) return false;
  writeRegistry(dataDir, file);
  return true;
}

/**
 * Resolve each app's private key. Apps whose key can't be resolved (revoked
 * vault entry, missing 1Password item) are dropped rather than throwing — one
 * broken app must not take down the GitHub integration for the others.
 */
export async function loadGitHubAppConfigs(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<GitHubAppConfig & { record: GitHubAppRecord }>> {
  const out: Array<GitHubAppConfig & { record: GitHubAppRecord }> = [];
  for (const record of listGitHubApps(dataDir, env)) {
    const ref = record.privateKeyRef;
    let privateKeyPem: string | undefined;
    try {
      privateKeyPem =
        ref.startsWith("secret://") || ref.startsWith("op://") || ref.startsWith("env://")
          ? await resolveSecret(ref, dataDir)
          : ref;
    } catch {
      privateKeyPem = undefined;
    }
    if (!privateKeyPem || !privateKeyPem.includes("PRIVATE KEY")) continue;
    out.push({ appId: record.appId, privateKeyPem, record });
  }
  return out;
}

/**
 * Pick the order to try apps in when resolving which one covers `owner/repo`.
 * An app owned by the same account as the repo is overwhelmingly the right one,
 * so try it first — that turns the common case into a single API call instead of
 * one per configured app.
 */
export function orderAppsForOwner<T extends { record: GitHubAppRecord }>(apps: T[], owner: string): T[] {
  const lower = owner.toLowerCase();
  return apps.slice().sort((a, b) => {
    const aMatch = a.record.owner?.toLowerCase() === lower ? 0 : 1;
    const bMatch = b.record.owner?.toLowerCase() === lower ? 0 : 1;
    return aMatch - bMatch;
  });
}
