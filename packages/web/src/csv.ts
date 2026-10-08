// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Delimiter-separated text into rows, for the `table` component kind.
//
// Client-only on purpose: the node stores a CSV's bytes without caring what is
// in them, so nothing below the view layer needs to parse one. A character
// scanner rather than a regex — quoted fields can contain the delimiter, a
// newline, and escaped quotes, which is exactly the shape a regex gets wrong.

/** Hard bound on rows kept. A table in a chat message is for reading, not for
 *  browsing a dataset; past this the caller says how many rows were left out. */
export const MAX_TABLE_ROWS = 200;

export interface Csv {
  header: string[];
  rows: string[][];
  /** Rows beyond MAX_TABLE_ROWS, so the view can say how many it dropped. */
  omitted: number;
}

/** `\t` when the first line has more tabs than commas, else `,`. Agents produce
 *  both, and a TSV parsed as CSV silently becomes one wide column. */
function delimiterOf(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || undefined);
  return (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
}

export function parseCsv(text: string, limit = MAX_TABLE_ROWS): Csv {
  const source = String(text ?? "");
  const delimiter = delimiterOf(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline otherwise yields a final row of one empty cell.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (field !== "" || row.length) endRow();

  const header = rows.shift() ?? [];
  const omitted = Math.max(0, rows.length - limit);
  return { header, rows: rows.slice(0, limit), omitted };
}
