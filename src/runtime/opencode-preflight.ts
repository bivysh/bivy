// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// OpenCode credential preflight.
//
// `opencode run` boots OpenCode's own internal server and calls the selected
// provider through it. When that provider has no credential, OpenCode does NOT
// surface a clean 401 — its server throws and prints its opaque `NamedError`
// envelope to stdout:
//
//   Error: { "name": "UnknownError", "data": {
//     "message": "Unexpected server error. Check server logs for details.",
//     "ref": "err_25799b27" } }
//
// Bivy relays that verbatim into the agent output, and the `err_` ref points at
// OpenCode's server log — which Bivy doesn't capture — so the user is stuck. Like
// codex-preflight.ts, this backstop detects the missing credential up front (the
// vault handoff in credentials.ts injects each provider's key into the env) and
// returns a clear, actionable message instead of letting OpenCode 500.
//
// It's provider-aware: OpenCode models are `provider/model` ids, so the run's
// selected provider tells us exactly which key var must be present.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiKeyEnvVar } from "./credentials.js";

export interface PreflightContext {
  /** The session's selected model provider (e.g. "openai", "anthropic"), lowercased. */
  provider?: string;
  /** Override for deterministic tests. */
  authPath?: string;
}

function nativeAuthPath(ctx: PreflightContext): string {
  if (ctx.authPath) return ctx.authPath;
  const data = process.env.XDG_DATA_HOME?.trim() || (process.platform === "win32" ? process.env.APPDATA?.trim() : "") || path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "auth.json");
}

/** OpenCode owns an encrypted/on-disk provider login independently of Bivy's
 * env-var vault. Only inspect provider keys — never copy credential values. */
function hasNativeCredential(provider: string, ctx: PreflightContext): boolean {
  try {
    const auth = JSON.parse(fs.readFileSync(nativeAuthPath(ctx), "utf8")) as Record<string, unknown>;
    return Boolean(auth[provider]);
  } catch {
    return false;
  }
}

/** Actionable message shown when OpenCode's selected provider has no credential. */
export function opencodeNoCredentialMessage(provider: string, envVar: string): string {
  const label = provider.charAt(0).toUpperCase() + provider.slice(1);
  return [
    `OpenCode has no ${label} credential on this node, so it can't start a turn — its server would fail with an opaque \`UnknownError: Unexpected server error\` (the \`err_…\` ref points at OpenCode's own server log, which Bivy can't read).`,
    "",
    "Fix it any of these ways:",
    `• Add a ${label} API key under Keys & OAuth — Bivy passes it to OpenCode as ${envVar}, or`,
    "• Pick a different model whose provider you've already connected, or",
    `• Run \`opencode auth login\` on this node to sign in directly.`,
  ].join("\n");
}

/**
 * Returns a human-readable error when OpenCode's selected provider has no usable
 * credential in the resolved environment, or undefined to proceed.
 *
 * Conservative by design: if the provider is unknown (no model selected, or a
 * provider we don't map) we return undefined rather than block a run that might
 * authenticate some other way (e.g. an on-disk `opencode auth` login). Anthropic
 * is additionally satisfied by a Claude Code OAuth token.
 */
export function opencodeCredentialPreflight(
  env: Record<string, string | undefined>,
  ctx: PreflightContext = {},
): string | undefined {
  const provider = ctx.provider?.trim().toLowerCase();
  if (!provider) return undefined;
  // Anthropic can authenticate via the Claude Code OAuth token, not just a key.
  if (provider === "anthropic" && env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return undefined;
  const envVar = apiKeyEnvVar(provider);
  if (env[envVar]?.trim() || hasNativeCredential(provider, ctx)) return undefined;
  return opencodeNoCredentialMessage(provider, envVar);
}
