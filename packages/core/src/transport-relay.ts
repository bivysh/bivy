// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// RelayTransport — the hosted / remote path used by app.bivy.sh. Faithful port
// of connect()/mintClientTicket()/sendFrame()/onLinkReady() and the pairing
// handshake from public/app/remote-app.js.
//
// Unlike DirectTransport, commands are not mapped to REST here: every command is
// sealed into an E2E frame and delivered to the node over the relay, which
// stays blind. The node executes it and streams events back as sealed frames.

import { importRoomKey, open as openMsg, seal, createReplayGuard, type RoomKey } from "./crypto.js";
import { b64, unb64, unb64url, b64url } from "./base64.js";
import { frameMessages, createFrameReassembler } from "./relay-frame.js";
import { deviceKeypair, pairingProof, wrapKeyFor, type DeviceKeypair } from "./pairing.js";
import type { LocalStore } from "./local-store.js";
import type { Command, ServerEvent, Transport, TransportHandlers, ConnectionStatus } from "./protocol.js";

export interface RelayTransportOptions {
  store: LocalStore;
  handlers: TransportHandlers;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  /** First reconnect delay in ms (doubles up to MAX_BACKOFF). Test seam. */
  initialBackoffMs?: number;
}

const MAX_BACKOFF = 15000;
// Refreshing our view of the node (sessions/models/runtimes/terminals) is worth
// doing the first time a socket reaches the node, and again if the node keeps
// flapping for a while — but NOT once per flap. The relay re-sends `peer.online`
// to this client every time the node re-attaches, and a cold-starting or
// unstable node can flap many times a minute. Re-firing the whole command burst
// on each one piles counted frames onto this single long-lived client socket
// until the relay's per-socket limiter (RELAY_MAX_CLIENT_MESSAGES_PER_MINUTE)
// trips and closes it — which surfaces as "Rate limit exceeded" in the composer
// even though the user never sent anything. Throttle the refresh to at most once
// per this window per socket; queued user frames still flush() on every event.
const RESYNC_THROTTLE_MS = 15000;
// A transient reconnect (node blip, brief radio drop, a single-use ticket that
// raced) recovers on its own via scheduleReconnect(), so surfacing every failed
// attempt as a toast just spams the user with "ticket request failed" noise
// while the "Reconnecting…" banner already says the same thing more calmly. Only
// escalate to a real error toast once we've failed this many times in a row —
// past that it's a genuine outage worth telling the user about, not a blip.
const CONNECT_FAILURES_BEFORE_ALERT = 4;
// How many times we re-mint a fresh grant + retry after the node rejects
// pairing before we stop and surface an actionable error. The account pair
// grant is single-use and minted fresh on every connect, so a transient
// rejection recovers on retry; a genuine mismatch fails every time and we
// bail out instead of spinning in "linking…" forever.
const MAX_PAIR_ATTEMPTS = 3;

