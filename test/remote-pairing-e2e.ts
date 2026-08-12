import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { RelayConnector, type RelayConfig } from "../src/remote/index.js";
import { PairingStore } from "../src/device-registry.js";
import { generatePairingKeypair, pairingProof, deriveWrapKey, unwrapRoomKey } from "../src/pairing-crypto.js";
import { sealFrame, openFrame } from "../src/e2e.js";
import net from "node:net";

/**
 * End-to-end test for the X25519 pairing redesign over the REAL relay +
 * RelayConnector + control plane. The "phone" is simulated with the same
 * pairing-crypto primitives the browser uses.
 *
 * Requires localhost networking (binds two services), so it runs on CI / a real
 * host, not inside a network-restricted sandbox. Run manually with:
 *   npx tsx test/remote-pairing-e2e.ts
 *
 * Verifies:
 *  1. A device with a valid QR proof completes the handshake and receives the
 *     room key over the relay (never in the clear).
 *  2. Bidirectional encrypted frames work after pairing.
 *  3. Revoking another device rotates the room key; the surviving device keeps
 *     working with the re-wrapped key while the revoked device is cut off.
 */

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const cpDir = path.join(root, "services/control-plane");
const relayDir = path.join(root, "services/relay");
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
const CP = await freePort(), RELAY = await freePort();
const SECRET = "pairing-test-secret";
const procs: ChildProcess[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an HTTP listener until it accepts connections, so a slow CI cold start
 * doesn't race the first request (the fixed boot delay could expire before the
 * control plane bound its port, yielding ECONNREFUSED).
 */
async function waitForServer(port: number, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(`http://localhost:${port}/`);
      return;
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (code && code !== "ECONNREFUSED") return;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for localhost:${port}`);
      await delay(200);
    }
  }
}

function svc(cwd: string, env: Record<string, string>) {
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  child.once("error", (error) => { console.error(`Failed to start service in ${cwd}:`, error); done(1); });
  procs.push(child);
}
function done(code: number) { for (const p of procs) p.kill("SIGKILL"); process.exit(code); }
function ok(cond: boolean, msg: string) {
  console.log((cond ? "✓ " : "✗ FAIL: ") + msg);
  if (!cond) done(1);
}
async function http(p: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${CP}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

// A simulated phone: holds an X25519 keypair, completes the handshake, and
// tracks the room key it currently holds (updated on key.rotate).
interface Phone {
  device: ReturnType<typeof generatePairingKeypair>;
  ws: WebSocket;
  nodePub: string;
  saw: any[];
  roomKey: Buffer | null;
  deviceId: string | null;
}

async function makePhone(store: PairingStore, nodeId: string, phoneSession: string): Promise<Phone> {
  const device = generatePairingKeypair();
  const nodePub = store.nodePublicKeyB64();
  const secret = store.issuePairSecret(); // stands in for the QR's pairing secret
  const ticket = (await http("/client/relay-ticket", {}, phoneSession)).json.ticket;
  const ws = new WebSocket(`ws://localhost:${RELAY}/client?ticket=${ticket}&nodeId=${nodeId}`);
  const phone: Phone = { device, ws, nodePub, saw: [], roomKey: null, deviceId: null };

  ws.on("error", () => { /* keep process alive; reconnect logic not needed in test */ });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.once("error", (e) => rej(e));
    setTimeout(() => rej(new Error("ws open timeout")), 8000);
  });
  ws.on("message", (d) => {
    const env = JSON.parse(d.toString());
    if (env.t === "ready") {
      const proofB64 = pairingProof(secret, device.publicKeyB64);
      ws.send(JSON.stringify({ t: "pair", p: JSON.stringify({ k: "pair.hello", devicePublicKeyB64: device.publicKeyB64, proofB64 }) }));
    } else if (env.t === "pair") {
      const msg = JSON.parse(env.p);
      if (msg.k === "pair.welcome" && !phone.roomKey) {
        try {
          phone.roomKey = unwrapRoomKey(deriveWrapKey(device.privateKeyB64, nodePub, "pair"), msg.wrapped);
          phone.deviceId = msg.deviceId;
        } catch { /* not ours */ }
      } else if (msg.k === "key.rotate") {
        const rotateKey = deriveWrapKey(device.privateKeyB64, nodePub, "rotate");
        for (const del of msg.deliveries) {
          try { phone.roomKey = unwrapRoomKey(rotateKey, del.wrapped); break; } catch { /* not ours */ }
        }
      }
    } else if (env.t === "frame" && phone.roomKey) {
      try { phone.saw.push(openFrame(phone.roomKey, env.p).data); } catch { /* wrong key */ }
    }
  });
  return phone;
}

