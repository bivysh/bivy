// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The one title request every session namer sends: the instruction, the
// prompt wrapper, the output budget and the cleanup. The Claude adapter, the
// Pi adapter, the Codex namer, the selected-model namer and the node-level
// namer all use it, so a model or API change is fixed in one place.
//
// No sampling parameters: current Claude models and the ChatGPT Codex backend
// reject `temperature` with a 400, which silently left every session on its
// first-words fallback title.

export const SESSION_TITLE_INSTRUCTION =
  "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.";

/** Room for a short title plus whatever a reasoning model spends first. */
export const SESSION_TITLE_MAX_TOKENS = 200;

/** The small, current Anthropic model the direct Messages API namer uses. */
export const ANTHROPIC_TITLE_MODEL = "claude-haiku-5-5";

const TITLE_TIMEOUT_MS = 30_000;

/** The user message: the session's first prompt, capped. */
export function sessionTitlePrompt(firstPrompt: string): string {
  return `Create a short title for this coding-agent session using the full first message below:\n\n${firstPrompt.trim().slice(0, 4000)}`;
}

/** Sanitize model output into a title: strip quotes/control chars, collapse
 *  whitespace, drop trailing punctuation, cap at 60 chars. */
export function cleanSessionName(value: string): string {
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
 * Title a session through the Anthropic Messages API. `headers` carry the
 * credential: `authorization` (a Claude subscription token, which must lead
 * with the Claude Code identity block) or `x-api-key`. Returns undefined on any
 * failure, so the caller keeps its fallback title.
 */
export async function anthropicSessionTitle(opts: {
  headers: Record<string, string>;
  firstPrompt: string;
  baseUrl?: string;
}): Promise<string | undefined> {
  if (!opts.firstPrompt.trim()) return undefined;
  const oauth = "authorization" in opts.headers;
  const base = (opts.baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...opts.headers },
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      body: JSON.stringify({
        model: ANTHROPIC_TITLE_MODEL,
        max_tokens: SESSION_TITLE_MAX_TOKENS,
        system: oauth
          ? [
              { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
              { type: "text", text: SESSION_TITLE_INSTRUCTION },
            ]
          : SESSION_TITLE_INSTRUCTION,
        messages: [{ role: "user", content: sessionTitlePrompt(opts.firstPrompt) }],
      }),
    });
    if (!response.ok) {
      console.warn(`Session title request failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      return undefined;
    }
    const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (json.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
    return cleanSessionName(text) || undefined;
  } catch (error) {
    console.warn("Session title request failed", error);
    return undefined;
  }
}
