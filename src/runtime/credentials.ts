// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Shared credential resolver for agent env injection.
//
// A node-level resolver so every agent runtime can reuse the model-provider
// logins the user did once, instead of re-authenticating per agent. It reads
// Bivy's own credential store (credential-store.ts) DIRECTLY — api keys and
// non-expired OAuth tokens need no Pi at all. Only an expired OAuth token
// touches Pi, via the isolated pi-oauth bridge, to run the provider's refresh.
//
// This keeps Bivy's hot credential path decoupled from Pi: Pi is just another
// agent that reads the same store.

import { createCredentialVault } from "./credential-store.js";
import { refreshModelOAuth } from "./oauth/model-oauth.js";
import type { AgentCredentialStore, ProviderCredential } from "./types.js";

/** Refresh an OAuth token this many ms before it expires (clock-skew guard). */
const OAUTH_REFRESH_SKEW_MS = 60_000;

/** Resolver over Bivy's credential store, with OAuth refresh-on-read via the bridge. */
export class NodeCredentialResolver implements AgentCredentialStore {
  private readonly store: ReturnType<typeof createCredentialVault>;

  constructor(private readonly credsDir: string) {
    this.store = createCredentialVault(credsDir);
  }

  async getCredential(provider: string): Promise<ProviderCredential | undefined> {
    const id = provider.trim().toLowerCase();
    if (!id) return undefined;

    const cred = await this.store.read(id).catch(() => undefined);
    if (!cred) return undefined;

    if (cred.type === "api_key") {
      const token = typeof cred.key === "string" ? cred.key : "";
      if (!token) return undefined;
      return { provider: id, kind: "api_key", token, ...(cred.env ? { env: cred.env } : {}) };
    }

    // OAuth: use the stored access token while it's fresh; otherwise ask Pi to
    // run the provider's refresh (which rotates + persists back into our store
    // under the store lock).
    let token = typeof cred.access === "string" ? cred.access : "";
    const expires = Number(cred.expires) || 0;
    if (!token || expires <= Date.now() + OAUTH_REFRESH_SKEW_MS) {
      const refreshed = await refreshModelOAuth(this.credsDir, id).catch(() => undefined);
      if (refreshed) token = refreshed;
    }
    if (!token) return undefined;
    const env = (cred as { env?: Record<string, string> }).env;
    return { provider: id, kind: "oauth", token, ...(env ? { env } : {}) };
  }

  /** Providers with a stored credential — the vault's contents (not ambient env). */
  async listConfigured(): Promise<string[]> {
    const infos = await this.store.list().catch(() => []);
    return infos.map((info) => info.providerId);
  }
}

/** Build the shared credential resolver from the node's credential vault dir. */
export function createCredentialStore(credsDir: string): AgentCredentialStore {
  return new NodeCredentialResolver(credsDir);
}

// Conventional environment variables agent CLIs/SDKs read for each provider. This
// is how a login the user did once inside Bivy reaches an arbitrary agent process:
// the agent doesn't know about Bivy's vault, but it does read these env vars.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cohere: "COHERE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Env var an api-key credential for `provider` should be exposed under. */
function apiKeyEnvVar(provider: string): string {
  return PROVIDER_ENV_KEYS[provider] ?? `${provider.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`;
}

// A custom endpoint's base URL is stored in its credential `env` under one of
// these vars. When that endpoint is the session's ACTIVE provider we also alias
// its key to the matching standard key var, so an agent that reads OPENAI_* /
// AZURE_OPENAI_* / ANTHROPIC_* picks up the custom endpoint. Injected only for
// the active provider — a global base-URL var would hijack the real provider.
const BASE_URL_TO_KEY_VAR: Record<string, string> = {
  OPENAI_BASE_URL: "OPENAI_API_KEY",
  AZURE_OPENAI_BASE_URL: "AZURE_OPENAI_API_KEY",
  ANTHROPIC_BASE_URL: "ANTHROPIC_API_KEY",
};

/**
 * Map every credential the node holds (or a chosen subset) to the environment
 * variables an agent process reads, so one sign-in inside Bivy serves whatever
 * runtime/model the user selects — not just the Pi agent. Anthropic OAuth
 * (Claude Pro/Max) is exposed as CLAUDE_CODE_OAUTH_TOKEN; every other credential
 * is exposed as the provider's API-key var.
 *
 * Provider-scoped `env` (custom base URLs) is injected ONLY for `activeProvider`
 * — the session's selected provider. Base-URL vars like OPENAI_BASE_URL are
 * global to the agent process, so injecting a custom endpoint's base URL for a
 * non-active provider would silently redirect the real provider. Best-effort: a
 * provider that fails to resolve is skipped rather than failing the session.
 */
export async function buildAgentCredentialEnv(
  store: AgentCredentialStore,
  providers?: string[],
  activeProvider?: string,
): Promise<Record<string, string>> {
  const ids = providers ?? (store.listConfigured ? await store.listConfigured().catch(() => []) : []);
  const active = activeProvider?.trim().toLowerCase() || undefined;
  // Process the active provider LAST so its base URL and standard-key alias win
  // over a same-named var from another provider (e.g. a real "openai" key var
  // must not clobber an active custom endpoint's aliased OPENAI_API_KEY).
  const ordered = active ? [...ids].sort((a, b) => Number(a === active) - Number(b === active)) : ids;
  const env: Record<string, string> = {};
  for (const id of ordered) {
    let cred: ProviderCredential | undefined;
    try {
      cred = await store.getCredential(id);
    } catch {
      continue;
    }
    if (!cred) continue;
    const isActive = !!active && cred.provider === active;
    if (cred.kind === "oauth") {
      // OAuth *subscription* tokens are provider-specific and are not accepted
      // as a plain API key. Only Anthropic has a documented env var an external
      // agent reads (Claude Code's OAuth token); other providers' subscription
      // logins can't be handed off this way, so don't emit a misleading key.
      if (cred.provider !== "anthropic") continue;
      Object.assign(env, cred.env ?? {});
      env.CLAUDE_CODE_OAUTH_TOKEN = cred.token;
    } else {
      env[apiKeyEnvVar(cred.provider)] = cred.token;
      // A custom endpoint's base URL (and standard-key alias) is injected only
      // when it's the active provider, so it can't hijack the real provider.
      if (isActive && cred.env) {
        Object.assign(env, cred.env);
        for (const baseVar of Object.keys(cred.env)) {
          const keyVar = BASE_URL_TO_KEY_VAR[baseVar];
          if (keyVar && cred.token) env[keyVar] = cred.token;
        }
      }
    }
  }
  return env;
}
