// SPDX-License-Identifier: AGPL-3.0-only
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
import { agentNativeLabel, type CredentialRecord } from "../credentials/records.js";
import { loadIngestPolicy, defaultPresetsPath } from "../credentials/presets.js";
import { resolveCodexHome } from "./codex-auth.js";
import { grokAuthEntryKey, resolveGrokHome, GROK_OIDC_ISSUER } from "./grok-auth.js";
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

type MappedCredential = { providerId: string; credential: StoredCredential };

/**
 * Fold one mapped agent-native login into the vault per the node's ingest policy
 * (`credentials.config.json` → `ingest.policy`; default `merge`):
 *  - `merge`: merge into the provider's `default` slot (historical behavior) — a
 *    native login updates the provider's synced Bivy credential, rotation-safe.
 *  - `separate`: land as a distinct, node-local credential under a reserved
 *    agent-derived label (with the account id when the login carries one), so it
 *    never overwrites a Bivy key and is selectable via a preset.
 */
async function foldIngested(credsDir: string, agent: string, mapped: MappedCredential): Promise<number> {
  const store = createCredentialVault(credsDir);
  const policy = loadIngestPolicy(defaultPresetsPath(credsDir));
  if (policy !== "separate") {
    return store.importAll({ [mapped.providerId]: mapped.credential });
  }
  const rawAccount = (mapped.credential as Record<string, unknown>).accountId;
  const accountId = typeof rawAccount === "string" ? rawAccount : undefined;
  const record: CredentialRecord = {
    provider: mapped.providerId,
    label: agentNativeLabel(agent, accountId),
    source: { kind: "stored", cred: mapped.credential },
    origin: "agent-native",
    sync: "node",
  };
  return store.importRecords([record]);
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
  return foldIngested(credsDir, "codex", mapped);
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
    if (mapped) return foldIngested(credsDir, "claude", mapped);
  }
  return 0;
}

/** Map the official Grok CLI's `~/.grok/auth.json` OIDC entry into a Bivy credential. */
export function grokAuthToCredential(raw: unknown): { providerId: string; credential: StoredCredential } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  // Prefer the known xAI OIDC entry key; fall back to the first oidc entry whose
  // issuer is auth.x.ai (covers a client-id change without breaking ingest).
  const preferredKey = grokAuthEntryKey();
  let entry = record[preferredKey] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") {
    for (const value of Object.values(record)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Record<string, unknown>;
      if (candidate.oidc_issuer === GROK_OIDC_ISSUER || candidate.auth_mode === "oidc") {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return undefined;
  const access = typeof entry.key === "string" ? entry.key : "";
  const refresh = typeof entry.refresh_token === "string" ? entry.refresh_token : "";
  if (!access || !refresh) return undefined;
  const expiresFromField = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  const expires = Number.isFinite(expiresFromField) && expiresFromField > 0
    ? expiresFromField
    : (jwtExpiryMs(access) ?? Date.now() + 60 * 60 * 1000);
  return { providerId: "xai", credential: { type: "oauth", access, refresh, expires } };
}

/** Fold a login/refresh done in the Grok CLI back into Bivy's vault. */
export async function ingestGrokCredentials(credsDir: string): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(resolveGrokHome(), "auth.json"), "utf8"));
  } catch {
    return 0; // no Grok login on disk
  }
  const mapped = grokAuthToCredential(raw);
  if (!mapped) return 0;
  return foldIngested(credsDir, "grok", mapped);
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
    case "grok":
      return ingestGrokCredentials(credsDir);
    case "pi":
      // Pi's TUI writes a plaintext auth.json in its own dir; fold it back into
      // the shared vault.
      return createCredentialVault(credsDir, piDir).ingestPlaintext();
    default:
      return 0;
  }
}
