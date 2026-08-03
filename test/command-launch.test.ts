// SPDX-License-Identifier: FSL-1.1-ALv2
import assert from "node:assert/strict";
import { commandLaunch } from "../src/command-launch.js";

const direct = commandLaunch("echo", ["hello"], false, "python3", "/app/pty-runner.py");
assert.deepEqual(direct, { command: "echo", args: ["hello"], usesPty: false });

const terminal = commandLaunch("login", ["--interactive"], true, "python3", "/app/pty-runner.py");
assert.deepEqual(terminal, {
  command: "python3",
  args: ["/app/pty-runner.py", "login", "--interactive"],
  usesPty: true,
});

console.log("command-launch: all tests passed");
