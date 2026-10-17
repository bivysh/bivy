// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import http, { createServer, type IncomingMessage } from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BufferBudget, forwardOrEvict } from "./backpressure.js";
import { PreviewRelay } from "./preview.js";
import { renderRelayMetrics, PROMETHEUS_CONTENT_TYPE } from "./metrics.js";
import { initSentry } from "./instrument.js";

// Optional error reporting. Resolves to a no-op unless SENTRY_DSN is set, and
// only then is @sentry/node loaded (see instrument.ts).
const Sentry = await initSentry();

/**
 * Bivy — Relay.
 *
 * Routes frames between remote clients and nodes through NAT. The node dials
 * OUTBOUND (so no inbound ports / port-forwarding needed). Clients connect and
 * select a node; the relay forwards frames between them.
 *
 * E2E PRIVACY INVARIANT: the relay only ever reads the envelope routing field
 * (`t`). For data frames (`t === "frame"`) the opaque `p` payload is forwarded
 * VERBATIM and never parsed, logged, or stored. Session content is encrypted
 * by the node + client with a key established during pairing; the relay does
 * not have it. See README.md.
 */

const port = Number(process.env.PORT ?? 4500);
const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:4400";
const relaySecret = process.env.RELAY_SECRET ?? "dev-relay-secret";

// Fail fast rather than route traffic with the shared dev secret, which would
// let anyone introspect tokens against the control plane. Refuse it not just in
// NODE_ENV=production but whenever this relay points at a NON-local control
// plane — a `staging` (or unset-NODE_ENV) deploy reaching a real control plane
// over the network with the well-known default is exactly as exploitable as a
// production one. Local dev against a localhost control plane still works.
const isLocalControlPlane = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(controlPlaneUrl);
if ((process.env.NODE_ENV === "production" || !isLocalControlPlane) && (!process.env.RELAY_SECRET || relaySecret === "dev-relay-secret")) {
  console.error("Refusing to start: RELAY_SECRET must be set to a strong, non-default value when reaching a non-local control plane (openssl rand -hex 32).");
  process.exit(1);
}

// Optional identifier for this relay process when running a sharded fleet.
// Surfaced in /healthz and /metrics so dashboards and uptime
// checks can tell shards apart and spot a hot shard. Routing itself is decided
// by the control plane (which shard URL a node/client is handed), so this label
// is purely observational and has no effect on behavior.
const shardId = process.env.RELAY_SHARD_ID ?? null;
// Account-free ("solo") admission. OFF by default and only honoured when the
// operator explicitly opts in — the hosted relay leaves this unset, so its
// control-plane-introspected admission path is provably unchanged (Gap 1).
//
// In this mode a node/client presents a `room` (an unguessable id from the
// pairing QR) plus a bearer `roomToken` (the pairing secret) instead of a
// control-plane ticket. The FIRST node to claim a room fixes its token (TOFU);
// a client is admitted iff it presents the same token. Security rests on three
// legs: (1) the room id is unguessable so an attacker cannot pre-claim a room
// it doesn't know; (2) the token is a high-entropy bearer matched in constant
// time; (3) session content stays E2E-encrypted — the relay never sees it. The
// relay stays blind either way. Suitable for a self-hosted, single-user relay.
const allowRoomTokens = process.env.RELAY_ALLOW_ROOM_TOKENS === "1";
// Fail fast on a dangerous misconfiguration: a relay reaching a real (non-local)
// control plane is an account-gated deployment, and enabling account-free room
// tokens there would open an admission path that BYPASSES the control plane's
// account/ownership checks — anyone with a room id + token gets on. Solo
// mode is for a self-hosted, control-plane-free relay only, so we refuse rather
// than silently run a relay that is account-gated on one door and open on the
// other. (A localhost control plane — i.e. no real CP — is still fine.)
if (allowRoomTokens && !isLocalControlPlane) {
  console.error(
    "Refusing to start: RELAY_ALLOW_ROOM_TOKENS=1 (account-free admission) must not be combined with a non-local control plane. " +
      "Solo mode is for a self-hosted relay with no control plane; point CONTROL_PLANE_URL at localhost or unset the room-token flag.",
  );
  process.exit(1);
}
// The minimum entropy floor we can enforce relay-side: reject a room token
// shorter than a 128-bit secret (32 hex / ~22 base64url chars).
const MIN_ROOM_TOKEN_LEN = 22;
// room id -> the token that first claimed it (solo mode only). Cleared when the
// room is torn down, so it never grows unbounded.
const roomTokens = new Map<string, string>();

