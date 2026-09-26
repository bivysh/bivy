// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { Duplex } from "node:stream";
type WriteCallback = (error?: Error | null) => void;
import { createWebSocketStream, type WebSocket } from "ws";

/** Byte totals for one direction each; shared by every stream of a relay. */
export interface StreamBytes { toNode: number; fromNode: number }

/** A bounded HTTP-compatible socket over an outbound WebSocket. Each write is
 * split into small frames; backpressure propagates in both directions. */
export class PreviewStream extends Duplex {
  private readonly wire: Duplex;
  private timeoutMs = 0;
  private timer?: NodeJS.Timeout;
  constructor(ws: WebSocket, private readonly bytes?: StreamBytes) {
    super({ highWaterMark: 64 * 1024 });
    this.wire = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
    this.wire.on("data", (chunk: Buffer) => {
      this.touch();
      if (this.bytes) this.bytes.fromNode += chunk.length;
      if (!this.push(chunk)) this.wire.pause();
    });
    this.wire.once("end", () => this.push(null));
    this.wire.once("error", (error) => this.destroy(error));
    this.wire.once("close", () => this.destroy());
  }
  override _read(): void { this.wire.resume(); }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: WriteCallback): void {
    if (this.bytes) this.bytes.toNode += chunk.length;
    let offset = 0;
    const next = (error?: Error | null): void => {
      if (error || offset >= chunk.length) { callback(error); return; }
      this.touch();
      const end = Math.min(offset + 64 * 1024, chunk.length);
      const part = chunk.subarray(offset, end);
      offset = end;
      this.wire.write(part, encoding, next);
    };
    next();
  }
  override _final(callback: () => void): void { this.wire.end(callback); }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    clearTimeout(this.timer); this.wire.destroy(); callback(error);
  }
  /** Read by http.Agent when it parks a kept-alive socket. */
  get timeout(): number { return this.timeoutMs; }
  setTimeout(ms: number, callback?: () => void): this {
    this.timeoutMs = ms; this.touch();
    if (callback) this.once("timeout", callback);
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  // http.Agent refs a pooled socket while in use; timers here are already unref'd.
  ref(): this { return this; }
  unref(): this { return this; }
  private touch(): void {
    clearTimeout(this.timer);
    if (this.timeoutMs) { this.timer = setTimeout(() => this.emit("timeout"), this.timeoutMs); this.timer.unref(); }
  }
}