function phoneSend(phone: Phone, data: unknown) {
  phone.ws.send(JSON.stringify({ t: "frame", p: sealFrame(phone.roomKey!, data) }));
}

async function main() {
  svc(cpDir, { PORT: String(CP), RELAY_SECRET: SECRET, RELAY_PUBLIC_URL: `ws://localhost:${RELAY}` });
  svc(relayDir, { PORT: String(RELAY), RELAY_SECRET: SECRET, CONTROL_PLANE_URL: `http://localhost:${CP}` });
  await Promise.all([waitForServer(CP), waitForServer(RELAY)]);

  const login = await http("/auth/dev-login", { email: "owner@bivy.test" });
  const enroll = await http("/nodes/enroll", { nodeId: "node_pair_1", name: "MacBook" }, login.json.token);
  const enr = enroll.json.enrollmentToken;
  const grant = await http("/node/link-grant", {}, enr);
  const phoneSession = grant.json.sessionToken;

  // Node connector with a pairing store (the production path).
  const store = PairingStore.load(root + "/.bivy-test-" + Date.now());
  const received: any[] = [];
  const config: RelayConfig = { url: `ws://localhost:${RELAY}`, enrollmentToken: enr, controlPlaneUrl: `http://localhost:${CP}` };
  const connector = new RelayConnector(config, (msg) => received.push(msg), { pairing: store });
  connector.start();
  await delay(800);

  // 1. Phone A completes the X25519 handshake.
  const a = await makePhone(store, "node_pair_1", phoneSession);
  await delay(800);
  ok(a.roomKey !== null, "phone A completed the handshake and obtained a room key");
  ok(a.roomKey!.equals(store.roomKey()), "phone A's room key matches the node's room key");

  // 2. Bidirectional encrypted frames after pairing.
  phoneSend(a, { kind: "prompt", text: "list files" });
  await delay(400);
  ok(received.some((m) => m.kind === "prompt" && m.text === "list files"), "node decrypted the phone's prompt over the handshake key");
  connector.sendEvent({ type: "session.event", event: { type: "message_end" } });
  await delay(400);
  ok(a.saw.some((p) => p.type === "session.event"), "phone A decrypted the node's event");

  // 3. Pair phone B, then revoke it; phone A must rotate and keep working.
  const b = await makePhone(store, "node_pair_1", phoneSession);
  await delay(800);
  ok(b.roomKey !== null && b.deviceId !== null, "phone B completed the handshake");

  const deliveries = store.revokeDevice(b.deviceId!);
  ok(deliveries !== null, "revoking phone B produced rotation deliveries");
  connector.pushRotate(deliveries!);
  await delay(600);
  ok(a.roomKey!.equals(store.roomKey()), "phone A received the rotated room key");

  // Node sends an event with the new key: A (rotated) decrypts, B (revoked) cannot.
  const beforeA = a.saw.length, beforeB = b.saw.length;
  connector.sendEvent({ type: "session.event", event: { type: "post_revoke" } });
  await delay(500);
  ok(a.saw.length > beforeA && a.saw.some((p) => p.type === "session.event"), "surviving phone A still decrypts after rotation");
  ok(b.saw.length === beforeB, "revoked phone B can no longer decrypt node events");

  connector.stop();
  console.log("\nAll X25519 pairing e2e checks passed.");
  done(0);
}

// Watchdog so the test can never hang a CI runner.
setTimeout(() => { console.error("WATCHDOG: timed out"); done(1); }, 45000).unref();

main().catch((e) => { console.error(e); done(1); });
