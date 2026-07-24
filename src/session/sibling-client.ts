// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// A NODE acting as a relay CLIENT of a sibling node it co-owns — the transport
// that lets an owner daemon stream replication frames to its standby
// (docs/session-replication.md). Bivy has no node↔node link; nodes reach each
// other only the way a phone reaches a node: as a client in the sibling's relay
// room. This is the node-side port of the browser client
// (packages/core/src/transport-relay.ts), built on the already-unit-tested
// node crypto core (relay-cli-crypto.ts) + framing (relay-chunk.ts).
//
// Handshake (all relay frames opaque to the relay):
//   1. POST /node/sibling-link-grant {nodeId} (Bearer enrollment token)
//        → a client-scoped grant for the sibling (closes the credential gap).
//   2. POST /client/relay-ticket {nodeId}     (Bearer grant) → single-use ticket.
//   3. WS  <relay>/client?ticket=..&nodeId=sibling
//   4. pair.account {grant, devicePublicKeyB64} → pair.welcome {nodePub, wrapped}
//        → ECDH-unwrap the sibling's room key (acceptWelcome).
//   5. sealed request/reply frames, correlated by requestId.
//
// NOTE: the live path requires a running relay + control plane + a second node,
// so it is exercised by the multi-node validation plan in the doc, not by an
// in-process unit test. The framing/correlation logic is kept small and the
// crypto it calls is unit-tested in relay-cli-crypto.test.ts.

import { WebSocket } from "ws";

import { newDeviceKeypair, acceptWelcome, RoomCipher } from "../relay-cli-crypto.js";
import { frameMessages, FrameReassembler } from "../relay-chunk.js";
import type { PairingKeypair } from "../pairing-crypto.js";

type FetchLike = typeof fetch;

export interface SiblingClientOptions {
  controlPlaneUrl: string;
  /** This node's enrollment token (authorizes minting a sibling grant). */
  enrollmentToken: string;
  /** The sibling node to connect to (the standby). */
  siblingNodeId: string;
  /** Fallback relay URL if the control plane doesn't return one. */
  relayUrl?: string;
  label?: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  WebSocketImpl?: typeof WebSocket;
  /** Called for every decrypted inbound event (e.g. replication acks). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Called on transport close so the owner can reconnect/backoff. */
  onClose?: () => void;
}

/** A single request awaiting its correlated reply. */
interface Pending {
  resolve: (event: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SiblingClient {
  private ws?: WebSocket;
  private cipher?: RoomCipher;
  private readonly keypair: PairingKeypair = newDeviceKeypair();
  private readonly reassembler = new FrameReassembler();
  private readonly pending = new Map<string, Pending>();
  private paired?: Promise<void>;
  private resolvePaired?: () => void;
  private rejectPaired?: (err: Error) => void;
  private closed = false;
  private reqSeq = 0;

  constructor(private readonly opts: SiblingClientOptions) {}

  private get fetchImpl(): FetchLike {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Connect + pair; resolves once the sibling's room key is established. */
  async connect(): Promise<void> {
    const cp = this.opts.controlPlaneUrl.replace(/\/$/, "");
    // 1. Mint a client grant for the sibling using our enrollment token.
    const grantRes = await this.postJson(`${cp}/node/sibling-link-grant`, this.opts.enrollmentToken, {
      nodeId: this.opts.siblingNodeId,
    });
    const grant = String(grantRes.grant ?? "");
    if (!grant) throw new Error("sibling-link-grant returned no grant");
    const relayFromGrant = typeof grantRes.relayUrl === "string" ? grantRes.relayUrl : undefined;
    // 2. Exchange the grant for a single-use relay ticket.
    const ticketRes = await this.postJson(`${cp}/client/relay-ticket`, grant, { nodeId: this.opts.siblingNodeId });
    const ticket = String(ticketRes.ticket ?? "");
    if (!ticket) throw new Error("relay-ticket returned no ticket");
    const relayBase = (typeof ticketRes.relayUrl === "string" ? ticketRes.relayUrl : relayFromGrant || this.opts.relayUrl || "").replace(/\/$/, "");
    if (!relayBase) throw new Error("no relay URL for sibling");

    // 3. Open the /client socket in the sibling's room.
    const url = `${relayBase}/client?ticket=${encodeURIComponent(ticket)}&nodeId=${encodeURIComponent(this.opts.siblingNodeId)}`;
    const WSImpl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WSImpl(url);
    this.ws = ws;
    this.paired = new Promise<void>((resolve, reject) => {
      this.resolvePaired = resolve;
      this.rejectPaired = reject;
    });
    ws.on("message", (data: unknown) => this.onMessage(String(data), grant));
    ws.on("close", () => this.handleClose());
    ws.on("error", (err: Error) => this.rejectPaired?.(err));
    await this.paired;
  }

  private async onMessage(raw: string, grant: string): Promise<void> {
    let msg: { t?: string; p?: unknown; fc?: unknown; fi?: unknown; fn?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "ready" || msg.t === "peer.online") {
      // Begin account pairing to obtain the sibling's room key.
      this.sendControl({ t: "pair", p: { k: "pair.account", sessionToken: grant, devicePublicKeyB64: this.keypair.publicKeyB64, label: this.opts.label ?? "Bivy replica" } });
      return;
    }
    if (msg.t === "pair") {
      this.handlePair(msg.p as unknown as Record<string, unknown>);
      return;
    }
    if (msg.t === "frame" && typeof msg.p === "string" && this.cipher) {
      const full = this.reassembler.accept(msg);
      if (!full) return;
      try {
        const frame = this.cipher.open(full);
        this.dispatchEvent(frame.data as Record<string, unknown>);
      } catch {
        /* undecryptable frame — ignore */
      }
    }
  }

  private handlePair(p: Record<string, unknown>): void {
    const k = String(p?.k ?? "");
    if (k === "pair.welcome") {
      try {
        const roomKey = acceptWelcome(this.keypair, { nodePublicKeyB64: String(p.nodePublicKeyB64 ?? ""), wrapped: String(p.wrapped ?? "") });
        this.cipher = new RoomCipher(roomKey);
        this.resolvePaired?.();
      } catch (err) {
        this.rejectPaired?.(err instanceof Error ? err : new Error(String(err)));
      }
    } else if (k === "pair.error") {
      this.rejectPaired?.(new Error(String(p.error ?? "pairing rejected by sibling")));
    }
  }

  private dispatchEvent(event: Record<string, unknown>): void {
    const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
    if (requestId && this.pending.has(requestId)) {
      const waiter = this.pending.get(requestId)!;
      clearTimeout(waiter.timer);
      this.pending.delete(requestId);
      waiter.resolve(event);
      return;
    }
    this.opts.onEvent?.(event);
  }

  /** Send a command and await its correlated reply event (by requestId). */
  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const requestId = `repl-${++this.reqSeq}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("sibling reply timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.sendSealed({ ...command, requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendSealed(command: Record<string, unknown>): void {
    if (!this.cipher || this.ws?.readyState !== WebSocket.OPEN) throw new Error("sibling client not connected");
    const payload = this.cipher.seal(command);
    for (const frame of frameMessages(payload)) {
      if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("sibling client closed mid-send");
      this.ws.send(frame);
    }
  }

  private sendControl(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private async postJson(url: string, bearer: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private handleClose(): void {
    if (this.closed) return;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("sibling client closed"));
    }
    this.pending.clear();
    this.rejectPaired?.(new Error("closed before pairing"));
    this.opts.onClose?.();
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
