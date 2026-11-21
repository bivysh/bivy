// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A session whose folder was removed (a worktree cleaned up to free disk) used
// to fail with Node's "spawn /usr/bin/node ENOENT", which reads as a missing
// agent install. The protocol runtime now names the missing folder instead.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/protocol-agent.mjs");
const gone = mkdtempSync(path.join(os.tmpdir(), "bivy-gone-"));
rmSync(gone, { recursive: true });

const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol" });
await assert.rejects(
  async () => {
    const { session } = await runtime.createSession({ workspace: gone, toolInterceptor: async () => undefined });
    await session.prompt("hi");
  },
  (error: Error) => error.message.includes("folder no longer exists") && error.message.includes(gone),
);
console.log("protocol-runtime-missing-folder: passed");
