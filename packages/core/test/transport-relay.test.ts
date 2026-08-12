// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { RelayTransport } from "../src/transport-relay.js";
import { createLocalStore, b64, b64url, unb64url, seal, open, importRoomKey, createFrameReassembler } from "../src/index.js";
import type { ConnectionStatus } from "../src/protocol.js";

// Node side of the account-pair handshake: wrap a room key for the device's
// public key exactly as the node does (X25519 ECDH → HKDF → AES-GCM seal).
async function nodeWrapForDevice(nodePriv: CryptoKey, devicePubB64: string, roomKey: Uint8Array): Promise<string> {
  const devPub = await crypto.subtle.importKey("raw", unb64url(devicePubB64) as BufferSource, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: devPub }, nodePriv, 256));
  const base = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveBits"]);
  const info = new TextEncoder().encode("bivy-pair-v1");
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0) as BufferSource, info: info as BufferSource },
      base,
      256,
    ),
  );
  const enc = await crypto.subtle.importKey("raw", bits as BufferSource, "AES-GCM", false, ["encrypt"]);
  return seal(enc, b64(roomKey)); // node ships b64(roomKey) sealed
}

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

/** A minimal, test-driven stand-in for the browser WebSocket. */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 1; // open by the time the relay says "ready"
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  emit(env: unknown) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
}

