// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// OSC 7577 (Program Resume Protocol) as the node's terminals check it. The
// first vectors are the spec's own examples (rev 0.5, token
// `dummy-token-replace-me`); Pi 1.7 reports the same way.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";

import { ProgramResumeBoard, readResumeReport } from "../src/program-resume.js";

const TOKEN = "dummy-token-replace-me";
const NOW = 1795543200;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const signed = (body: string, token = TOKEN) => `${body}:mac=${createHash("sha256").update(`${body}:${token}`).digest("hex")}`;
const report = (pid: number, argv: string[], time = NOW) => signed(`pid=${pid}:time=${time}:argv=${argv.map(b64).join(",")}`);

test("the spec's example report and clear are accepted", () => {
  assert.deepEqual(
    readResumeReport("pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1", TOKEN, NOW),
    { outcome: "report", pid: 74877, time: NOW, command: { argv: ["lazygit"], cwd: "/home/user/src/project" } },
  );
  assert.deepEqual(
    readResumeReport("pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93", TOKEN, NOW),
    { outcome: "clear", pid: 74877, time: NOW },
  );
});

test("a report signed with another token, or outside the clock window, changes nothing", () => {
  assert.equal(readResumeReport(signed(`pid=7:time=${NOW}:argv=${b64("pi")}`, "someone-elses-token-xx"), TOKEN, NOW).outcome, "ignored");
  assert.equal(readResumeReport(report(7, ["pi"], NOW - 120), TOKEN, NOW).outcome, "ignored");
  assert.equal(readResumeReport("?", TOKEN, NOW).outcome, "ignored");
});

test("an authentic report that breaks the rules is rejected: relative program, both argv and clear, an unmet need", () => {
  assert.deepEqual(readResumeReport(report(7, ["./run.sh"]), TOKEN, NOW), { outcome: "rejected", pid: 7 });
  assert.equal(readResumeReport(signed(`pid=7:time=${NOW}:argv=${b64("pi")}:clear=1`), TOKEN, NOW).outcome, "rejected");
  assert.equal(readResumeReport(signed(`pid=7:time=${NOW}:argv=${b64("pi")}:need=env`), TOKEN, NOW).outcome, "rejected");
  assert.equal(readResumeReport(report(7, ["pi", "two\nlines"]), TOKEN, NOW).outcome, "rejected");
});

test("the board prefers the PTY's own process, forgets a cleared or rejected owner, and ignores older reports", () => {
  const board = new ProgramResumeBoard(TOKEN, () => 10, () => true);
  assert.equal(board.apply(report(20, ["vim", "notes.md"]), NOW), true);
  assert.deepEqual(board.current(), { argv: ["vim", "notes.md"] });
  board.apply(report(10, ["pi", "--session", "abc"]), NOW);
  board.apply(report(20, ["vim", "other.md"]), NOW);
  assert.deepEqual(board.current(), { argv: ["pi", "--session", "abc"] }, "the ancestor wins over what it started");
  assert.equal(board.apply(report(10, ["pi", "--session", "old"], NOW - 5), NOW), false, "an older report than the last is ignored");
  board.apply(signed(`pid=10:time=${NOW}:clear=1`), NOW);
  assert.deepEqual(board.current(), { argv: ["vim", "other.md"] });
  board.apply(report(20, ["./relative"]), NOW);
  assert.equal(board.current(), undefined);
});
