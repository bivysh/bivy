// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { rowsBefore, splitTurn, startBefore, turnSpans, turnStartOf, type TurnItemKind } from "../packages/web/src/turnWork.js";

// A transcript in shorthand: P prompt, N notice, t tool, x thinking, p prose, o output.
type Row = "P" | "N" | "t" | "x" | "p" | "o";
const roleOf = (row: Row) => row === "P" ? "prompt" as const : row === "N" ? "notice" as const : "response" as const;
const kindOf = (row: Row): TurnItemKind => row === "t" || row === "x" ? "work" : row === "p" ? "prose" : "output";
const rows = (text: string) => text.split("") as Row[];

// Interim prose and tools fold into the work; an output inside it stays visible;
// what follows the last work step is the answer.
assert.deepEqual(
  splitTurn(["p1", "t1", "o1", "p2", "t2", "p3", "o2"], (item) => kindOf(item[0] as Row)),
  { work: ["p1", "t1", "p2", "t2"], outputs: ["o1"], answer: ["p3", "o2"] },
);
assert.deepEqual(splitTurn(["p1", "o1"], (item) => kindOf(item[0] as Row)), { work: [], outputs: [], answer: ["p1", "o1"] });

// Each turn counts its prompt, one work row however long, and each answer or
// output; a notice is a turn of its own; a leading response is a turn without a prompt.
const transcript = rows("pt" + "Pptptptp" + "N" + "Pp" + "Pxtpo");
const spans = turnSpans(transcript, roleOf, kindOf);
assert.deepEqual(spans, [
  { start: 0, rows: 1 },
  { start: 2, rows: 3 },
  { start: 10, rows: 1 },
  { start: 11, rows: 2 },
  { start: 13, rows: 4 },
]);

// The window takes whole turns from the end while they fit, and always at least one.
assert.equal(startBefore(spans, transcript.length, 6), 11);
assert.equal(startBefore(spans, transcript.length, 2), 13, "a turn longer than the window still shows whole");
assert.equal(startBefore(spans, 11, 4), 2, "show earlier steps back from the current start");
assert.equal(startBefore(spans, 0, 20), 0);
assert.equal(turnStartOf(spans, 7), 2, "a jump target opens its whole turn");
assert.equal(rowsBefore(spans, 11), 5);
