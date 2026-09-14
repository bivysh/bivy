// `bivy exec` runs a headless turn over the daemon's HTTP + WebSocket API and
// must reflect the turn's real outcome in its exit code. Regression coverage
// for: a mid-turn WebSocket disconnect (network drop, daemon restart, …) used
// to exit 0 whenever *any* partial assistant text had streamed in — so a
// truncated reply looked like a clean success to a script checking `$?`. Only
// an observed `agent_end` (turn actually finished) may exit 0.
//
// Drives the real `src/exec.ts` CLI as a subprocess against a minimal fake
// HTTP+WS server (same style as test/attach-utf8.test.ts), so this exercises
// the actual close/finish logic exec.ts runs, not a reimplementation of it.

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const execEntry = path.join(repoRoot, "src", "exec.ts");
const execArgs = existsSync(tsxCli) ? [tsxCli, execEntry] : [execEntry];

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

type Behavior =
  | "disconnect-after-partial"
  | "disconnect-no-text"
  | "complete-normally"
  // Turn ends with NO assistant text but a failing agent_end (non-zero code)
  // plus an agent_output stderr line — e.g. an unauthenticated CLI. exec must
  // surface the stderr and exit non-zero, not report a silent empty success.
  | "fail-no-text-with-code";

/** Records the parsed body of the last POST /api/session, so tests can assert
 *  which fields (name/model/workspace) exec sends to the daemon. */
type CreateProbe = { body?: Record<string, unknown> };

/** Spin up a fake daemon: /api/session + /api/session/prompt over HTTP, turn events over a /ws socket. */
async function withFakeDaemon(behavior: Behavior, fn: (url: string, probe: CreateProbe) => Promise<void>) {
  const sessionId = "sess-fake-1";
  let wsSocket: import("ws").WebSocket | undefined;
  const probe: CreateProbe = {};

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST" && req.url === "/api/session") {
        try { probe.body = body ? JSON.parse(body) : {}; } catch { probe.body = {}; }
        res.end(JSON.stringify({ id: sessionId }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/session/prompt") {
        res.end(JSON.stringify({ ok: true }));
        // Drive the turn's WS events once the prompt is "accepted", mirroring
        // how the real daemon streams a turn after /api/session/prompt returns.
        queueMicrotask(() => {
          if (!wsSocket) return;
          const send = (event: Record<string, unknown>) => wsSocket!.send(JSON.stringify({ type: "session.event", sessionId, event }));
          if (behavior === "disconnect-after-partial") {
            send({ type: "message_start", message: { role: "assistant", content: "" } });
            send({ type: "message_update", message: { role: "assistant", content: "partial answer text" } });
            setTimeout(() => wsSocket!.close(), 20); // drop before agent_end
          } else if (behavior === "disconnect-no-text") {
            setTimeout(() => wsSocket!.close(), 20); // drop with no text at all
          } else if (behavior === "fail-no-text-with-code") {
            send({ type: "tool_execution_update", toolName: "agent_output", toolCallId: "agent-output", input: { stream: "stderr", output: "Error: Not signed in. Run: grok login" } });
            send({ type: "agent_end", code: 1 });
          } else {
            send({ type: "message_start", message: { role: "assistant", content: "" } });
            send({ type: "message_update", message: { role: "assistant", content: "the full answer" } });
            send({ type: "message_end", message: { role: "assistant", content: "the full answer" } });
            send({ type: "agent_end" });
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => { wsSocket = socket; });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    await fn(url, probe);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runExec(url: string, extraArgs: string[] = [], timeoutMs = 8000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgs, "--url", url, ...extraArgs, "hello"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`exec did not exit in time; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

await check("exits non-zero when the socket closes mid-turn WITH a partial answer already streamed", async () => {
  await withFakeDaemon("disconnect-after-partial", async (url) => {
    const { code, stdout } = await runExec(url);
    assert.notEqual(code, 0, `expected a non-zero exit for a mid-turn disconnect, got ${code} (stdout=${JSON.stringify(stdout)})`);
  });
});

await check("exits non-zero when the socket closes mid-turn with no text at all", async () => {
  await withFakeDaemon("disconnect-no-text", async (url) => {
    const { code } = await runExec(url);
    assert.notEqual(code, 0);
  });
});

await check("exits zero only once agent_end is actually observed", async () => {
  await withFakeDaemon("complete-normally", async (url) => {
    const { code, stdout } = await runExec(url);
    assert.equal(code, 0, `expected exit 0 on a real completion, got ${code}`);
    assert.ok(stdout.includes("the full answer"), `stdout should carry the final answer, got ${JSON.stringify(stdout)}`);
  });
});

await check("exits non-zero and surfaces stderr when a turn ends with no text but a failing agent_end", async () => {
  await withFakeDaemon("fail-no-text-with-code", async (url) => {
    const { code, stdout, stderr } = await runExec(url);
    assert.notEqual(code, 0, `a failed turn with no output must exit non-zero, got ${code}`);
    assert.equal(stdout.trim(), "", `stdout should stay empty on failure, got ${JSON.stringify(stdout)}`);
    assert.ok(stderr.includes("Not signed in"), `stderr should carry the agent's error, got ${JSON.stringify(stderr)}`);
  });
});

await check("sends --name/--model/--workspace to the daemon instead of leaking them into the prompt", async () => {
  await withFakeDaemon("complete-normally", async (url, probe) => {
    const { code } = await runExec(url, ["--agent", "codex", "--name", "nightly audit", "--model", "gpt-5.6-sol", "--workspace", "/tmp/ws"]);
    assert.equal(code, 0);
    assert.ok(probe.body, "the create request body should have been recorded");
    assert.equal(probe.body!.agent, "codex");
    assert.equal(probe.body!.name, "nightly audit", "explicit --name must be sent as the `name` field");
    assert.equal(probe.body!.workspace, "/tmp/ws");
    assert.deepEqual(probe.body!.model, { provider: "", id: "gpt-5.6-sol" }, "--model must be sent as a model ref, verbatim id");
  });
});

if (failures > 0) {
  console.error(`\n${failures} exec-exit-code test(s) failed.`);
  process.exit(1);
}
console.log("\nAll exec-exit-code tests passed.");
