// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Ingest credentials FROM an agent's own store INTO Bivy's vault.
//
// The reverse of provisioning: when a user logs in inside an agent's native CLI
// (e.g. `codex login`, or a login done in Pi's TUI), Bivy folds that credential
// back into its vault so the one login is unified everywhere. Merge is
// rotation-safe (freshest `expires` wins), so it's safe even when both Bivy and
// the agent have touched the same credential.
//
// Triggered on `bivy run <agent>` terminal exit (server.ts) and by the auth.json
// watcher; each agent contributes a small format adapter here.

import fs from "node:fs";
import path from "node:path";
import { createCredentialVault, type StoredCredential } from "./credential-store.js";
import { resolveCodexHome } from "./codex-auth.js";
import { claudeCredentialFiles } from "./anthropic-preflight.js";

/** Read the `exp` (seconds) claim from a JWT access token → absolute epoch ms. */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Map Codex's `~/.codex/auth.json` into a Bivy credential (provider id → credential). */
export function codexAuthToCredential(raw: unknown): { providerId: string; credential: StoredCredential } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  // API-key mode: `codex login --api-key` writes OPENAI_API_KEY.
  if (typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY.trim()) {
    return { providerId: "openai", credential: { type: "api_key", key: record.OPENAI_API_KEY.trim() } };
  }
  // ChatGPT subscription: the OAuth token set the CLI persists.
  const tokens = record.tokens as Record<string, unknown> | undefined;
  const access = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : "";
  if (!access || !refresh) return undefined;
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
  const expires = jwtExpiryMs(access) ?? Date.now() + 60 * 60 * 1000;
  return {
    providerId: "openai-codex",
    credential: { type: "oauth", access, refresh, expires, ...(accountId ? { accountId } : {}) },
  };
}

/** Fold a login/refresh done in the Codex CLI back into Bivy's vault. Returns imported count. */
export async function ingestCodexCredentials(credsDir: string): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(resolveCodexHome(), "auth.json"), "utf8"));
  } catch {
    return 0; // no Codex login on disk
  }
  const mapped = codexAuthToCredential(raw);
  if (!mapped) return 0;
  return createCredentialVault(credsDir).importAll({ [mapped.providerId]: mapped.credential });
}

/** Map the Claude CLI's `.credentials.json` (`claudeAiOauth`) into a Bivy credential. */
export function claudeAuthToCredential(raw: unknown): { providerId: string; credential: StoredCredential } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const oauth = (raw as Record<string, unknown>).claudeAiOauth as Record<string, unknown> | undefined;
  const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
  const refresh = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  if (!access || !refresh) return undefined;
  // Claude stores `expiresAt` as an absolute epoch-ms timestamp already.
  const expires = Number(oauth?.expiresAt) || Date.now() + 60 * 60 * 1000;
  return { providerId: "anthropic", credential: { type: "oauth", access, refresh, expires } };
}

/** Fold a login done in the Claude CLI (`claude /login`) back into Bivy's vault. */
export async function ingestClaudeCredentials(credsDir: string): Promise<number> {
  for (const file of claudeCredentialFiles()) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // not this path (or macOS Keychain — no file to read)
    }
    const mapped = claudeAuthToCredential(raw);
    if (mapped) return createCredentialVault(credsDir).importAll({ [mapped.providerId]: mapped.credential });
  }
  return 0;
}

/**
 * Ingest an agent's native credential store into Bivy's vault. Called when a
 * `bivy run <agent>` terminal exits, so a login done inside that agent's CLI is
 * captured centrally. Best-effort and per-agent; unknown agents are a no-op.
 *
 * Gemini is intentionally absent: its `~/.gemini` login is a Google account
 * (Code Assist) token, a different auth model from an api key / subscription
 * OAuth Bivy can provision back — folding it in would be misleading.
 */
export async function ingestAgentCredentials(agentId: string | undefined, credsDir: string, piDir: string): Promise<number> {
  switch ((agentId ?? "").toLowerCase()) {
    case "codex":
    case "codex-approvals":
      return ingestCodexCredentials(credsDir);
    case "claude":
    case "claude-code":
    case "claude-code-sdk":
      return ingestClaudeCredentials(credsDir);
    case "pi":
      // Pi's TUI writes a plaintext auth.json in its own dir; fold it back into
      // the shared vault.
      return createCredentialVault(credsDir, piDir).ingestPlaintext();
    default:
      return 0;
  }
}
