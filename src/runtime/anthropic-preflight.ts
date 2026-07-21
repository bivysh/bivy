// SPDX-License-Identifier: FSL-1.1-ALv2
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
  return /\b401\b|unauthorized|authentication|invalid x-api-key|(missing|invalid).*(bearer|api[\s_-]?key|token)/i.test(raw);
}

/**
 * Phrase an SDK error for the user: an auth failure gets the sign-in guidance
 * appended; anything else is returned unchanged.
 */
export function describeAnthropicError(raw: string): string {
  const text = raw.trim() || "Claude Code error";
  return isAnthropicAuthError(text) ? `${text}\n\n${ANTHROPIC_AUTH_HINT}` : text;
}
