#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Verify terminal support from an installed consumer, not the checkout's deps.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/smoke-pty.mjs <installed-package-dir>");
const require = createRequire(path.resolve(process.argv[2], "package.json"));
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  let output = "";
  const terminal = pty.spawn("/bin/sh", ["-c", "printf bivy-pty-ok"], {
    name: "xterm",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  const timer = setTimeout(() => {
    terminal.kill();
    reject(new Error("Installed PTY did not finish within 10 seconds"));
  }, 10_000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    try {
      assert.equal(exitCode, 0);
      assert.ok(output.includes("bivy-pty-ok"), `Missing PTY output: ${output}`);
      resolve();
    } catch (error) { reject(error); }
  });
});
console.log("Installed native PTY: passed (spawn, output, exit)");
