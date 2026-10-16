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
