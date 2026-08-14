// SPDX-License-Identifier: AGPL-3.0-only
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

import path from "node:path";
import { createCredentialVault } from "./store.js";
import { resolveCredential, type CredentialPresets } from "./records.js";
import { loadPresets, defaultPresetsPath } from "./presets.js";
import type { AgentCredentialStore, ProviderCredential } from "./types.js";
import type { SecretResolver, OAuthRefresher } from "./ports.js";

/** Refresh an OAuth token this many ms before it expires (clock-skew guard). */
const OAUTH_REFRESH_SKEW_MS = 60_000;

/** Stable project identifiers discoverable without importing repo/session code. */
export function projectIdsFromWorkspace(workspace: string): string[] {
  const resolved = path.resolve(workspace);
  const ids = new Set<string>([resolved, path.basename(resolved)]);
  for (const part of resolved.split(path.sep)) {
    const split = part.indexOf("__");
    if (split > 0 && split < part.length - 2) ids.add(`${part.slice(0, split)}/${part.slice(split + 2)}`);
  }
  return [...ids];
}

/** Resolver over Bivy's credential store, with OAuth refresh-on-read via the bridge. */
export class NodeCredentialResolver implements AgentCredentialStore {
  private readonly store: ReturnType<typeof createCredentialVault>;
  private readonly presetsPath: string;
  private presetsCache?: CredentialPresets;

  // Reference resolution (op:///env:///cmd://) and OAuth refresh are injected
  // capabilities (ports) — the resolver stays free of secrets.ts and the Pi
  // OAuth bridge. The node adapters are bound by the runtime shim.
  constructor(
    private readonly credsDir: string,
    private readonly secrets: SecretResolver,
    private readonly oauth: OAuthRefresher,
  ) {
    this.store = createCredentialVault(credsDir);
    this.presetsPath = defaultPresetsPath(credsDir);
  }

  /** The node's selection presets, read once per resolver (see presets.ts). */
  private presets(): CredentialPresets {
    if (!this.presetsCache) this.presetsCache = loadPresets(this.presetsPath);
    return this.presetsCache;
  }

  async getCredential(provider: string, context?: { project?: string; workspace?: string; preferLabel?: string }): Promise<ProviderCredential | undefined> {
    const id = provider.trim().toLowerCase();
    if (!id) return undefined;

    // Selection is data-driven: pick the record for this provider per the active
    // preset (records.ts). With one credential per provider this resolves to that
    // credential; ambiguity (multiple accounts, no preset) returns nothing rather
    // than guessing.
    const records = await this.store.listRecords().catch(() => []);
    const presets = this.presets();
    // Project assignments are ordinary preset mappings named `project:<id>`.
    // Bivy-managed clones encode owner/repo as owner__repo in their workspace
    // path; direct local workspaces also match their absolute path/basename.
    const explicitProject = context?.project?.trim();
    const workspace = context?.workspace?.trim();
    const projectCandidates = [explicitProject, ...(workspace ? projectIdsFromWorkspace(workspace) : [])].filter((value): value is string => Boolean(value));
    const projectPreset = projectCandidates.map((value) => `project:${value}`).find((name) => presets.presets?.[name]?.[id]);
    const selection = resolveCredential(id, records, presets, { ...(projectPreset ? { preset: projectPreset } : {}), ...(context?.preferLabel ? { preferLabel: context.preferLabel } : {}) });
    if (!selection) return undefined;
    const source = selection.record.source;

    // A reference credential is a pointer (op:// / env://) resolved per-node at
    // read time via the secret vault — the secret never lived in our store. It is
    // api-key-shaped. A node that can't resolve it (no `op` session, missing env)
    // reports no credential here rather than falling back to another account.
    if (source.kind === "reference") {
      const token = (await this.secrets.resolve(source.ref).catch(() => undefined))?.trim();
      if (!token) return undefined;
      return { provider: id, kind: "api_key", token };
    }

    const cred = source.cred;

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
      // Refresh the SELECTED record (its label), not just the provider default —
      // so a second account on the same provider is left untouched.
      const refreshed = await this.oauth.refresh(id, selection.record.label).catch(() => undefined);
      if (refreshed) token = refreshed;
    }
    if (!token) return undefined;
    const env = (cred as { env?: Record<string, string> }).env;
    return { provider: id, kind: "oauth", token, ...(env ? { env } : {}) };
  }

  /** Providers with a stored credential — the vault's contents (not ambient env). */
  async listConfigured(): Promise<string[]> {
    const infos = await this.store.list().catch(() => []);
    // A provider may hold several labeled records; expose each provider once.
    return [...new Set(infos.map((info) => info.providerId))];
  }
}

/**
 * Build the shared credential resolver from the node's credential vault dir and
 * the injected reference/OAuth capabilities. The runtime shim
 * (runtime/credentials.ts) binds the node adapters and exposes the
 * `createCredentialStore(credsDir)` convenience every current caller uses.
 */
export function createCredentialStore(
  credsDir: string,
  secrets: SecretResolver,
  oauth: OAuthRefresher,
): AgentCredentialStore {
  return new NodeCredentialResolver(credsDir, secrets, oauth);
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
export function apiKeyEnvVar(provider: string): string {
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
  workspace?: string,
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
      cred = await store.getCredential(id, workspace ? { workspace } : undefined);
    } catch {
      continue;
    }
    if (!cred) continue;
    const isActive = !!active && cred.provider === active;
    if (cred.kind === "oauth") {
      // OAuth *subscription* tokens are provider-specific and are not accepted
      // as a plain API key. Only Anthropic has a documented env var an external
      // agent reads (Claude Code's OAuth token). Codex and Grok get their
      // subscription via native auth.json materialization (codex-auth.ts /
      // grok-auth.ts), not as env keys — so don't emit a misleading key here.
      if (cred.provider !== "anthropic") continue;
      Object.assign(env, cred.env ?? {});
      env.CLAUDE_CODE_OAUTH_TOKEN = cred.token;
    } else {
      env[apiKeyEnvVar(cred.provider)] = cred.token;
      // vibe-kit/grok-cli (and some forks) read GROK_API_KEY instead of the
      // official XAI_API_KEY. Project both so either Grok binary works off one
      // Bivy API-key login.
      if (cred.provider === "xai") env.GROK_API_KEY = cred.token;
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
