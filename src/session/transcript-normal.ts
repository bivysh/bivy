import type { RuntimeMessage } from "../runtime/types.js";

/**
 * Runtime-neutral transcript for session **fork** (see docs/session-fork-plan.md).
 *
 * A byte-exact transcript only round-trips within one runtime (pi's session
 * file, Claude Code's `~/.claude` jsonl), so a fork that changes agent goes
 * through this normalized form instead. Every wrapped runtime already exposes
 * its transcript as `RuntimeMessage[]` (`{ role, content }`, content a string or
 * an Anthropic-style block array) via `readMessages()`; `normalizeMessages`
 * flattens that shared shape into portable turns, and `buildSeedPrompt` renders
 * a compact continuation context for a runtime that can't natively replay
 * foreign history.
 *
 * Fidelity is explicit end-to-end so continuity is never silently lossy:
 *   - "full"   — same runtime: the raw transcript is transported and resumed.
 *   - "seeded" — different runtime: the destination seeds a single context turn
 *                (recent turns + a link to the full original transcript).
 */

export type ForkFidelity = "full" | "seeded";

export type NormalizedRole = "user" | "assistant" | "tool" | "error";

export interface NormalizedTurn {
  role: NormalizedRole;
  /** Human-readable text for this turn (tool payloads compacted, not raw). */
  text: string;
  /** Tool name when the turn is (or contains) a tool call/result. */
  toolName?: string;
  /** Compacted one-line tool activity — never the raw tool input/output. */
  toolSummary?: string;
  /** Epoch ms when known. */
  ts?: number;
}

export interface NormalizedTranscriptHeader {
  sourceRuntimeId: string;
  model?: string;
  title?: string;
  createdAt: string;
}

export interface NormalizedTranscript {
  header: NormalizedTranscriptHeader;
  turns: NormalizedTurn[];
}

/** Cap a tool payload down to a short, log-safe one-liner. */
function compactValue(value: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

/** Flatten one runtime message's content into text + tool annotations. */
function readContent(content: unknown): { text: string; tools: Array<{ name?: string; summary: string }>; toolResultOnly: boolean } {
  if (typeof content === "string") {
    return { text: content, tools: [], toolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", tools: [], toolResultOnly: false };
  }
  const texts: string[] = [];
  const tools: Array<{ name?: string; summary: string }> = [];
  let sawText = false;
  let sawToolResult = false;
  for (const raw of content as Block[]) {
    const type = raw?.type;
    if (type === "text" && typeof raw.text === "string") {
      texts.push(raw.text);
      sawText = true;
    } else if (type === "tool_use") {
      tools.push({ name: raw.name, summary: `${raw.name ?? "tool"}(${compactValue(raw.input)})` });
    } else if (type === "tool_result") {
      sawToolResult = true;
      tools.push({ name: undefined, summary: `→ ${compactValue(raw.content)}` });
    }
    // "thinking" and unknown block types are intentionally dropped: internal
    // reasoning is neither portable across runtimes nor needed for continuity.
  }
  return { text: texts.join("\n").trim(), tools, toolResultOnly: sawToolResult && !sawText };
}

function normalizeRole(role: unknown, toolResultOnly: boolean): NormalizedRole {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "error") return "error";
  // A "user" message that is purely tool_result is really tool output.
  if (role === "user") return toolResultOnly ? "tool" : "user";
  return "user";
}

function toTs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/**
 * Flatten a runtime transcript (`readMessages()` output) into portable turns.
 * Pure and defensive: unknown shapes degrade to empty text rather than throwing.
 */
export function normalizeMessages(
  messages: readonly RuntimeMessage[] | undefined,
  header: NormalizedTranscriptHeader,
): NormalizedTranscript {
  const turns: NormalizedTurn[] = [];
  for (const message of messages ?? []) {
    const m = message as { role?: unknown; content?: unknown; timestamp?: unknown; ts?: unknown };
    const { text, tools, toolResultOnly } = readContent(m.content);
    const role = normalizeRole(m.role, toolResultOnly);
    const namedTool = tools.find((t) => t.name)?.name;
    const toolSummary = tools.length ? tools.map((t) => t.summary).join("; ") : undefined;
    // Skip turns that carry nothing a destination could use.
    if (!text && !toolSummary) continue;
    turns.push({
      role,
      text,
      ...(namedTool ? { toolName: namedTool } : {}),
      ...(toolSummary ? { toolSummary } : {}),
      ...(toTs(m.timestamp ?? m.ts) !== undefined ? { ts: toTs(m.timestamp ?? m.ts) } : {}),
    });
  }
  return { header, turns };
}

export interface SeedPromptOptions {
  /** Max recent turns to inline (default 12). */
  recentTurns?: number;
  /** Per-turn text cap (default 700 chars). */
  perTurnChars?: number;
  /** URL of the source session's full transcript, if the client knows it. */
  transcriptUrl?: string;
  /** Target agent's display name, for the framing line. */
  targetAgent?: string;
  /** Repo / branch / PR context lines to carry, when known. */
  context?: { repoSlug?: string; branch?: string; prUrl?: string };
}

function truncate(text: string, max: number): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

/**
 * Render a compact continuation prompt for a **seeded** (cross-runtime) fork.
 *
 * Deliberately small — the last N turns plus a link to the full transcript —
 * rather than the entire history: enough to continue coherently, with the full
 * context one click away (the resolved decision in docs/session-fork-plan.md).
 * A structured superset of the old client-side `sessionHandoffSummary`.
 */
export function buildSeedPrompt(transcript: NormalizedTranscript, opts: SeedPromptOptions = {}): string {
  const recentTurns = opts.recentTurns ?? 12;
  const perTurnChars = opts.perTurnChars ?? 700;
  const title = transcript.header.title || "Untitled session";
  const targetAgent = opts.targetAgent || "a new agent";
  const recent = transcript.turns
    .filter((t) => t.text || t.toolSummary)
    .slice(-recentTurns)
    .map((t) => {
      const body = t.text || (t.toolSummary ? `[${t.toolName ?? "tool"}] ${t.toolSummary}` : "");
      return `- ${t.role}: ${truncate(body, perTurnChars)}`;
    })
    .join("\n");
  const lines = [
    `I am continuing an existing Bivy session (forked from ${transcript.header.sourceRuntimeId} to ${targetAgent}).`,
    `Session: ${title}`,
    opts.transcriptUrl ? `Full original transcript: ${opts.transcriptUrl}` : null,
    transcript.header.model ? `Model before fork: ${transcript.header.model}` : null,
    opts.context?.repoSlug ? `Repository: ${opts.context.repoSlug}` : null,
    opts.context?.branch ? `Branch: ${opts.context.branch}` : null,
    opts.context?.prUrl ? `PR: ${opts.context.prUrl}` : null,
    "",
    "Recent conversation (most recent last):",
    recent || "- (no prior turns were available)",
    "",
    opts.transcriptUrl
      ? "Open the full transcript link above if this summary is missing anything, then continue from here."
      : "Continue from here.",
  ];
  return lines.filter((line): line is string => line != null).join("\n");
}
