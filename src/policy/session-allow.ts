// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Session-scoped "always allow" for approval prompts — the approval card's
// "Allow `git status` for this session" action.
//
// Deliberately narrow: rules live in memory only, are keyed by session, and
// vanish when the session closes. Persistent per-tool allow/deny rules were
// removed from Bivy on purpose (governance beyond the floor belongs to the
// agents); this is the smallest thing that stops a user in `always`/`risky`
// mode from approving the same harmless command twenty times in one turn.
//
// What a rule can never do: override the catastrophic floor (a deny, not an
// ask) or silence a backstop / risky-integration prompt. PolicyEngine enforces
// that — a rule only applies to the mode-driven asks.
import { bashCommand, isShellTool } from "../guard.js";

/** The thing a rule remembers. For shell tools it's the program plus its
 *  subcommand when there is one (`git status`, `npm test`, `ls`), so allowing
 *  `git status` never pre-approves `git push`. For every other tool it's the
 *  tool name (`edit`, `write`). Returned to the client so the button can say
 *  exactly what it will remember. */
export function approvalRememberKey(toolName: string, input: unknown): string {
  const tool = toolName.toLowerCase();
  if (!isShellTool(tool)) return tool;
  const words = bashCommand(input).trim().split(/\s+/).filter(Boolean);
  const program = words[0];
  if (!program) return tool;
  const sub = words[1];
  const hasSubcommand = sub !== undefined && /^[a-z][a-z0-9-]*$/i.test(sub);
  return hasSubcommand ? `${program} ${sub}` : program;
}

export class SessionAllowRules {
  private readonly rules = new Map<string, Set<string>>();

  allow(sessionId: string, key: string): void {
    let set = this.rules.get(sessionId);
    if (!set) {
      set = new Set();
      this.rules.set(sessionId, set);
    }
    set.add(key);
  }

  has(sessionId: string, key: string): boolean {
    return this.rules.get(sessionId)?.has(key) ?? false;
  }

  /** Forget every rule for a session — called on close/kill so a rule never
   *  outlives the conversation it was granted in. */
  clear(sessionId: string): void {
    this.rules.delete(sessionId);
  }

  list(sessionId: string): string[] {
    return [...(this.rules.get(sessionId) ?? [])];
  }
}
