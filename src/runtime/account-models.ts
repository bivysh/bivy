// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Which of a provider's models the signed-in account may use.
//
// A subscription sign-in can cover only part of a provider's catalog, and some
// providers say which part: ChatGPT lists the models a plan includes (the list
// Codex itself shows). An agent that ships a fixed catalog (Pi) is filtered to
// that list, so it never offers or starts on a model the account will refuse.
// Adding a provider is a row in SOURCES. A provider without a row, or a lookup
// that fails, leaves the catalog untouched.

import { createCredentialVault } from "./credential-store.js";

interface AccountCredential { access?: unknown; accountId?: unknown }
type Source = (credential: AccountCredential) => Promise<string[] | undefined>;

/** The ChatGPT models endpoint Codex reads; `client_version` gates newer models. */
const CHATGPT_CLIENT_VERSION = "0.165.0";

const chatgptModels: Source = async (credential) => {
  if (typeof credential.access !== "string" || !credential.access) return undefined;
  const response = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`, {
    headers: {
      authorization: `Bearer ${credential.access}`,
      ...(typeof credential.accountId === "string" && credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
  const ids = (body.models ?? [])
    .filter((model) => model.visibility === "list" && typeof model.slug === "string")
    .map((model) => model.slug as string);
  return ids.length ? ids : undefined;
};

const SOURCES: Record<string, Source> = {
  "openai-codex": chatgptModels,
};

const TTL_MS = 60 * 60_000;
const cache = new Map<string, { at: number; ids: Set<string> | undefined }>();

/** The model ids `provider`'s signed-in account may use, or undefined when unknown. */
export async function accountModelIds(credsDir: string, provider: string, now = Date.now()): Promise<Set<string> | undefined> {
  const source = SOURCES[provider];
  if (!source) return undefined;
  const credential = await createCredentialVault(credsDir).read(provider).catch(() => undefined) as AccountCredential & { type?: string } | undefined;
  if (!credential || credential.type !== "oauth") return undefined;
  const key = `${credsDir}\0${provider}\0${String(credential.accountId ?? "")}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.ids;
  const ids = await source(credential).catch(() => undefined);
  const value = ids ? new Set(ids) : undefined;
  // Remember failures briefly too, so an offline node doesn't retry every call.
  cache.set(key, { at: ids ? now : now - TTL_MS + 5 * 60_000, ids: value });
  return value;
}

/** Every provider with an account list, keyed by provider id. */
export async function accountModelLists(credsDir: string): Promise<Map<string, Set<string>>> {
  const lists = new Map<string, Set<string>>();
  for (const provider of Object.keys(SOURCES)) {
    const ids = await accountModelIds(credsDir, provider);
    if (ids) lists.set(provider, ids);
  }
  return lists;
}

/** Drop models the account can't use; providers without a list pass through. */
export function withinAccount<T extends { provider?: string; id: string }>(models: T[], lists: Map<string, Set<string>>): T[] {
  return models.filter((model) => {
    const allowed = lists.get(String(model.provider ?? ""));
    return !allowed || allowed.has(model.id);
  });
}

/** Test hook: forget cached lists. */
export function resetAccountModels(): void {
  cache.clear();
}
