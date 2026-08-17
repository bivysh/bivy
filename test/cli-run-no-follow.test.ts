// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "bivy.mjs");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// `bivy run --no-follow` starts a daemon run-terminal and returns immediately,
// without binding the local TTY. It should open exactly one terminal over the
// WebSocket, print a background-session hint, and exit 0 once the daemon
// confirms the terminal is open.
test("bivy run --no-follow opens a background run-terminal and returns immediately", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-run-nofollow-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-run-nofollow-workspace-"));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (req.url === "/api/auth/bootstrap") {
      assert.equal(req.headers["x-bivy-bootstrap"], "test-bootstrap");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "test-device-token" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  });

  // Stand in for the daemon's /ws endpoint: accept the terminal.open.run and
  // reply terminal.opened, just as the run-terminal subsystem does.
  const openMessages: Array<Record<string, unknown>> = [];
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket, request) => {
    assert.match(request.url || "", /access_token=test-device-token/);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.kind === "terminal.open.run") {
        openMessages.push(msg);
        socket.send(JSON.stringify({ type: "terminal.opened", termId: "term-nofollow-1", workspace, mode: "run" }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => { wss.close(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  fs.writeFileSync(path.join(dataDir, "cli.json"), JSON.stringify({ workspace, port: address.port }));
  fs.writeFileSync(path.join(dataDir, "bootstrap.json"), JSON.stringify({ secret: "test-bootstrap" }), { mode: 0o600 });

  const result = await runCli([
    "run", "--no-follow", "--workspace", workspace, "--", "echo", "hello",
  ], { BIVY_DATA_DIR: dataDir, DISPLAY: "", WAYLAND_DISPLAY: "" });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started echo in the background\./);
  assert.match(result.stdout, /bivy resume/);

  // Exactly one terminal opened, carrying the raw command — not a chat session.
  assert.equal(openMessages.length, 1);
  assert.equal(openMessages[0]!.command, "echo");
  assert.deepEqual(openMessages[0]!.args, ["hello"]);
  assert.equal(openMessages[0]!.workspace, workspace);
});
