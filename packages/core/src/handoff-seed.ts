// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A hand-off seed is the first prompt that carries a conversation into an agent
// that couldn't import it natively: a cross-agent fork, or a session imported
// from outside Bivy. It is written for the agent, not the reader — the
// transcript above it already shows the same conversation — so clients render it
// as a compact "context handed over" line instead of a wall of user text.
//
// The node writes these (src/session/transcript-normal.ts buildSeedPrompt and
// src/session/native-import.ts). One row per shape; a new seed is a new row.

export interface HandoffSeed {
  kind: "fork" | "import";
  /** The agent (runtime id or display name) the conversation came from. */
  from: string;
}

const SEEDS: Array<{ kind: HandoffSeed["kind"]; pattern: RegExp }> = [
  { kind: "fork", pattern: /^I am continuing an existing Bivy session \(forked from (.+?) to .+?\)\./ },
  { kind: "import", pattern: /^I am continuing an? (.+?) session that was started outside Bivy and imported here\./ },
];

/** The hand-off a user message carries, or undefined for an ordinary prompt. */
export function handoffSeedOf(text: string | undefined): HandoffSeed | undefined {
  if (!text) return undefined;
  for (const seed of SEEDS) {
    const match = seed.pattern.exec(text);
    if (match) return { kind: seed.kind, from: match[1]! };
  }
  return undefined;
}
