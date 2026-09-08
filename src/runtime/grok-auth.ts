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

/** Decode a JWT payload without verifying its signature (best-effort). */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The xAI user id the Grok CLI records as `user_id` in each auth.json entry —
 * the OIDC subject (`sub`) of the access token (falling back to `principal_id`).
 * The current Grok CLI (1.x) rejects an auth.json entry that is *missing* this
 * field (serde: "missing field `user_id`"), so a minted file without it cannot
 * be parsed — Grok then can't authenticate or self-refresh and silently
 * produces empty turns. Bivy's `xai` vault record only stores {access, refresh,
 * expires}, so we recover the id from the access token's own claims.
 */
export function grokUserIdFromAccessToken(access: string): string | undefined {
  const claims = decodeJwtClaims(access);
  if (!claims) return undefined;
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (sub) return sub;
  const principal = typeof claims.principal_id === "string" ? claims.principal_id.trim() : "";
  return principal || undefined;
}

/**
 * Whether an existing auth.json entry for our scope is parseable by the current
 * Grok CLI. An entry written by an older Bivy (or hand-rolled) that lacks a
 * non-empty `user_id` cannot be loaded — leaving it in place guarantees a
 * broken, unauthenticated session, so those are re-minted rather than kept.
 */
function grokEntryIsHealthy(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const userId = (entry as Record<string, unknown>).user_id;
  return typeof userId === "string" && userId.trim().length > 0;
}

function readGrokAuthJson(authFile: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure the Grok CLI has a usable credential file, minting one from Bivy's
 * vault when needed. Returns the resolved `GROK_HOME` (so the caller can pin it
 * on the subprocess env) or `undefined` when there's nothing to do / no vault
 * credential — in which case the caller's preflight surfaces the actionable
 * "no credential" error unchanged.
 *
 * Idempotent and low-churn: a *parseable* existing entry for our scope (a native
 * `grok login` or a prior materialization) is left untouched — Grok owns and
 * self-refreshes it. The one exception is a legacy entry that the current Grok
 * CLI can no longer parse (missing `user_id`): leaving that in place guarantees
 * a silently-unauthenticated session, so it is re-minted from the vault (other
 * scopes in the file are preserved). We write to the *default* Grok home (never
 * a throwaway dir) so sessions stay where the CLI already looks.
 */
export async function ensureGrokAuth(credsDir: string): Promise<string | undefined> {
  const grokHome = resolveGrokHome();
  const authFile = path.join(grokHome, "auth.json");

  const provider = getModelOAuthProvider("xai");
  if (!provider) return fs.existsSync(authFile) ? grokHome : undefined;
  const entryKey = grokAuthEntryKey(provider.clientId);

  // A parseable entry for our scope is Grok's to own and refresh — never clobber
  // it. Only an absent file or a legacy entry the current CLI can't load (no
  // `user_id`) falls through to (re)minting below.
  const existingJson = fs.existsSync(authFile) ? readGrokAuthJson(authFile) : undefined;
  if (existingJson && grokEntryIsHealthy(existingJson[entryKey])) return grokHome;

  // An API key authenticates Grok directly (preflight / env projection) — no
  // auth.json needed. Only skip minting when we have no OAuth entry to heal.
  if (process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim()) {
    return fs.existsSync(authFile) ? grokHome : undefined;
  }

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

  // The current Grok CLI requires `user_id` on every entry; recover it from the
  // access token's OIDC claims. Without it the file is unparseable and useless,
  // so surface the honest "no credential" state (undefined) rather than writing
  // a file Grok will silently reject.
  const userId = grokUserIdFromAccessToken(access);
  if (!userId) return fs.existsSync(authFile) ? grokHome : undefined;

  const expiresMs = Number(cred.expires) || 0;
  const entry: Record<string, unknown> = {
    key: access,
    user_id: userId,
    auth_mode: "oidc",
    create_time: new Date().toISOString(),
    refresh_token: refresh,
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: provider.clientId,
  };
  if (expiresMs > 0) entry.expires_at = new Date(expiresMs).toISOString();

  // Preserve any other scopes already present (e.g. a native login for a
  // different client id) — replace only our own entry.
  const authJson = { ...(existingJson ?? {}), [entryKey]: entry };

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
