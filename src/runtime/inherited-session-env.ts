// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Agents mark the shells they run with variables that say "you are inside my
// session". A node started from such a shell (an agent ran `bivy`, a dev node,
// a setup script) inherits them, and every agent the node launches would think
// it is a child of that session. Claude Code then stops saving its transcript
// (CLAUDE_CODE_CHILD_SESSION), which history, takeover and fork read. The node
// itself is never part of a session, so it drops these once at startup.
//
// Exact names, not prefixes: CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN and
// similar are the user's own configuration and must reach the agents.

/** Variables an agent sets in its own shells to mark its session. */
export const INHERITED_SESSION_MARKERS: readonly string[] = [
  // Claude Code (and the Claude Agent SDK)
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  // Codex
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  // OpenCode
  "OPENCODE",
  "OPENCODE_PID",
  // Grok
  "GROK_AGENT",
  "GROK_SESSION_ID",
  // Generic "run by an agent" markers
  "AGENT",
  "AI_AGENT",
  // Bivy's own per-session identity (see session-env.ts)
  "BIVY_SESSION_ID",
  "BIVY_SESSION_TOKEN",
];

/** Remove inherited session markers from `env` in place; returns the names removed. */
export function scrubInheritedSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of INHERITED_SESSION_MARKERS) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}
