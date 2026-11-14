// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/** A key name agents use: `bivy secrets exec --env NAME`. Same rule as the node's vault. */
export const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface KeyLine { name: string; value: string }

/**
 * Reads pasted `.env`-style text: `NAME=value`, `export NAME=value`, quoted
 * values, `#` comments and blank lines. Lines that aren't an assignment with a
 * valid name and a value come back in `skipped` (1-based line numbers); a later
 * line for the same name wins.
 */
export function parseKeyLines(text: string): { keys: KeyLine[]; skipped: number[] } {
  const keys = new Map<string, string>();
  const skipped: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const assignment = /^export\s/.test(line) ? line.slice(7).trim() : line;
    const eq = assignment.indexOf("=");
    const name = eq > 0 ? assignment.slice(0, eq).trim() : "";
    const value = eq > 0 ? unquote(assignment.slice(eq + 1).trim()) : "";
    if (!KEY_NAME.test(name) || !value) { skipped.push(index + 1); return; }
    keys.delete(name);
    keys.set(name, value);
  });
  return { keys: [...keys].map(([name, value]) => ({ name, value })), skipped };
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.length > 1 && value.endsWith(quote)) return value.slice(1, -1);
  // Unquoted: a ` #` starts a comment, as in dotenv files.
  const comment = value.search(/\s#/);
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}
