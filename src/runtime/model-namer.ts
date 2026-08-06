// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Node-level fallback session namer.
//
// A runtime's own adapter names a session with its own model (PiSession.suggestName,
// ClaudeSession.suggestName). The generic CLI agents (codex, opencode, aider, …) run
// the "dumb-pipe" ProcessRuntime, which has no model — so as a node-level fallback
// Bivy resolves the CLI's selected provider/model against Pi's model registry (Bivy
// has no model catalog of its own; Pi's registry is the borrowed model metadata) and
// asks it for a title using whatever credential the shared vault holds.
//
// This is deliberately the ONLY place outside the Pi adapter that touches the Pi
// inference SDK, kept under src/runtime/ so the core daemon (src/server.ts) stays
// free of any @earendil-works import.

import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "./pi-oauth.js";

function cleanSessionName(value: string): string {
  return value
    .replace(/[\r\n"'`]/g, " ")
    .replace(/\p{Control}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,:;\-–—]+$/g, "")
    .slice(0, 60)
    .trim();
}

/**
 * A CLI can report its model in provider-qualified (`anthropic/claude-…`) or bare
 * form; try the given provider/id first, then a `provider/id` split, so the
 * registry lookup succeeds for either convention.
 */
function selectedModelCandidates(provider: string | undefined, id: string | undefined): Array<{ provider: string; id: string }> {
  const cleanProvider = provider?.trim();
  const cleanId = id?.trim();
  if (!cleanProvider || !cleanId) return [];
  const out: Array<{ provider: string; id: string }> = [{ provider: cleanProvider, id: cleanId }];
  const slash = cleanId.indexOf("/");
  if (slash > 0) {
    const prefixedProvider = cleanId.slice(0, slash);
    const bareId = cleanId.slice(slash + 1);
    if (prefixedProvider && bareId) out.push({ provider: prefixedProvider, id: bareId });
  }
  return out.filter((candidate, index) => out.findIndex((x) => x.provider === candidate.provider && x.id === candidate.id) === index);
}

/**
 * Title a session with the provider/model the user selected for it, resolved via
 * Pi's model registry against the shared vault's credentials. Returns undefined
 * when the model can't be resolved, no credential is configured, or the request
 * fails — the caller keeps its deterministic title / node-level fallback.
 */
export async function suggestNameFromSelectedModel(opts: {
  credsDir: string;
  piDir: string;
  provider: string | undefined;
  id: string | undefined;
  firstPrompt: string;
  sessionId: string;
}): Promise<string | undefined> {
  const prompt = opts.firstPrompt.trim();
  if (!prompt) return undefined;

  try {
    const registry = new ModelRegistry(await createPiModelRuntime({ credsDir: opts.credsDir, piDir: opts.piDir }));
    let model: Model<Api> | undefined;
    for (const candidate of selectedModelCandidates(opts.provider, opts.id)) {
      model = registry.find(candidate.provider, candidate.id) as Model<Api> | undefined;
      if (model) break;
    }
    if (!model) return undefined;

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const response = await completeSimple(
      model,
      {
        systemPrompt:
          "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.",
        messages: [{ role: "user", content: `Create a short title for this coding-agent session using the full first message below:\n\n${prompt.slice(0, 4000)}`, timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, temperature: 0.2, maxTokens: 24, reasoning: "minimal", sessionId: `${opts.sessionId}:name` },
    );

    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join(" ");
    return cleanSessionName(text) || undefined;
  } catch (error) {
    console.warn("Selected-model session naming failed", error);
    return undefined;
  }
}
