import type { ForkHistoryMessage, RuntimeMessage } from "../runtime/types.js";

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
 *   - "full"     — same runtime: the raw native transcript is transported and
 *                  resumed byte-for-byte.
 *   - "replayed" — different runtime that can import portable history: the FULL
 *                  conversation is written as real prior turns into the target's
 *                  own store and resumed (a "true fork" — see `buildForkHistory`).
 *   - "seeded"   — different runtime with no history import: the destination seeds
 *                  a single context turn (recent turns + a link to the original).
 */

export type ForkFidelity = "full" | "replayed" | "seeded";

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
  /**
   * Optional HARD cap on the number of recent turns to inline. Default: no fixed
   * cap — `charBudget` governs how far back the verbatim tail reaches, so a long
   * run of short turns carries far more than the old fixed 12. Set this only to
   * force an exact count (the tests do).
   */
  recentTurns?: number;
  /** Per-turn text cap (default 700 chars). */
  perTurnChars?: number;
  /**
   * Total character budget for the inlined recent-turns block (default 12000,
   * ~3k tokens at ~4 chars/token). The seed fills this budget with as much
   * verbatim recent history as fits — walking backward from the latest turn —
   * instead of a fixed tail, then notes how many earlier turns were dropped and
   * points at the full transcript for them. The most recent turn is always kept
   * even if it alone exceeds the budget, so the seed is never empty.
   */
  charBudget?: number;
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
 * Render a continuation prompt for a **seeded** (cross-runtime) fork — the
 * fallback when the target runtime can't replay history into its own store.
 *
 * The recent-conversation block is **budget-adaptive**, not a fixed tail: it
 * walks backward from the latest turn packing verbatim turns until `charBudget`
 * is reached (or the optional `recentTurns` count cap is hit), so a long run of
 * short turns carries far more context than the old fixed 12, while a few
 * verbose turns still stay bounded for the target's context window and cost. Any
 * turns that don't fit are summarised as an omission count that points at the
 * full transcript — the complete history is one link away. A structured superset
 * of the old client-side `sessionHandoffSummary`.
 */
export function buildSeedPrompt(transcript: NormalizedTranscript, opts: SeedPromptOptions = {}): string {
  const perTurnChars = opts.perTurnChars ?? 700;
  const charBudget = opts.charBudget ?? 12000;
  const maxCount = opts.recentTurns ?? Number.POSITIVE_INFINITY;
  const title = transcript.header.title || "Untitled session";
  const targetAgent = opts.targetAgent || "a new agent";

  const formatted = transcript.turns
    .filter((t) => t.text || t.toolSummary)
    .map((t) => {
      const body = t.text || (t.toolSummary ? `[${t.toolName ?? "tool"}] ${t.toolSummary}` : "");
      return `- ${t.role}: ${truncate(body, perTurnChars)}`;
    });

  // Pack the newest turns first, within both the char budget and the count cap.
  // The most recent turn is always kept, even if it alone exceeds the budget, so
  // the seed is never empty.
  const picked: string[] = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0 && picked.length < maxCount; i -= 1) {
    const cost = formatted[i]!.length + 1;
    if (picked.length > 0 && used + cost > charBudget) break;
    picked.push(formatted[i]!);
    used += cost;
  }
  picked.reverse();
  const omitted = formatted.length - picked.length;
  const recent = picked.length ? picked.join("\n") : "- (no prior turns were available)";

  const lines = [
    `I am continuing an existing Bivy session (forked from ${transcript.header.sourceRuntimeId} to ${targetAgent}).`,
    `Session: ${title}`,
    opts.transcriptUrl ? `Full original transcript: ${opts.transcriptUrl}` : null,
    transcript.header.model ? `Model before fork: ${transcript.header.model}` : null,
    opts.context?.repoSlug ? `Repository: ${opts.context.repoSlug}` : null,
    opts.context?.branch ? `Branch: ${opts.context.branch}` : null,
    opts.context?.prUrl ? `PR: ${opts.context.prUrl}` : null,
    "",
    omitted > 0
      ? `Recent conversation (most recent last; ${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted — see the full transcript${opts.transcriptUrl ? " linked above" : ""}):`
      : "Recent conversation (most recent last):",
    recent,
    "",
    opts.transcriptUrl
      ? "Open the full transcript link above if this summary is missing anything, then continue from here."
      : "Continue from here.",
  ];
  return lines.filter((line): line is string => line != null).join("\n");
}

/**
 * Render a normalized transcript as portable `{role, text}` turns for a
 * **replayed** ("true fork") cross-runtime fork — the target runtime writes
 * these as real prior conversation into its own store and resumes, so the new
 * agent opens on a copy of the whole history instead of a seeded summary.
 *
 * Unlike `buildSeedPrompt` this keeps EVERY turn, not just the tail, and keeps
 * each turn's own role instead of flattening the conversation into one user
 * prompt. Two deliberate shaping rules keep the result valid on any target model:
 *   - Tool activity is inlined as plain text (`[ran X] …`, `[tool result] …`),
 *     never as provider-specific `tool_use`/`tool_result` blocks whose ids/schemas
 *     would dangle or mismatch in a different runtime.
 *   - Non-conversational roles fold into the model's voice: a pure tool-result
 *     turn and a system/error notice both attach as `assistant` text (the agent's
 *     own work), so only the human's turns ever carry the `user` role.
 * Consecutive same-role turns are merged so the resumed history reads as clean
 * alternating turns. Tool payloads inherit `normalizeMessages`' compaction, so a
 * replayed fork is faithful in its prose but summarised in raw tool I/O — the
 * working tree (carried separately as a dirty patch) holds the real file state.
 */
export function buildForkHistory(transcript: NormalizedTranscript): ForkHistoryMessage[] {
  const history: ForkHistoryMessage[] = [];
  for (const turn of transcript.turns) {
    const role: ForkHistoryMessage["role"] = turn.role === "user" ? "user" : "assistant";
    const parts: string[] = [];
    if (turn.role === "error" && turn.text) parts.push(`[system] ${turn.text}`);
    else if (turn.text) parts.push(turn.text);
    if (turn.toolSummary) {
      const label = turn.role === "tool" ? "tool result" : turn.toolName ? `ran ${turn.toolName}` : "tool";
      parts.push(`[${label}] ${turn.toolSummary}`);
    }
    const text = parts.join("\n\n").trim();
    if (!text) continue;
    const last = history[history.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${text}`;
    else history.push({ role, text });
  }
  return history;
}
