// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { DataRowChange, RequestAnswer, ValueChange } from "../types.js";

const MAX_CHANGES = 200;
const shown = (value: unknown): string => typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);

/** Leaves of a JSON value by path ("items[0].price"); an empty object or list is a leaf. */
function flatten(value: unknown, at = "", out = new Map<string, string>()): Map<string, string> {
  if (value && typeof value === "object" && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, Array.isArray(value) ? `${at}[${key}]` : at ? `${at}.${key}` : key, out);
  } else out.set(at || "(body)", shown(value));
  return out;
}
/** What changed between two values, path by path: what a person reads instead of two bodies. */
export function valueChanges(before: unknown, after: unknown): ValueChange[] {
  const a = flatten(before), b = flatten(after);
  const changes: ValueChange[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) === b.get(path)) continue;
    changes.push({ path, ...(a.has(path) ? { before: a.get(path) } : {}), ...(b.has(path) ? { after: b.get(path) } : {}) });
    if (changes.length >= MAX_CHANGES) break;
  }
  return changes;
}
const parsed = (answer: RequestAnswer): unknown => { if (answer.json) { try { return JSON.parse(answer.body); } catch { /* shown as text */ } } return answer.body; };
/** Two answers to the same request: the status, then the body by path. */
export function answerChanges(before: RequestAnswer, after: RequestAnswer): ValueChange[] {
  const status = before.status === after.status ? [] : [{ path: "(status)", before: String(before.status || before.error), after: String(after.status || after.error) }];
  return [...status, ...valueChanges(parsed(before), parsed(after))];
}
/** Whether an answer differs in what a reviewer cares about: its status or its body. */
export function answerChanged(before: RequestAnswer, after: RequestAnswer): boolean {
  return before.status !== after.status || Boolean(before.error) !== Boolean(after.error) || answerChanges(before, after).length > 0;
}

/** Rows matched by key: added, changed (with the fields that changed), removed. */
export function rowChanges(before: Record<string, string>[], after: Record<string, string>[], key: string): { added: DataRowChange[]; changed: DataRowChange[]; removed: DataRowChange[] } {
  const keyed = (rows: Record<string, string>[]) => new Map(rows.map((row, index) => [row[key] ?? `#${index + 1}`, row]));
  const a = keyed(before), b = keyed(after);
  const added: DataRowChange[] = [], changed: DataRowChange[] = [], removed: DataRowChange[] = [];
  for (const [id, row] of b) {
    const old = a.get(id);
    if (!old) { added.push({ key: id, row }); continue; }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(row)])].filter((column) => old[column] !== row[column])
      .map((column) => ({ path: column, ...(column in old ? { before: old[column] } : {}), ...(column in row ? { after: row[column] } : {}) }));
    if (fields.length) changed.push({ key: id, row, fields });
  }
  for (const [id, row] of a) if (!b.has(id)) removed.push({ key: id, row });
  const cap = <T>(list: T[]) => list.slice(0, MAX_CHANGES);
  return { added: cap(added), changed: cap(changed), removed: cap(removed) };
}
