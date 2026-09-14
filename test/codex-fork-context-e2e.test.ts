// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCodexRollout } from "../src/runtime/codex-sessions.js";

// Uses the real Codex parser + context reconstruction, but a LOCAL model endpoint:
// no credentials, paid model calls, or generated answers. A successful resume or
// Bivy read-back alone cannot detect silently discarded imported response items.
// Run: BIVY_CODEX_E2E=1 pnpm exec tsx --test test/codex-fork-context-e2e.test.ts
test("Codex sends cross-agent fork history to the model on the next turn", {
  skip: process.env.BIVY_CODEX_E2E !== "1",
  timeout: 30_000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-codex-context-"));
  const previousHome = process.env.CODEX_HOME;
  let resolveRequest!: (body: string) => void;
  const requestBody = new Promise<string>((resolve) => { resolveRequest = resolve; });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    resolveRequest(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(400).end("Test captured model input; no generation required.");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  fs.writeFileSync(path.join(home, "config.toml"), `model_provider = "probe"
model = "gpt-5.4"
[model_providers.probe]
name = "Local test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
`);
  const child = spawn("codex", ["app-server"], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  type Reply = { result?: unknown; error?: unknown };
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    resolveRequest("");
  };
  child.on("error", failPending);
  child.on("exit", () => failPending(new Error(`Codex exited: ${stderr}`)));
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.resolve(reply);
    pending.delete(reply.id);
  });
  let nextId = 0;
  async function rpc(method: string, params: unknown) {
    const id = ++nextId;
    const reply = new Promise<Reply>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const response = await reply;
    assert.equal(response.error, undefined, JSON.stringify(response.error));
  }
  const timer = setTimeout(() => { child.kill(); resolveRequest(""); }, 20_000);
  try {
    process.env.CODEX_HOME = home;
    const history = [
      { role: "user" as const, text: "Remember the fork secret: watermelon." },
      { role: "assistant" as const, text: "I will remember watermelon from the Claude conversation." },
      { role: "user" as const, text: "Also remember the number 731." },
      { role: "assistant" as const, text: "Noted: 731." },
    ];
    const { id } = writeCodexRollout(history, home);
    await rpc("initialize", { clientInfo: { name: "bivy-test", version: "1" } });
    await rpc("thread/resume", { threadId: id, cwd: home });
    await rpc("turn/start", { threadId: id, input: [{ type: "text", text: "What did we discuss before the fork?" }] });
    const body = await requestBody;
    assert.ok(body, `No model request captured: ${stderr}`);
    const input = JSON.parse(body).input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    const messages = input.map((item) => ({ role: item.role, text: item.content?.map((part) => part.text ?? "").join("") }));
    assert.deepEqual(messages.filter((item) => history.some((prior) => prior.text === item.text)), history);
    assert.ok(messages.some((item) => item.text === "What did we discuss before the fork?"));
  } finally {
    clearTimeout(timer);
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    lines.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
