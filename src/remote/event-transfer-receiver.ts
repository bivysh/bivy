// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Standalone node mirror of packages/core/src/event-transfer.ts. The release
// omits packages/; behavior is covered by the cross-stack transfer tests.
const unb64 = (data: string): Uint8Array => Uint8Array.from(atob(data), c => c.charCodeAt(0));
interface Command { kind: string; [key: string]: unknown }
interface ServerEvent { type: string; sessionId?: string; requestId?: string; [key: string]: unknown }

import { TRANSFER_PAGE_BYTES, MAX_TRANSFER_BYTES } from "../wire-format.js";
export { TRANSFER_PAGE_BYTES, MAX_TRANSFER_BYTES };
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

interface Offer { id: string; bytes: number; key: string; iv: string; pageBytes: number }
interface Pending {
  offer: Offer;
  envelope: ServerEvent;
  bytes: Uint8Array<ArrayBuffer>;
  offset: number;
  requestId: string;
  retries: number;
}

/** Deliver complete events in wire order. A history snapshot and its baseline
 * are never exposed partially; later live events wait behind that snapshot.
 * Only one page is in flight, with bounded retries and memory. */
export class EventTransferReceiver {
  private queue: ServerEvent[] = [];
  private queuedBytes = 0;
  private pending?: Pending;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(private deps: {
    send(command: Command): Promise<void>;
    emit(event: ServerEvent): void;
    fault(message: string): void;
    timeoutMs?: number;
  }) {}

  accept(event: ServerEvent): void {
    if (event.type === "transfer.part") { void this.part(event); return; }
    if (this.pending || this.queue.length) {
      this.queuedBytes += new TextEncoder().encode(JSON.stringify(event)).length;
      if (this.queuedBytes > MAX_QUEUED_BYTES || this.queue.length >= 4096) {
        this.reset();
        this.deps.fault("Transcript delivery fell behind. Reconnecting to synchronize again.");
        return;
      }
      this.queue.push(event);
      return;
    }
    this.deliver(event);
  }

  private deliver(event: ServerEvent): void {
    if (event.code !== "transfer_required") { this.deps.emit(event); return; }
    const offer = event.transfer as Offer | undefined;
    if (!offer || !/^[a-f0-9]{48}$/.test(offer.id) || !/^[a-f0-9]{64}$/.test(offer.key) || !/^[a-f0-9]{24}$/.test(offer.iv) ||
        !Number.isSafeInteger(offer.bytes) || offer.bytes <= 0 || offer.bytes > MAX_TRANSFER_BYTES || offer.pageBytes !== TRANSFER_PAGE_BYTES) {
      this.deps.emit({ type: "session.error", code: "delivery_invalid", sessionId: event.sessionId, requestId: event.requestId, error: "Invalid large-response transfer. Update the app and retry." });
      return;
    }
    this.pending = { offer, envelope: event, bytes: new Uint8Array(offer.bytes), offset: 0, requestId: "", retries: 0 };
    this.request();
  }

  private request(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.requestId = `transfer-${crypto.randomUUID()}`;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      if (++pending.retries <= 2) this.request();
      else this.fail("Large-response delivery timed out. Retry to synchronize.");
    }, this.deps.timeoutMs ?? 10_000);
    void this.deps.send({ kind: "transfer.read", transferId: pending.offer.id, offset: pending.offset, requestId: pending.requestId })
      .catch(() => { if (this.pending === pending) this.fail("Could not request the next response page. Retry to synchronize."); });
  }

  private async part(event: ServerEvent): Promise<void> {
    const pending = this.pending;
    // Other paired clients use the same encrypted room; their replies are not ours.
    if (!pending || event.requestId !== pending.requestId || event.transferId !== pending.offer.id || event.offset !== pending.offset) return;
    clearTimeout(this.timer);
    if (typeof event.error === "string") { this.fail(event.error); return; }
    try {
      if (typeof event.data !== "string" || event.data.length > Math.ceil(TRANSFER_PAGE_BYTES / 3) * 4) throw new Error("Invalid response page.");
      const bytes = unb64(event.data);
      if (bytes.length !== Math.min(TRANSFER_PAGE_BYTES, pending.offer.bytes - pending.offset)) throw new Error("Incomplete response page.");
      pending.bytes.set(bytes, pending.offset);
      pending.offset += bytes.length;
      pending.retries = 0;
      if (pending.offset < pending.offer.bytes) { this.request(); return; }
      // Reject duplicate final pages while the authenticated decryption is asynchronous.
      pending.requestId = "";
      const generation = this.generation;
      const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
      const key = await crypto.subtle.importKey("raw", fromHex(pending.offer.key), "AES-GCM", false, ["decrypt"]);
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(pending.offer.iv) }, key, pending.bytes);
      } catch { throw new Error("Response integrity check failed."); }
      if (generation !== this.generation || this.pending !== pending) return;
      const complete = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as ServerEvent;
      if (!complete || typeof complete.type !== "string" || complete.code === "transfer_required" || complete.type === "transfer.part") throw new Error("Invalid response envelope.");
      this.pending = undefined;
      this.deps.emit(complete);
      this.drain();
    } catch (error) {
      if (this.pending === pending) this.fail(`${(error as Error).message} Retry to synchronize.`);
    }
  }

  private fail(message: string): void {
    const envelope = this.pending?.envelope;
    this.reset();
    this.deps.emit({ type: "session.error", code: "delivery_failed", sessionId: envelope?.sessionId, requestId: envelope?.requestId, error: message });
    // Dropping queued events invalidates the stream. Reconnect triggers the
    // existing history/replay recovery; never apply a tail as a full snapshot.
    this.deps.fault(message);
  }

  private drain(): void {
    while (!this.pending && this.queue.length) {
      const next = this.queue.shift()!;
      this.queuedBytes -= new TextEncoder().encode(JSON.stringify(next)).length;
      this.deliver(next);
    }
  }

  reset(): void {
    clearTimeout(this.timer);
    this.pending = undefined;
    this.queue = [];
    this.queuedBytes = 0;
    this.generation++;
  }
}
