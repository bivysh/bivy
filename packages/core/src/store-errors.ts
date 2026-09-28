// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Error-humanization helpers for the session store. Split out of store.ts so the
// reducer keeps only state-folding logic. Pure string→string functions — no state.

/**
 * Make a raw provider/runtime error string readable. Model APIs often return
 * `<status> {json}` (e.g. `400 {"error":{"message":"…"}}`); pull out the human
 * sentence so the chat shows that instead of a JSON blob. Mirrors the node's
 * humanizeAgentError so a live (node-sent) error and a reloaded (persisted)
 * error read identically. Unparseable input is returned trimmed and unchanged.
 */
export function humanizeError(raw: string): string {
  const text = String(raw ?? "").trim();
  if (/^WebSocket closed 1006\b/i.test(text)) {
    return "The agent/provider connection dropped unexpectedly (WebSocket 1006). Bivy will keep the session; retry your message or continue from the latest saved state.";
  }
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(text.slice(brace)) as Record<string, unknown>;
      const err = body.error as Record<string, unknown> | string | undefined;
      const msg =
        (typeof err === "object" && err && typeof (err as { message?: unknown }).message === "string" && (err as { message: string }).message) ||
        (typeof body.message === "string" && body.message) ||
        (typeof err === "string" && err) ||
        "";
      if (msg && msg.trim()) return msg.trim();
    } catch {
      // Not JSON we recognize — fall through to the raw text.
    }
  }
  return text;
}

/**
 * The Claude Code CLI surfaces API/transport failures — auth 401s, dropped
 * sockets, rate limits — as an ordinary assistant *text* message (e.g.
 * "Failed to authenticate. API Error: 401 Invalid authentication credentials"),
 * with no structured error flag on the persisted message. Left alone those
 * render as a normal grey reply and read as if the agent answered. Match that
 * shape so both the live turn and a reloaded transcript classify it as an error
 * bubble instead. Anchored to the message *being* the error line (not merely
 * mentioning an error code mid-prose) so a genuine reply that discusses a 401
 * isn't misclassified.
 */
export function looksLikeAgentError(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /^Failed to authenticate\b/i.test(t) || /^API Error:\s*\d{3}\b/i.test(t) || /^WebSocket closed 1006\b/i.test(t);
}

/**
 * True when a failure is about the model credential rather than the work — a
 * 401/403, a missing or invalid key, or an OAuth session that expired and could
 * not be refreshed. Callers use it to offer a "fix your sign-in" affordance next
 * to the error instead of leaving the user to guess where credentials live.
 * Only ever applied to text already classified as an error, so a broad match is
 * safe; it must not be used to classify ordinary prose.
 */
export function looksLikeAuthFailure(text: string): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  return /\b401\b|\b403\b|unauthori[sz]ed|authenticat|oauth|subscription|invalid x-api-key|(missing|no|expired|invalid)[\s\S]*(bearer|api[\s_-]?key|token|credential)/i.test(t);
}

/** Agent family → the credential provider its sign-in targets. Matched by id
 *  prefix so versioned/variant ids (claude-code-sdk, codex-approvals) need no
 *  row of their own. Agents that are not tied to one provider (pi, opencode,
 *  generic CLIs) are absent on purpose — they resolve through the model's own
 *  provider instead. */
const RUNTIME_AUTH_PROVIDERS: ReadonlyArray<readonly [prefix: string, provider: string]> = [
  ["codex", "openai-codex"],
  ["claude", "anthropic"],
  ["grok", "xai"],
  ["gemini", "google"],
];

/**
 * Which credential provider the user must (re)authenticate for, given the agent
 * that failed and, when known, the provider behind its current model. Returns
 * undefined when neither names a provider we can open a sign-in for — the caller
 * should then fall back to the provider settings as a whole.
 */
export function authProviderForRuntime(runtimeId?: string | null, modelProvider?: string | null): string | undefined {
  const id = String(runtimeId ?? "").trim().toLowerCase();
  const family = RUNTIME_AUTH_PROVIDERS.find(([prefix]) => id.startsWith(prefix));
  if (family) return family[1];
  const provider = String(modelProvider ?? "").trim().toLowerCase();
  return provider || undefined;
}