function freshNonce(): string {
  return b64(crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * A pairing rejection that retrying can't fix — the account's device limit is
 * reached, the device belongs to another account, or it isn't authorized for
 * this node. These are deterministic control-plane decisions, so we show the
 * reason and stop instead of re-minting grants in a loop.
 */
function isPermanentPairError(reason: string): boolean {
  return /device limit|another account|isn't authorized|not authorized|forbidden/i.test(reason);
}

export class RelayTransport implements Transport {
  private readonly store: LocalStore;
  private readonly handlers: TransportHandlers;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;

  private ws: WebSocket | null = null;
  private connected = false;
  private readonly initialBackoff: number;
  private backoff: number;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pairSent = false;
  private pairAttempts = 0;
  /** Consecutive failed connect attempts, reset the moment a socket goes live.
   *  Gates the transient-vs-real error toast (see CONNECT_FAILURES_BEFORE_ALERT). */
  private connectFailures = 0;
  private curKey: RoomKey | null = null;
  private devicePromise: Promise<DeviceKeypair> | null = null;
  private readonly sendQueue: string[] = [];
  private readonly reassemble = createFrameReassembler();
  private readonly acceptFrame = createReplayGuard();

  constructor(opts: RelayTransportOptions) {
    this.store = opts.store;
    this.handlers = opts.handlers;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    this.WS = opts.webSocketImpl ?? ((globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket);
    this.initialBackoff = opts.initialBackoffMs ?? 1000;
    this.backoff = this.initialBackoff;
  }

  private cpBase(): string {
    return (this.store.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
  }

  private setStatus(s: ConnectionStatus): void {
    this.handlers.onStatus(s);
  }

  /**
   * The device's pairing keypair, resolved once and reused for the life of this
   * transport. The account-pair handshake sends the device public key in
   * `pair.account`, then unwraps the node's room-key delivery in the
   * `pair.welcome` reply with the matching private key — so BOTH steps must see
   * the SAME keypair or the unwrap fails and the client loops forever in
   * "reconnecting". On installs where the key store is flaky (iOS home-screen
   * PWAs, whose IndexedDB can fail to round-trip within a single page load) a
   * fresh `deviceKeypair()` call per step could return divergent keys; memoizing
   * here pins one identity across the whole handshake.
   */
  private device(): Promise<DeviceKeypair> {
    if (!this.devicePromise) {
      this.devicePromise = deviceKeypair(this.store).catch((e) => {
        this.devicePromise = null; // let the next attempt retry rather than cache a failure
        throw e;
      });
    }
    return this.devicePromise;
  }

  private async keyFor(nodeId: string): Promise<RoomKey | null> {
    const encoded = this.store.keys()[nodeId];
    if (!encoded) return null;
    return importRoomKey(unb64url(encoded));
  }

  /** Do we have enough material to (re)connect to the current node? */
  canConnect(): boolean {
    const cur = this.store.cur;
    if (!cur) return false;
    return Boolean(
      this.curKey || this.store.keys()[cur] || this.store.s || (this.store.nodePubs()[cur] && this.store.pairSecrets()[cur]),
    );
  }

  /** Account-free ("solo") relay creds for the current node, if this device was
   *  paired via a solo QR. Present means: skip the control-plane ticket mint and
   *  dial `/client?room=&roomToken=` directly. */
  private soloCreds(): { room: string; roomToken: string } | null {
    const rec = this.store.solo()[this.store.cur];
    return rec && rec.room && rec.roomToken ? rec : null;
  }

  private async mintClientTicket(): Promise<{ ticket: string; relayUrl: string | null }> {
    const res = await this.fetchImpl(`${this.cpBase()}/client/relay-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.store.s}` },
      body: JSON.stringify({ nodeId: this.store.cur }),
    });
    if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
    const data: { ticket?: string; relayUrl?: unknown } = await res.json();
    if (!data?.ticket) throw new Error("no ticket");
    return { ticket: data.ticket, relayUrl: typeof data.relayUrl === "string" ? data.relayUrl : null };
  }

  async connect(): Promise<void> {
    this.closedByUs = false;
    this.setStatus("connecting");
    this.curKey = await this.keyFor(this.store.cur);
    // Account-free ("solo") admission has no control plane to mint a ticket
    // against: authorize onto the relay with the room id + bearer token from the
    // pairing QR. The pairing handshake (pair.hello over the relay) is unchanged.
    const solo = this.soloCreds();
    let ticket = "";
    let relayUrl: string | null = null;
    if (!solo) {
      try {
        ({ ticket, relayUrl } = await this.mintClientTicket());
      } catch (e) {
        // Stay quiet on a transient failure — scheduleReconnect() will retry and
        // the "Reconnecting…" banner already communicates the state. Only surface a
        // toast once we've failed repeatedly, i.e. it's a real outage, not a blip.
        this.connectFailures += 1;
        if (this.connectFailures >= CONNECT_FAILURES_BEFORE_ALERT) {
          this.handlers.onError?.((e as Error)?.message || "ticket mint failed");
        }
        this.scheduleReconnect();
        return;
      }
    }
    this.pairSent = false;
    const targetNodeId = this.store.cur;
    const relayBase = (relayUrl || this.store.relay).replace(/\/$/, "");
    const url = solo
      ? `${relayBase}/client?room=${encodeURIComponent(solo.room)}&roomToken=${encodeURIComponent(solo.roomToken)}`
      : `${relayBase}/client?ticket=${encodeURIComponent(ticket)}&nodeId=${encodeURIComponent(targetNodeId)}`;
    const ws = new this.WS(url);
    this.ws = ws;
    const isCurrent = () => ws === this.ws && targetNodeId === this.store.cur;

    ws.onmessage = async (m: MessageEvent) => {
      if (!isCurrent()) return;
      let env: { t?: string; p?: string; error?: string };
      try {
        env = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (env.t === "ready" || env.t === "peer.online") {
        this.connected = true;
        this.backoff = this.initialBackoff;
        this.connectFailures = 0; // a live socket clears the transient-failure streak
        this.setStatus(this.curKey ? "online" : "pairing");
        await this.onLinkReady();
      } else if (env.t === "peer.offline") {
        this.setStatus("reconnecting");
      } else if (env.t === "pair" && typeof env.p === "string") {
        await this.handlePairFrame(env.p);
      } else if (env.t === "error") {
        this.handlers.onError?.(env.error || "relay error");
      } else if (env.t === "frame" && typeof env.p === "string") {
        if (!this.curKey) return;
        const full = this.reassemble(env);
        if (full === null) return;
        try {
          const frame = JSON.parse(await openMsg(this.curKey, full)) as { data: ServerEvent } & Record<string, unknown>;
          if (!this.acceptFrame(frame)) return; // stale/replayed
          this.handlers.onEvent(frame.data);
        } catch {
          /* decrypt failed */
        }
      }
    };
    ws.onclose = () => {
      if (!isCurrent() || this.closedByUs) return;
      this.connected = false;
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    // Only one pending reconnect at a time, and a cancelable one — otherwise
    // close() can't stop it and overlapping schedules race two connect()s.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.canConnect() && !this.closedByUs) void this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  /**
   * True at most once per RESYNC_THROTTLE_MS for the CURRENT socket. A fresh
   * socket always refreshes on its first link-ready; a flapping node's repeated
   * `peer.online` events on the same long-lived socket are coalesced so the
   * refresh burst can't drain the relay's per-socket message budget. State lives
   * on the socket itself, so a genuine reconnect (new socket) resyncs again.
   */
  private shouldResync(): boolean {
    const ws = this.ws as (WebSocket & { _resyncAt?: number }) | null;
    if (!ws) return false;
    const now = Date.now();
    if (ws._resyncAt !== undefined && now - ws._resyncAt < RESYNC_THROTTLE_MS) return false;
    ws._resyncAt = now;
    return true;
  }

  /** Once the relay reports the node reachable: resume if paired, else pair. */
  private async onLinkReady(): Promise<void> {
    if (this.curKey) {
      this.flush();
      if (!this.shouldResync()) return; // node flap re-fired peer.online; don't re-burst
      const active = this.store.sessions(); // touch to keep parity with legacy loadSessionIndex timing
      void active;
      await this.send({ kind: "sessions.list" });
      await this.send({ kind: "models.list" });
      await this.send({ kind: "runtimes.list" });
      await this.send({ kind: "terminal.list" });
      await this.send({ kind: "terminal.multiplexers" });
    } else {
      this.setStatus("linking");
      const cur = this.store.cur;
      if (this.store.nodePubs()[cur] && this.store.pairSecrets()[cur]) await this.sendPairHello();
      else await this.sendAccountPair();
    }
  }

  private async sendPairHello(): Promise<void> {
    if (this.pairSent) return;
    const cur = this.store.cur;
    const nodePub = this.store.nodePubs()[cur];
    const secret = this.store.pairSecrets()[cur];
    if (!nodePub || !secret) return;
    const dev = await this.device();
    const proofB64 = await pairingProof(secret, dev.pub);
    this.pairSent = true;
    this.rawSend(
      JSON.stringify({
        t: "pair",
        p: JSON.stringify({ k: "pair.hello", devicePublicKeyB64: dev.pub, proofB64, label: deviceLabel() }),
      }),
    );
  }

  private async sendAccountPair(): Promise<void> {
    if (this.pairSent || !this.store.s) return;
    const dev = await this.device();
    this.pairSent = true;
    try {
      const res = await this.fetchImpl(`${this.cpBase()}/client/pair-grant`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.store.s}` },
        body: JSON.stringify({ nodeId: this.store.cur }),
      });
      const out: { grant?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !out?.grant) throw new Error("Could not create pairing grant");
      this.rawSend(
        JSON.stringify({
          t: "pair",
          p: JSON.stringify({ k: "pair.account", sessionToken: out.grant, devicePublicKeyB64: dev.pub, label: deviceLabel() }),
        }),
      );
    } catch (e) {
      this.pairSent = false;
      this.handlers.onError?.((e as Error)?.message || "Could not pair this device");
      this.setStatus("reconnecting");
    }
  }

  private async handlePairFrame(payload: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const cur = this.store.cur;
    let nodePub = this.store.nodePubs()[cur];
    if (!nodePub && typeof msg.nodePublicKeyB64 === "string") {
      this.store.addNodePub(cur, msg.nodePublicKeyB64);
      nodePub = msg.nodePublicKeyB64;
    }
    const dev = await this.device();
    if (msg.k === "pair.welcome" && typeof msg.wrapped === "string" && nodePub && !this.curKey) {
      try {
        const wrapKey = await wrapKeyFor(dev.priv, nodePub, "pair");
        const roomKeyBytes = unb64(await openMsg(wrapKey, msg.wrapped));
        this.storeRoomKey(cur, roomKeyBytes);
        this.store.clearPairSecret(cur);
        this.curKey = await this.keyFor(cur);
        this.pairAttempts = 0;
        this.setStatus("online");
        this.flush();
        await this.send({ kind: "sessions.list" });
        await this.send({ kind: "history" });
        await this.send({ kind: "models.list" });
        await this.send({ kind: "runtimes.list" });
        // Mirror the already-paired burst in onLinkReady(): without this, a
        // device pairing for the first time (or re-pairing after its room key
        // was lost/rotated) never asks for live `bivy run` terminals, so a
        // session already running on the node is invisible until some other
        // event happens to refresh it (issue: "bivy run does not appear to
        // reach the relay").
        await this.send({ kind: "terminal.list" });
        await this.send({ kind: "terminal.multiplexers" });
      } catch {
        this.setStatus("reconnecting");
      }
    } else if (msg.k === "key.rotate" && Array.isArray(msg.deliveries) && nodePub) {
      const wrapKey = await wrapKeyFor(dev.priv, nodePub, "rotate");
      for (const d of msg.deliveries as Array<{ wrapped: string }>) {
        try {
          this.storeRoomKey(cur, unb64(await openMsg(wrapKey, d.wrapped)));
          this.curKey = await this.keyFor(cur);
          break;
        } catch {
          /* not ours */
        }
      }
    } else if (msg.k === "pair.error") {
      this.onPairRejected(typeof msg.error === "string" ? msg.error : "");
    }
  }

  /**
   * The node rejected this device's pairing. A rejection carries a reason from
   * the node/control plane (e.g. "Device limit reached"): permanent reasons
   * won't change on retry, so surface them and stop immediately rather than
   * spinning in "linking…". Otherwise (a transient/raced single-use grant) we
   * re-mint a fresh grant and retry a few times before giving up.
   */
  private onPairRejected(reason: string): void {
    if (isPermanentPairError(reason)) {
      this.handlers.onError?.(reason);
      this.close();
      return;
    }
    this.pairAttempts += 1;
    if (this.pairAttempts >= MAX_PAIR_ATTEMPTS) {
      this.handlers.onError?.(
        reason ||
          "Couldn't link this device — the node rejected it. Make sure the node is online and you're signed in to the right account, then try again.",
      );
      this.close();
      return;
    }
    this.handlers.onError?.(reason ? `${reason} — retrying…` : "Device link was rejected — retrying…");
    this.pairSent = false;
    // Drop the current socket without letting its onclose fire a second
    // reconnect: nulling `ws` first makes the stale handler's isCurrent() false.
    const stale = this.ws;
    this.ws = null;
    this.connected = false;
    try {
      stale?.close();
    } catch {
      /* noop */
    }
    this.scheduleReconnect();
  }

  private storeRoomKey(nodeId: string, roomKeyBytes: Uint8Array): void {
    this.store.addKey(nodeId, b64url(roomKeyBytes));
  }

  private rawSend(text: string): void {
    if (this.connected && this.ws?.readyState === 1) this.ws.send(text);
    else this.sendQueue.push(text);
  }

  private flush(): void {
    while (this.sendQueue.length && this.ws?.readyState === 1) {
      const next = this.sendQueue.shift();
      if (next !== undefined) this.ws.send(next);
    }
  }

  /** Seal a command into an anti-replay frame and deliver it (or queue it). */
  async send(command: Command): Promise<void> {
    if (!this.curKey) return;
    const wrapped = { v: 1, ts: Date.now(), nonce: freshNonce(), data: command };
    const sealed = await seal(this.curKey, JSON.stringify(wrapped));
    for (const frame of frameMessages(sealed, freshNonce)) this.rawSend(frame);
  }

  close(): void {
    this.closedByUs = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
    }
    this.ws = null;
    this.setStatus("offline");
  }

  /**
   * Force a fresh dial without going through "offline". A socket iOS resumed
   * after suspension can look open (readyState 1, no `onclose`) yet be dead, so
   * we can't wait for the OS to notice — drop it and reconnect. Nulling `ws`
   * first makes the stale socket's onclose a no-op (isCurrent() === false), so
   * it can't schedule a competing reconnect. connect() sets "connecting" itself,
   * so the UI never flashes the "Not connected" state a plain close() would.
   */
  reconnect(): void {
    const stale = this.ws;
    this.ws = null;
    this.connected = false;
    this.pairSent = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      stale?.close();
    } catch {
      /* noop */
    }
    void this.connect();
  }
}

function deviceLabel(): string {
  const nav = (globalThis as unknown as { navigator?: { platform?: string } }).navigator;
  return nav?.platform || "Device";
}
