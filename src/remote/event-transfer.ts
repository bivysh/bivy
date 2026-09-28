// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash, randomBytes } from "node:crypto";

// A logical event is immutable while clients pull its pages. Pages are encoded
// independently, so neither history nor an individual attachment must fit in a
// single sealed frame. Keep in sync with core/event-transfer.ts (conformance test).
import { TRANSFER_PAGE_BYTES, MAX_TRANSFER_BYTES } from "../wire-format.js";
export { TRANSFER_PAGE_BYTES, MAX_TRANSFER_BYTES };
const MAX_STORED_BYTES = 128 * 1024 * 1024;
const TTL_MS = 120_000;
const INLINE_EVENT_BYTES = 4 * 1024 * 1024;

export class EventTransferStore {
  private entries = new Map<string, { body: Buffer; expires: number; hash: string }>();
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private now: () => number = Date.now, private inlineBytes = INLINE_EVENT_BYTES) {}

  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) {
      this.bytes -= entry.body.length;
      this.entries.delete(id);
    }
  }

  offer(event: unknown): Record<string, unknown> | null {
    const body = Buffer.from(JSON.stringify(event));
    if (body.length <= this.inlineBytes) return null;
    const source = event as Record<string, unknown>;
    const context = { sessionId: source.sessionId, requestId: source.requestId };
    this.prune();
    if (body.length > MAX_TRANSFER_BYTES) return {
      type: "session.error", ...context, code: "delivery_too_large",
      error: "This response exceeds the machine's 64 MiB delivery limit. The original data is retained on the machine.",
    };
    const hash = createHash("sha256").update(body).digest("hex");
    let id = [...this.entries].find(([, entry]) => entry.hash === hash)?.[0];
    if (!id) {
      // Never evict an active snapshot to admit another: all existing clients
      // must either complete that exact revision or receive an explicit expiry.
      if (this.bytes + body.length > MAX_STORED_BYTES || this.entries.size >= 16) return {
        type: "session.error", ...context, code: "delivery_busy", error: "The machine is serving large responses. Please retry shortly.",
      };
      id = randomBytes(24).toString("hex");
      this.entries.set(id, { body, hash, expires: this.now() + TTL_MS });
      this.bytes += body.length;
      if (!this.timer) {
        this.timer = setInterval(() => this.prune(), TTL_MS);
        this.timer.unref();
      }
    }
    // Legacy clients already display session.notice messages. Updated clients consume the
    // transfer before the reducer sees this compatibility envelope.
    return { type: "session.notice", ...context, code: "transfer_required",
      message: "Update the Bivy app to load this large response.",
      transfer: { id, bytes: body.length, sha256: hash, pageBytes: TRANSFER_PAGE_BYTES } };
  }

  read(command: Record<string, unknown>): Record<string, unknown> {
    this.prune();
    const { transferId, offset, requestId } = command;
    const entry = typeof transferId === "string" ? this.entries.get(transferId) : undefined;
    const base = { type: "transfer.part", transferId, requestId, offset };
    if (!entry) return { ...base, error: "This response expired. Retry to fetch a fresh snapshot." };
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.body.length || offset % TRANSFER_PAGE_BYTES !== 0) {
      return { ...base, error: "Invalid transfer offset." };
    }
    return { ...base, data: entry.body.subarray(offset, offset + TRANSFER_PAGE_BYTES).toString("base64") };
  }

  clear(): void { clearInterval(this.timer); this.timer = undefined; this.entries.clear(); this.bytes = 0; }
}
