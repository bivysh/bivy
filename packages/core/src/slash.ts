// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Client-side slash commands for the Bivy chat composer.
//
// Slash commands used to work only in the (since-removed) Bivy terminal TUI. The
// React/PWA composer had no parser at all, so typing "/model" or "/pr" sent the
// literal text to the agent as a normal prompt — the command silently did
// nothing. That is the "slash commands don't work through the React app" bug.
//
// This module is the shared, framework-agnostic source of truth for the
// commands the web client understands, plus a small parser/matcher. Keeping it
// in @bivy/core makes the parser unit-testable (test/slash.test.ts) and reusable
// by any future client (e.g. Expo). The dispatch itself lives in the client,
// since each Bivy command maps to a first-class client action (open a picker,
// open a PR, start a session).
//
// Agent-native slashes (Claude Code's `/compact`, a shim's `/status`, …) are
// ALSO supported: the active *session* advertises them via `capabilities.commands`
// (per session, not per runtime — see AppStore.commandsBySession), the composer
// merges them into this menu (matchSlashCommands' `extra` arg), and invoking one
// either forwards the raw "/name args" text to the agent as a normal prompt
// (mode "prompt" — the default, used by Pi and Claude whose prompt() interprets a
// leading slash) or issues a dedicated `command.invoke` message (mode "protocol").
//
// Collisions: a Bivy control command always wins its own name, so `/model`
// opens Bivy's picker. The colliding agent command stays reachable through the
// `/agent:<name>` escape hatch, e.g. `/agent:model` runs Claude/Codex's own
// `/model`.

export interface SlashCommand {
  /** Canonical command name including the leading slash, e.g. "/pr". */
  name: string;
  /** One-line description shown in the command menu. */
  description?: string;
  /** Alternate spellings (with leading slash), e.g. "/stop" for "/abort". */
  aliases?: string[];
  /**
   * How an agent-native command reaches the agent when invoked. Absent (or
   * "prompt") forwards the raw "/name args" line as a normal prompt so the
   * agent's own parser runs it — Pi and Claude Code work this way. "protocol"
   * issues a dedicated `command.invoke` message a shim answers out-of-band.
   * Bivy control commands (SLASH_COMMANDS) leave this unset; it only applies to
   * advertised agent commands.
   */
  mode?: "prompt" | "protocol";
}

/**
 * The commands the composer recognises. These are Bivy control commands (manage
 * the session/model/PR), not agent-authoring commands — agent-native slashes
 * like Claude Code's `/compact` arrive per session via `capabilities.commands`
 * and are merged in separately (see matchSlashCommands' `extra`).
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/pr", description: "Commit, push, and open a pull request for this repo session." },
  { name: "/github-status", description: "Force a fresh GitHub PR status check for this session." },
  { name: "/new", description: "Start a new session in the current workspace." },
  { name: "/model", description: "Choose the model for this session." },
  { name: "/agent", description: "Choose the agent for this session." },
  { name: "/abort", description: "Stop the current turn.", aliases: ["/stop"] },
  { name: "/help", description: "List the available commands." },
];

/** The prefix that scopes a slash to the active agent's own command, bypassing a
 *  Bivy control command of the same name — e.g. "/agent:model" → the agent's
 *  "/model" even though Bivy's "/model" would otherwise win. */
export const AGENT_SCOPE_PREFIX = "/agent:";

export interface ParsedSlash {
  /** Canonical command name (alias resolved), including the leading slash. */
  name: string;
  /** Everything after the command word, trimmed. */
  args: string;
  /**
   * True when the user explicitly scoped to the agent via "/agent:<name>",
   * forcing the agent's own command even when a Bivy control command shares the
   * name. `name` is the un-scoped command ("/model" for "/agent:model").
   */
  agentScoped?: boolean;
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

/** The `/agent:<name>` escape-hatch spelling for an agent command. */
export function agentScopedName(name: string): string {
  return `${AGENT_SCOPE_PREFIX}${name.replace(/^\/+/, "")}`;
}

/**
 * Parse "/cmd the rest" into `{ name: "/cmd", args: "the rest" }`, lower-casing
 * and alias-resolving the command word. Returns null when the input is not a
 * slash command. An UNKNOWN command still parses (name returned as typed) so the
 * caller can report "unknown command" rather than leaking the text to the agent.
 *
 * "/agent:<name>" is recognised as the escape hatch: it sets `agentScoped` and
 * returns the un-scoped `name` ("/agent:model" → name "/model"), with no alias
 * resolution (the user asked for the agent's literal command).
 */
export function parseSlash(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!isSlashInput(trimmed)) return null;
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!m || !m[1]) return null;
  const args = (m[2] ?? "").trim();
  const rawWord = m[1].toLowerCase();
  // Escape hatch: "/agent:model" targets the agent's own "/model". "/agent"
  // (and "/agent foo") without a colon stays the Bivy control command.
  if (rawWord.startsWith("agent:")) {
    const scoped = rawWord.slice("agent:".length);
    if (scoped) return { name: `/${scoped}`, args, agentScoped: true };
  }
  const word = `/${rawWord}`;
  return { name: resolveAlias(word), args };
}