// Constant-time bearer comparison. Different lengths can't be compared by
// timingSafeEqual (it throws), so we short-circuit — that leaks only length,
// negligible for a high-entropy secret.
function tokenMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
const maxFrameBytes = Number(process.env.RELAY_MAX_FRAME_BYTES ?? 256 * 1024);
// Agent sessions can legitimately stream hundreds/thousands of small events
// per minute. A too-low node-side rate limit makes the relay terminate the
// node socket mid-session, which presents as the node flapping offline and the
// just-created session disappearing from clients. Keep the old env var as a
// compatibility fallback, but use role-specific defaults.
const legacyMaxMessagesPerMinute = process.env.RELAY_MAX_MESSAGES_PER_MINUTE;
const maxClientMessagesPerMinute = Number(process.env.RELAY_MAX_CLIENT_MESSAGES_PER_MINUTE ?? legacyMaxMessagesPerMinute ?? 600);
// Do NOT let the legacy, role-agnostic limit cap node sockets. Older deploys
// often set RELAY_MAX_MESSAGES_PER_MINUTE for browser/client abuse protection
// (for example 600/min). Applying that same value to the enrolled node socket
// makes high-volume session streams flap offline with "Rate limit exceeded".
// Nodes keep their higher role-specific default unless the node-specific env is
// set explicitly.
const maxNodeMessagesPerMinute = Number(process.env.RELAY_MAX_NODE_MESSAGES_PER_MINUTE ?? 6000);
if (legacyMaxMessagesPerMinute && !process.env.RELAY_MAX_NODE_MESSAGES_PER_MINUTE) {
  console.warn("[relay] ignoring RELAY_MAX_MESSAGES_PER_MINUTE for node sockets; set RELAY_MAX_NODE_MESSAGES_PER_MINUTE to override the 6000/min node default");
}
// Cap concurrent connections from a single IP (blunt abuse/DoS guard) and drop
// connections that stop responding to heartbeat pings (frees rooms held open by
// dead TCP sockets behind NAT/mobile networks).
const maxConnectionsPerIp = Number(process.env.RELAY_MAX_CONNECTIONS_PER_IP ?? 50);
const idleTimeoutMs = Number(process.env.RELAY_IDLE_TIMEOUT_MS ?? 120_000);
// A consumer that stops reading makes `ws` buffer forwarded frames in the
// relay's own memory without bound — one stuck phone/node could OOM a shard and
// take down every room on it. Frames are E2E-opaque and non-superseding, so we
// cannot silently drop one; instead we evict a socket whose outbound buffer
// crosses this high-water mark (it reconnects and re-syncs). The relay-wide
// budget covers many stuck sockets at once. A healthy socket never approaches
// either. See backpressure.ts.
const maxBufferedBytes = Number(process.env.RELAY_MAX_BUFFERED_BYTES ?? 16 * 1024 * 1024);
const maxTotalBufferedBytes = Number(process.env.RELAY_MAX_TOTAL_BUFFERED_BYTES ?? 256 * 1024 * 1024);
const buffers = new BufferBudget(maxBufferedBytes, maxTotalBufferedBytes, maxFrameBytes);

// Operational counters only — never payloads. Exposed at /metrics for uptime
// checks and dashboards.
const metrics = {
  totalConnections: 0,
  openConnections: 0,
  framesForwarded: 0,
  workNotifications: 0,
  rejectedAuth: 0,
  rejectedControlPlane: 0,
  rejectedRate: 0,
  rejectedTooLarge: 0,
  rejectedPerIp: 0,
  evictedSlow: 0,
};
const ipConnections = new Map<string, number>();

