import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";

// A Pi turn that fails because the conversation no longer fits the model's
// context window ends with `condition: "context_overflow"`, read from Pi's own
// per-provider overflow detection. The wording here is Groq's, which Bivy's
// text match alone doesn't know, so without the condition the session would get
// a bare error instead of the offer to continue in a fresh session.

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Please reduce the length of the messages or completion.", type: "invalid_request_error" } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-overflow-"));
const workspace = path.join(piDir, "ws");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
  providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } },
}));

const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir: path.join(piDir, "sessions"), credentialOwner: "agent", allowModelNetwork: false });
try {
  const { session } = await runtime.createSession({ workspace });
  await session.setModel!("local", "m");
  const ends: Array<{ condition?: string }> = [];
  session.subscribe((event) => {
    if (event.type === "agent_end") ends.push(event);
  });
  await session.prompt("hi");
  session.dispose();

  assert.equal(ends.length, 1);
  assert.equal(ends[0].condition, "context_overflow");
} finally {
  server.close();
  fs.rmSync(piDir, { recursive: true, force: true });
}
