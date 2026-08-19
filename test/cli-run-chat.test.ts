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

test("bivy run --chat creates an app-style governed session without launching the native CLI", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-run-chat-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-run-chat-workspace-"));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const requests: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
      if (req.url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      if (req.url === "/api/auth/bootstrap") {
        assert.equal(req.headers["x-bivy-bootstrap"], "test-bootstrap");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "test-device-token" }));
        return;
      }
      requests.push({ path: req.url || "", authorization: req.headers.authorization, body });
      if (req.url === "/api/session") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "chat-session-123", runtimeId: "claude-code-sdk", agentName: "Claude Code" }));
        return;
      }
      if (req.url === "/api/sessions/rename") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: body.name }));
        return;
      }
      if (req.url === "/api/node/info") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ nodeId: "node-abc", name: "Laptop" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  fs.writeFileSync(path.join(dataDir, "cli.json"), JSON.stringify({ workspace, port: address.port }));
  fs.writeFileSync(path.join(dataDir, "bootstrap.json"), JSON.stringify({ secret: "test-bootstrap" }), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "relay.json"), JSON.stringify({
    clientBaseUrl: "https://app.example.test",
    controlPlaneUrl: "https://control.example.test",
    url: "wss://relay.example.test",
  }), { mode: 0o600 });

  const result = await runCli([
    "run", "claude", "--chat", "--no-open", "--workspace", workspace,
    "--model", "opus", "--name", "Review auth",
  ], { BIVY_DATA_DIR: dataDir, DISPLAY: "", WAYLAND_DISPLAY: "" });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started chat session chat-session-123 \(Claude Code\)/);
  // The deep link carries this node's id so the app switches to it before
  // opening the session (it may be connected to another node, or none yet).
  assert.match(result.stdout, /https:\/\/app\.example\.test\/sessions\/chat-session-123\?node=node-abc/);

  const codexResult = await runCli([
    "run", "codex", "--chat", "--no-open", "--workspace", workspace,
  ], { BIVY_DATA_DIR: dataDir, DISPLAY: "", WAYLAND_DISPLAY: "" });
  assert.equal(codexResult.code, 0, codexResult.stderr || codexResult.stdout);

  assert.deepEqual(requests, [
    {
      path: "/api/session",
      authorization: "Bearer test-device-token",
      body: { agent: "claude-code-sdk", model: { provider: "", id: "opus" }, workspace },
    },
    {
      path: "/api/sessions/rename",
      authorization: "Bearer test-device-token",
      body: { sessionId: "chat-session-123", name: "Review auth" },
    },
    { path: "/api/node/info", authorization: "Bearer test-device-token", body: {} },
    {
      path: "/api/session",
      authorization: "Bearer test-device-token",
      body: { agent: "codex-approvals", workspace },
    },
    // No --name: the creation-time placeholder the app's own sessions carry, so
    // the empty chat is listed/advertised now and still auto-named on first message.
    {
      path: "/api/sessions/rename",
      authorization: "Bearer test-device-token",
      body: { sessionId: "chat-session-123", name: "Session chat-ses" },
    },
    { path: "/api/node/info", authorization: "Bearer test-device-token", body: {} },
  ]);
});
