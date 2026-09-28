// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { portableCommand } from "../src/portable-process.mjs";

// Windows resolution and cmd.exe quoting are pure functions of PATH/PATHEXT and
// the files present, so they are exercised here on any OS (PATHEXT is lowercase
// only because this filesystem may be case-sensitive); scripts/smoke-windows.mjs
// proves the same command lines round-trip through a real cmd.exe.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-portable-"));
for (const file of ["tool.exe", "agent.cmd"]) fs.writeFileSync(path.join(dir, file), "");
const win = { platform: "win32" as const, env: { PATH: dir, PATHEXT: ".exe;.cmd", COMSPEC: "C:\\Windows\\system32\\cmd.exe" } };

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("POSIX launches the command as given", () => {
  assert.deepEqual(portableCommand("agent", ["&calc"], { platform: "linux", env: win.env }), { command: "agent", args: ["&calc"], options: {} });
});

test("Windows resolves a bare name through PATHEXT", () => {
  assert.deepEqual(portableCommand("tool", ["--help"], win), { command: path.join(dir, "tool.exe"), args: ["--help"], options: {} });
});

test("Windows runs a .cmd shim through cmd.exe, escaping for it and for the shim's own %* line", () => {
  const { command, args, options } = portableCommand("agent", ["&calc", 'x"y'], win);
  assert.equal(command, win.env.COMSPEC);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.deepEqual(options, { windowsVerbatimArguments: true });
  assert.ok(args[3].endsWith(' ^^^"^^^&calc^^^" ^^^"x\\^^^"y^^^""'), args[3]);
});
