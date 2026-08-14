// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Bivy's browser-safe provider registry and baseline model catalog.
 *
 * This is product metadata, not runtime state: a node-less PWA can search it,
 * render the right sign-in methods, and browse a useful baseline. Nodes overlay
 * live provider/agent discovery without replacing these identities.
 */
export const BIVY_PROVIDER_CATALOG_VERSION = "2026-08-14";

export type ProviderAuthMethod =
  | { kind: "api_key"; label: string; helpUrl?: string }
  | { kind: "oauth"; label: string; oauthProviderId?: string }
  | { kind: "reference"; label: string };

export interface BivyCatalogModel {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface BivyProviderDefinition {
  id: string;
  name: string;
  aliases?: string[];
  authMethods: ProviderAuthMethod[];
  env?: string[];
  compatibility?: "anthropic" | "openai" | "google" | "custom";
  models: BivyCatalogModel[];
}

const api = (label: string, helpUrl?: string): ProviderAuthMethod => ({ kind: "api_key", label, ...(helpUrl ? { helpUrl } : {}) });
const oauth = (label: string, oauthProviderId?: string): ProviderAuthMethod => ({ kind: "oauth", label, ...(oauthProviderId ? { oauthProviderId } : {}) });
const ref: ProviderAuthMethod = { kind: "reference", label: "Password manager or environment" };

export const BIVY_PROVIDER_CATALOG: readonly BivyProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", authMethods: [oauth("Claude Pro / Max"), api("Anthropic API key", "https://console.anthropic.com/settings/keys"), ref], env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], compatibility: "anthropic", models: [
    { id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ] },
  { id: "openai", name: "OpenAI API", aliases: ["openai-api"], authMethods: [api("OpenAI API key", "https://platform.openai.com/api-keys"), ref], env: ["OPENAI_API_KEY"], compatibility: "openai", models: [
    { id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true },
    { id: "gpt-4o", name: "GPT-4o" },
  ] },
  { id: "openai-codex", name: "OpenAI — ChatGPT subscription", aliases: ["codex"], authMethods: [oauth("ChatGPT Plus / Pro", "openai-codex")], compatibility: "openai", models: [
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", reasoning: true },
    { id: "gpt-5-codex", name: "GPT-5 Codex", reasoning: true },
  ] },
  { id: "google", name: "Google Gemini", aliases: ["gemini"], authMethods: [api("Gemini API key", "https://aistudio.google.com/app/apikey"), ref], env: ["GEMINI_API_KEY"], compatibility: "google", models: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true },
  ] },
  { id: "xai", name: "xAI", authMethods: [oauth("Grok / X subscription"), api("xAI API key", "https://console.x.ai"), ref], env: ["XAI_API_KEY", "GROK_API_KEY"], compatibility: "openai", models: [] },
  { id: "openrouter", name: "OpenRouter", authMethods: [api("OpenRouter API key", "https://openrouter.ai/keys"), ref], env: ["OPENROUTER_API_KEY"], compatibility: "openai", models: [] },
  { id: "groq", name: "Groq", authMethods: [api("Groq API key", "https://console.groq.com/keys"), ref], env: ["GROQ_API_KEY"], compatibility: "openai", models: [] },
  { id: "mistral", name: "Mistral", authMethods: [api("Mistral API key"), ref], env: ["MISTRAL_API_KEY"], compatibility: "openai", models: [] },
  { id: "deepseek", name: "DeepSeek", authMethods: [api("DeepSeek API key"), ref], env: ["DEEPSEEK_API_KEY"], compatibility: "openai", models: [] },
  { id: "together", name: "Together AI", authMethods: [api("Together API key"), ref], env: ["TOGETHER_API_KEY"], compatibility: "openai", models: [] },
  { id: "fireworks", name: "Fireworks AI", authMethods: [api("Fireworks API key"), ref], env: ["FIREWORKS_API_KEY"], compatibility: "openai", models: [] },
  { id: "cohere", name: "Cohere", authMethods: [api("Cohere API key"), ref], env: ["COHERE_API_KEY"], models: [] },
  { id: "perplexity", name: "Perplexity", authMethods: [api("Perplexity API key"), ref], env: ["PERPLEXITY_API_KEY"], compatibility: "openai", models: [] },
] as const;

const byId = new Map<string, BivyProviderDefinition>();
for (const provider of BIVY_PROVIDER_CATALOG) {
  byId.set(provider.id, provider);
  for (const alias of provider.aliases ?? []) byId.set(alias, provider);
}

export function bivyProvider(id: string): BivyProviderDefinition | undefined {
  return byId.get(String(id || "").trim().toLowerCase());
}

export function searchBivyProviders(query: string): BivyProviderDefinition[] {
  const needle = query.trim().toLowerCase();
  return BIVY_PROVIDER_CATALOG.filter((provider) => !needle || `${provider.name} ${provider.id} ${(provider.aliases ?? []).join(" ")}`.toLowerCase().includes(needle));
}
