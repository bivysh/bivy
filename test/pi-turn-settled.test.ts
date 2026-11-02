import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";

// Bivy's `agent_end` means the turn is over: the chat stops showing work, the
// diff and usage refresh run, and `bivy exec` prints its answer. Pi ends a
// low-level run on a 429 and then retries on its own, so a Pi session must
// report one `agent_end`, after the retry, carrying the reply that succeeded.

let calls = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit" } }));
      return;
    }
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk({ role: "assistant", content: "recovered" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-settled-"));
const workspace = path.join(piDir, "ws");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
  providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } },
}));
fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 10 } }));

const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir: path.join(piDir, "sessions"), credentialOwner: "agent", allowModelNetwork: false });
try {
  const { session } = await runtime.createSession({ workspace });
  await session.setModel!("local", "m");
  const ends: Array<{ willRetry?: boolean; messages?: Array<{ role: string; stopReason?: string }> }> = [];
  session.subscribe((event) => { if (event.type === "agent_end") ends.push(event); });
  await session.prompt("hi");
  session.dispose();

  assert.equal(calls, 2, "Pi retried the rate-limited request");
  assert.equal(ends.length, 1, "the retried turn ends once");
  assert.equal(ends[0].willRetry, false);
  assert.equal(ends[0].messages?.at(-1)?.stopReason, "stop", "the turn ends on the reply that succeeded");
} finally {
  server.close();
  fs.rmSync(piDir, { recursive: true, force: true });
}
