// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The two first-run choices: where agents run, and which AI accounts they use.

import { modelAuthApiKeyProvider, type RuntimeInfo } from "@bivy/core";

export type RunPlace = "cloud" | "own";

const PLACE_KEY = "bivy:run-place";
const AI_DONE_KEY = "bivy:connect-ai-done";

export function readRunPlace(): RunPlace | null {
  const value = localStorage.getItem(PLACE_KEY);
  return value === "cloud" || value === "own" ? value : null;
}

export function rememberRunPlace(place: RunPlace | null): void {
  if (place) localStorage.setItem(PLACE_KEY, place);
  else localStorage.removeItem(PLACE_KEY);
}

export function connectAiDone(): boolean {
  return localStorage.getItem(AI_DONE_KEY) === "1";
}

export function rememberConnectAiDone(): void {
  localStorage.setItem(AI_DONE_KEY, "1");
}

/** Where a sign-in made from this device is kept. Unless the user runs agents
 *  on Bivy Cloud, a sign-in stays on the computer it was made on: it never
 *  joins the account's synced vault, so nothing about it reaches the server.
 *  Cloud machines (`eph-…`) always use the account default, because cloud runs
 *  need the kept copy. */
export function signInSync(nodeId: string | null | undefined, place: RunPlace | null = readRunPlace()): "node" | undefined {
  return place !== "cloud" && !nodeId?.startsWith("eph-") ? "node" : undefined;
}

/** The AI subscriptions offered first. Each row is a provider sign-in; which
 *  agent uses it comes from the runtime catalog, not from this table. */
export interface AiAccount {
  provider: string;
  name: string;
  plan: string;
}

export const AI_ACCOUNTS: readonly AiAccount[] = [
  { provider: "anthropic", name: "Claude", plan: "Pro or Max plan" },
  { provider: "openai-codex", name: "ChatGPT", plan: "Plus or Pro plan" },
];

const usesProvider = (runtime: RuntimeInfo, provider: string) => {
  const declared = runtime.credentialRequirements?.providers ?? [];
  return declared.includes(provider) || declared.includes(modelAuthApiKeyProvider(provider));
};

/** The agent to use once these providers are connected: the selected one when
 *  it can use any of them (or declares nothing), otherwise the first available
 *  agent that can. Undefined when no change is needed or possible. */
export function agentForProviders(runtimes: readonly RuntimeInfo[], selectedId: string, connected: readonly string[]): RuntimeInfo | undefined {
  if (connected.length === 0) return undefined;
  const available = runtimes.filter((runtime) => String(runtime.status ?? "available") === "available");
  const selected = available.find((runtime) => runtime.id === selectedId);
  if (selected && (!selected.credentialRequirements?.providers?.length || connected.some((provider) => usesProvider(selected, provider)))) return undefined;
  for (const provider of connected) {
    const match = available.find((runtime) => usesProvider(runtime, provider));
    if (match) return match;
  }
  return undefined;
}
