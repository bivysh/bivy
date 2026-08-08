// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unified credential provisioning — one login in Bivy, every agent works.
//
// Bivy holds the single source of truth (the encrypted vault) and *projects* it
// into whatever form each native agent consumes when that agent runs:
//   - env vars (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, …) for agents that
//     read the environment;
//   - a native on-disk store for agents that read their own file (Pi's auth.json,
//     Codex's ~/.codex/auth.json).
// Every projection is refreshed-before-use, so agents receive a fresh access
// token and rarely need to self-refresh — which keeps Bivy the single OAuth
// refresh authority (rotating refresh tokens are single-use; two agents
// refreshing the same credential would invalidate each other).
//
// This is the seam behind `bivy run <agent>`, `bivy shim`, and the chat→native
// TUI hand-off. Claude Code manages its own env projection (claude-code.ts) and
// is intentionally left as-is.

import { createCredentialVault } from "./credential-store.js";
import { buildAgentCredentialEnv, createCredentialStore } from "./credentials.js";
import { ensureCodexAuth, ensureCodexTrusted } from "./codex-auth.js";
import { ensureGrokAuth } from "./grok-auth.js";
import { refreshModelOAuth } from "./oauth/model-oauth.js";
import { isNativeOAuthProvider } from "./oauth/model-oauth-providers.js";

/**
 * Refresh any stored OAuth credential that is already expired, centrally, so a
 * projection hands the agent a fresh access token. No-op for fresh tokens and
 * non-OAuth providers; runs under the store lock (single-flight).
 */
export async function refreshExpiringOAuth(credsDir: string): Promise<void> {
  const infos = await createCredentialVault(credsDir).list().catch(() => []);
  await Promise.all(
    infos
      .filter((info) => info.type === "oauth" && isNativeOAuthProvider(info.providerId))
      .map((info) => refreshModelOAuth(credsDir, info.providerId).catch(() => undefined)),
  );
}

/**
 * Environment variables that project Bivy's unified logins onto an agent
 * process. Refreshes expiring OAuth first. This is how `bivy run <agent>` and
 * the TUI hand-off make one Bivy sign-in serve any agent that reads env vars.
 */
export async function provisionAgentEnv(credsDir: string, providers?: string[]): Promise<Record<string, string>> {
  await refreshExpiringOAuth(credsDir);
  return buildAgentCredentialEnv(createCredentialStore(credsDir), providers);
}

/**
 * Materialize Pi's plaintext auth.json from the shared vault with fresh tokens,
 * for Pi's own CLI/TUI (which reads its file store in `piDir`). Pair with the
 * daemon's auth.json watcher (ingestPlaintext), which folds any TUI-time
 * login/refresh back in.
 */
export async function provisionPiAuthJson(credsDir: string, piDir: string): Promise<void> {
  await refreshExpiringOAuth(credsDir);
  createCredentialVault(credsDir, piDir).materializePlaintext();
}

/**
 * Full projection for a native `bivy run <agent>` launch: env vars for every
 * agent, plus the native on-disk store for agents that need one. Returns the env
 * to set on the PTY (may include CODEX_HOME). `credsDir` is the shared vault;
 * `piDir` is Pi's own dir (used only for Pi's plaintext auth.json).
 */
export async function provisionAgentRun(credsDir: string, piDir: string, agentId?: string, workspace?: string): Promise<Record<string, string>> {
  const env = await provisionAgentEnv(credsDir);
  if (agentId === "pi") {
    await provisionPiAuthJson(credsDir, piDir).catch((error) => {
      console.warn("[provision] pi auth.json materialization failed:", (error as Error).message);
    });
  } else if (agentId === "codex") {
    // Codex reads OPENAI_API_KEY (already in env) or its own auth.json; mint the
    // latter from a connected ChatGPT subscription when present.
    const home = await ensureCodexAuth(credsDir).catch(() => undefined);
    if (home) env.CODEX_HOME = home;
    // Pre-trust the run workspace so Codex doesn't stall on its first-run trust
    // prompt (which blocks it from writing the rollout takeover relies on).
    if (workspace) ensureCodexTrusted(workspace);
  } else if (agentId === "grok") {
    // Official Grok CLI reads XAI_API_KEY/GROK_API_KEY (already in env for api
    // keys) or its own auth.json; mint the latter from a connected SuperGrok /
    // X subscription when present.
    const home = await ensureGrokAuth(credsDir).catch(() => undefined);
    if (home) env.GROK_HOME = home;
  }
  return env;
}
