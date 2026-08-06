// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";

/**
 * End-to-end test for Step 2 (relay).
 *
 * Spawns the control plane + relay, enrolls a node, then connects a mock node
 * and a remote client through the relay. Verifies:
 *  1. A client can send an E2E-encrypted frame to the node and get a reply.
 *  2. The relay only ever transports CIPHERTEXT (never the plaintext).
 *  3. Account ownership is enforced (a foreign account cannot reach the node).
 *
 * The E2E key here stands in for a pairing-derived shared secret. The relay
 * never has it.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cpDir = path.resolve(testDir, "../../control-plane");
const relayDir = path.resolve(testDir, "..");
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned")));
    });
    server.on("error", reject);
  });
}
const CP_PORT = await freePort();
const RELAY_PORT = await freePort();
const SECRET = "test-relay-secret";

const procs: ChildProcess[] = [];
function spawnService(cwd: string, env: Record<string, string>) {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`Failed to start service in ${cwd}:`, error);
    cleanup(1);
  });
  procs.push(child);
  return child;
}

function cleanup(code: number) {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not ready yet
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

// --- E2E crypto (pairing-derived key stand-in) -------------------------
const KEY = randomBytes(32); // shared by node + client only; NOT by relay
function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}
function open(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function frame(plaintext: string) {
  return JSON.stringify({ t: "frame", p: seal(plaintext) });
}

async function http(pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${CP_PORT}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`\u2717 FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`\u2713 ${msg}`);
}

async function main() {
  spawnService(cpDir, { PORT: String(CP_PORT), RELAY_SECRET: SECRET });
  spawnService(relayDir, {
    PORT: String(RELAY_PORT),
    RELAY_SECRET: SECRET,
    CONTROL_PLANE_URL: `http://localhost:${CP_PORT}`,
  });
  await waitForHttp(`http://localhost:${CP_PORT}/healthz`);

  // Account A enrolls a node.
  const loginA = await http("/auth/dev-login", { email: "owner@a.com" });
  const sessA = loginA.json.token;
  const enroll = await http("/nodes/enroll", { nodeId: "node_test_1", name: "Test" }, sessA);
  const enrToken = enroll.json.enrollmentToken;
  expect(!!enrToken, "node enrolled, got enrollment token");

  // Mock node exchanges its enrollment token for a single-use relay ticket,
  // then connects to the relay with the ticket (never the reusable bearer).
  const nodeTicket = (await http("/node/relay-ticket", {}, enrToken)).json.ticket;
  expect(!!nodeTicket, "node minted a relay ticket");
  const node = await connect(`ws://localhost:${RELAY_PORT}/node?ticket=${nodeTicket}`);
  const nodeSaw: string[] = [];
  node.on("message", (d) => nodeSaw.push(d.toString()));
  await delay(300);

  // Remote client (account A) mints a ticket, then connects, selecting the node.
  const clientTicket = (await http("/client/relay-ticket", {}, sessA)).json.ticket;
  expect(!!clientTicket, "client minted a relay ticket");
  const client = await connect(
    `ws://localhost:${RELAY_PORT}/client?ticket=${clientTicket}&nodeId=node_test_1`,
  );
  const clientSaw: string[] = [];
  client.on("message", (d) => clientSaw.push(d.toString()));
  await delay(300);

  // 1. Client -> node encrypted frame.
  const clientPlaintext = JSON.stringify({ kind: "prompt", text: "summarize my repo" });
  client.send(frame(clientPlaintext));
  await delay(300);

  const nodeFrame = nodeSaw.map((t) => JSON.parse(t)).find((m) => m.t === "frame");
  expect(!!nodeFrame, "node received a frame from the client");
  expect(open(nodeFrame.p) === clientPlaintext, "node decrypts client frame correctly");
  expect(!nodeFrame.p.includes("summarize"), "frame on the wire is ciphertext, not plaintext");

  // 2. Node -> client encrypted reply.
  const nodePlaintext = JSON.stringify({ kind: "event", delta: "Found 12 files." });
  node.send(frame(nodePlaintext));
  await delay(300);
  const clientFrame = clientSaw.map((t) => JSON.parse(t)).find((m) => m.t === "frame");
  expect(!!clientFrame, "client received a frame from the node");
  expect(open(clientFrame.p) === nodePlaintext, "client decrypts node frame correctly");

  // 2b. Node flap recovery: when the node drops and redials (common on flaky
  // mobile links), the still-connected client must be told peer.offline AND then
  // peer.online — otherwise the client stays stuck on "node offline" forever.
  const flapMark = clientSaw.length;
  node.close();
  await delay(300);
  expect(
    clientSaw.slice(flapMark).map((t) => JSON.parse(t)).some((m) => m.t === "peer.offline"),
    "client notified peer.offline when the node drops",
  );
  const onlineMark = clientSaw.length;
  const nodeTicket2 = (await http("/node/relay-ticket", {}, enrToken)).json.ticket;
  const node2 = await connect(`ws://localhost:${RELAY_PORT}/node?ticket=${nodeTicket2}`);
  node2.on("message", (d) => nodeSaw.push(d.toString()));
  await delay(400);
  expect(
    clientSaw.slice(onlineMark).map((t) => JSON.parse(t)).some((m) => m.t === "peer.online"),
    "client notified peer.online when the node reconnects",
  );

  // 3. Ownership enforcement: account B cannot reach account A's node.
  const loginB = await http("/auth/dev-login", { email: "intruder@b.com" });
  const sessB = loginB.json.token;
  const intruderTicket = (await http("/client/relay-ticket", {}, sessB)).json.ticket;
  let rejected = false;
  await new Promise<void>((resolve) => {
    const intruder = new WebSocket(
      `ws://localhost:${RELAY_PORT}/client?ticket=${intruderTicket}&nodeId=node_test_1`,
    );
    intruder.on("close", () => {
      rejected = true;
      resolve();
    });
    intruder.on("error", () => resolve());
    setTimeout(resolve, 1500);
  });
  expect(rejected, "foreign account is refused access to the node");

  console.log("\nAll relay e2e checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
