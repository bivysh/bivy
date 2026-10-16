// SPDX-License-Identifier: AGPL-3.0-only

/** What one rendered item of an agent turn is, for grouping its work. */
export type TurnItemKind =
  /** Tool calls and thinking: always part of the work. */
  | "work"
  /** Assistant prose: interim narration before the last work step, the answer after it. */
  | "prose"
  /** Something the agent produced (files, apps, a plan, a notice): stays visible. */
  | "output";

export type TurnSplit<T> = { work: T[]; outputs: T[]; answer: T[] };

/**
 * Split a turn's response into one collapsible work group and what stays in the
 * transcript. Everything up to the last work step is work (interim prose
 * included), except outputs, which stay visible; whatever follows the last work
 * step is the answer. While the agent is still working, prose that trails the
 * latest tool call reads as the answer until another tool call follows it.
 */
export function splitTurn<T>(items: T[], kindOf: (item: T) => TurnItemKind): TurnSplit<T> {
  const kinds = items.map(kindOf);
  const lastWork = kinds.lastIndexOf("work");
  if (lastWork < 0) return { work: [], outputs: [], answer: items };
  const work: T[] = [];
  const outputs: T[] = [];
  items.slice(0, lastWork + 1).forEach((item, index) => (kinds[index] === "output" ? outputs : work).push(item));
  return { work, outputs, answer: items.slice(lastWork + 1) };
}

/** One quiet line of interim prose for the collapsed work row. */
export function noteSnippet(text: string, max = 140): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** One turn as the reader sees it: where it starts in the transcript, and how
 *  many rows it shows (prompt, one work line, then each answer or output). */
export type TurnSpan = { start: number; rows: number };

/**
 * Measure the transcript in turns. A prompt opens a turn; a session-level
 * notice is a turn of its own; entries before the first prompt form a
 * response-only turn. A turn's work, however many tool calls and interim
 * messages it holds, counts as one row.
 */
export function turnSpans<T>(entries: readonly T[], roleOf: (entry: T) => "prompt" | "notice" | "response", kindOf: (entry: T) => TurnItemKind): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let open: { start: number; prompt: boolean; response: T[] } | null = null;
  const close = () => {
    if (!open) return;
    const { work, outputs, answer } = splitTurn(open.response, kindOf);
    spans.push({ start: open.start, rows: (open.prompt ? 1 : 0) + (work.length ? 1 : 0) + outputs.length + answer.length });
    open = null;
  };
  entries.forEach((entry, index) => {
    const role = roleOf(entry);
    if (role === "response") {
      if (!open) open = { start: index, prompt: false, response: [] };
      open.response.push(entry);
      return;
    }
    close();
    if (role === "notice") spans.push({ start: index, rows: 1 });
    else open = { start: index, prompt: true, response: [] };
  });
  close();
  return spans;
}

/** Where to start showing whole turns before `before`, adding earlier turns
 *  while they fit in `rows` (always at least one turn, however long). */
export function startBefore(spans: readonly TurnSpan[], before: number, rows: number): number {
  let start = before;
  let used = 0;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    if (span.start >= before) continue;
    if (used > 0 && used + span.rows > rows) break;
    used += span.rows;
    start = span.start;
  }
  return start;
}

/** The start of the turn holding `index`, so a window never opens mid-turn. */
export function turnStartOf(spans: readonly TurnSpan[], index: number): number {
  return spans.findLast((span) => span.start <= index)?.start ?? 0;
}

/** Rows hidden before `start`, for the "show earlier" count. */
export function rowsBefore(spans: readonly TurnSpan[], start: number): number {
  return spans.reduce((sum, span) => span.start < start ? sum + span.rows : sum, 0);
}
