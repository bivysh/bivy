// SPDX-License-Identifier: MIT
// `bivy background`: the detached watcher runs the command, logs its output,
// and wakes the session through the node with the session's own token — once
// on the first --match line, once on exit. The job spec carries that token, so
// it must not reach the command's environment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const watcher = fileURLToPath(new URL("../bin/background-job.mjs", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-bg-test-"));

const wakes: { url?: string; auth?: string; text: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    wakes.push({ url: req.url, auth: req.headers.authorization, text: JSON.parse(body).text });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const nodeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function job(spec: Record<string, unknown>) {
  const log = path.join(dir, `${wakes.length}.log`);
  const child = spawn(process.execPath, [watcher], {
    stdio: "ignore",
    env: { ...process.env, BIVY_BACKGROUND_JOB: JSON.stringify({ sessionId: "s/1", nodeUrl, auth: "bivy_st_x", cwd: dir, log, ...spec }) },
  });
  await new Promise((resolve) => child.on("exit", resolve));
  return fs.readFileSync(log, "utf8");
}

try {
  const log = await job({
    label: "serve",
    command: "sh",
    args: ["-c", 'echo booting; echo "ready on 3000"; echo "spec=${BIVY_BACKGROUND_JOB:-unset}"; echo ready again; exit 3'],
    match: "^ready on",
  });
  assert.equal(wakes.length, 2, "one wake for the first match, one for the exit");
  assert(wakes.every((w) => w.url === "/api/session/s%2F1/wake" && w.auth === "Bearer bivy_st_x"));
  assert.match(wakes[0].text, /"serve" printed a line matching .*\n {4}ready on 3000/);
  assert.match(wakes[1].text, /"serve" exited with code 3/);
  assert.match(wakes[1].text, /Last output:\n {4}booting\n {4}ready on 3000\n {4}spec=unset/);
  assert.match(log, /spec=unset/, "the token-bearing job spec stays out of the command's env");

  await job({ label: "missing", command: path.join(dir, "no-such-command"), args: [] });
  assert.match(wakes[2].text, /"missing" exited with code 127[\s\S]*ENOENT/, "a command that cannot start still wakes the session");
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("background-job: passed");
