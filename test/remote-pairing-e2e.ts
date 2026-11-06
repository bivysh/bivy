import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { TeamShare } from "../src/team-share.js";
import { SessionInvites, guestEvent } from "../src/session-invites.js";
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

/** Send one `pair.account` over the relay and resolve with the node's answer. */
async function accountPair(nodeId: string, ticketBearer: string, grant: string, devicePublicKeyB64: string): Promise<any> {
  const ticket = (await http("/client/relay-ticket", { nodeId }, ticketBearer)).json.ticket;
  const ws = new WebSocket(`ws://localhost:${RELAY}/client?ticket=${ticket}&nodeId=${nodeId}`);
  try {
    return await new Promise((resolve, reject) => {
      ws.on("message", (d) => {
        const env = JSON.parse(d.toString());
        if (env.t === "ready") ws.send(JSON.stringify({ t: "pair", p: JSON.stringify({ k: "pair.account", sessionToken: grant, devicePublicKeyB64, ephemeral: true }) }));
        else if (env.t === "pair") resolve(JSON.parse(env.p));
      });
      ws.once("error", reject);
      setTimeout(() => reject(new Error("pair.account got no answer")), 8000);
    });
  } finally {
    ws.close();
  }
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
  let teamShared = false;
  const invites = new SessionInvites(root + "/.bivy-test-invites-" + Date.now());
  const guestFrames: Array<{ msg: any; inviteId?: string }> = [];
  const guests = {
    invites: () => invites.list(),
    forAccount: (accountId: string) => invites.forAccount(accountId),
    eventFor: (inviteId: string, event: unknown) => {
      const invite = invites.get(inviteId);
      return invite ? guestEvent(invite, event, () => false) : null;
    },
  };
  const connector = new RelayConnector(config, (msg, guest) => { received.push(msg); guestFrames.push({ msg, inviteId: guest?.inviteId }); }, { pairing: store, teamShared: () => teamShared, guests });
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

  // 4. Account pairing. The grant crosses the relay inside `pair.account`, so
  // a relay that reads it must not be able to pair a key of its own with it,
  // replay it, or use a reusable link grant in its place.
  const device = generatePairingKeypair();
  const relayKey = generatePairingKeypair();
  const pairGrant = (await http("/client/pair-grant", { nodeId: "node_pair_1", devicePublicKeyB64: device.publicKeyB64 }, login.json.token)).json.grant;
  ok((await accountPair("node_pair_1", phoneSession, pairGrant, relayKey.publicKeyB64)).k === "pair.error", "a pair grant does not pair a different device key");
  const welcome = await accountPair("node_pair_1", phoneSession, pairGrant, device.publicKeyB64);
  ok(welcome.k === "pair.welcome" && unwrapRoomKey(deriveWrapKey(device.privateKeyB64, store.nodePublicKeyB64(), "pair"), welcome.wrapped).equals(store.roomKey()), "a pair grant pairs the device key it was minted for");
  ok((await accountPair("node_pair_1", phoneSession, pairGrant, device.publicKeyB64)).k === "pair.error", "a pair grant works only once");
  ok((await accountPair("node_pair_1", phoneSession, phoneSession, relayKey.publicKeyB64)).k === "pair.error", "a reusable link grant does not pair");

  // A linking QR's grant reaches its one node, never the account's settings.
  const automations = (bearer: string) => fetch(`http://localhost:${CP}/account/automations`, { headers: { authorization: `Bearer ${bearer}` } });
  ok((await automations(phoneSession)).status === 401, "a node-scoped link grant cannot read account-wide routes");
  ok((await automations(login.json.token)).status === 200, "an account session can");

  // 5. A machine shared with the team (team-machines.ts, src/team-share.ts).
  const teammate = await http("/auth/dev-login", { email: "teammate@bivy.test" });
  const outsider = await http("/auth/dev-login", { email: "outsider@bivy.test" });
  await http("/account/team", { name: "Acme" }, login.json.token);
  const invite = await http("/account/team/invites", {}, login.json.token);
  await http("/account/team/join", { token: invite.json.url.split("#")[1] }, teammate.json.token);
  const mateDevice = generatePairingKeypair();
  const mateGrant = () => http("/client/pair-grant", { nodeId: "node_pair_1", devicePublicKeyB64: mateDevice.publicKeyB64 }, teammate.json.token);
  ok((await mateGrant()).status === 404, "a teammate can't reach a machine that isn't shared");
  const share = (shared: boolean) => fetch(`http://localhost:${CP}/node/team-share`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${enr}` }, body: JSON.stringify({ shared }),
  });
  await share(true);
  const listed = await (await fetch(`http://localhost:${CP}/nodes`, { headers: { authorization: `Bearer ${teammate.json.token}` } })).json() as any[];
  ok(listed.some((n) => n.id === "node_pair_1" && n.sharedBy === "owner@bivy.test"), "the teammate's machine list shows it, shared by the owner");
  ok((await http("/client/pair-grant", { nodeId: "node_pair_1", devicePublicKeyB64: mateDevice.publicKeyB64 }, outsider.json.token)).status === 404, "someone outside the team still can't");
  const refused = await accountPair("node_pair_1", teammate.json.token, (await mateGrant()).json.grant, mateDevice.publicKeyB64);
  ok(refused.k === "pair.error" && /isn't shared/.test(refused.error), "the machine refuses a teammate until its own switch is on");
  teamShared = true;
  const mateWelcome = await accountPair("node_pair_1", teammate.json.token, (await mateGrant()).json.grant, mateDevice.publicKeyB64);
  ok(mateWelcome.k === "pair.welcome", "with sharing on, the teammate's device pairs through the owner's room");
  const mateRecord = store.listDevices().find((d) => d.publicKeyB64 === mateDevice.publicKeyB64);
  ok(mateRecord?.teammate?.email === "teammate@bivy.test", "the machine records whose device it is");

  // Leaving the team: the control plane stops vouching, and the machine's
  // next check removes the device and rotates the room key.
  const teamView = await (await fetch(`http://localhost:${CP}/account/team`, { headers: { authorization: `Bearer ${teammate.json.token}` } })).json() as any;
  const mateId = teamView.members.find((m: any) => m.email === "teammate@bivy.test").accountId;
  await fetch(`http://localhost:${CP}/account/team/members/${mateId}`, { method: "DELETE", headers: { authorization: `Bearer ${teammate.json.token}` } });
  ok((await mateGrant()).status === 404, "after leaving, the teammate can't get a new pair grant");
  const roomKeyBefore = store.roomKey();
  const teamShareCheck = new TeamShare({
    request: (pathname, init) => fetch(`http://localhost:${CP}${pathname}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${enr}` } }),
    enabled: () => teamShared,
    devices: () => store.listDevices(),
    revoke: (id) => { store.revokeDevice(id); },
  });
  await teamShareCheck.check();
  ok(!store.listDevices().some((d) => d.teammate), "the machine removed the departed teammate's device");
  ok(!store.roomKey().equals(roomKeyBefore), "and rotated its room key");

  // 6. A session invite: a teammate gets one session, under its own key.
  teamShared = false;
  await share(false);
  const guest = await http("/auth/dev-login", { email: "guest@bivy.test" });
  const invite2 = await http("/account/team/invites", {}, login.json.token);
  await http("/account/team/join", { token: invite2.json.url.split("#")[1] }, guest.json.token);
  const guestId = (await (await fetch(`http://localhost:${CP}/account/team`, { headers: { authorization: `Bearer ${guest.json.token}` } })).json() as any)
    .members.find((m: any) => m.email === "guest@bivy.test").accountId;
  const guestDevice = generatePairingKeypair();
  const guestGrant = () => http("/client/pair-grant", { nodeId: "node_pair_1", devicePublicKeyB64: guestDevice.publicKeyB64 }, guest.json.token);
  ok((await guestGrant()).status === 404, "without an invite, a teammate can't reach an unshared machine");
  const inv = invites.create({ sessionId: "s1", accountId: guestId, email: "guest@bivy.test", mode: "view", durationMs: 60 * 60_000 });
  const routed = await (await fetch(`http://localhost:${CP}/node/session-invites`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${enr}` }, body: JSON.stringify({ invites: invites.routing() }),
  })).json() as any;
  ok(routed.invites.length === 1 && !JSON.stringify(routed).includes(inv.keyB64), "the control plane gets routing only, never the invite key");
  const guestNodes = await (await fetch(`http://localhost:${CP}/nodes`, { headers: { authorization: `Bearer ${guest.json.token}` } })).json() as any[];
  ok(guestNodes.some((n) => n.id === "node_pair_1" && n.guestSessions === 1), "the guest's machine list shows the invite");
  const guestWelcome = await accountPair("node_pair_1", guest.json.token, (await guestGrant()).json.grant, guestDevice.publicKeyB64);
  const guestKey = guestWelcome.k === "pair.welcome" ? unwrapRoomKey(deriveWrapKey(guestDevice.privateKeyB64, store.nodePublicKeyB64(), "pair"), guestWelcome.wrapped) : null;
  ok(Boolean(guestKey) && guestKey!.equals(Buffer.from(inv.keyB64, "base64")), "the guest's device gets the invite key");
  ok(!guestKey!.equals(store.roomKey()) && !store.listDevices().some((d) => d.publicKeyB64 === guestDevice.publicKeyB64), "never the room key, and it isn't one of the machine's devices");

  // The guest's frames open under the invite key and are marked as theirs; they
  // see their session's events and nothing else.
  const guestTicket = (await http("/client/relay-ticket", { nodeId: "node_pair_1" }, guest.json.token)).json.ticket;
  const gws = new WebSocket(`ws://localhost:${RELAY}/client?ticket=${guestTicket}&nodeId=node_pair_1`);
  const guestSaw: any[] = [];
  await new Promise<void>((res, rej) => { gws.on("message", (d) => {
    const env = JSON.parse(d.toString());
    if (env.t === "ready") res();
    if (env.t === "frame") { try { guestSaw.push(openFrame(guestKey!, env.p).data); } catch { /* room-key frame */ } }
  }); setTimeout(() => rej(new Error("guest ws")), 8000); });
  gws.send(JSON.stringify({ t: "frame", p: sealFrame(guestKey!, { kind: "session.open", sessionId: "s1" }) }));
  await delay(500);
  ok(guestFrames.some((f) => f.msg.kind === "session.open" && f.inviteId === inv.id), "the machine knows the frame came from that guest");
  connector.sendEvent({ type: "session.event", sessionId: "s1", event: { type: "message_end" } });
  connector.sendEvent({ type: "session.event", sessionId: "s2", event: { type: "message_end" } });
  connector.sendEvent({ type: "sessions.list", sessions: [{ id: "s1" }, { id: "s2" }] });
  await delay(600);
  ok(guestSaw.some((e) => e.sessionId === "s1") && !guestSaw.some((e) => e.sessionId === "s2"), "the guest sees their session's events, not others'");
  const listed2 = guestSaw.find((e) => e.type === "sessions.list");
  ok(listed2?.sessions.length === 1 && listed2.sessions[0].guestMode === "view", "and a session list cut to their session, marked view-only");

  // Revoking deletes the key: the guest's next frame opens under nothing.
  invites.revoke(inv.id);
  const before = guestFrames.length;
  gws.send(JSON.stringify({ t: "frame", p: sealFrame(guestKey!, { kind: "session.open", sessionId: "s1" }) }));
  await delay(500);
  ok(guestFrames.length === before, "after revoking, the guest's frames are no longer accepted");
  gws.close();

  connector.stop();
  console.log("\nAll X25519 pairing e2e checks passed.");
  done(0);
}

// Watchdog so the test can never hang a CI runner.
setTimeout(() => { console.error("WATCHDOG: timed out"); done(1); }, 45000).unref();

main().catch((e) => { console.error(e); done(1); });
