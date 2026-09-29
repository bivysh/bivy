// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import type { SessionInstructions } from "./runtime/types.js";

/**
 * Account-wide agent instructions: one Markdown file of the user's global
 * preferences, handed to every agent session IN ADDITION to the repo's own
 * AGENTS.md/CLAUDE.md (which the agent keeps loading itself).
 *
 * The source of truth on a machine is `<appDir>/AGENTS.md` — plain Markdown the
 * user can also edit by hand. Its mtime is the last-writer-wins clock: the
 * account-wide copy rides in the E2E model-auth vault envelope (see server.ts),
 * and a synced import stamps the file with the writer's timestamp so every
 * machine compares like with like. Clearing is an empty file, not a delete, so
 * the empty state carries a timestamp and propagates too.
 *
 * Delivery is the caller's business; this module only produces the composed
 * text (and a file holding it, for agents that take a path).
 */

/** Cap on the editable text. It rides on every turn of every session. */
export const MAX_AGENT_INSTRUCTIONS_BYTES = 16 * 1024;

export interface AgentInstructions {
  text: string;
  /** Epoch ms of the last write; 0 when no file exists yet. */
  updatedAt: number;
}

/**
 * What every agent session is told about running under Bivy, whether or not the
 * user wrote instructions: that the user is in a chat, and which `bivy` commands
 * reach it. The commands read $BIVY_SESSION_ID (src/runtime/session-env.ts), so
 * this works for any agent with a shell. Keep it short: it rides on every turn.
 */
export const BIVY_AGENT_NOTE = [
  "You are running inside Bivy. The user follows this session in a chat app (web or phone): they cannot see your " +
    "terminal or files you only write to disk. $BIVY_SESSION_ID identifies this session; the `bivy` commands below use it.",
  "- Show a LOCAL file or image (report, screenshot, chart, a file they asked for): run " +
    '`bivy attach <path> [--caption "short note"]`, or call the `attach_to_chat` tool if you have it. Images render ' +
    "inline, other files as downloads; the path must be inside the session workspace. Markdown image syntax like " +
    "![](path) does not render a local path. A REMOTE `https://` image in markdown does render.",
  "- Something with a UI: `bivy app publish <manifest.json>` (a web server's port, a static build, a terminal) or " +
    "`bivy app run -- <command>` (a desktop app) gives the user a live preview; `bivy app shot` screenshots it so you " +
    "can check your work; `bivy app present` tells the user a visible change is ready to look at. " +
    "`bivy app --help` has the details.",
].join("\n");

const PREAMBLE =
  "The user's global Bivy instructions follow. They apply to every workspace; where they conflict with " +
  "instructions from the current repository (AGENTS.md, CLAUDE.md, …), the repository's instructions win.";

export function agentInstructionsPath(appDir: string): string {
  return path.join(appDir, "AGENTS.md");
}

function composedPath(appDir: string): string {
  return path.join(appDir, "agent-instructions.composed.md");
}

export function readAgentInstructions(appDir: string): AgentInstructions {
  try {
    const file = agentInstructionsPath(appDir);
    return { text: fs.readFileSync(file, "utf8"), updatedAt: Math.trunc(fs.statSync(file).mtimeMs) };
  } catch {
    return { text: "", updatedAt: 0 };
  }
}

export function writeAgentInstructions(appDir: string, text: string, updatedAt = Date.now()): AgentInstructions {
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error(`Agent instructions are limited to ${MAX_AGENT_INSTRUCTIONS_BYTES / 1024} KB.`);
  }
  const file = agentInstructionsPath(appDir);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(updatedAt), new Date(updatedAt));
  return readAgentInstructions(appDir);
}

/**
 * Reconcile a synced copy with the local file (last writer wins).
 * - "imported": the synced copy was newer and is now the local file.
 * - "local-newer": this machine holds a newer copy the account should get.
 * - "unchanged": nothing to do.
 */
export function mergeSyncedAgentInstructions(appDir: string, incoming: unknown): "imported" | "local-newer" | "unchanged" {
  const local = readAgentInstructions(appDir);
  const synced = incoming && typeof incoming === "object" ? (incoming as Partial<AgentInstructions>) : undefined;
  if (typeof synced?.text !== "string" || typeof synced.updatedAt !== "number") {
    return local.updatedAt > 0 ? "local-newer" : "unchanged";
  }
  if (synced.text === local.text) return "unchanged";
  if (synced.updatedAt > local.updatedAt) {
    writeAgentInstructions(appDir, synced.text, synced.updatedAt);
    return "imported";
  }
  return "local-newer";
}

/** The Bivy note, then the user's text (if any) under the precedence preamble. */
export function composeAgentInstructions(text: string): string {
  const body = text.trim();
  return body ? `${BIVY_AGENT_NOTE}\n\n${PREAMBLE}\n\n${body}\n` : `${BIVY_AGENT_NOTE}\n`;
}

/**
 * The instructions for a session starting now: always at least the Bivy note.
 * Keeps a composed copy on disk (rewritten only when it changes) for agents
 * that take a file path rather than text. Undefined only if that file can't be
 * written.
 */
export function sessionInstructions(appDir: string): SessionInstructions | undefined {
  const text = composeAgentInstructions(readAgentInstructions(appDir).text);
  const file = composedPath(appDir);
  try {
    fs.mkdirSync(appDir, { recursive: true });
    let current: string | undefined;
    try { current = fs.readFileSync(file, "utf8"); } catch { /* not written yet */ }
    if (current !== text) fs.writeFileSync(file, text);
    return { text, file };
  } catch (error) {
    // Never block a session on this; it just starts without them.
    console.warn("[agent-instructions] could not prepare instructions:", (error as Error).message);
    return undefined;
  }
}
