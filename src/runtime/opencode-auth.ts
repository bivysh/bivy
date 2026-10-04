// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// OpenCode credential projection.
//
// A subscription a user connects inside Bivy (a ChatGPT plan, stored in the
// vault as `openai-codex`) should serve OpenCode too, without a separate
// `opencode auth login`. OpenCode reads its logins from `auth.json`, or, when
// set, from OPENCODE_AUTH_CONTENT, which REPLACES that file for the process. So
// the projection is the user's own auth.json plus any vault subscription it
// lacks, handed over in that env var. The user's file is never written and
// their own logins always win.
//
// The refresh token is withheld. OpenAI rotates it on every grant, so an
// OpenCode refresh would invalidate the vault's copy for Codex and Pi. OpenCode
// gets the access token Bivy keeps fresh; a later launch projects a new one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "./credential-store.js";
import { refreshExpiringOAuth } from "./credential-provisioning.js";

/** Vault OAuth provider -> the provider key OpenCode's auth.json uses for it. */
const OPENCODE_SUBSCRIPTIONS: Array<{ vault: string; opencode: string }> = [
  { vault: "openai-codex", opencode: "openai" },
];

/** OpenCode's auth.json, resolved the way the CLI resolves it. */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME?.trim() || (process.platform === "win32" ? env.APPDATA?.trim() : "") || path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "auth.json");
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `{ OPENCODE_AUTH_CONTENT }` carrying the user's OpenCode logins plus each
 * Bivy-connected subscription they don't already have, or `{}` when there is
 * nothing to add (OpenCode then reads its own file as usual).
 */
export async function opencodeAuthEnv(credsDir: string, authPath = opencodeAuthPath()): Promise<Record<string, string>> {
  const native = readJsonObject(authPath);
  const missing = OPENCODE_SUBSCRIPTIONS.filter((row) => !native[row.opencode]);
  if (!missing.length) return {};
  await refreshExpiringOAuth(credsDir).catch(() => undefined);
  const vault = createCredentialVault(credsDir);
  const projected: Record<string, unknown> = {};
  for (const row of missing) {
    const cred = (await vault.read(row.vault).catch(() => undefined)) as Record<string, unknown> | undefined;
    if (cred?.type !== "oauth" || typeof cred.access !== "string" || !cred.access) continue;
    projected[row.opencode] = {
      type: "oauth",
      access: cred.access,
      refresh: "",
      expires: typeof cred.expires === "number" ? cred.expires : 0,
      ...(typeof cred.accountId === "string" && cred.accountId ? { accountId: cred.accountId } : {}),
    };
  }
  if (!Object.keys(projected).length) return {};
  return { OPENCODE_AUTH_CONTENT: JSON.stringify({ ...native, ...projected }) };
}
