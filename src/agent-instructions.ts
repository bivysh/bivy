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
 * the empty state carries a timestamp and propagates too. The one switch beside
 * the text — whether sessions also get the Bivy note — lives in a small sidecar
 * file and shares that clock: flipping it rewrites AGENTS.md's timestamp.
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
  /** Send BIVY_AGENT_NOTE ahead of the text. On unless the user turned it off. */
  bivyNote: boolean;
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
  "- Show an IMAGE (screenshot, chart, diagram) inside your reply: write it as markdown, " +
    "`![short caption](relative/path.png)`, where you want it to appear. The path must be inside the session " +
    "workspace; a remote `https://` image works too. No tool call needed.",
  "- Send a FILE, or an image on its own (a report, a download they asked for): run " +
    '`bivy attach <path> [--caption "short note"]`, or call the `attach_to_chat` tool if you have it. Same ' +
    "workspace-only rule; files arrive as downloads.",
  "- Something with a UI: `bivy app publish <manifest.json>` (a web server's port, a static build, a terminal) or " +
    "`bivy app run -- <command>` (a desktop app) gives the user a live preview; `bivy app shot` screenshots it so you " +
    "can check your work; `bivy app present` tells the user a visible change is ready to look at, and " +
    "`.bivy/scenarios/*.json` files let them open it in the states that matter (errors, empty, slow) with `--try`. " +
    "`bivy app --help` has the details.",
  '- If this session\'s title (taken from the first message) doesn\'t say what the work is, or the work changes ' +
    'direction: `bivy title "<short title>"`.',
  "- Your chat reply is what the user reads; when you finish while they are away, Bivy pushes to their phone for you. " +
    'To bring them back while you keep working: `bivy notify` (a push only; say what you need in the chat). To ask ' +
    'and wait for an answer: `bivy ask "<question>" [--option A --option B]` prints their answer (or use your own ' +
    "ask-the-user tool).",
  "- Only when the user asks for another agent or another of their machines to take part: " +
    '`bivy delegate "<self-contained task>" --agent <id> [--machine <name>] --wait` runs it there and prints ' +
    "its answer and any branch/PR; `--to codex,grok@<machine>` asks several to compare, `bivy delegate machines` " +
    "lists machines and their agents. Use your own sub-agents for everything else.",
  "- Work that should run on its own later (on a schedule, or when CI fails or an issue arrives) is a Bivy automation: " +
    "`bivy guide automate`. Applying one may ask the user first.",
  "- `bivy context` shows your session, workspace and published apps; `bivy guide` has short playbooks; " +
    "`bivy help` lists every command (`--json` for all).",
].join("\n");

const PREAMBLE =
  "The user's global Bivy instructions follow. They apply to every workspace; where they conflict with " +
  "instructions from the current repository (AGENTS.md, CLAUDE.md, …), the repository's instructions win.";

export function agentInstructionsPath(appDir: string): string {
  return path.join(appDir, "AGENTS.md");
}

function optionsPath(appDir: string): string {
  return path.join(appDir, "agent-instructions.json");
}

function readBivyNote(appDir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(optionsPath(appDir), "utf8")) as { bivyNote?: unknown }).bivyNote !== false;
  } catch {
    return true;
  }
}

function composedPath(appDir: string): string {
  return path.join(appDir, "agent-instructions.composed.md");
}

export function readAgentInstructions(appDir: string): AgentInstructions {
  const bivyNote = readBivyNote(appDir);
  try {
    const file = agentInstructionsPath(appDir);
    return { text: fs.readFileSync(file, "utf8"), updatedAt: Math.trunc(fs.statSync(file).mtimeMs), bivyNote };
  } catch {
    return { text: "", updatedAt: 0, bivyNote };
  }
}

/** Write the text (and optionally the Bivy-note switch), stamped `updatedAt`. */
export function writeAgentInstructions(appDir: string, text: string, updatedAt = Date.now(), bivyNote?: boolean): AgentInstructions {
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error(`Agent instructions are limited to ${MAX_AGENT_INSTRUCTIONS_BYTES / 1024} KB.`);
  }
  const file = agentInstructionsPath(appDir);
  fs.mkdirSync(appDir, { recursive: true });
  if (bivyNote !== undefined) fs.writeFileSync(optionsPath(appDir), `${JSON.stringify({ bivyNote })}\n`);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(updatedAt), new Date(updatedAt));
  return readAgentInstructions(appDir);
}

/**
 * Reconcile a synced copy with the local file (last writer wins).
 * - "imported": the synced copy was newer and is now the local file.
 * - "local-newer": this machine holds a newer copy the account should get.
 * - "unchanged": nothing to do.
 * A synced copy without `bivyNote` comes from a peer that predates the switch,
 * where the note was always on.
 */
export function mergeSyncedAgentInstructions(appDir: string, incoming: unknown): "imported" | "local-newer" | "unchanged" {
  const local = readAgentInstructions(appDir);
  const synced = incoming && typeof incoming === "object" ? (incoming as Partial<AgentInstructions>) : undefined;
  if (typeof synced?.text !== "string" || typeof synced.updatedAt !== "number") {
    return local.updatedAt > 0 ? "local-newer" : "unchanged";
  }
  const bivyNote = synced.bivyNote !== false;
  if (synced.text === local.text && bivyNote === local.bivyNote) return "unchanged";
  if (synced.updatedAt > local.updatedAt) {
    writeAgentInstructions(appDir, synced.text, synced.updatedAt, bivyNote);
    return "imported";
  }
  return "local-newer";
}

/** The Bivy note (unless switched off), then the user's text (if any) under the precedence preamble. */
export function composeAgentInstructions(text: string, bivyNote = true): string {
  const body = text.trim();
  return [bivyNote ? BIVY_AGENT_NOTE : "", body ? `${PREAMBLE}\n\n${body}` : ""].filter(Boolean).map((part) => `${part}\n`).join("\n");
}

/**
 * The instructions for a session starting now, or undefined when there is
 * nothing to send (no text and the Bivy note switched off) or the file can't be
 * written. Keeps a composed copy on disk (rewritten only when it changes) for
 * agents that take a file path rather than text.
 */
export function sessionInstructions(appDir: string): SessionInstructions | undefined {
  const { text: userText, bivyNote } = readAgentInstructions(appDir);
  const text = composeAgentInstructions(userText, bivyNote);
  const file = composedPath(appDir);
  try {
    if (!text) {
      // An MCP server spec injected earlier may still point here; don't let it
      // serve instructions the user has since cleared.
      fs.rmSync(file, { force: true });
      return undefined;
    }
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