function clientIp(req: { socket?: { remoteAddress?: string | null } }): string {
  return (req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

interface Room {
  node?: WebSocket;
  nodeAccountId?: string;
  clients: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

function room(nodeId: string): Room {
  let r = rooms.get(nodeId);
  if (!r) {
    r = { clients: new Set() };
    rooms.set(nodeId, r);
  }
  return r;
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Every admission makes one or two control-plane calls. fetch() opens a new
// connection per concurrent request with no cap, so a reconnect storm of 3,000
// nodes had the relay holding ~4,700 sockets to the control plane, each with its
// own DNS lookup and handshake, while the control plane only runs a pool's worth
// of queries at a time anyway. A small keep-alive pool queues them here instead.
const controlPlaneHttp = controlPlaneUrl.startsWith("https:") ? https : http;
const controlPlaneAgent = new controlPlaneHttp.Agent({ keepAlive: true, maxSockets: 32 });

// What a control-plane call came back with. "rejected" is the control plane
// answering no (4xx: bad ticket, admission denied); "unavailable" is it not
// answering at all (unreachable, 5xx, timeout, unreadable body). Callers that
// only want the data can treat both as null via `introspect()`.
type ControlPlaneReply = { status: "ok"; body: any } | { status: "rejected" } | { status: "unavailable" };

function callControlPlane(path: string, body: unknown): Promise<ControlPlaneReply> {
  const unavailable = { status: "unavailable" } as const;
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = controlPlaneHttp.request(`${controlPlaneUrl}${path}`, {
      method: "POST",
      agent: controlPlaneAgent,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${relaySecret}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", () => resolve(unavailable));
      res.on("end", () => {
        const code = res.statusCode ?? 0;
        if (code >= 400 && code < 500) return resolve({ status: "rejected" });
        if (code < 200 || code >= 300) return resolve(unavailable);
        try {
          resolve({ status: "ok", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve(unavailable);
        }
      });
    });
    // Counts only once a pooled socket is assigned, so queueing in a storm never trips it.
    req.setTimeout(60_000, () => req.destroy());
    req.on("error", () => resolve(unavailable));
    req.end(payload);
  });
}

async function introspect(path: string, body: unknown): Promise<any | null> {
  const reply = await callControlPlane(path, body);
  return reply.status === "ok" ? reply.body : null;
}

// Sent instead of "Unauthorized" when the control plane couldn't answer an
// admission check. Nodes back off much more slowly after "Unauthorized", so a
// control-plane restart reported that way kept them offline for minutes.
const CONTROL_PLANE_UNAVAILABLE = "Control plane unavailable";

function refuseUnavailable(ws: WebSocket) {
  metrics.rejectedControlPlane += 1;
  send(ws, { t: "error", error: CONTROL_PLANE_UNAVAILABLE });
  ws.close(1013, "Try again later");
}

async function setNodeStatus(nodeId: string, online: boolean) {
  await introspect("/internal/node-status", { nodeId, online });
}

/**
 * Forward a frame. Relay reads ONLY `msg.t`. For data frames the payload is
 * passed straight through as the original bytes — never inspected.
 */
const FRAME_PREFIX = Buffer.from('{"t":"frame"');
const PAIR_PREFIX = Buffer.from('{"t":"pair"');
function isForwardable(data: Buffer): boolean {
  // We forward opaque data frames (t === "frame") and pairing-handshake control
  // frames (t === "pair"). The `p` payload is never inspected — pairing frames
  // carry only public keys and an ECDH-wrapped room key, never the room key in
  // the clear.
  //
  // Fast path: every frame is serialized as `JSON.stringify({ t: "frame"|"pair",
  // ... })` on both ends (see packages/core/src/relay-frame.ts and
  // src/relay-client.ts), so `t` is always the first key and the compact
  // envelope begins with this exact prefix. Checking the prefix avoids
  // JSON.parse-ing the whole frame — up to the max frame size — on the hot
  // forward path just to read one field; at streaming rates that parse (and its
  // per-call AST build) was a primary relay CPU cost. Fall back to a full parse
  // only when the prefix doesn't match, so a serializer change can never
  // silently drop frames. The bytes themselves are forwarded, so a frame is
  // never decoded to a string and re-encoded per recipient.
  if (startsWith(data, FRAME_PREFIX) || startsWith(data, PAIR_PREFIX)) return true;
  try {
    const env = JSON.parse(data.toString()) as { t?: unknown };
    return env.t === "frame" || env.t === "pair";
  } catch {
    return false;
  }
}

function startsWith(data: Buffer, prefix: Buffer): boolean {
  return data.length >= prefix.length && data.compare(prefix, 0, prefix.length, 0, prefix.length) === 0;
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as any as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function authOk(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return String(req.headers.authorization ?? "") === `Bearer ${relaySecret}`;
}

// One domain per deployment/shard, advertised automatically to admitted nodes.
// No user, agent, app manifest, or node needs DNS/TLS/port configuration.
const previews = process.env.RELAY_PREVIEW_ORIGIN
  ? new PreviewRelay(process.env.RELAY_PREVIEW_ORIGIN, undefined,
    async (route) => (await introspect("/internal/preview-wake", { route }))?.waking === true)
  : undefined;
// Metrics get their own listener (METRICS_PORT/METRICS_HOST, loopback by
// default), never the public port: a reverse proxy in front (Caddy,
// kamal-proxy) forwards every path. See docs/configuration.md.
const metricsServer = createServer((req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE });
    res.end(renderRelayMetrics({ ...metrics, bufferedBytes: buffers.queued }, rooms.size, shardId, previews?.metrics()));
    return;
  }
  if (req.url === "/metrics.json") {
    // Backcompat: the pre-Prometheus JSON counters, kept for any tooling that
    // still reads them.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, shardId, rooms: rooms.size, ...metrics, bufferedBytes: buffers.queued, preview: previews?.metrics() }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const httpServer = createServer((req, res) => {
  if (previews?.handle(req, res)) return;
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, shardId, rooms: rooms.size }));
    return;
  }
  if (req.method === "POST" && req.url === "/internal/run-updated") {
    void (async () => {
      if (!authOk(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const body = await readJsonBody(req);
      const accountId = typeof body?.accountId === "string" ? body.accountId : "";
      const id = typeof body?.id === "string" ? body.id : "";
      const revision = typeof body?.revision === "string" ? body.revision : undefined;
      if (!accountId || !id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "accountId and id required" }));
        return;
      }
      // A client is attached to one node room, but the hint is account-wide: an
      // operator watching machine A must still see a Run advance on machine B.
      // De-duplicate sockets defensively if room topology ever permits a client
      // to appear more than once. The hint is content-free; clients fetch the
      // canonical account-scoped record before rendering anything.
      const recipients = new Set<WebSocket>();
      for (const r of rooms.values()) {
        if (r.nodeAccountId !== accountId) continue;
        for (const client of r.clients) if (client.readyState === WebSocket.OPEN) recipients.add(client);
      }
      for (const client of recipients) send(client, { t: "run.updated", id, revision });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered: recipients.size }));
    })().catch((error) => {
      Sentry.captureException(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/internal/work-available") {
    void (async () => {
      if (!authOk(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const body = await readJsonBody(req);
      const accountId = typeof body?.accountId === "string" ? body.accountId : "";
      const id = typeof body?.id === "string" ? body.id : undefined;
      const label = typeof body?.label === "string" ? body.label : undefined;
      const nodeId = typeof body?.nodeId === "string" ? body.nodeId : undefined;
      const excludeNodeId = typeof body?.excludeNodeId === "string" ? body.excludeNodeId : undefined;
      if (!accountId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "accountId required" }));
        return;
      }
      let delivered = 0;
      for (const [roomNodeId, r] of rooms) {
        if ((!nodeId || roomNodeId === nodeId) && roomNodeId !== excludeNodeId && r.nodeAccountId === accountId && r.node?.readyState === WebSocket.OPEN) {
          send(r.node, { t: "work.available", id, label });
          delivered += 1;
        }
      }
      metrics.workNotifications += delivered;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered }));
    })().catch((error) => {
      Sentry.captureException(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

httpServer.on("upgrade", (req, socket, head) => {
  if (previews?.upgrade(req, socket, head) || previews?.upgradeStream(req, socket, head)) return;
  const url = new URL(req.url ?? "", "http://relay");
  const role = url.pathname === "/node" ? "node" : url.pathname === "/client" ? "client" : null;
  if (!role) {
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  if ((ipConnections.get(ip) ?? 0) >= maxConnectionsPerIp) {
    metrics.rejectedPerIp += 1;
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    registerConnection(ws, ip);
    void handleConnection(role, ws, url);
  });
});

// Track per-IP concurrency and liveness for every accepted socket. The `close`
// handler always fires (even when handleConnection rejects auth), so counters
// stay balanced.
function registerConnection(ws: WebSocket, ip: string) {
  metrics.totalConnections += 1;
  metrics.openConnections += 1;
  ipConnections.set(ip, (ipConnections.get(ip) ?? 0) + 1);
  const state = ws as WebSocket & { _meshAlive?: boolean };
  state._meshAlive = true;
  ws.on("pong", () => {
    state._meshAlive = true;
  });
  ws.on("error", (error) => {
    // `ws` emits errors such as WS_ERR_UNSUPPORTED_MESSAGE_LENGTH before the
    // normal `message` handler runs. Without a listener this crashes the relay,
    // causing Caddy 502s for every reconnecting phone/node.
    if ((error as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
      metrics.rejectedTooLarge += 1;
      try {
        ws.close(1009, "Frame too large");
      } catch {
        ws.terminate();
      }
      return;
    }
    console.warn("[relay] websocket error:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error);
  });
  ws.once("close", () => {
    metrics.openConnections -= 1;
    const remaining = (ipConnections.get(ip) ?? 1) - 1;
    if (remaining <= 0) ipConnections.delete(ip);
    else ipConnections.set(ip, remaining);
  });
}

// Heartbeat: ping every socket each interval; terminate any that did not pong
// since the previous round. Unref'd so it never keeps the process alive.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const state = ws as WebSocket & { _meshAlive?: boolean };
    if (state._meshAlive === false) {
      ws.terminate();
      continue;
    }
    state._meshAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore — a failed ping just means the socket is already gone
    }
  }
}, idleTimeoutMs);
heartbeat.unref();

async function handleConnection(role: "node" | "client", ws: WebSocket, url: URL) {
  // Account-free admission (opt-in, no control plane). See allowRoomTokens.
  const roomToken = url.searchParams.get("roomToken");
  if (allowRoomTokens && roomToken) {
    const roomId = url.searchParams.get("room") ?? url.searchParams.get("nodeId");
    if (!roomId) {
      send(ws, { t: "error", error: "Missing room" });
      ws.close(1008, "Missing room");
      return;
    }
    if (roomToken.length < MIN_ROOM_TOKEN_LEN) {
      metrics.rejectedAuth += 1;
      send(ws, { t: "error", error: "Weak room token" });
      ws.close(1008, "Weak room token");
      return;
    }
    // A synthetic per-room account so attachClient's same-account ownership
    // check passes for this room and never collides with a real CP accountId.
    const soloAccount = `solo:${roomId}`;
    if (role === "node") {
      // TOFU: the first node fixes the room's token; a mismatching claim on a
      // live room is rejected (prevents hijacking a room whose id leaked).
      const claimed = roomTokens.get(roomId);
      if (claimed !== undefined && !tokenMatch(claimed, roomToken)) {
        metrics.rejectedAuth += 1;
        send(ws, { t: "error", error: "Room already claimed" });
        ws.close(1008, "Room already claimed");
        return;
      }
      roomTokens.set(roomId, roomToken);
      attachNode(ws, roomId, soloAccount);
    } else {
      const expected = roomTokens.get(roomId);
      if (expected === undefined || !tokenMatch(expected, roomToken)) {
        metrics.rejectedAuth += 1;
        // "Node offline" when the room was never claimed vs "Forbidden" on a
        // token mismatch — same distinction the CP client path draws.
        send(ws, { t: "error", error: expected === undefined ? "Node offline" : "Forbidden" });
        ws.close(1008, "Not available");
        return;
      }
      attachClient(ws, roomId, soloAccount);
    }
    return;
  }

  // The connecting party presents a single-use ticket (minted directly against
  // the control plane), never its reusable bearer. The relay forwards it to the
  // control plane for a one-shot introspection and never stores it.
  const ticket = url.searchParams.get("ticket");
  if (!ticket) {
    send(ws, { t: "error", error: "Missing ticket" });
    ws.close(1008, "Missing ticket");
    return;
  }

  if (role === "node") {
    const reply = await callControlPlane("/internal/introspect/node", { token: ticket });
    if (reply.status === "unavailable") return refuseUnavailable(ws);
    const info = reply.status === "ok" ? reply.body : null;
    if (!info?.nodeId) {
      metrics.rejectedAuth += 1;
      send(ws, { t: "error", error: "Unauthorized node" });
      ws.close(1008, "Unauthorized");
      return;
    }
    attachNode(ws, info.nodeId, info.accountId);
  } else {
    const nodeId = url.searchParams.get("nodeId");
    const reply = await callControlPlane("/internal/introspect/session", { token: ticket });
    if (reply.status === "unavailable") return refuseUnavailable(ws);
    const info = reply.status === "ok" ? reply.body : null;
    if (!info?.accountId || !nodeId) {
      metrics.rejectedAuth += 1;
      send(ws, { t: "error", error: "Unauthorized client" });
      ws.close(1008, "Unauthorized");
      return;
    }
    // A node-scoped link grant may only reach the node it was minted for.
    if (info.nodeId && info.nodeId !== nodeId) {
      send(ws, { t: "error", error: "Token not valid for this node" });
      ws.close(1008, "Forbidden");
      return;
    }
    attachClient(ws, nodeId, info.accountId);
  }
}

function allowMessage(
  ws: WebSocket,
  data: RawData,
  maxMessagesPerMinute: number,
  meta: { role: "node" | "client"; nodeId: string; accountId: string },
): boolean {
  const bytes = Array.isArray(data) ? data.reduce((n, chunk) => n + chunk.length, 0) : data.byteLength;
  if (bytes > maxFrameBytes) {
    metrics.rejectedTooLarge += 1;
    send(ws, { t: "error", error: "Frame too large" });
    ws.close(1009, "Frame too large");
    return false;
  }

  const now = Date.now();
  const state = ws as WebSocket & { _meshRate?: { windowStart: number; count: number } };
  const current = state._meshRate;
  if (!current || now - current.windowStart >= 60_000) state._meshRate = { windowStart: now, count: 1 };
  else current.count += 1;

  if (maxMessagesPerMinute > 0 && (state._meshRate?.count ?? 0) > maxMessagesPerMinute) {
    metrics.rejectedRate += 1;
    console.warn(
      `[relay] rate limit exceeded role=${meta.role} nodeId=${meta.nodeId} accountId=${meta.accountId} ` +
        `count=${state._meshRate?.count ?? 0}/min limit=${maxMessagesPerMinute}`,
    );
    send(ws, { t: "error", error: "Rate limit exceeded" });
    ws.close(1008, "Rate limit exceeded");
    return false;
  }
  return true;
}

function attachNode(ws: WebSocket, nodeId: string, accountId: string) {
  const r = room(nodeId);
  // Replace any existing node connection (reconnect).
  if (r.node && r.node !== ws) r.node.close(1000, "Replaced by new connection");
  r.node = ws;
  r.nodeAccountId = accountId;
  void setNodeStatus(nodeId, true);
  send(ws, { t: "ready", role: "node", nodeId, previewOrigin: previews?.attach(ws, nodeId) });
  // Tell the node about already-waiting clients, and symmetrically tell every
  // waiting client the node is back. Without the client-side notice a node
  // reconnect (common on flaky/mobile links — the node blips offline mid-session
  // and immediately redials) leaves clients stuck showing "node offline"
  // forever, because clients otherwise only ever receive peer.offline (on node
  // drop) and never a matching peer.online to clear it.
  if (r.clients.size > 0) {
    send(ws, { t: "peer.online", clients: r.clients.size });
    for (const client of r.clients) send(client, { t: "peer.online", clients: r.clients.size });
  }

  ws.on("message", (data) => {
    if (!allowMessage(ws, data, maxNodeMessagesPerMinute, { role: "node", nodeId, accountId })) return;
    const frame = asBuffer(data);
    // Node → all clients. Payload forwarded verbatim for frames.
    if (isForwardable(frame)) {
      metrics.framesForwarded += 1;
      for (const client of r.clients) {
        if (forwardOrEvict(client, frame, buffers) === "evicted") metrics.evictedSlow += 1;
      }
    }
  });

  ws.on("close", () => {
    if (r.node === ws) {
      r.node = undefined;
      void setNodeStatus(nodeId, false);
      for (const client of r.clients) send(client, { t: "peer.offline" });
    }
    if (!r.node && r.clients.size === 0) {
      rooms.delete(nodeId);
      roomTokens.delete(nodeId);
    }
  });
}

function attachClient(ws: WebSocket, nodeId: string, accountId: string) {
  const r = room(nodeId);

  // Ownership: a client may only reach a node owned by the same account.
  // We learn the node's account when it connects. If it is not connected we
  // cannot verify ownership, so we refuse (and report offline).
  if (!r.node || r.nodeAccountId !== accountId) {
    send(ws, { t: "error", error: r.node ? "Forbidden" : "Node offline" });
    ws.close(1008, "Not available");
    if (!r.node && r.clients.size === 0) {
      rooms.delete(nodeId);
      roomTokens.delete(nodeId);
    }
    return;
  }

  r.clients.add(ws);
  send(ws, { t: "ready", role: "client", nodeId });
  send(r.node, { t: "peer.online", clients: r.clients.size });

  ws.on("message", (data) => {
    if (!allowMessage(ws, data, maxClientMessagesPerMinute, { role: "client", nodeId, accountId })) return;
    const frame = asBuffer(data);
    // Client → node. Payload forwarded verbatim for frames.
    if (isForwardable(frame) && r.node) {
      metrics.framesForwarded += 1;
      if (forwardOrEvict(r.node, frame, buffers) === "evicted") metrics.evictedSlow += 1;
    }
  });

  ws.on("close", () => {
    r.clients.delete(ws);
    if (r.node) send(r.node, { t: "peer.offline", clients: r.clients.size });
    if (!r.node && r.clients.size === 0) {
      rooms.delete(nodeId);
      roomTokens.delete(nodeId);
    }
  });
}

// The container runs node as PID 1, which gets no default SIGTERM action. Exit
// explicitly so `docker stop` is immediate; nodes and clients reconnect.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));

httpServer.listen({ port, host: process.env.BIND_HOST || undefined }, () => {
  console.log(`Relay listening on http://localhost:${port}  (control plane: ${controlPlaneUrl}, max frame: ${maxFrameBytes} bytes, max buffered: ${maxBufferedBytes} bytes per socket / ${maxTotalBufferedBytes} total, rate: client ${maxClientMessagesPerMinute}/min, node ${maxNodeMessagesPerMinute}/min)`);
});
const metricsPort = Number(process.env.METRICS_PORT ?? 9464);
const metricsHost = process.env.METRICS_HOST || "127.0.0.1";
metricsServer.listen({ port: metricsPort, host: metricsHost }, () => console.log(`Metrics on http://${metricsHost}:${metricsPort}/metrics`));
// Metrics are never worth taking the relay down (e.g. the port is taken).
metricsServer.on("error", (error) => console.warn(`[relay] metrics not served: ${error.message}`));
