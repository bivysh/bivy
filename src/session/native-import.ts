// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Seeded-continuation prompt for importing a discovered provider-native
// session (issue #156) when a true native resume isn't available — the
// session-level sibling of session/fork.ts's cross-runtime seed path. Pure and
// side-effect-free (no filesystem/runtime access) so it's unit-testable with
// synthetic transcripts.
//
// This is deliberately a THIN, import-specific wrapper around
// transcript-normal.ts's shared primitives rather than a copy: normalizeMessages
// flattens the runtime's RuntimeMessage[] into portable turns exactly as fork
// does, but the prompt wording here is honest about being an IMPORT (same
// runtime, no resume available) rather than fork's "moved to a different
// agent" framing — those are different user-facing claims and must not be
// conflated.

import { normalizeMessages, type NormalizedTranscript, type NormalizedTranscriptHeader } from "./transcript-normal.js";
import type { RuntimeMessage } from "../runtime/types.js";

export interface NativeImportSeedOptions {
  /** The provider's display name, e.g. "Codex". */
  provider: string;
  /** The discovered session's title/first-prompt summary, when known. */
  title?: string;
  /** Working directory the original session ran in, when known. */
  cwd?: string;
  /** Max recent turns to inline (default 12, same default as fork's seed). */
  recentTurns?: number;
  /** Per-turn text cap (default 700 chars). */
  perTurnChars?: number;
}

function truncate(text: string, max: number): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

/**
 * Build the first prompt for a seeded import: a compact summary of the
 * discovered session's recent turns, framed honestly as a best-effort
 * continuation rather than a true resume. Bounded (recent turns + a per-turn
 * character cap, same shape as fork's buildSeedPrompt) so this never inlines
 * an entire transcript — the "bounded metadata only" spirit of discovery
 * extends to what a seeded import is willing to carry into the new session.
 */
export function buildNativeImportSeedPrompt(transcript: NormalizedTranscript, opts: NativeImportSeedOptions): string {
  const recentTurns = opts.recentTurns ?? 12;
  const perTurnChars = opts.perTurnChars ?? 700;
  const title = opts.title || transcript.header.title || "Untitled session";
  const recent = transcript.turns
    .filter((t) => t.text || t.toolSummary)
    .slice(-recentTurns)
    .map((t) => {
      const body = t.text || (t.toolSummary ? `[${t.toolName ?? "tool"}] ${t.toolSummary}` : "");
      return `- ${t.role}: ${truncate(body, perTurnChars)}`;
    })
    .join("\n");
  const lines = [
    `I am continuing a ${opts.provider} session that was started outside Bivy and imported here.`,
    `Native resume wasn't available for it, so this is a fresh session seeded with a summary of the prior conversation — not the original session itself.`,
    `Session: ${title}`,
    opts.cwd ? `Working directory: ${opts.cwd}` : null,
    "",
    "Recent conversation (most recent last):",
    recent || "- (no prior turns were available)",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

/** Convenience: normalize + seed in one call, for the common case of reading a
 *  runtime's raw messages straight off disk. */
export function buildNativeImportSeedFromMessages(
  messages: readonly RuntimeMessage[] | undefined,
  header: NormalizedTranscriptHeader,
  opts: NativeImportSeedOptions,
): string {
  return buildNativeImportSeedPrompt(normalizeMessages(messages, header), opts);
}
