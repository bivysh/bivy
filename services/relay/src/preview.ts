// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { PreviewStream } from "./preview-stream.js";

interface Peer { control: WebSocket; streams: Set<Duplex>; pending: Set<string> }
interface Pending { peer: Peer; resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function headers(input: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const blocked = new Set([...HOP, ...(input.connection ?? "").toLowerCase().split(",").map((s) => s.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !blocked.has(key) && !key.startsWith("x-forwarded-") && key !== "forwarded"));
}

/** Preview delivery is a separate HTTPS trust boundary, NOT encrypted session
 * frames. Only this dedicated domain accepts browser traffic. The authenticated
 * node connection supplies routing; one-use tickets attach bounded byte streams
 * to that node's app gateway, never arbitrary TCP destinations. */
export class PreviewRelay {
  private readonly suffix: string;
  private readonly peers = new Map<string, Peer>();
  private readonly pending = new Map<string, Pending>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private active = 0;
  constructor(readonly originTemplate: string, private readonly timeoutMs = 10_000) {
    if (!/^https:\/\/\{app\}\.[a-z0-9.-]+$/.test(originTemplate)) throw new Error("RELAY_PREVIEW_ORIGIN must be https://{app}.<dedicated-preview-domain>");
    this.suffix = new URL(originTemplate.replace("{app}", "a")).hostname.slice(1);
  }

  /** Called ONLY after existing node admission succeeds. Route names are bound
   * to node identity, so one tenant cannot claim another tenant's app hosts. */
  attach(control: WebSocket, nodeId: string): string {
    const route = createHash("sha256").update(nodeId).digest("hex").slice(0, 24);
    const old = this.peers.get(route);
    if (old) this.detach(old);
    const peer: Peer = { control, streams: new Set(), pending: new Set() };
    this.peers.set(route, peer);
    control.once("close", () => {
      this.detach(peer);
      if (this.peers.get(route) === peer) this.peers.delete(route);
    });
    return this.originTemplate.replace("{app}", `{app}-${route}`);
  }

  private detach(peer: Peer): void {
    for (const token of [...peer.pending]) this.reject(token, new Error("Preview machine disconnected"));
    for (const stream of peer.streams) stream.destroy();
  }
  private reject(token: string, error: Error): void {
    const pending = this.pending.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(token);
    pending.peer.pending.delete(token);
    this.active--;
    pending.reject(error);
  }
  private open(peer: Peer, signal: AbortSignal): Promise<Duplex> {
    if (signal.aborted || peer.control.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Preview machine unavailable"));
    if (this.active >= 1024 || peer.pending.size + peer.streams.size >= 64 || peer.control.bufferedAmount > 1024 * 1024) return Promise.reject(new Error("Preview capacity exceeded"));
    return new Promise((resolve, reject) => {
      const token = randomBytes(32).toString("hex");
      const abort = () => this.reject(token, new Error("Preview request cancelled"));
      const cleanup = () => signal.removeEventListener("abort", abort);
      const timer = setTimeout(() => this.reject(token, new Error("Preview machine did not respond")), this.timeoutMs);
      timer.unref();
      this.active++;
      this.pending.set(token, { peer, timer, resolve: (stream) => { cleanup(); resolve(stream); }, reject: (error) => { cleanup(); reject(error); } });
      peer.pending.add(token);
      signal.addEventListener("abort", abort, { once: true });
      peer.control.send(JSON.stringify({ t: "preview.connect", ticket: token }));
    });
  }

  /** Stream credentials are carried in headers, never URLs or access logs. */
  upgradeStream(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (req.url !== "/preview/stream") return false;
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const pending = token && this.pending.get(token);
    if (!pending || pending.peer.control.readyState !== WebSocket.OPEN || req.headers.origin) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true; }
    clearTimeout(pending.timer);
    this.pending.delete(token!);
    pending.peer.pending.delete(token!);
    // ws validates the handshake. An invalid handshake must also release the
    // reservation and reject the waiting HTTP client, without permitting reuse.
    let accepted = false;
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        accepted = true;
        ws.on("error", () => ws.terminate());
        const stream = new PreviewStream(ws);
        stream.on("error", () => stream.destroy());
        pending.peer.streams.add(stream);
        stream.once("close", () => { pending.peer.streams.delete(stream); this.active--; });
        pending.resolve(stream);
      });
    } finally {
      if (!accepted) { this.active--; pending.reject(new Error("Invalid preview stream handshake")); }
    }
    return true;
  }

  private route(req: IncomingMessage): { preview: boolean; peer?: Peer } {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (host !== this.suffix.slice(1) && !host.endsWith(this.suffix)) return { preview: false };
    const label = host.slice(0, -this.suffix.length);
    const match = /^(?:view-)?[a-f0-9]{32}-([a-f0-9]{24})$/.exec(label);
    return { preview: true, peer: match ? this.peers.get(match[1]) : undefined };
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const route = this.route(req);
    if (!route.preview) return false;
    // Fail closed for every path on preview hosts, including /metrics, /node,
    // /internal/* and unknown/offline routes. Never fall through to relay APIs.
    if (!route.peer) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end("Preview machine is offline. Reconnect it and reload."); return true;
    }
    const abort = new AbortController();
    const upstream = this.request(req, route.peer, abort.signal);
    res.once("close", () => { abort.abort(); upstream.destroy(); });
    upstream.once("response", (response) => {
      res.writeHead(response.statusCode ?? 502, headers(response.headers));
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("error", () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end("Preview connection interrupted. Reload to retry.");
    });
    req.pipe(upstream);
    return true;
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const route = this.route(req);
    if (!route.preview) return false;
    if (!route.peer || req.headers.upgrade?.toLowerCase() !== "websocket") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true; }
    const abort = new AbortController();
    const upstream = this.request(req, route.peer, abort.signal, true);
    socket.once("close", () => { abort.abort(); upstream.destroy(); });
    upstream.once("upgrade", (response, peer, upstreamHead) => {
      const result = { ...headers(response.headers), connection: "Upgrade", upgrade: "websocket" };
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(result).flatMap(([key, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}\r\n`)).join("")}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      socket.once("close", () => peer.destroy()); peer.once("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.once("response", (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Preview rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on("error", () => socket.destroy());
    upstream.end();
    return true;
  }

  private request(req: IncomingMessage, peer: Peer, signal: AbortSignal, upgrade = false): http.ClientRequest {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      void this.open(peer, signal).then((stream) => callback?.(null, stream), (error: Error) => callback?.(error, undefined as never));
      return undefined as never;
    };
    const forwarded = headers(req.headers);
    if (upgrade) { forwarded.connection = "Upgrade"; forwarded.upgrade = "websocket"; }
    const request = http.request({ host: "preview.invalid", path: req.url, method: req.method, headers: forwarded, agent });
    request.setTimeout(60_000, () => request.destroy(new Error("Preview idle timeout")));
    request.once("close", () => agent.destroy());
    return request;
  }

  close(): void { for (const peer of this.peers.values()) this.detach(peer); this.peers.clear(); this.wss.close(); }
}
