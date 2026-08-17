import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import net from "node:net";
import { sealFrame, openFrame } from "../src/e2e.js";
import { RelayConnector, type RelayConfig } from "../src/remote/index.js";
import { PairingStore } from "../src/device-registry.js";
import { generatePairingKeypair, pairingProof, deriveWrapKey, unwrapRoomKey } from "../src/pairing-crypto.js";

/**
 * Full remote-control path test:
 *   control plane + relay + real RelayConnector (node) + simulated phone client.
 *
 * The phone reaches its node through the X25519 pairing handshake (the legacy
 * static-e2eKey room-key path was retired). Node↔browser crypto
 * interop is covered by test/crypto-conformance.test.ts; the pairing handshake +
 * key rotation by test/remote-pairing-e2e.ts. This test focuses on the wider
 * remote-control path that sits ON TOP of a paired session:
 *  1. A node-scoped link grant is minted by the control plane and can list only
 *     its own node, not the whole account's registry.
 *  2. A phone completes the handshake and its prompt/history frames round-trip to
 *     the node, E2E-private (the relay never sees the room key or plaintext).
 *  3. The node's session.history backfill and session.event frames reach the
 *     phone, decrypted.
 *  4. A grant scoped to node A cannot reach node B (foreign-account refusal).
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
const SECRET = "remote-test-secret";
const procs: ChildProcess[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an HTTP listener until it accepts connections. Replaces a fixed boot
 * delay so a slow CI cold start (npx tsx spawn + service init) doesn't race the
 * first request — the failure mode was an ECONNREFUSED on /auth/dev-login when
 * the control plane took longer than the old 2.5s to bind.
 */
async function waitForServer(port: number, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(`http://localhost:${port}/`);
      return; // any HTTP response means the listener is up
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (code && code !== "ECONNREFUSED") return; // connected, just not HTTP-friendly (e.g. ws)
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
function done(code: number) { for (const p of procs) p.kill("SIGTERM"); process.exit(code); }
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

async function mintClientTicket(token: string): Promise<string> {
  const out = await http("/client/relay-ticket", {}, token);
  ok(out.status === 200 && !!out.json?.ticket, "client minted a single-use relay ticket");
  return out.json.ticket as string;
}

// A simulated phone: an X25519 keypair that completes the pairing handshake over
// the relay and then holds the room key for bulk frames (same primitives the
// browser client uses).
interface Phone {
  ws: WebSocket;
  saw: any[];
  roomKey: Buffer | null;
}

/** Connect a phone, run the X25519 handshake, and resolve once it holds the room key. */
async function pairPhone(store: PairingStore, nodeId: string, phoneSession: string): Promise<Phone> {
  const device = generatePairingKeypair();
  const nodePub = store.nodePublicKeyB64();
  const secret = store.issuePairSecret(); // stands in for the QR's pairing secret
  const ticket = await mintClientTicket(phoneSession);
  const ws = new WebSocket(`ws://localhost:${RELAY}/client?ticket=${encodeURIComponent(ticket)}&nodeId=${nodeId}`);
  const phone: Phone = { ws, saw: [], roomKey: null };
  ws.on("error", () => { /* keep the process alive; the assertions surface failures */ });
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
        try { phone.roomKey = unwrapRoomKey(deriveWrapKey(device.privateKeyB64, nodePub, "pair"), msg.wrapped); } catch { /* not ours */ }
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

  // 1. Enroll the node + mint a node-scoped link grant (as the node would).
  const login = await http("/auth/dev-login", { email: "owner@bivy.test" });
  const enroll = await http("/nodes/enroll", { nodeId: "node_remote_1", name: "MacBook" }, login.json.token);
  const enr = enroll.json.enrollmentToken;
  const grant = await http("/node/link-grant", {}, enr);
  const phoneSession = grant.json.sessionToken;
  ok(!!phoneSession && grant.json.relayUrl === `ws://localhost:${RELAY}`, "node minted a node-scoped link grant for the phone");

  // A QR link grant is intentionally node-scoped. It can list only its linked
  // node, not the whole account's node registry.
  const nodeList = await fetch(`http://localhost:${CP}/nodes`, { headers: { authorization: `Bearer ${phoneSession}` } }).then((r) => r.json());
  ok(Array.isArray(nodeList) && nodeList.length === 1 && nodeList[0]?.id === "node_remote_1", "node-scoped phone grant lists only its linked node");

  // 2. Real node connector dials the relay, carrying its pairing store (the
  // production path — there is no static-key fallback).
  const received: any[] = [];
  const store = PairingStore.load(root + "/.bivy-remote-e2e-" + CP);
  const config: RelayConfig = { url: `ws://localhost:${RELAY}`, enrollmentToken: enr, controlPlaneUrl: `http://localhost:${CP}` };
  const connector = new RelayConnector(config, (msg) => received.push(msg), { pairing: store });
  connector.start();
  await delay(800);

  // 3a. Phone completes the handshake, then sends a prompt + history request.
  const phone = await pairPhone(store, "node_remote_1", phoneSession);
  await delay(800);
  ok(phone.roomKey !== null && phone.roomKey!.equals(store.roomKey()), "phone completed the handshake and shares the node's room key");

  phoneSend(phone, { kind: "prompt", text: "list files" });
  phoneSend(phone, { kind: "history" });
  await delay(500);
  ok(received.some((m) => m.kind === "prompt" && m.text === "list files"), "node connector received the phone's prompt (decrypted)");
  ok(received.some((m) => m.kind === "history"), "node connector received the phone's history request (decrypted)");

  // History backfill: the node replies with a session.history frame.
  connector.sendEvent({ type: "session.history", sessionId: "s1", messages: [{ role: "user", content: "earlier message" }] });
  await delay(400);
  ok(phone.saw.some((p) => p.type === "session.history"), "phone received session history backfill (decrypted)");

  // 3b. Node pushes an event; phone receives + decrypts it.
  connector.sendEvent({ type: "session.event", event: { type: "message_end", message: { role: "assistant", content: "Done." } } });
  await delay(500);
  ok(phone.saw.some((p) => p.type === "session.event"), "phone received the node's event frame (decrypted)");

  // 4. A different account's session must not reach this account's node. The
  // intruder can mint a valid ticket for its own account, but the relay refuses
  // to attach it to a node owned by someone else.
  const loginB = await http("/auth/dev-login", { email: "intruder@bivy.test" });
  const badTicket = await mintClientTicket(loginB.json.token);
  let refused = false;
  await new Promise<void>((res) => {
    const bad = new WebSocket(`ws://localhost:${RELAY}/client?ticket=${encodeURIComponent(badTicket)}&nodeId=node_remote_1`);
    bad.on("close", () => { refused = true; res(); });
    bad.on("error", () => res());
    setTimeout(res, 1500);
  });
  ok(refused, "a foreign account's session is refused for this node");

  connector.stop();
  console.log("\nAll Step-B remote-path checks passed.");
  done(0);
}

// Watchdog so the test can never hang a CI runner.
setTimeout(() => { console.error("WATCHDOG: timed out"); done(1); }, 45000).unref();

main().catch((e) => { console.error(e); done(1); });
