import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const attachEntry = path.join(repoRoot, "src", "attach.ts");
const attachArgs = existsSync(tsxCli) ? [tsxCli, attachEntry] : [attachEntry];

async function main() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);

  const url = `http://127.0.0.1:${address.port}`;
  const termId = "term-utf8";
  const replay = "╭─ Claude 🧠\r\n";
  const echo = "λ typed ✓\r\n";
  const input = "λ\n";
  let inputSeen = "";

  const child = spawn(process.execPath, [...attachArgs, "--url", url, "--attach", termId], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { kind?: string; termId?: string; data?: string };
      if (msg.kind === "terminal.attach") {
        assert.equal(msg.termId, termId);
        socket.send(JSON.stringify({ type: "terminal.attached", termId, data: replay }));
        setTimeout(() => child.stdin.write(input), 25);
      } else if (msg.kind === "terminal.input") {
        inputSeen += msg.data ?? "";
        socket.send(JSON.stringify({ type: "terminal.output", termId, data: echo }));
        socket.send(JSON.stringify({ type: "terminal.exit", termId, code: 0 }));
      }
    });
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timed out waiting for attach bridge; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 8000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });

  server.close();

  assert.equal(code, 0, stderr);
  assert.equal(inputSeen, input, "local UTF-8 input is forwarded unchanged");
  assert.ok(stdout.includes(replay), "scrollback UTF-8 output is written unchanged");
  assert.ok(stdout.includes(echo), "live UTF-8 output is written unchanged");
  console.log("attach: ok (UTF-8 input/output bridge)");
}

main().catch((error) => {
  console.error("attach: FAILED\n", error);
  process.exit(1);
});
