// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The parser behind the `table` component kind. The browser spec proves a CSV
// renders as a table; these are the cases that are far cheaper to pin here than
// through a rendered page — the ones a regex-based parser gets wrong.
import { strict as assert } from "node:assert";
import test from "node:test";

import { parseCsv, MAX_TABLE_ROWS } from "../packages/web/src/csv.js";

test("keeps a quoted field containing the delimiter, a newline and escaped quotes whole", () => {
  const csv = 'city,note\nOslo,"Mild, coastal"\nBergen,"Says ""wet""\nall year"';
  const { header, rows } = parseCsv(csv);
  assert.deepEqual(header, ["city", "note"]);
  assert.deepEqual(rows, [
    ["Oslo", "Mild, coastal"],
    ["Bergen", 'Says "wet"\nall year'],
  ]);
});

test("reads tab-separated text, which a comma parser would collapse into one column", () => {
  const { header, rows } = parseCsv("city\tkwh\nOslo\t4650");
  assert.deepEqual(header, ["city", "kwh"]);
  assert.deepEqual(rows, [["Oslo", "4650"]]);
});

test("handles CRLF and a trailing newline without inventing a blank row", () => {
  const { rows } = parseCsv("a,b\r\n1,2\r\n");
  assert.deepEqual(rows, [["1", "2"]]);
});

test("caps the rows it keeps and reports how many it left out", () => {
  const body = Array.from({ length: MAX_TABLE_ROWS + 7 }, (_, i) => `${i},x`).join("\n");
  const { rows, omitted } = parseCsv(`n,v\n${body}`);
  assert.equal(rows.length, MAX_TABLE_ROWS, "a message table is for reading, not for browsing a dataset");
  assert.equal(omitted, 7);
});

test("an empty or header-only file yields no rows rather than throwing", () => {
  assert.deepEqual(parseCsv(""), { header: [], rows: [], omitted: 0 });
  assert.deepEqual(parseCsv("a,b"), { header: ["a", "b"], rows: [], omitted: 0 });
});

test("a ragged row keeps its own cells; the view pads against the header", () => {
  // Real CSVs are ragged. Padding belongs to the renderer (which lays cells out
  // against the header), not here, so no data is invented or dropped.
  const { rows } = parseCsv("a,b,c\n1,2\n1,2,3,4");
  assert.deepEqual(rows, [["1", "2"], ["1", "2", "3", "4"]]);
});
