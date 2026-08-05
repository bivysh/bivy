import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCredentialVault } from "../src/runtime/credential-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-setup-isolated-"));
const dataDir = path.join(scratch, "data");
const home = path.join(scratch, "home");
const workspace = path.join(scratch, "workspace");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const nodePort = await freePort();
const cp = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/node/link-grant") {
    res.end(JSON.stringify({ sessionToken: "sandbox-link-token", relayUrl: "ws://127.0.0.1:9" }));
    return;
  }
  if (req.url === "/node/model-auth-vault") {
    res.end(JSON.stringify({ ok: true, vault: null, wrappedKey: null, requests: [] }));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => cp.listen(0, "127.0.0.1", resolve));
const cpAddress = cp.address();
assert.ok(cpAddress && typeof cpAddress === "object");
const controlPlaneUrl = `http://127.0.0.1:${cpAddress.port}`;
const remoteApp = "https://app.example.test";

fs.writeFileSync(path.join(dataDir, "cli.json"), `${JSON.stringify({ workspace, port: nodePort, env: { BIVY_RUNTIME: "pi" }, service: false }, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, "relay.json"), `${JSON.stringify({ url: "ws://127.0.0.1:9", controlPlaneUrl, clientBaseUrl: remoteApp, enrollmentToken: "sandbox-enrollment" }, null, 2)}\n`);
await createCredentialVault(path.join(dataDir, "credentials")).setApiKey("openai", "sandbox-only-key");

const env = {
  ...process.env,
  HOME: home,
  BIVY_DATA_DIR: dataDir,
  BIVY_HOST: "127.0.0.1",
  BIVY_OPEN_BOOTSTRAP: "1",
  BIVY_SETUP_SKIP_SERVICE: "1",
  BIVY_SKIP_AGENT_PREINSTALL: "1",
  NO_COLOR: "1",
  PORT: String(nodePort),
};
const daemon = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let daemonLog = "";
daemon.stdout.on("data", (chunk) => { daemonLog += chunk.toString(); });
daemon.stderr.on("data", (chunk) => { daemonLog += chunk.toString(); });

try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${nodePort}/api/status`);
      if (response.ok) break;
    } catch { /* node is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`http://127.0.0.1:${nodePort}/api/status`)).ok, true, `isolated node did not start:\n${daemonLog}`);

  const setup = spawn(process.execPath, ["bin/bivy.mjs", "setup"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  setup.stdout.on("data", (chunk) => { output += chunk.toString(); });
  setup.stderr.on("data", (chunk) => { output += chunk.toString(); });
  setup.stdin.end("p\n");
  const code = await new Promise<number | null>((resolve) => setup.on("exit", resolve));
  assert.equal(code, 0, output);
  assert.match(output, /Which agent do you want to try first\?/);
  assert.match(output, /Default agent: Pi/);
  assert.match(output, /Background-service install skipped/);
  assert.match(output, /Remote app:\s+https:\/\/app\.example\.test/);
  assert.match(output, /Run your first task:/);
  assert.ok(output.indexOf(remoteApp) < output.indexOf("Run your first task:"), "remote app must be presented before terminal fallback steps");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "cli.json"), "utf8")).port, nodePort, "sandbox setup kept its isolated port");
  console.log("setup-isolated-smoke: agent-first setup reaches the remote app without touching the host service");
} finally {
  daemon.kill("SIGTERM");
  await new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  await new Promise<void>((resolve) => cp.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
