// The argument hint an agent advertises for one of its slash commands (Claude
// Code's `argumentHint`, ACP's `input.hint`, a skill's `argument-hint`), cleaned
// for the composer: one line, bounded, or undefined when there is none.

const MAX_HINT = 80;

export function commandArgumentHint(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const hint = raw.replace(/\s+/g, " ").trim();
  if (!hint) return undefined;
  return hint.length > MAX_HINT ? `${hint.slice(0, MAX_HINT - 1)}…` : hint;
}
