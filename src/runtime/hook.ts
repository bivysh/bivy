// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeEvent } from "./types.js";

/**
 * The turn is waiting on one of the user's own hooks (a PreToolUse check, a
 * Stop hook, …). Every runtime reports it in this one shape, `agent_hook`, so
 * clients show the same "Running PreToolUse hook…" status for any agent instead
 * of looking stuck, and never mistake the wait for a tool call. It is a status,
 * not a chat entry.
 */
export interface AgentHook {
  /** The hook event: Claude's `PreToolUse`, Codex's `preToolUse`, … */
  hook?: unknown;
  /** A running hook, or one that has just finished. */
  done?: unknown;
}

export function agentHookEvent(hook: AgentHook): RuntimeEvent {
  const raw = typeof hook.hook === "string" ? hook.hook.trim() : "";
  // One spelling for every agent: Codex sends camelCase, Claude PascalCase.
  const name = raw ? raw[0]!.toUpperCase() + raw.slice(1) : "";
  return { type: "agent_hook", ...(name ? { hook: name } : {}), ...(hook.done === true ? { done: true } : {}) };
}
