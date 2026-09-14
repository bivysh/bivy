// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Bivy-owned, browser-safe provider registry and baseline model catalog.
 *
 * This is versioned product metadata, not runtime state. It intentionally has
 * no Node, Pi, agent, or network dependencies, so clients can show providers,
 * authentication choices, help links, and a useful model baseline before they
 * connect to a node. Runtime discovery may augment this snapshot but does not
 * own these provider identities.
 */
export const BIVY_PROVIDER_CATALOG_VERSION = "2026-08-14";

export type ProviderAuthMethod =
  | { kind: "api_key"; label: string; helpUrl?: string }
  | { kind: "oauth"; label: string; oauthProviderId?: string; helpUrl?: string }
  | { kind: "reference"; label: string; helpUrl?: string };

export interface BivyCatalogModel {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface BivyProviderDefinition {
  id: string;
  name: string;
  aliases?: readonly string[];
  authMethods: readonly ProviderAuthMethod[];
  /** Well-known environment variables, ordered by preference. */
  env?: readonly string[];
  compatibility?: "anthropic" | "openai" | "google" | "custom";
  helpUrl?: string;
  models: readonly BivyCatalogModel[];
}

const apiKey = (label: string, helpUrl?: string): ProviderAuthMethod => ({ kind: "api_key", label, ...(helpUrl ? { helpUrl } : {}) });
const oauth = (label: string, oauthProviderId?: string): ProviderAuthMethod => ({ kind: "oauth", label, ...(oauthProviderId ? { oauthProviderId } : {}) });
const reference: ProviderAuthMethod = { kind: "reference", label: "Password manager or environment" };

/** Authoritative common providers and the offline baseline models Bivy ships. */
export const BIVY_PROVIDER_CATALOG: readonly BivyProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", authMethods: [oauth("Claude Pro / Max", "anthropic"), apiKey("Anthropic API key", "https://console.anthropic.com/settings/keys"), reference], env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], compatibility: "anthropic", helpUrl: "https://docs.anthropic.com/", models: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ] },
  { id: "openai", name: "OpenAI API", aliases: ["openai-api"], authMethods: [apiKey("OpenAI API key", "https://platform.openai.com/api-keys"), reference], env: ["OPENAI_API_KEY"], compatibility: "openai", helpUrl: "https://platform.openai.com/docs/", models: [
    { id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true },
    { id: "gpt-4o", name: "GPT-4o" },
  ] },
  { id: "openai-codex", name: "OpenAI — ChatGPT subscription", aliases: ["codex"], authMethods: [oauth("ChatGPT Plus / Pro", "openai-codex")], compatibility: "openai", models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", reasoning: true },
    { id: "gpt-5-codex", name: "GPT-5 Codex", reasoning: true },
  ] },
  { id: "google", name: "Google Gemini", aliases: ["gemini"], authMethods: [apiKey("Gemini API key", "https://aistudio.google.com/app/apikey"), reference], env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], compatibility: "google", helpUrl: "https://ai.google.dev/gemini-api/docs", models: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true },
  ] },
  { id: "xai", name: "xAI", authMethods: [oauth("Grok / X subscription", "xai"), apiKey("xAI API key", "https://console.x.ai"), reference], env: ["XAI_API_KEY", "GROK_API_KEY"], compatibility: "openai", models: [] },
  { id: "openrouter", name: "OpenRouter", authMethods: [apiKey("OpenRouter API key", "https://openrouter.ai/keys"), reference], env: ["OPENROUTER_API_KEY"], compatibility: "openai", models: [] },
  { id: "groq", name: "Groq", authMethods: [apiKey("Groq API key", "https://console.groq.com/keys"), reference], env: ["GROQ_API_KEY"], compatibility: "openai", models: [] },
  { id: "mistral", name: "Mistral", authMethods: [apiKey("Mistral API key", "https://console.mistral.ai/api-keys"), reference], env: ["MISTRAL_API_KEY"], compatibility: "openai", models: [] },
  { id: "deepseek", name: "DeepSeek", authMethods: [apiKey("DeepSeek API key", "https://platform.deepseek.com/api_keys"), reference], env: ["DEEPSEEK_API_KEY"], compatibility: "openai", models: [] },
  { id: "together", name: "Together AI", authMethods: [apiKey("Together API key", "https://api.together.ai/settings/api-keys"), reference], env: ["TOGETHER_API_KEY"], compatibility: "openai", models: [] },
  { id: "fireworks", name: "Fireworks AI", authMethods: [apiKey("Fireworks API key", "https://fireworks.ai/account/api-keys"), reference], env: ["FIREWORKS_API_KEY"], compatibility: "openai", models: [] },
  { id: "cohere", name: "Cohere", authMethods: [apiKey("Cohere API key", "https://dashboard.cohere.com/api-keys"), reference], env: ["COHERE_API_KEY"], models: [] },
  { id: "perplexity", name: "Perplexity", authMethods: [apiKey("Perplexity API key", "https://www.perplexity.ai/settings/api"), reference], env: ["PERPLEXITY_API_KEY"], compatibility: "openai", models: [] },
] as const;

/** Common providers that accept API keys, for browser pickers and validation. */
export const BIVY_API_KEY_PROVIDER_IDS: readonly string[] = BIVY_PROVIDER_CATALOG
  .filter((provider) => provider.authMethods.some((method) => method.kind === "api_key"))
  .map((provider) => provider.id);

const providersById = new Map<string, BivyProviderDefinition>();
for (const provider of BIVY_PROVIDER_CATALOG) {
  providersById.set(provider.id, provider);
  for (const alias of provider.aliases ?? []) providersById.set(alias, provider);
}

/** Resolve a canonical provider id or a declared alias. */
export function bivyProvider(id: string): BivyProviderDefinition | undefined {
  return providersById.get(String(id || "").trim().toLowerCase());
}

/** Search the static registry without requiring a node or network request. */
export function searchBivyProviders(query: string): BivyProviderDefinition[] {
  const needle = query.trim().toLowerCase();
  return BIVY_PROVIDER_CATALOG.filter((provider) =>
    !needle || `${provider.name} ${provider.id} ${(provider.aliases ?? []).join(" ")}`.toLowerCase().includes(needle));
}
