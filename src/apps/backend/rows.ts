// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** A database client's output as rows. Clients print different formats
 * (`sqlite3 -json`, `psql --csv`, `mysql --batch` prints TSV, `duckdb -json`);
 * each format is a row here, tried in order. Values become text: they're shown
 * and compared, never computed with. */
export interface Rows { columns: string[]; rows: Record<string, string>[] }
const MAX_ROWS = 1000;
const text = (value: unknown): string => value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** A delimited line, with quotes ("a ""quoted"" value") as CSV writes them. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === "\"" && line[i + 1] === "\"") { cell += "\""; i++; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"" && !cell) quoted = true;
    else if (char === delimiter) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  return [...cells, cell];
}
function delimited(output: string, delimiter: string): Rows | undefined {
  const lines = output.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length || !lines[0]!.includes(delimiter)) return undefined;
  const columns = splitLine(lines[0]!, delimiter);
  return { columns, rows: lines.slice(1, MAX_ROWS + 1).map((line) => Object.fromEntries(splitLine(line, delimiter).map((cell, i) => [columns[i] ?? `column ${i + 1}`, cell]))) };
}
const FORMATS: { name: string; read(output: string): Rows | undefined }[] = [
  { name: "JSON", read: (output) => {
    let value: unknown;
    try { value = JSON.parse(output); } catch { return undefined; }
    if (!Array.isArray(value)) return undefined;
    const objects = value.slice(0, MAX_ROWS).filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
    const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))];
    return { columns, rows: objects.map((row) => Object.fromEntries(columns.map((column) => [column, text(row[column])]))) };
  } },
  { name: "TSV", read: (output) => delimited(output, "\t") },
  { name: "CSV", read: (output) => delimited(output, ",") },
  // One column, no delimiter: still a table.
  { name: "lines", read: (output) => {
    const lines = output.split(/\r?\n/).filter((line) => line.length);
    if (!lines.length) return undefined;
    return { columns: [lines[0]!], rows: lines.slice(1, MAX_ROWS + 1).map((line) => ({ [lines[0]!]: line })) };
  } },
];
export function parseRows(output: string): Rows {
  const trimmed = output.trim();
  if (!trimmed) return { columns: [], rows: [] };
  for (const format of FORMATS) { const rows = format.read(trimmed); if (rows) return rows; }
  return { columns: [], rows: [] };
}

/** A saved query's file: the query, and its `-- title:` and `-- key:` comments. */
export function readQueryFile(text: string): { sql: string; title?: string; key?: string } {
  const tag = (name: string) => new RegExp(`^\\s*--\\s*${name}\\s*:\\s*(.+)$`, "im").exec(text)?.[1]?.trim();
  return { sql: text.trim(), ...(tag("title") ? { title: tag("title") } : {}), ...(tag("key") ? { key: tag("key") } : {}) };
}
