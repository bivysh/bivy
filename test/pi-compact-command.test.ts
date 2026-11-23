import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";

// Pi's own TUI runs /compact itself; its SDK prompt() would send the line to
// the model. Bivy offers it and runs Pi's compaction instead, and the turn
// ends once even when Pi has nothing to compact (Pi reports that as a
// compaction failure, which the chat shows as one notice, not a second error).

let calls = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => { calls += 1; res.writeHead(500).end(); });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-compact-"));
const workspace = path.join(piDir, "ws");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
  providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } },
}));

const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir: path.join(piDir, "sessions"), credentialOwner: "agent", allowModelNetwork: false });
try {
  const { session } = await runtime.createSession({ workspace });
  await session.setModel!("local", "m");
  assert.ok(session.getCommands!().some((command) => command.name === "/compact"), "the composer offers /compact");
  const events: Array<{ type: string; level?: string; message?: string; trigger?: string }> = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("/compact keep the plan");
  session.dispose();

  assert.equal(calls, 0, "the line never reached the model");
  assert.deepEqual(events.filter((e) => e.type === "agent_compaction").map((e) => e.trigger), ["manual", "manual"]);
  const notices = events.filter((e) => e.type === "session.notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "warning");
  assert.match(String(notices[0].message), /^The agent couldn't summarize the conversation: Nothing to compact/);
  assert.equal(events.filter((e) => e.type === "agent_end").length, 1, "the turn ends once");
} finally {
  server.close();
  fs.rmSync(piDir, { recursive: true, force: true });
}
