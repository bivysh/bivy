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

/** Rows a chart may read from one file. Far above the display-table cap: a
 *  chart summarises a dataset rather than listing it, so the useful ceiling is
 *  "enough to plot" rather than "enough to read". */
export const MAX_CHART_ROWS = 5000;

/**
 * Delimited text as objects keyed by the header, with numeric-looking cells
 * coerced to numbers — the shape Vega-Lite's `values` expects. Without the
 * coercion every quantitative encoding would receive strings and plot as
 * nominal categories, which looks like a broken chart rather than a typing
 * mistake.
 *
 * An empty cell stays an empty string rather than becoming 0, so a gap in the
 * data is not silently plotted as a real zero.
 */
export function csvToObjects(text: string, limit = MAX_CHART_ROWS): Array<Record<string, string | number>> {
  const { header, rows } = parseCsv(text, limit);
  return rows.map((row) => {
    const record: Record<string, string | number> = {};
    header.forEach((key, i) => {
      const cell = row[i] ?? "";
      const numeric = cell !== "" && !Number.isNaN(Number(cell));
      record[key] = numeric ? Number(cell) : cell;
    });
    return record;
  });
}
