// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentCredentialStore } from "./types.js";

export class CredentialSelectionError extends Error {}

/** Preserve historical best-effort auth only when no explicit account failed. */
export function credentialEnvFallback(error: unknown): Record<string, string> {
  if (error instanceof CredentialSelectionError) throw error;
  return {};
}

/** Bind a private provider→label map, without changing shared vault assignments. */
export async function withSessionCredentials<T extends { credentials?: AgentCredentialStore }>(
  options: T, labels?: Record<string, string>,
): Promise<T> {
  if (!labels || !Object.keys(labels).length) return options;
  const store = options.credentials;
  if (!store) throw new CredentialSelectionError("This agent manages its own login and cannot use automation account overrides");
  const selected = { ...labels };
  const credentials: AgentCredentialStore = {
    listConfigured: async () => [...new Set([...(await store.listConfigured?.().catch(() => []) ?? []), ...Object.keys(selected)])],
    async getCredential(provider, context) {
      const label = selected[provider.trim().toLowerCase()];
      let credential;
      try {
        credential = await store.getCredential(provider, { ...context, ...(label ? { preferLabel: label } : {}) });
      } catch (error) {
        if (label) throw new CredentialSelectionError(`Could not read selected account “${label}” for ${provider}`);
        throw error;
      }
      if (label && !credential) throw new CredentialSelectionError(`Selected account “${label}” for ${provider} is unavailable on this machine`);
      if (label && credential?.kind === "oauth" && credential.provider !== "anthropic") {
        throw new CredentialSelectionError(`This agent cannot use a ${provider} subscription override; use an API key or a Bivy-managed model agent`);
      }
      // Do not let an inherited alternative Anthropic login outrank the pin.
      if (label && credential?.provider === "anthropic") return {
        ...credential,
        env: { ...credential.env, [credential.kind === "oauth" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: "" },
      };
      return credential;
    },
  };
  // Fail before starting a subprocess, including overrides for a second provider.
  for (const provider of Object.keys(selected)) await credentials.getCredential(provider);
  return { ...options, credentials };
}
