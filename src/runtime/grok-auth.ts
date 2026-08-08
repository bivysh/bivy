// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Grok (xAI CLI) credential materialization.
//
// An xAI SuperGrok / X subscription a user connects *inside Bivy* lands in the
// shared node vault as an `xai` OAuth record. The official Grok CLI
// (`curl -fsSL https://x.ai/cli/install.sh | bash`) cannot read that vault — it
// authenticates from `XAI_API_KEY` / `GROK_API_KEY` or its own
// `$GROK_HOME/auth.json` (the file `grok login` writes). This module bridges the
// gap: it mints the file Grok expects from the vault record, so a subscription
// connected in Bivy "just works" for the Grok agent with no separate
// `grok login`.
//
// Why it's sound: Bivy's `xai` OAuth app IS the Grok CLI's own OAuth app
// (identical client_id `b1a00492-…`, token endpoint, and scopes including
// `grok-cli:access` — verified against @earendil-works/pi-ai and the shipped
// grok binary), so tokens minted through Bivy are accepted by Grok's backend.
// The vault already stores {access, refresh, expires}; we write them in the
// shape Grok's auth.json uses for OIDC sessions.
//
// Rotation note: xAI does *not* rotate the refresh token on every grant
// (`refreshRotates: false` in model-oauth-providers), so minting is safe even
// if Grok later self-refreshes — the vault's refresh token stays valid. We mint
// only when no auth.json exists yet (Grok then owns and self-refreshes it),
// matching the Codex materialization policy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "./credential-store.js";
import { getModelOAuthProvider } from "./oauth/model-oauth-providers.js";
import { refreshModelOAuth } from "./oauth/model-oauth.js";

/** xAI OIDC issuer the official Grok CLI keys its auth.json entry on. */
export const GROK_OIDC_ISSUER = "https://auth.x.ai";

/** Resolve Grok's home dir exactly as the CLI does (`GROK_HOME` or `~/.grok`). */
export function resolveGrokHome(): string {
  return process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
}

/** Map key Grok uses for the xAI OIDC session inside auth.json. */
export function grokAuthEntryKey(clientId?: string): string {
  const id = clientId?.trim() || getModelOAuthProvider("xai")?.clientId || "";
  return `${GROK_OIDC_ISSUER}::${id}`;
}

/**
 * Ensure the Grok CLI has a usable credential file, minting one from Bivy's
 * vault when needed. Returns the resolved `GROK_HOME` (so the caller can pin it
 * on the subprocess env) or `undefined` when there's nothing to do / no vault
 * credential — in which case the caller's preflight surfaces the actionable
 * "no credential" error unchanged.
 *
 * Idempotent and low-churn: if an `auth.json` already exists (a native
 * `grok login` or a prior materialization) it is left untouched — Grok owns and
 * self-refreshes it — so we mint at most once. We write to the *default* Grok
 * home (never a throwaway dir) so sessions stay where the CLI already looks.
 */
export async function ensureGrokAuth(credsDir: string): Promise<string | undefined> {
  const grokHome = resolveGrokHome();
  const authFile = path.join(grokHome, "auth.json");

  // Never clobber an existing login (native or previously materialized); Grok
  // owns and refreshes it. An API key, if present, is handled by preflight /
  // env projection — no auth.json needed.
  if (fs.existsSync(authFile)) return grokHome;
  if (process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim()) return undefined;

  const provider = getModelOAuthProvider("xai");
  if (!provider) return undefined;

  // Ensure the vault access token is still live before we project it. No-op when
  // fresh; refreshes under the store lock when expired. Failure leaves the vault
  // alone and we fall through to the (likely still-stale) read below.
  await refreshModelOAuth(credsDir, "xai").catch(() => undefined);

  const store = createCredentialVault(credsDir);
  const cred = await store.read("xai").catch(() => undefined);
  if (!cred || cred.type !== "oauth") return undefined;

  const access = typeof cred.access === "string" ? cred.access : "";
  const refresh = typeof cred.refresh === "string" ? cred.refresh : "";
  if (!access || !refresh) return undefined;

  const expiresMs = Number(cred.expires) || 0;
  const entryKey = grokAuthEntryKey(provider.clientId);
  const entry: Record<string, unknown> = {
    key: access,
    auth_mode: "oidc",
    create_time: new Date().toISOString(),
    refresh_token: refresh,
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: provider.clientId,
  };
  if (expiresMs > 0) entry.expires_at = new Date(expiresMs).toISOString();

  const authJson = { [entryKey]: entry };

  try {
    fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
    const tmp = `${authFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(authJson, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, authFile);
  } catch {
    return undefined;
  }
  return grokHome;
}
