// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The node reads agents' terminal status reports the way a terminal emulator
// would. Sequences below are the ones Claude Code, Codex, Grok, Pi and OpenCode
// were seen sending (2026-11-10).
import { strict as assert } from "node:assert";
import test from "node:test";

import { PROGRAM_STATUS_REPLY, ProgramStatusBoard, TerminalSignalReader } from "../src/terminal-signals.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("a 7501 query is answered, and a report split across chunks decodes once whole", () => {
  const reader = new TerminalSignalReader();
  assert.deepEqual(reader.read("\x1b]7501;?\x1b\\").replies, [PROGRAM_STATUS_REPLY]);
  const report = `\x1b]7501;state=blocked:kind=permission:app=grok:msg=${b64("Trust this folder?")}\x1b\\`;
  assert.deepEqual(reader.read(`drawing${report.slice(0, 20)}`).signals, []);
  assert.deepEqual(reader.read(`${report.slice(20)}more`).signals, [
    { type: "status", id: "", status: { state: "blocked", kind: "permission", app: "grok", msg: "Trust this folder?" } },
  ]);
});

test("a report with a control character in its text, or an unknown state, is dropped", () => {
  const reader = new TerminalSignalReader();
  assert.deepEqual(reader.read(`\x1b]7501;state=working:msg=${b64("two\nlines")}\x07`).signals, []);
  assert.deepEqual(reader.read("\x1b]7501;state=sleeping:app=x\x07").signals, []);
});

test("the BEL that ends a title is not a bell; a bare BEL is", () => {
  const reader = new TerminalSignalReader();
  assert.deepEqual(reader.read("\x1b]0;~/repo\x07$ ").signals, []);
  assert.deepEqual(reader.read("done\x07").signals, [{ type: "bell" }]);
});

test("desktop notifications: OSC 9, 777 and kitty 99", () => {
  const reader = new TerminalSignalReader();
  assert.deepEqual(reader.read("\x1b]9;Turn complete\x07").signals, [{ type: "notify", body: "Turn complete" }]);
  assert.deepEqual(reader.read("\x1b]777;notify;Grok;Needs you\x07").signals, [{ type: "notify", title: "Grok", body: "Needs you" }]);
  assert.deepEqual(reader.read("\x1b]99;i=1:d=0;OpenCode\x1b\\\x1b]99;i=1:p=body;Done\x1b\\").signals, [{ type: "notify", title: "OpenCode", body: "Done" }]);
  assert.deepEqual(reader.read("\x1b]99;i=opentui:p=?;\x1b\\").signals, [], "a capability query is not a notification");
});

test("OSC 9;4 progress drives the status until the program speaks 7501", () => {
  const reader = new TerminalSignalReader();
  const board = new ProgramStatusBoard();
  const feed = (chunk: string) => { for (const signal of reader.read(chunk).signals) board.apply(signal); };
  feed("\x1b]9;4;3;0\x07");
  assert.equal(board.current()?.state, "working");
  feed("\x1b]7501;state=idle:app=grok\x1b\\\x1b]9;4;1;50\x07");
  assert.deepEqual(board.current(), { state: "idle", app: "grok" }, "progress is ignored once 7501 is in use");
});

test("the board shows what needs the person, and clears records by id and on a new prompt", () => {
  const board = new ProgramStatusBoard();
  board.apply({ type: "status", id: "", status: { state: "working", app: "claude-code" } });
  board.apply({ type: "status", id: "build/test", status: { state: "blocked", kind: "question" } });
  assert.deepEqual(board.current(), { state: "blocked", kind: "question", app: "claude-code" }, "blocked outranks working; app is inherited");
  board.apply({ type: "clear", id: "build" });
  assert.equal(board.current()?.state, "working", "clearing a parent clears its children");
  board.apply({ type: "prompt" });
  assert.equal(board.current(), undefined, "a new shell prompt ends the run's working state");
});
