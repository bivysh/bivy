// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Client-side slash commands for the Bivy chat composer.
//
// Bivy no longer ships its own control slash-commands (the old "/pr", "/model",
// "/new", …). The ONLY slashes the composer surfaces are the ones the active
// *session* advertises via `capabilities.commands` (per session, not per
// runtime — see AppStore.commandsBySession). This module is the shared,
// framework-agnostic parser/matcher for those agent-native commands, kept in
// @bivy/core so it stays unit-testable (test/slash.test.ts) and reusable by any
// future client (e.g. Expo).
//
// Invoking an advertised command either forwards the raw "/name args" text to
// the agent as a normal prompt (mode "prompt" — the default, used by Pi and
// Claude whose prompt() interprets a leading slash) or issues a dedicated
// `command.invoke` message (mode "protocol").

export interface SlashCommand {
  /** Canonical command name including the leading slash, e.g. "/compact". */
  name: string;
  /** One-line description shown in the command menu. */
  description?: string;
  /** Alternate spellings (with leading slash). */
  aliases?: string[];
  /**
   * How an agent-native command reaches the agent when invoked. Absent (or
   * "prompt") forwards the raw "/name args" line as a normal prompt so the
   * agent's own parser runs it — Pi and Claude Code work this way. "protocol"
   * issues a dedicated `command.invoke` message a shim answers out-of-band.
   */
  mode?: "prompt" | "protocol";
}

export interface ParsedSlash {
  /** Command name (lower-cased), including the leading slash. */
  name: string;
  /** Everything after the command word, trimmed. */
  args: string;
}

/** True when `text` looks like a slash-command invocation ("/" then a letter). */
export function isSlashInput(text: string): boolean {
  return /^\/[a-zA-Z]/.test(text.trimStart());
}

/**
 * True when an advertised agent command is well-formed enough to trust in the
 * menu/dispatch: a string `name` beginning with "/" and at least one more
 * character. Hardens every consumer against malformed handshake data (a shim
 * that advertised junk, or a partial capability payload).
 */
export function isValidAgentCommand(c: unknown): c is SlashCommand {
  return Boolean(
    c &&
      typeof c === "object" &&
      typeof (c as SlashCommand).name === "string" &&
      (c as SlashCommand).name.startsWith("/") &&
      (c as SlashCommand).name.length >= 2,
  );
}

/**
 * Parse "/cmd the rest" into `{ name: "/cmd", args: "the rest" }`, lower-casing
 * the command word. Returns null when the input is not a slash command. An
 * UNKNOWN command still parses (name returned as typed) so the caller can report
 * "unknown command" rather than leaking the text to the agent.
 */
export function parseSlash(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!isSlashInput(trimmed)) return null;
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!m || !m[1]) return null;
  const args = (m[2] ?? "").trim();
  return { name: `/${m[1].toLowerCase()}`, args };
}

/**
 * Resolve a parsed slash line against the active agent's advertised commands.
 *   - "agent": an advertised command of that name was found.
 *   - "unknown": no match. `hasCatalog` tells the caller whether the session
 *     advertised any commands at all, so it can reject (catalog present) vs.
 *     permissively forward the raw line to the agent (no catalog — back-compat
 *     for runtimes that advertise nothing and parse slashes themselves).
 */
export type SlashResolution =
  | { kind: "agent"; command: SlashCommand; args: string }
  | { kind: "unknown"; name: string; hasCatalog: boolean };

export function resolveSlash(parsed: ParsedSlash, extra: SlashCommand[] = []): SlashResolution {
  const valid = extra.filter(isValidAgentCommand);
  const hasCatalog = valid.length > 0;
  const command = valid.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
  if (command) return { kind: "agent", command, args: parsed.args };
  return { kind: "unknown", name: parsed.name, hasCatalog };
}

/**
 * The advertised commands whose name (or alias) starts with the given "/…"
 * prefix, for the composer's autocomplete menu. Returns nothing once the user
 * has typed a space (they're past the command word). "/" alone returns every
 * advertised command. Malformed entries are dropped.
 */
export function matchSlashCommands(prefix: string, extra: SlashCommand[] = []): SlashCommand[] {
  const p = prefix.trimStart().toLowerCase();
  if (!p.startsWith("/") || /\s/.test(p)) return [];
  const all = extra.filter(isValidAgentCommand);
  if (p === "/") return all;
  return all.filter(
    (c) => c.name.toLowerCase().startsWith(p) || c.aliases?.some((a) => a.toLowerCase().startsWith(p)),
  );
}

/**
 * A human-readable help block listing the active session's advertised agent
 * commands, for the `/help` output. Returns a friendly line when the session
 * advertised none.
 */
export function slashHelpText(extra: SlashCommand[] = []): string {
  const describe = (c: SlashCommand) => {
    const names = [c.name, ...(c.aliases ?? [])].join(", ");
    return c.description ? `${names} — ${c.description}` : names;
  };
  const lines = extra.filter(isValidAgentCommand).map(describe);
  if (!lines.length) return "No commands available for this agent.";
  return ["Commands:", ...lines].join("\n");
}
