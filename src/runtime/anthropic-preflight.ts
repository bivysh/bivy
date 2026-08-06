// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Anthropic (Claude Code SDK) credential preflight + auth-error phrasing.
//
// The Claude Agent SDK authenticates via `ANTHROPIC_API_KEY`, a Claude
// Pro/Max subscription token (`CLAUDE_CODE_OAUTH_TOKEN`), or the `claude` CLI's
// own on-disk login. Bivy's shared vault forwards whichever Anthropic credential
// the node holds (see credentials.ts / claude-code.ts's resolveCredentialEnv),
// but when the node has none, the SDK spawns and its very first request fails
// with an opaque upstream `unexpected status 401 Unauthorized: …`.
//
// This module detects the no-credential state up front so Bivy can surface a
// clear, actionable message instead of the raw 401, and phrases any auth failure
// that still slips through (expired token, revoked key) with the same guidance.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isModelAuthError } from "./auth-errors.js";

export interface AnthropicPreflightDeps {
  /** Existence check (injectable for tests). Defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Home directory (injectable for tests). Defaults to os.homedir(). */
  home?: string;
  /** CLAUDE_CONFIG_DIR override (injectable for tests). Defaults to the env var. */
  configDir?: string;
  /** Platform (injectable for tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** Candidate paths for the `claude` CLI's own stored login (`.credentials.json`). */
export function claudeCredentialFiles(deps: AnthropicPreflightDeps = {}): string[] {
  const home = deps.home ?? os.homedir();
  const dirs = [deps.configDir ?? process.env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")]
    .filter((d): d is string => Boolean(d && d.trim()));
  return dirs.map((d) => path.join(d, ".credentials.json"));
}

/** How to fix a missing/invalid Anthropic credential — shared by both messages. */
const ANTHROPIC_AUTH_FIX = [
  "• Add an Anthropic API key or sign in with Claude under Models & providers, or",
  "• Run `claude` on this node and use `/login` to sign in with your Claude subscription.",
].join("\n");

/** Shown when the node has no Anthropic credential at all (preflight block). */
export const ANTHROPIC_NO_CREDENTIAL_MESSAGE = [
  "Claude Code has no Anthropic credential on this node, so it can't start a turn — it would fail with `401 Unauthorized`.",
  "",
  "Sign in one of these ways, then start the session again:",
  ANTHROPIC_AUTH_FIX,
].join("\n");

/** Appended to a raw auth failure that surfaced from the SDK despite a credential. */
export const ANTHROPIC_AUTH_HINT = ["This looks like an authentication failure.", ANTHROPIC_AUTH_FIX].join("\n");

/**
 * Whether the Claude Code SDK will find a usable Anthropic credential given the
 * environment it will run with. True when an API key or OAuth token is in the
 * env, or the `claude` CLI has a login on disk. On macOS the CLI login lives in
 * the Keychain (no inspectable file), so this returns true there rather than
 * risk false-blocking a working login — the SDK falls back to its own auth.
 */
export function hasAnthropicCredential(env: Record<string, string | undefined>, deps: AnthropicPreflightDeps = {}): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return true;
  const exists = deps.fileExists ?? ((p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  return claudeCredentialFiles(deps).some(exists);
}

/**
 * Returns an actionable error when the Claude Code SDK has no usable Anthropic
 * credential, or undefined when one is present so the turn should proceed.
 */
export function anthropicCredentialPreflight(env: Record<string, string | undefined>, deps: AnthropicPreflightDeps = {}): string | undefined {
  return hasAnthropicCredential(env, deps) ? undefined : ANTHROPIC_NO_CREDENTIAL_MESSAGE;
}

/** True when a raw error string looks like an Anthropic auth failure (401 etc.). */
export function isAnthropicAuthError(raw: string): boolean {
  return isModelAuthError(raw);
}

/** Outcome of a live provider probe (B1). `probed: false` means access could not
 *  be validated safely (no API key to test, or the network/endpoint was
 *  unreachable) — the caller should fall back to presence and NOT treat this as
 *  a rejection. `probed: true` carries an authoritative `ok`. */
export interface ModelAccessProbe {
  probed: boolean;
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * Safely validate that an Anthropic API key actually grants access, rather than
 * trusting mere presence (B1). Uses `GET /v1/models` — an authenticated, read-only,
 * zero-token endpoint — so it never spends inference budget or mutates anything.
 *
 * Only API keys (`sk-…`) are probed: OAuth subscription tokens and the `claude`
 * CLI's on-disk/Keychain login have no comparably safe check, so for those we
 * return `{ probed: false, ok: true }` and let presence stand. Any non-auth
 * failure (network down, 5xx, timeout) is also `probed: false` — we only report
 * `ok: false` when the provider affirmatively rejects the credential (401/403).
 */
export async function probeAnthropicAccess(
  apiKey: string | undefined,
  deps: { fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string } = {},
): Promise<ModelAccessProbe> {
  const key = apiKey?.trim();
  // Subscription/OAuth tokens are not API keys; there is no safe read probe.
  if (!key || !key.startsWith("sk-")) return { probed: false, ok: true, reason: "no API key to probe" };

  const doFetch = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 4000);
  try {
    const res = await doFetch(`${base}/v1/models?limit=1`, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
    });
    if (res.ok) return { probed: true, ok: true, status: res.status };
    if (res.status === 401 || res.status === 403) {
      return { probed: true, ok: false, status: res.status, reason: `Anthropic rejected the credential (${res.status})` };
    }
    // 429/5xx/etc. — the key may be fine; don't falsely fail readiness.
    return { probed: false, ok: true, status: res.status, reason: `inconclusive (${res.status})` };
  } catch (error) {
    return { probed: false, ok: true, reason: error instanceof Error ? error.message : "probe failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Phrase an SDK error for the user: an auth failure gets the sign-in guidance
 * appended; anything else is returned unchanged.
 */
export function describeAnthropicError(raw: string): string {
  const text = raw.trim() || "Claude Code error";
  return isAnthropicAuthError(text) ? `${text}\n\n${ANTHROPIC_AUTH_HINT}` : text;
}
