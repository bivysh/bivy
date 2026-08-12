// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";

/**
 * Account-free ("solo") relay admission (Gap 1 — no control plane).
 *
 * With RELAY_ALLOW_ROOM_TOKENS=1 a node/client is admitted by presenting an
 * unguessable `room` + a bearer `roomToken` (both from the pairing QR) instead
 * of a control-plane ticket. This test spawns ONLY the relay (solo needs no CP)
 * and asserts:
 *   - the opt-in is off by default → the ticket path is unchanged;
 *   - node + client with a matching token pair up, and a frame round-trips;
 *   - a wrong token, an unclaimed room, and a weak token are all rejected;
 *   - a live room cannot be hijacked by a mismatching node claim.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(testDir, "..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned"))));
    });
    server.on("error", reject);
  });
}

const SOLO_PORT = await freePort();
const GATED_OFF_PORT = await freePort();

const procs: ChildProcess[] = [];
function spawnRelay(env: Record<string, string>) {
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: relayDir, env: { ...process.env, ...env }, stdio: "inherit" });
  child.once("error", (error) => {
    console.error("Failed to start relay:", error);
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

interface Conn {
  ws: WebSocket;
  ready: Promise<boolean>;
  next: () => Promise<Record<string, unknown> | null>;
}

// Connect and keep the socket open. `ready` resolves true on the first "ready"
// message, false on close/error/timeout without one. `next` awaits the next
// parsed message (a raw "frame" is returned as {t,p} too).
function connect(url: string, timeoutMs = 3000): Conn {
  const ws = new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  let waiter: ((m: Record<string, unknown> | null) => void) | null = null;
  const push = (m: Record<string, unknown>) => {
    if (waiter) {
      waiter(m);
      waiter = null;
    } else queue.push(m);
  };
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      // Only queue forwarded data frames for next(); control messages
      // ("ready", "peer.*") are handled by the ready promise, and queuing them
      // would make next() return a stale control message instead of the frame.
      if (m.t === "frame") push(m);
    } catch {
      // ignore non-JSON
    }
  });
  const ready = new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    ws.on("message", (d) => {
      try {
        if (JSON.parse(d.toString()).t === "ready") settle(true);
      } catch {
        // ignore
      }
    });
    ws.once("close", () => settle(false));
    ws.once("error", () => settle(false));
    setTimeout(() => settle(false), timeoutMs);
  });
  const next = () =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const q = queue.shift();
      if (q) return resolve(q);
      waiter = resolve;
      setTimeout(() => {
        if (waiter === resolve) {
          waiter = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  return { ws, ready, next };
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`✓ ${msg}`);
}

const ROOM = "room_" + "a".repeat(40); // unguessable id (stand-in for the QR room)
const TOKEN = "t".repeat(43); // ~256-bit base64url-length bearer

async function main() {
  spawnRelay({ PORT: String(SOLO_PORT), RELAY_ALLOW_ROOM_TOKENS: "1" });
  spawnRelay({ PORT: String(GATED_OFF_PORT) }); // no opt-in → ticket path only
  await waitForHttp(`http://localhost:${SOLO_PORT}/healthz`);
  await waitForHttp(`http://localhost:${GATED_OFF_PORT}/healthz`);

  const solo = `ws://localhost:${SOLO_PORT}`;
  const gatedOff = `ws://localhost:${GATED_OFF_PORT}`;

  // 1. Opt-in OFF: presenting a room token to a normal relay is ignored — the
  //    ticket path still governs, so the hosted relay is provably unchanged.
  const offNode = connect(`${gatedOff}/node?room=${ROOM}&roomToken=${TOKEN}`);
  expect((await offNode.ready) === false, "opt-in off → room token ignored, ticket path unchanged (node not admitted)");
  offNode.ws.close();

  // 2. Solo node with a room token is admitted.
  const node = connect(`${solo}/node?room=${ROOM}&roomToken=${TOKEN}`);
  expect((await node.ready) === true, "solo node with room token is admitted");

  // 3. Solo client with the SAME token pairs into the live room.
  const client = connect(`${solo}/client?room=${ROOM}&roomToken=${TOKEN}`);
  expect((await client.ready) === true, "solo client with matching token is admitted");

  // 4. A data frame round-trips client → node, forwarded verbatim (E2E: the
  //    relay never inspects `p`). Proves pairing works with no control plane.
  const opaque = JSON.stringify({ t: "frame", p: "opaque-e2e-ciphertext" });
  client.ws.send(opaque);
  const seen = await node.next();
  expect(!!seen && seen.t === "frame" && seen.p === "opaque-e2e-ciphertext", "frame round-trips node↔client in solo mode");

  // 5. Wrong token for a live room is rejected.
  const badClient = connect(`${solo}/client?room=${ROOM}&roomToken=${"x".repeat(43)}`);
  expect((await badClient.ready) === false, "client with a wrong token is rejected");

  // 6. Client for a room no node ever claimed is rejected (reported offline).
  const orphanClient = connect(`${solo}/client?room=${"room_" + "b".repeat(40)}&roomToken=${TOKEN}`);
  expect((await orphanClient.ready) === false, "client for an unclaimed room is rejected");

  // 7. A weak (low-entropy) room token is refused outright.
  const weakNode = connect(`${solo}/node?room=${"room_" + "c".repeat(40)}&roomToken=short`);
  expect((await weakNode.ready) === false, "a weak room token is refused");

  // 8. A live room cannot be hijacked: a second node claiming it with a
  //    different token is rejected (TOFU — first claim owns the room).
  const hijack = connect(`${solo}/node?room=${ROOM}&roomToken=${"z".repeat(43)}`);
  expect((await hijack.ready) === false, "a mismatching claim on a live room is rejected (no hijack)");

  console.log("\nAll solo relay admission checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
