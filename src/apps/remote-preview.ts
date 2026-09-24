// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { WebSocket } from "ws";
import { AppGateway, previewOriginTemplate } from "./gateway.js";
import type { AppRegistry } from "./registry.js";
import { PreviewStream } from "./preview-stream.js";

/** Automatically discovered preview delivery. The app gateway receives ONLY
 * HTTP streams on a private in-process socket, never a publicly bound port. */
export class RemotePreview {
  private gateway?: AppGateway;
  private origin?: string;
  private relayUrl?: string;
  private online = false;
  private sockets = new Set<WebSocket>();
  constructor(private readonly registry: AppRegistry, private readonly returnOrigins: () => readonly string[]) {}

  get available(): boolean { return this.online && Boolean(this.gateway); }
  ready(origin: string | undefined, relayUrl: string): void {
    this.disconnect();
    if (!origin) return;
    const template = previewOriginTemplate(origin);
    const target = new URL(relayUrl);
    if (target.protocol !== "wss:" && !(target.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) return;
    if (this.origin !== template) {
      this.gateway?.close();
      this.gateway = new AppGateway(this.registry, template, this.returnOrigins);
      this.origin = template;
    }
    this.relayUrl = relayUrl.replace(/\/$/, "") + "/preview/stream";
    this.online = true;
  }
  connect(ticket: string): void {
    if (!this.available || !this.relayUrl || !/^[a-f0-9]{64}$/.test(ticket) || this.sockets.size >= 64) return;
    const gateway = this.gateway!;
    const ws = new WebSocket(this.relayUrl, { headers: { authorization: `Bearer ${ticket}` }, maxPayload: 64 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false, followRedirects: false });
    this.sockets.add(ws);
    ws.on("error", () => ws.terminate());
    ws.once("close", () => this.sockets.delete(ws));
    ws.once("open", () => {
      if (!this.online || gateway !== this.gateway) { ws.terminate(); return; }
      const stream = new PreviewStream(ws);
      stream.on("error", () => stream.destroy());
      // A stalled/incomplete HTTP request cannot retain a tunnel indefinitely.
      stream.setTimeout(60_000, () => stream.destroy());
      gateway.server.emit("connection", stream);
    });
  }
  open(id: string, returnTo?: string): string {
    if (!this.available) throw new Error("Preview delivery is unavailable. Reconnect the machine and try again.");
    return this.gateway!.open(id, returnTo);
  }
  revoke(id: string): void { this.gateway?.revoke(id); }
  disconnect(): void {
    this.online = false;
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }
  close(): void { this.disconnect(); this.gateway?.close(); this.gateway = undefined; this.origin = undefined; }
}
