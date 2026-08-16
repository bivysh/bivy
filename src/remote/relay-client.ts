// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { seal, sealFrame, openFrame, ReplayGuard } from "../e2e.js";
import { frameMessages, FrameReassembler } from "../relay-chunk.js";
import { soloCredentials, buildDialUrl } from "./solo.js";
import type { PairingStore, RotateDelivery } from "../device-registry.js";

/**
 * Relay connector (node side).
 *
 * Dials the relay OUTBOUND so the node needs no inbound ports. Authenticates
 * with the node's enrollment token (obtained from the control plane during
 * `/nodes/enroll`). Bridges encrypted frames between remote clients and the
 * local session.
 *
 * Config lives in `.bivy/relay.json`:
 *   { "url": "wss://relay.example", "enrollmentToken": "enr_..." }
 * Or via env: BIVY_RELAY_URL, BIVY_RELAY_TOKEN.
 *
 * The connector is OPTIONAL: if no config is present, the node runs local-only
 * (free tier) exactly as before. Frame encryption always uses the rotating room
 * key from the node's `PairingStore` (X25519 pairing); there is no static key.
 */

export interface RelayConfig {
  url: string;
  // Present for the hosted (control-plane) admission path. Absent in solo mode,
  // where `room`+`roomToken` authorize the relay connection instead.
  enrollmentToken?: string;
  controlPlaneUrl?: string;
  // Account-free ("solo") admission: an unguessable room id + bearer token,
  // presented to a relay started with RELAY_ALLOW_ROOM_TOKENS=1 in place of a
  // control-plane ticket. Both are carried out-of-band in the pairing QR. See
  // ./solo.ts and services/relay/src/index.ts.
  room?: string;
  roomToken?: string;
  // Base http(s) URL where the remote web client is hosted (the page a phone
  // opens after scanning the linking QR). Defaults to the control plane.
  clientBaseUrl?: string;
  // Pre-shared room key (base64) baked in by a device/CP that is REUSING an
  // existing session's node id — an ephemeral rebuild (see PairingStore.load).
  // A fresh machine that mints its own node id has no e2eKey and generates a
  // random room key as before. Only consumed to SEED a brand-new pairing state;
  // an existing pairing.json always wins.
  e2eKey?: string;
}

export type ClientMessage = { kind: string; [key: string]: unknown };

function isFatalRelayError(message: string) {
  return /hosted relay is not enabled|unauthorized|missing token/i.test(message);
}

export function loadRelayConfig(appDir: string): RelayConfig | null {
  const envUrl = process.env.BIVY_RELAY_URL;
  const filePath = path.join(appDir, "relay.json");
  let raw: {
    url?: string;
    enrollmentToken?: string;
    controlPlaneUrl?: string;
    clientBaseUrl?: string;
    e2eKey?: string;
    room?: string;
    roomToken?: string;
  } = {};
  if (fs.existsSync(filePath)) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      raw = {};
    }
  }
  const url = envUrl ?? raw.url;
  const enrollmentToken = process.env.BIVY_RELAY_TOKEN ?? raw.enrollmentToken;
  const solo = soloCredentials({
    room: process.env.BIVY_RELAY_ROOM ?? raw.room,
    roomToken: process.env.BIVY_RELAY_ROOM_TOKEN ?? raw.roomToken,
  });
  // A usable config needs a relay url plus SOME way to authorize onto it:
  // either a hosted enrollment token or a complete solo credential.
  if (!url || (!enrollmentToken && !solo)) return null;
  const controlPlaneUrl = process.env.BIVY_CONTROL_PLANE_URL ?? raw.controlPlaneUrl;
  const clientBaseUrl = process.env.BIVY_CLIENT_BASE_URL ?? raw.clientBaseUrl ?? controlPlaneUrl;
  const e2eKey = process.env.BIVY_ROOM_KEY ?? raw.e2eKey;
  return { url, enrollmentToken, controlPlaneUrl, clientBaseUrl, e2eKey, room: solo?.room, roomToken: solo?.roomToken };
}