function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/client/relay-ticket")) return { ok: true, json: async () => ({ ticket: "t", relayUrl: "wss://relay" }) };
    if (u.includes("/client/pair-grant")) return { ok: true, json: async () => ({ grant: "g" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

// Yield to the event loop so real WebCrypto (deviceKeypair) + the fake fetch
// promises settle. Real timers are used because WebCrypto resolves off the
// microtask queue; the transport's reconnect backoff is set to ~1ms so retries
// fire fast.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 3));
}

describe("RelayTransport pairing rejection recovery", () => {
  function makeTransport() {
    FakeWS.instances.length = 0;
    const store = createLocalStore(mem(), mem());
    store.cp = "https://cp.example";
    store.cur = "node-1";
    store.s = "session-token";
    const statuses: ConnectionStatus[] = [];
    const errors: string[] = [];
    const transport = new RelayTransport({
      store,
      handlers: {
        onEvent: () => {},
        onStatus: (s) => statuses.push(s),
        onError: (m) => errors.push(m),
      },
      fetchImpl: fakeFetch(),
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      initialBackoffMs: 1,
    });
    return { transport, statuses, errors };
  }

  async function reachPairing(ws: FakeWS) {
    ws.emit({ t: "ready" });
    await settle(); // onLinkReady → sendAccountPair → pair.account frame
  }

  async function reject(ws: FakeWS, error?: string) {
    ws.emit({ t: "pair", p: JSON.stringify({ k: "pair.error", error }) });
    await settle(); // handlePairFrame → onPairRejected
  }

  it("re-mints a fresh grant and retries when the node rejects pairing", async () => {
    const { transport, statuses } = makeTransport();
    await transport.connect();
    expect(FakeWS.instances).toHaveLength(1);

    await reachPairing(FakeWS.instances[0]);
    // The node sends the sealed pair.account before it can be rejected.
    expect(FakeWS.instances[0].sent.some((s) => s.includes("pair.account"))).toBe(true);

    // First rejection: don't stall — tear down and schedule a retry.
    await reject(FakeWS.instances[0]);
    expect(statuses).toContain("reconnecting");

    // Backoff elapses → a brand-new socket (fresh ticket + grant) is opened.
    await settle();
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("gives up with an actionable error after repeated rejections", async () => {
    const { transport, statuses, errors } = makeTransport();
    await transport.connect();

    for (let i = 0; i < 3; i++) {
      const ws = FakeWS.instances.at(-1)!;
      await reachPairing(ws);
      await reject(ws);
    }

    expect(statuses.at(-1)).toBe("offline");
    expect(errors.some((e) => /couldn't link this device/i.test(e))).toBe(true);
  });

  it("completes the account-pair handshake and goes online (device key stays consistent)", async () => {
    const { transport, statuses } = makeTransport();
    const store = (transport as unknown as { store: ReturnType<typeof createLocalStore> }).store;
    await transport.connect();
    const ws = FakeWS.instances[0];
    await reachPairing(ws);

    // Pull the device public key the client sent in pair.account, then act as the
    // node: wrap a room key for exactly that key. If the client resolved a
    // different keypair for the unwrap step, the handshake could never complete.
    const pairAccount = ws.sent.map((s) => JSON.parse(s)).find((e) => e.t === "pair" && String(e.p).includes("pair.account"));
    const devicePub = JSON.parse(pairAccount.p).devicePublicKeyB64 as string;

    const nodeKp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const nodePubB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", nodeKp.publicKey)));
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await nodeWrapForDevice(nodeKp.privateKey, devicePub, roomKey);

    ws.emit({ t: "pair", p: JSON.stringify({ k: "pair.welcome", deviceId: "d1", nodePublicKeyB64: nodePubB64, wrapped }) });
    await settle();

    expect(statuses).toContain("online");
    expect(store.keys()["node-1"]).toBe(b64url(roomKey)); // room key unwrapped + persisted
  });

  it("requests live bivy-run terminals on first pairing, not just on reconnect (issue #476)", async () => {
    // A device that already has a room key skips pairing entirely and goes
    // straight through onLinkReady()'s `if (this.curKey)` branch, which sends
    // terminal.list/terminal.multiplexers alongside sessions.list. A device
    // pairing for the very first time (or re-pairing after losing its room
    // key) instead completes via the pair.welcome branch below — which must
    // request the exact same burst, or a `bivy run` session already live on
    // the node stays invisible to that device until something unrelated
    // happens to refresh it.
    const { transport, statuses } = makeTransport();
    await transport.connect();
    const ws = FakeWS.instances[0];
    await reachPairing(ws);

    const pairAccount = ws.sent.map((s) => JSON.parse(s)).find((e) => e.t === "pair" && String(e.p).includes("pair.account"));
    const devicePub = JSON.parse(pairAccount.p).devicePublicKeyB64 as string;

    const nodeKp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const nodePubB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", nodeKp.publicKey)));
    const roomKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await nodeWrapForDevice(nodeKp.privateKey, devicePub, roomKeyBytes);

    ws.sent.length = 0; // only inspect what the client sends after the welcome
    ws.emit({ t: "pair", p: JSON.stringify({ k: "pair.welcome", deviceId: "d1", nodePublicKeyB64: nodePubB64, wrapped }) });
    await settle();
    expect(statuses).toContain("online");

    // Decrypt everything the client sent right after pairing, exactly as the
    // node would, and collect each command's `kind`.
    const roomKey = await importRoomKey(roomKeyBytes);
    const reassemble = createFrameReassembler();
    const kinds: string[] = [];
    for (const raw of ws.sent) {
      const env = JSON.parse(raw) as { t?: string; p?: string; fc?: unknown; fi?: unknown; fn?: unknown };
      if (env.t !== "frame" || typeof env.p !== "string") continue;
      const full = reassemble(env as never);
      if (full === null) continue;
      const frame = JSON.parse(await open(roomKey, full)) as { data?: { kind?: string } };
      if (frame.data?.kind) kinds.push(frame.data.kind);
    }

    expect(kinds).toContain("sessions.list");
    expect(kinds).toContain("terminal.list");
    expect(kinds).toContain("terminal.multiplexers");
  });

  it("reconnect() drops a zombie socket and dials a fresh one without going offline", async () => {
    const { transport, statuses } = makeTransport();
    // Seed a room key so the connection goes straight to "online" (no pairing).
    const store = (transport as unknown as { store: ReturnType<typeof createLocalStore> }).store;
    store.addKey("node-1", b64url(crypto.getRandomValues(new Uint8Array(32))));

    await transport.connect();
    const first = FakeWS.instances[0];
    first.emit({ t: "ready" });
    await settle();
    expect(statuses.at(-1)).toBe("online");

    // The socket looks alive (iOS resumed it) but is dead — force a reconnect.
    statuses.length = 0;
    transport.reconnect();
    await settle();

    // The stale socket was torn down and a brand-new one opened...
    expect(first.closed).toBe(true);
    expect(FakeWS.instances.length).toBe(2);
    // ...never surfacing "offline" (that would flash "Not connected" in the UI).
    expect(statuses).not.toContain("offline");
    expect(statuses).toContain("connecting");

    // The fresh socket comes up and returns to online.
    FakeWS.instances[1].emit({ t: "ready" });
    await settle();
    expect(statuses.at(-1)).toBe("online");
  });

  it("coalesces the resync burst when a flapping node replays peer.online (rate-limit guard)", async () => {
    // The relay re-sends peer.online to this client every time the node
    // re-attaches. A flapping node used to make the client re-fire its whole
    // sessions/models/runtimes/terminals refresh burst on each one, piling
    // counted frames onto this single socket until the relay's per-socket
    // limiter closed it with "Rate limit exceeded" — with the user never having
    // sent anything. The refresh must fire once, then be throttled.
    const { transport } = makeTransport();
    const store = (transport as unknown as { store: ReturnType<typeof createLocalStore> }).store;
    const roomKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    store.addKey("node-1", b64url(roomKeyBytes)); // seed a room key → straight to the curKey branch

    await transport.connect();
    const ws = FakeWS.instances[0];

    ws.emit({ t: "ready" }); // first link-ready: refresh burst fires
    await settle();
    for (let i = 0; i < 5; i++) {
      ws.emit({ t: "peer.online", clients: 1 }); // node flaps on the SAME socket
      await settle();
    }

    // Decrypt everything the client sent and count refresh bursts by sessions.list.
    const roomKey = await importRoomKey(roomKeyBytes);
    const reassemble = createFrameReassembler();
    let sessionsListCount = 0;
    for (const raw of ws.sent) {
      const env = JSON.parse(raw) as { t?: string; p?: string };
      if (env.t !== "frame" || typeof env.p !== "string") continue;
      const full = reassemble(env as never);
      if (full === null) continue;
      const frame = JSON.parse(await open(roomKey, full)) as { data?: { kind?: string } };
      if (frame.data?.kind === "sessions.list") sessionsListCount++;
    }

    expect(sessionsListCount).toBe(1); // one refresh despite six link-ready events
  });

  it("stops immediately (no retry) on a permanent rejection and shows the reason", async () => {
    const { transport, statuses, errors } = makeTransport();
    await transport.connect();
    const openedBefore = FakeWS.instances.length;

    await reachPairing(FakeWS.instances[0]);
    await reject(FakeWS.instances[0], "Device limit reached (2)");

    expect(statuses.at(-1)).toBe("offline");
    expect(errors).toContain("Device limit reached (2)");
    // No fresh socket was opened — it did not retry.
    await settle();
    expect(FakeWS.instances.length).toBe(openedBefore);
  });
});

describe("RelayTransport transient-failure quieting", () => {
  // A fetch whose relay-ticket mint fails the first `failTimes` calls, then
  // succeeds — modeling a brief control-plane/network blip that recovers.
  function flakyTicketFetch(failTimes: number): typeof fetch {
    let ticketCalls = 0;
    return (async (url: string) => {
      const u = String(url);
      if (u.includes("/client/relay-ticket")) {
        ticketCalls += 1;
        if (ticketCalls <= failTimes) throw new Error("ticket request failed: 503");
        return { ok: true, json: async () => ({ ticket: "t", relayUrl: "wss://relay" }) };
      }
      if (u.includes("/client/pair-grant")) return { ok: true, json: async () => ({ grant: "g" }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  function makeTransport(fetchImpl: typeof fetch) {
    FakeWS.instances.length = 0;
    const store = createLocalStore(mem(), mem());
    store.cp = "https://cp.example";
    store.cur = "node-1";
    store.s = "session-token";
    store.addKey("node-1", b64url(crypto.getRandomValues(new Uint8Array(32))));
    const statuses: ConnectionStatus[] = [];
    const errors: string[] = [];
    const transport = new RelayTransport({
      store,
      handlers: { onEvent: () => {}, onStatus: (s) => statuses.push(s), onError: (m) => errors.push(m) },
      fetchImpl,
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      initialBackoffMs: 1,
    });
    return { transport, statuses, errors };
  }

  it("does not toast a transient ticket-mint failure, but still reconnects", async () => {
    const { transport, statuses, errors } = makeTransport(flakyTicketFetch(2));
    await transport.connect();
    await settle();

    // The first two mints threw; below the alert threshold, so no error toast —
    // just the calm "reconnecting" state the banner reflects.
    expect(errors).toHaveLength(0);
    expect(statuses).toContain("reconnecting");

    // The retry (backoff) mints a good ticket and the socket comes up.
    const ws = FakeWS.instances.at(-1)!;
    ws.emit({ t: "ready" });
    await settle();
    expect(statuses.at(-1)).toBe("online");
    expect(errors).toHaveLength(0);
  });

  it("surfaces an error once failures persist past the threshold", async () => {
    const { transport, errors } = makeTransport(flakyTicketFetch(Infinity));
    await transport.connect();
    // Let several backoff-driven retries elapse so the streak crosses the alert
    // threshold and a real outage finally tells the user.
    for (let i = 0; i < 8; i++) await settle();
    expect(errors.some((e) => /ticket request failed/i.test(e))).toBe(true);
  });
});

describe("RelayTransport solo (account-free) dial", () => {
  it("dials /client with room+roomToken and never mints a ticket", async () => {
    FakeWS.instances.length = 0;
    const store = createLocalStore(mem(), mem());
    store.cur = "node-solo";
    store.relay = "wss://relay.self/";
    store.setSolo("node-solo", { room: "room_deadbeef", roomToken: "z".repeat(43) });
    let ticketFetches = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("relay-ticket")) ticketFetches += 1;
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const transport = new RelayTransport({
      store,
      handlers: { onEvent: () => {}, onStatus: () => {}, onError: () => {} },
      fetchImpl,
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      initialBackoffMs: 1,
    });
    await transport.connect();
    await settle();
    expect(ticketFetches).toBe(0);
    const ws = FakeWS.instances.at(-1)!;
    expect(ws.url).toBe("wss://relay.self/client?room=room_deadbeef&roomToken=" + "z".repeat(43));
  });
});

