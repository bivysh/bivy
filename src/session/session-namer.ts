// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Session auto-naming, extracted from server.ts. Owns the four naming fields and
// the ~95-line state machine that titles a session from its first message: a
// deterministic first-pass rename, a three-tier model-based refinement, an
// attempt-cap retry, and the placeholder/first-prompt-capture guards that keep a
// session from "renaming on every message".
//
// Like the other extracted subsystems it operates on a NARROW session shape
// (NamerSession, not the ~50-field SessionRecord) and reaches the daemon only
// through the injected NamerDeps. The worktree branch-rename it triggers is a
// separate concern, injected as `renameBranch`, so this module never touches
// worktree/branch state directly.

import { suggestNameFromSelectedModel } from "../runtime/model-namer.js";

/** Only the session fields naming reads or writes. */
export interface NamerSession {
  id: string;
  sessionFile?: string;
  worktree?: { branch?: string };
  naming?: boolean;
  namedFromFirstPrompt?: boolean;
  namingAttempts?: number;
  firstNamingPrompt?: string;
  session: {
    getName(): string | undefined;
    setName(name: string): void;
    suggestName(prompt: string): Promise<string | undefined>;
    getCurrentModel(): { provider: string; id: string } | undefined;
  };
}

/** Naming's entire coupling surface to the rest of the daemon. */
export interface NamerDeps {
  broadcast(payload: unknown): void;
  persistSessionMetadata(record: NamerSession): void;
  scheduleAdvertise(): void;
  /** Rename the worktree's local branch to match the new title (a worktree
   *  concern; naming only triggers it). No-op for non-worktree sessions. */
  renameBranch(record: NamerSession, name: string): void;
  /** Shared "is this a creation-time placeholder / empty title" predicate — the
   *  gate deciding whether a session still needs a first-message name. Also used
   *  by session-discovery, so it stays server-side. */
  isPlaceholderName(name: string | undefined, id: string): boolean;
  /** Anthropic request headers from whatever node credential is available, or
   *  undefined when none is — the node-level namer's auth. */
  anthropicHeadersFromNodeCredential(): Promise<Record<string, string> | undefined>;
  credsDir: string;
  piDir: string;
}

export interface SessionNamer {
  maybeNameSession(record: NamerSession, firstPrompt: string): Promise<void>;
  setSessionName(record: NamerSession, name: string): void;
}

/** Deterministic title from the first ~6 words of the prompt (strips
 *  code/URLs/markdown). The floor everything else refines. */
export function fallbackSessionName(firstPrompt: string): string | undefined {
  const words = firstPrompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>\[\]{}()]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return undefined;
  const title = words.join(" ");
  return title.length > 80 ? `${title.slice(0, 77).trim()}…` : title;
}