export interface RelayConnectorOptions {
  // The node's pairing store: the source of the rotating room key used for frame
  // encryption, and the responder for X25519 pairing handshakes over the relay.
  // Required — there is no static-key fallback.
  pairing: PairingStore;
  // Control-plane hint delivered via the relay when a webhook enqueues work.
  // The hint carries only routing metadata; the node still fetches + claims the
  // item over the authenticated control-plane API.
  onWorkAvailable?: (hint: { id?: string; label?: string }) => void;
}

// Application-level keepalive. On flaky/mobile links the node→relay TCP socket
// can half-open silently: the node still thinks it is connected and buffers
// sends into a dead socket while clients see "node offline". The relay's own
// heartbeat eventually reaps the dead socket, but on a lenient interval (up to a
// few minutes). Pinging from the node and reconnecting when pongs stop cuts that
// detection window to ~1 minute so the node redials (and clients recover) fast.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 75_000;
// Only reset reconnect backoff after a connection has held this long. The relay
// accepts the WS upgrade and sends `ready` BEFORE its rate limiter may reject
// and close the socket a moment later, so resetting on `ready` alone let a
// rate-limited node reconnect every ~1s indefinitely — a storm that itself keeps
// tripping the limiter. Requiring a stable window lets backoff escalate normally.
const BACKOFF_STABLE_RESET_MS = 30_000;

export class RelayConnector {
  private ws?: WebSocket;
  private closed = false;
  private backoff = 1000;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private lastPongAt = 0;
  // True only between the relay's `ready` message (auth + entitlement passed)
  // and the socket closing. This — not "a connector object exists" — is what
  // "connected" means to the control plane, so it's what `bivy status` reports.
  private ready = false;
  // Most recent relay-side failure (ticket mint, socket error, or an `error`
  // frame), surfaced by `bivy status`/`doctor` so a node that never connects
  // explains why instead of silently showing "configured".
  private lastErrorMessage?: string;
  private readonly replay = new ReplayGuard();
  private readonly reassembler = new FrameReassembler();
  private readonly pairing: PairingStore;
  private readonly onWorkAvailable?: (hint: { id?: string; label?: string }) => void;

  constructor(
    private readonly config: RelayConfig,
    private readonly onClientMessage: (msg: ClientMessage) => void,
    options: RelayConnectorOptions,
  ) {
    this.pairing = options.pairing;
    this.onWorkAvailable = options.onWorkAvailable;
  }

  /** Current bulk-encryption key: the pairing store's rotating room key. */
  private roomKey(): Buffer {
    return this.pairing.roomKey();
  }

  /** Push a room-key rotation (after a device revoke) to connected devices. */
  pushRotate(deliveries: RotateDelivery[]) {
    if (this.ws?.readyState !== WebSocket.OPEN || deliveries.length === 0) return;
    this.ws.send(JSON.stringify({ t: "pair", p: JSON.stringify({ k: "key.rotate", deliveries }) }));
  }

  /**
   * True only while the relay link is live AND the relay has sent `ready`
   * (auth/entitlement checks passed) — i.e. the node is actually reachable from
   * the control plane. A socket that opened but was rejected, or one still
   * reconnecting, reads false.
   */
  get connected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Most recent relay-side failure, if any — for status/diagnostics. */
  get lastError(): string | undefined {
    return this.lastErrorMessage;
  }

  start() {
    this.closed = false;
    void this.connect();
  }

  stop() {
    this.closed = true;
    this.ready = false;
    this.stopHeartbeat();
    this.clearBackoffReset();
    this.ws?.close();
  }

  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        // No pong since the last few pings — treat the link as half-open and
        // force a reconnect rather than streaming into a dead socket.
        console.warn("[relay] keepalive timed out; reconnecting");
        this.stopHeartbeat();
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        // A failed ping means the socket is already gone; close will follow.
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // Reset reconnect backoff only once this connection has stayed up for a stable
  // window (see BACKOFF_STABLE_RESET_MS). Armed on `ready`, disarmed on close, so
  // a connection that the relay rate-limits and drops seconds later never counts
  // as healthy and backoff keeps escalating instead of hot-looping.
  private scheduleBackoffReset(ws: WebSocket) {
    this.clearBackoffReset();
    this.stableTimer = setTimeout(() => {
      if (!this.closed && this.ws === ws && ws.readyState === WebSocket.OPEN) this.backoff = 1000;
    }, BACKOFF_STABLE_RESET_MS);
    this.stableTimer.unref?.();
  }

