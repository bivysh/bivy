// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Classify model auth failures and map a failing session to the provider the
// user needs to (re)authenticate.
//
// When a runtime has no usable model credential — or a present-but-expired one —
// its first upstream request fails with a 401. Codex surfaces this as
// `failed to connect to websocket: HTTP error: 401 Unauthorized, url:
// wss://api.openai.com/v1/responses`; Anthropic as `401 Unauthorized`; others
// similarly. Rather than let that stream past as a raw error, the daemon runs
// `isModelAuthError` over surfaced errors and, when one matches, broadcasts a
// `session.auth_required` targeted at `authProviderForSession(...)` so the client
// can pop the "Sign in to your model" sheet for the right provider.

import { MODEL_OAUTH_PROVIDERS } from "./oauth/model-oauth-providers.js";

/**
 * True when a raw error string looks like a model auth failure (401 / missing
 * bearer / invalid key). Covers both the generic SDK phrasing and Codex's
 * websocket-connect form.
 */
export function isModelAuthError(raw: string): boolean {
  const text = String(raw || "");
  // Generic: an explicit 401, "unauthorized"/"authentication", or a
  // missing/invalid bearer/api-key/token phrase.
  if (/\b401\b|unauthorized|authentication|invalid x-api-key|(missing|no|invalid)[\s\S]*(bearer|api[\s_-]?key|token)/i.test(text))
    return true;
  // Codex app-server: websocket connect rejected with an HTTP 401/403.
  if (/failed to connect to websocket[\s\S]*http error:\s*40[13]/i.test(text)) return true;
  return false;
}

// Provider ids the app knows how to authenticate (OAuth subscription providers
// plus any provider that has a conventional API-key env var). Used to validate
// a model provider before signalling the client to sign in for it.
const KNOWN_KEY_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "gemini",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "together",
  "fireworks",
  "cohere",
  "perplexity",
]);

/**
 * Resolve which credential provider the user should sign in for, given the
 * failing runtime id and (optionally) its active model provider. Returns
 * undefined when we can't confidently name a provider — in that case the caller
 * should not raise the sign-in sheet.
 *
 * Codex runtimes (`codex`, `codex-approvals`) are served by the ChatGPT
 * subscription, whose vault/provider id is `openai-codex`; that's the id the
 * "Sign in with OpenAI" OAuth button targets.
 */
export function authProviderForSession(runtimeId: string, modelProvider?: string): string | undefined {
  const id = String(runtimeId || "").trim().toLowerCase();
  if (id.startsWith("codex")) return "openai-codex";
  const provider = String(modelProvider || "").trim().toLowerCase();
  if (!provider) return undefined;
  if (Object.prototype.hasOwnProperty.call(MODEL_OAUTH_PROVIDERS, provider)) return provider;
  if (KNOWN_KEY_PROVIDERS.has(provider)) return provider;
  return undefined;
}