/** Sanitize model/LLM output into a title: strip quotes/control chars, collapse
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

export function createSessionNamer(deps: NamerDeps): SessionNamer {
  /**
   * For process/CLI agents, ask the same provider/model the user selected for the
   * session to title it (via the node-level fallback namer, which resolves the
   * model through the borrowed catalog and the shared vault's credentials). If the
   * CLI uses an opaque local model or a short alias we can't resolve, this returns
   * undefined and the Anthropic node-level fallback (or deterministic title) stands.
   */
  async function suggestSessionNameFromSelectedModel(record: NamerSession, firstPrompt: string): Promise<string | undefined> {
    const current = record.session.getCurrentModel();
    if (!firstPrompt.trim() || !current) return undefined;
    return suggestNameFromSelectedModel({
      credsDir: deps.credsDir,
      piDir: deps.piDir,
      provider: current.provider,
      id: current.id,
      firstPrompt,
      sessionId: record.id,
    });
  }

  /**
   * A runtime-independent node-level namer for the CLI agents (codex, opencode,
   * aider, …) that run the generic ProcessRuntime with no model of their own.
   * Uses whatever Anthropic credential the node already holds (API key or a
   * Claude Pro/Max OAuth token). Best-effort: a missing credential / API error
   * returns undefined and the caller keeps the deterministic title.
   */
  async function suggestSessionNameFromNode(firstPrompt: string): Promise<string | undefined> {
    const prompt = firstPrompt.trim();
    if (!prompt) return undefined;
    try {
      const headers = await deps.anthropicHeadersFromNodeCredential();
      if (!headers) return undefined;
      // OAuth (Claude Pro/Max) credentials use a Bearer authorization header and
      // are only authorized for Claude Code, so a raw /v1/messages call must lead
      // with the Claude Code identity system block or it's rejected (which left
      // sessions stuck on the first-line fallback name). API keys (x-api-key)
      // carry no such restriction.
      const useOAuth = "authorization" in headers;
      const namingInstruction = "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.";
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: 24,
          temperature: 0.2,
          system: useOAuth
            ? [
                { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
                { type: "text", text: namingInstruction },
              ]
            : namingInstruction,
          messages: [{ role: "user", content: `Create a short title for this coding-agent session using the full first message below:\n\n${prompt.slice(0, 4000)}` }],
        }),
      });
      if (!response.ok) return undefined;
      const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (json.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
      return cleanSessionName(text) || undefined;
    } catch (error) {
      console.warn("Node-level session naming failed", error);
      return undefined;
    }
  }

  async function maybeNameSession(record: NamerSession, firstPrompt: string): Promise<void> {
    if (record.naming || record.namedFromFirstPrompt) return;
    // `namedFromFirstPrompt` lives only in memory — it was never persisted, and a
    // resumed session gets its stored name restored onto the runtime (see
    // createSession) but starts with the flag false. So after any reopen (idle
    // close, PWA reconnect, node restart) the next prompt fell through to naming
    // again and re-derived BOTH the title and the branch from that later
    // message's first line — which is exactly the "session/branch renames on
    // every message" the UI showed. Treat an already-real name as named and leave
    // it (and the branch) untouched; only the creation-time placeholders get a
    // first-message name. This also lets an agent-written name survive: once the
    // runtime sets a real title, later prompts keep it instead of overwriting.
    if (!deps.isPlaceholderName(record.session.getName(), record.id)) {
      record.namedFromFirstPrompt = true;
      return;
    }
    // Once the fallback rename below lands, the title is no longer a
    // "placeholder" by isPlaceholderSessionName's definition — so a retry triggered
    // by a *later* prompt must still title from the session's actual first
    // message, not whatever text happens to trigger the retry. Capture it once
    // and reuse it on every attempt; otherwise a retry would rename (and
    // re-branch) the session from a much later message, which is exactly the
    // "renames on every message" bug this function exists to prevent.
    if (!record.firstNamingPrompt) record.firstNamingPrompt = firstPrompt.trim();
    const prompt = record.firstNamingPrompt;
    if (!prompt) return;

    const MAX_NAMING_ATTEMPTS = 3;

    record.naming = true;
    try {
      // This deterministic rename (unlike the LLM refinement below) must not be
      // allowed to fail silently: maybeNameSession is always invoked fire-and-
      // forget (`void maybeNameSession(...)`), so an exception here previously
      // had no catch anywhere in its call chain — it became an unhandled
      // rejection, and because `namedFromFirstPrompt` is only set true at the
      // very end, the session was left permanently stranded on its creation-time
      // "Session <hex>" placeholder with no retry (a later prompt would still
      // see `record.naming` reset to false by `finally` below and could retry,
      // but the *first* message's name was lost, and if the failure was
      // deterministic — e.g. a metadata-store I/O error — every later prompt
      // would fail the same way and the placeholder would never clear).
      try {
        const fallback = fallbackSessionName(prompt) || `Session ${record.id.slice(0, 8)}`;
        // Always rename deterministically from the first user message, then let the
        // runtime/agent refine it. This keeps the UI useful even if model-based
        // naming fails, and keeps repo branches away from raw prompt text.
        record.session.setName(fallback);
        deps.persistSessionMetadata(record);
        deps.renameBranch(record, fallback);
        deps.broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: fallback, branch: record.worktree?.branch });
        deps.scheduleAdvertise();

        let finalName = fallback;
        let smartNamed = false;
        try {
          // Prefer the runtime's own model-based name (Pi, Claude Code SDK). CLI
          // agents on the dumb-pipe ProcessRuntime return undefined here, so next
          // ask the same provider/model selected for that session when it maps to
          // Pi's registry; only then fall back to the node-level Anthropic namer.
          const suggested = (await record.session.suggestName(prompt)) || (await suggestSessionNameFromSelectedModel(record, prompt)) || (await suggestSessionNameFromNode(prompt));
          if (suggested && suggested !== fallback) { finalName = suggested; smartNamed = true; }
        } catch (error) {
          console.warn("Session naming suggestion failed", error);
        }

        if (finalName !== fallback) {
          record.session.setName(finalName);
          deps.persistSessionMetadata(record);
          deps.renameBranch(record, finalName);
          deps.broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: finalName, branch: record.worktree?.branch });
          deps.scheduleAdvertise();
        }
        // Only lock the title in once a model actually produced one, or once
        // enough attempts have failed that further retries aren't worth it.
        // Previously this was set unconditionally here, so a single transient
        // failure of all three naming tiers (rate limit, network blip, a
        // credential mid-rotation) permanently froze the session on the blunt
        // word-truncated fallback — every session that hit it stayed on the
        // dumb title forever, with the retry the comment above promises never
        // actually happening. Leaving the flag false lets the next prompt's
        // fire-and-forget call retry the smart-naming tiers (still against the
        // captured first prompt above), up to a small cap so a session with no
        // usable credential at all doesn't retry on every single message forever.
        record.namingAttempts = (record.namingAttempts ?? 0) + 1;
        if (smartNamed || record.namingAttempts >= MAX_NAMING_ATTEMPTS) {
          record.namedFromFirstPrompt = true;
        }
      } catch (error) {
        console.error(`Session naming failed for ${record.id} — leaving the placeholder title in place; a later prompt will retry`, error);
      }
    } finally {
      record.naming = false;
    }
  }

  /** Manually set a session's title (e.g. GitHub-issue pickup) and lock it so the
   *  first-prompt namer won't overwrite it. */
  function setSessionName(record: NamerSession, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    record.session.setName(clean);
    record.namedFromFirstPrompt = true; // don't let the first-prompt namer overwrite it
    deps.persistSessionMetadata(record);
    deps.broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: clean, branch: record.worktree?.branch });
    deps.scheduleAdvertise();
  }

  return { maybeNameSession, setSessionName };
}