  private clearBackoffReset() {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  /**
   * Encrypt a string with the current room key for AT-REST storage off-node
   * (e.g. a session title in the control-plane index). Clients holding the room
   * key decrypt it; the control plane only ever sees ciphertext.
   */
  sealString(value: string): string {
    return seal(this.roomKey(), value);
  }

  /** Push a local session event to remote clients (encrypted). */
  sendEvent(event: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = sealFrame(this.roomKey(), event);
    // Large events (big file reads, long diffs, image attachments) are split
    // into multiple relay frames so none exceeds the relay's max-frame limit;
    // the client reassembles them before decrypting.
    for (const msg of frameMessages(payload)) {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(msg);
    }
  }

  /**
   * Handle a pairing control frame from a device (X25519 handshake). These are
   * forwarded verbatim by the relay (t === "pair") and never contain the room
   * key in the clear. Only `pair.hello` is acted on; the node replies with
   * `pair.welcome` carrying the ECDH-wrapped room key.
   */
  private async handlePairFrame(payload: string) {
    let msg: { k?: string; devicePublicKeyB64?: string; proofB64?: string; label?: string; sessionToken?: string; ephemeral?: boolean };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    let welcome = null;
    let reason = "Pairing failed";
    if (msg.k === "pair.hello" && msg.devicePublicKeyB64 && msg.proofB64) {
      welcome = this.pairing.handleHello({
        devicePublicKeyB64: msg.devicePublicKeyB64,
        proofB64: msg.proofB64,
        label: msg.label,
      });
    } else if (msg.k === "pair.account" && msg.devicePublicKeyB64 && msg.sessionToken) {
      const auth = await this.authorizeAccountPairing(msg.sessionToken, msg.devicePublicKeyB64, msg.label, msg.ephemeral === true);
      if (auth.ok) welcome = this.pairing.trustDevice({ devicePublicKeyB64: msg.devicePublicKeyB64, label: msg.label });
      else reason = auth.reason;
    } else {
      return;
    }
    if (!welcome) {
      this.ws?.send(JSON.stringify({ t: "pair", p: JSON.stringify({ k: "pair.error", error: reason }) }));
      return;
    }
    this.ws?.send(JSON.stringify({ t: "pair", p: JSON.stringify({ k: "pair.welcome", ...welcome }) }));
  }

  /**
   * Verify that an account-session client is allowed to link this node. Returns
   * the control plane's concrete failure reason (e.g. "Device limit reached")
   * so the node can relay it to the client instead of a bare "pairing rejected".
   */
  private async authorizeAccountPairing(
    sessionToken: string,
    devicePublicKeyB64: string,
    label?: string,
    ephemeral = false,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.config.controlPlaneUrl) return { ok: false, reason: "Node is not linked to a control plane." };
    try {
      const res = await fetch(`${this.config.controlPlaneUrl.replace(/\/$/, "")}/node/authorize-client`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.enrollmentToken}` },
        body: JSON.stringify({ sessionToken, devicePublicKeyB64, label, ephemeral }),
        // Node's fetch has no default timeout. Without this, a control plane that
        // accepts the TCP connection but never responds would hang pairing (and,
        // on the mintTicket path, the whole relay reconnect) indefinitely.
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok === true) return { ok: true };
      return { ok: false, reason: data.error || `Pairing rejected (${res.status}).` };
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message || "Could not reach the control plane to pair." };
    }
  }

  /**
   * Exchange the long-lived enrollment token for a short-lived, single-use
   * relay ticket — directly against the control plane (over TLS). Only the
   * ticket is presented to the relay, so the relay never sees a reusable
   * credential. A fresh ticket is minted on every (re)connect.
   */
  private async mintTicket(): Promise<{ ticket: string; relayUrl?: string }> {
    if (!this.config.controlPlaneUrl) {
      throw new Error("relay.json missing controlPlaneUrl (required for relay tickets)");
    }
    const res = await fetch(`${this.config.controlPlaneUrl.replace(/\/$/, "")}/node/relay-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.enrollmentToken}` },
      body: "{}",
      // connect() awaits this on every (re)connect; a hung control plane must
      // fail fast into scheduleReconnect() rather than wedge remote access.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
    const data = (await res.json()) as { ticket?: string; relayUrl?: string };
    if (!data?.ticket) throw new Error("control plane returned no ticket");
    return { ticket: data.ticket, relayUrl: typeof data.relayUrl === "string" ? data.relayUrl : undefined };
  }

  private async connect() {
    // Solo (account-free) mode: no control plane to mint a ticket against — the
    // node authorizes onto the relay with its room id + bearer token directly.
    const solo = soloCredentials({ room: this.config.room, roomToken: this.config.roomToken });

    let ticket: string | undefined;
    let relayUrl: string | undefined;
    if (!solo) {
      try {
        ({ ticket, relayUrl } = await this.mintTicket());
      } catch (error) {
        this.lastErrorMessage = `ticket mint failed: ${(error as Error).message}`;
        console.warn("[relay] could not mint relay ticket:", (error as Error).message);
        this.scheduleReconnect();
        return;
      }
    }
    if (this.closed) return;

    // Connect to the shard the control plane assigned this node,
    // falling back to the statically configured relay for older control planes.
    // Solo mode has no shard assignment, so it always uses the configured relay.
    const relayBase = (relayUrl ?? this.config.url).replace(/\/$/, "");
    const target = buildDialUrl(relayBase, "node", solo ?? { ticket: ticket! });
    const ws = new WebSocket(target);
    this.ws = ws;

    ws.on("open", () => {
      // The TCP/WebSocket handshake succeeded, but relay auth/entitlement
      // checks happen after upgrade. Wait for the relay's `ready` message
      // before declaring the connector usable or resetting reconnect backoff.
    });

    ws.on("message", (data) => {
      let env: { t?: string; p?: string };
      try {
        env = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (env.t === "ready") {
        this.ready = true;
        this.lastErrorMessage = undefined;
        this.startHeartbeat(ws);
        this.scheduleBackoffReset(ws);
        console.log("[relay] connected");
        return;
      }
      if (env.t === "pair" && typeof env.p === "string") {
        void this.handlePairFrame(env.p);
        return;
      }
      if (env.t === "work.available") {
        const hint = env as { id?: string; label?: string };
        this.onWorkAvailable?.({ id: typeof hint.id === "string" ? hint.id : undefined, label: typeof hint.label === "string" ? hint.label : undefined });
        return;
      }
      if (env.t === "frame" && typeof env.p === "string") {
        // Reassemble chunked frames (large client uploads) before decrypting;
        // returns null while more chunks are still in flight.
        const payload = this.reassembler.accept(env as { p?: unknown; fc?: unknown; fi?: unknown; fn?: unknown });
        if (payload === null) return;
        try {
          const frame = openFrame(this.roomKey(), payload);
          if (!this.replay.accept(frame)) {
            console.warn("[relay] dropped stale or replayed client frame");
            return;
          }
          this.onClientMessage(frame.data as ClientMessage);
        } catch {
          console.warn("[relay] failed to decrypt client frame");
        }
        return;
      }
      if (env.t === "error") {
        const message = (env as { error?: string }).error || "Relay error";
        this.lastErrorMessage = message;
        console.warn("[relay] error:", message);
        if (isFatalRelayError(message)) {
          console.warn("[relay] disabling connector; fix relay setup/plan and restart the node dev server");
          this.closed = true;
          ws.close();
        }
      }
    });

    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    ws.on("close", () => {
      this.ready = false;
      this.stopHeartbeat();
      this.clearBackoffReset();
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      this.lastErrorMessage = (error as Error).message;
      console.warn("[relay] socket error:", (error as Error).message);
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    setTimeout(() => {
      if (!this.closed) void this.connect();
    }, wait);
  }
}