function resolveAlias(word: string): string {
  for (const c of SLASH_COMMANDS) {
    if (c.name === word || c.aliases?.includes(word)) return c.name;
  }
  return word; // unknown — return as typed
}

/** Look up a known Bivy control command by canonical name or alias. */
export function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/**
 * The active agent's advertised commands, validated and de-collided for menu/help
 * use: malformed entries dropped, split into those that don't clash with a Bivy
 * command (offered under their own name) and those that do (only reachable via
 * the `/agent:<name>` escape hatch).
 */
function partitionAgentCommands(extra: SlashCommand[]): { direct: SlashCommand[]; scoped: SlashCommand[] } {
  const valid = extra.filter(isValidAgentCommand);
  const direct: SlashCommand[] = [];
  const scoped: SlashCommand[] = [];
  for (const c of valid) {
    if (findSlashCommand(c.name)) scoped.push({ ...c, name: agentScopedName(c.name) });
    else direct.push(c);
  }
  return { direct, scoped };
}

/**
 * Resolve a parsed slash line against the active agent's advertised commands.
 * Encodes the dispatch precedence the composer follows:
 *   1. "/agent:<name>" → the agent's own command (or unknown if it advertised none).
 *   2. A Bivy control command wins its own name.
 *   3. Otherwise an advertised agent command of that name.
 *   4. Unknown — `hasCatalog` tells the caller whether the session advertised any
 *      commands at all, so it can reject (catalog present) vs. permissively forward
 *      the raw line to the agent (no catalog — back-compat for runtimes that
 *      advertise nothing).
 */
export type SlashResolution =
  | { kind: "bivy"; name: string; args: string }
  | { kind: "agent"; command: SlashCommand; args: string }
  | { kind: "unknown"; name: string; hasCatalog: boolean };

export function resolveSlash(parsed: ParsedSlash, extra: SlashCommand[] = []): SlashResolution {
  const valid = extra.filter(isValidAgentCommand);
  const hasCatalog = valid.length > 0;
  const findAgent = (name: string) => valid.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (parsed.agentScoped) {
    const command = findAgent(parsed.name);
    return command ? { kind: "agent", command, args: parsed.args } : { kind: "unknown", name: agentScopedName(parsed.name), hasCatalog };
  }
  if (findSlashCommand(parsed.name)) return { kind: "bivy", name: parsed.name, args: parsed.args };
  const command = findAgent(parsed.name);
  if (command) return { kind: "agent", command, args: parsed.args };
  return { kind: "unknown", name: parsed.name, hasCatalog };
}

/**
 * Commands whose name (or alias) starts with the given "/…" prefix, for the
 * composer's autocomplete menu. Returns nothing once the user has typed a space
 * (they're past the command word). "/" alone returns every command.
 *
 * `extra` are the active session's advertised commands (capabilities.commands),
 * appended after the Bivy control commands. Agent commands whose name collides
 * with a Bivy command are re-surfaced under their `/agent:<name>` escape-hatch
 * spelling so they stay discoverable without shadowing the Bivy action.
 */
export function matchSlashCommands(prefix: string, extra: SlashCommand[] = []): SlashCommand[] {
  const p = prefix.trimStart().toLowerCase();
  if (!p.startsWith("/") || /\s/.test(p)) return [];
  const { direct, scoped } = partitionAgentCommands(extra);
  const all = [...SLASH_COMMANDS, ...direct, ...scoped];
  if (p === "/") return all;
  return all.filter(
    (c) => c.name.toLowerCase().startsWith(p) || c.aliases?.some((a) => a.toLowerCase().startsWith(p)),
  );
}

/**
 * A human-readable help block listing every command, for the `/help` output.
 * `extra` are the active session's advertised agent commands; they're appended
 * under an "Agent commands" heading (colliding ones shown via `/agent:<name>`).
 */
export function slashHelpText(extra: SlashCommand[] = []): string {
  const describe = (c: SlashCommand) => {
    const names = [c.name, ...(c.aliases ?? [])].join(", ");
    return c.description ? `${names} — ${c.description}` : names;
  };
  const lines = SLASH_COMMANDS.map(describe);
  const { direct, scoped } = partitionAgentCommands(extra);
  const agentLines = [...direct, ...scoped].map(describe);
  const blocks = ["Commands:", ...lines];
  if (agentLines.length) blocks.push("", "Agent commands:", ...agentLines);
  return blocks.join("\n");
}
