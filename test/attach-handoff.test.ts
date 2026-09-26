// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A terminal attached to a session that another device continues as a chat is
// told where the session went, and Enter takes it back into this terminal.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const attachEntry = path.join(repoRoot, "src", "attach.ts");
const attachArgs = existsSync(tsxCli) ? [tsxCli, attachEntry] : [attachEntry];

test("Enter takes a session back from chat into the same terminal", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [...attachArgs, "--url", `http://127.0.0.1:${address.port}`, "--attach", "run-1"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });

  const reopened: unknown[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { kind?: string; sessionId?: string };
      if (msg.kind === "terminal.attach") {
        socket.send(JSON.stringify({ type: "terminal.attached", termId: "run-1", data: "claude> " }));
        // Another device chose "Use chat".
        socket.send(JSON.stringify({ type: "terminal.closed", termId: "run-1", reason: "chat", sessionId: "s1" }));
        socket.send(JSON.stringify({ type: "terminal.exit", termId: "run-1", code: 0 }));
        setTimeout(() => child.stdin.write("\r"), 50);
      } else if (msg.kind === "terminal.open.tui") {
        reopened.push(msg.sessionId);
        socket.send(JSON.stringify({ type: "terminal.opened", termId: "run-2" }));
        socket.send(JSON.stringify({ type: "terminal.exit", termId: "run-2", code: 0 }));
      }
    });
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`attach bridge timed out; stdout=${JSON.stringify(stdout)}`)); }, 8000);
    child.on("exit", (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
  });
  server.close();

  assert.deepEqual(reopened, ["s1"], "Enter reopens the chat's session in this terminal");
  assert.match(stdout, /continued as chat/);
  assert.equal(code, 0);
});
