// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Codex credential materialization.
//
// A ChatGPT/Codex subscription a user connects *inside Bivy* lands in the shared
// node vault as an `openai-codex` OAuth record. The Codex CLI can't
// read that vault — it authenticates from `OPENAI_API_KEY` or its own
// `$CODEX_HOME/auth.json` (the file `codex login` writes). This module bridges the
// gap: it mints the file Codex expects from the vault record, so a subscription
// connected in Bivy "just works" for Codex with no separate `codex login`.
//
// Why it's sound: Pi's `openai-codex` OAuth app IS the Codex CLI's own OAuth app
// (identical client_id, token endpoint, and scopes — verified against the codex
// binary), so tokens minted through Bivy are accepted by Codex's backend. The
// vault stores {access, refresh, expires, accountId} but NOT the `id_token`
// Codex's auth.json requires; we recover it with a `refresh_token` grant. The
// original grant used `scope=openid`, so the refresh response carries a fresh
// `id_token` — the same call Codex itself makes to refresh.
//
// Rotation note: OpenAI rotates the refresh token on every grant, so we persist
// the rotated token back to the vault. We mint only when no auth.json exists yet
// (Codex then owns and self-refreshes it), which keeps churn to a single grant.
// The residual edge case — Codex self-refreshing later invalidates the vault's
// copy for *other* `openai-codex` consumers — is documented; for the common case
// (the subscription was connected for Codex) there are no other consumers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "./credential-store.js";

// Codex's own OAuth app — verified identical to the app Pi's `openai-codex` login
// uses, so a refresh grant minted here is honored by Codex's backend.
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Resolve Codex's home dir exactly as the CLI (and our rollout reader) does. */
export function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/**
 * Pre-trust a workspace in Codex's `config.toml` so a `bivy run codex` launched
 * there doesn't stall on the first-run "Do you trust the contents of this
 * directory?" gate — which, unanswered, blocks Codex before it writes a rollout
 * (and so blocks "continue as chat" takeover, which resumes by that rollout id).
 *
 * We only ADD a missing `[projects."<path>"]` trust entry; we never rewrite or
 * downgrade an existing one (a user may have deliberately set a different level).
 * Best-effort and idempotent: any failure just leaves the interactive prompt in
 * place, exactly as before. Mirrors what choosing "Yes, continue" would persist.
 */
export function ensureCodexTrusted(workspace: string): void {
  const dir = workspace?.trim();
  if (!dir) return;
  try {
    const codexHome = resolveCodexHome();
    const configFile = path.join(codexHome, "config.toml");
    let existing = "";
    try {
      existing = fs.readFileSync(configFile, "utf8");
    } catch { /* no config yet — we'll create one */ }
    // TOML basic-string key: escape backslashes and double quotes.
    const escaped = dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const header = `[projects."${escaped}"]`;
    // Already has a table header for this exact path → leave its trust_level be.
    if (existing.split(/\r?\n/).some((line) => line.trim() === header)) return;
    const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
    const block = `${prefix}\n${header}\ntrust_level = "trusted"\n`;
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.appendFileSync(configFile, block);
  } catch { /* best effort — an untrusted prompt is a soft failure, not a hard one */ }
}

interface RefreshedTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Exchange a refresh token for a fresh token set (incl. the `id_token`). */
async function refreshCodexTokens(refreshToken: string): Promise<RefreshedTokens | undefined> {
  let res: Response;
  try {
    res = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const idToken = typeof j.id_token === "string" ? j.id_token : "";
  const accessToken = typeof j.access_token === "string" ? j.access_token : "";
  const refreshTok = typeof j.refresh_token === "string" ? j.refresh_token : "";
  const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 0;
  if (!idToken || !accessToken || !refreshTok) return undefined;
  return { idToken, accessToken, refreshToken: refreshTok, expiresIn };
}

/**
 * Ensure the Codex CLI has a usable credential file, minting one from Bivy's
 * vault when needed. Returns the resolved `CODEX_HOME` (so the caller can pin it
 * on the subprocess env) or `undefined` when there's nothing to do / no vault
 * credential — in which case the caller's preflight surfaces the actionable
 * "no credential" error unchanged.
 *
 * Idempotent and low-churn: if an `auth.json` already exists (a native
 * `codex login` or a prior materialization) it is left untouched — Codex owns and
 * self-refreshes it — so we mint at most once. We write to the *default* Codex
 * home (never a throwaway dir) so Codex's rollouts stay where the session reader
 * looks.
 */
export async function ensureCodexAuth(credsDir: string): Promise<string | undefined> {
  const codexHome = resolveCodexHome();
  const authFile = path.join(codexHome, "auth.json");

  // Never clobber an existing login (native or previously materialized); Codex
  // owns and refreshes it. An OPENAI_API_KEY, if present, is handled by preflight.
  if (fs.existsSync(authFile)) return codexHome;
  if (process.env.OPENAI_API_KEY?.trim()) return undefined;

  const store = createCredentialVault(credsDir);
  const cred = await store.read("openai-codex").catch(() => undefined);
  if (!cred || cred.type !== "oauth" || typeof cred.refresh !== "string" || !cred.refresh) return undefined;

  const refreshed = await refreshCodexTokens(cred.refresh);
  if (!refreshed) return undefined;

  // Persist the rotated refresh token back to the vault FIRST — OpenAI rotates it
  // on every grant, so the previous one is now dead. If we can't persist it, bail
  // rather than strand the vault on a token we've just invalidated.
  try {
    await store.modify("openai-codex", async (current) => ({
      ...(current ?? cred),
      type: "oauth",
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken,
      expires: Date.now() + refreshed.expiresIn * 1000,
    }));
  } catch {
    return undefined;
  }

  const accountId = typeof cred.accountId === "string" ? cred.accountId : undefined;
  const authJson = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: refreshed.idToken,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const tmp = `${authFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(authJson, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, authFile);
  } catch {
    return undefined;
  }
  return codexHome;
}
