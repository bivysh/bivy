// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { forwardOrEvict } from "./backpressure.js";
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

// Optional identifier for this relay process when running a sharded fleet
// (docs/scaling.md). Surfaced in /healthz and /metrics so dashboards and uptime
// checks can tell shards apart and spot a hot shard. Routing itself is decided
// by the control plane (which shard URL a node/client is handed), so this label
// is purely observational and has no effect on behavior.
const shardId = process.env.RELAY_SHARD_ID ?? null;
const enforceEntitlements = process.env.ENFORCE_ENTITLEMENTS === "1";
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
// crosses this high-water mark (it reconnects and re-syncs). A healthy socket
// never approaches it. See backpressure.ts.
const maxBufferedBytes = Number(process.env.RELAY_MAX_BUFFERED_BYTES ?? 16 * 1024 * 1024);

// Operational counters only — never payloads. Exposed at /metrics for uptime
// checks and dashboards.
const metrics = {
  totalConnections: 0,
  openConnections: 0,
  framesForwarded: 0,
  workNotifications: 0,
  rejectedAuth: 0,
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

async function introspect(path: string, body: unknown): Promise<any | null> {
  try {
    const res = await fetch(`${controlPlaneUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${relaySecret}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function setNodeStatus(nodeId: string, online: boolean) {
  await introspect("/internal/node-status", { nodeId, online });
}

/**
 * Forward a frame. Relay reads ONLY `msg.t`. For data frames the payload is
 * passed straight through as the original JSON text — never inspected.
 */
function isForwardable(text: string): boolean {
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
  // silently drop frames.
  if (text.startsWith('{"t":"frame"') || text.startsWith('{"t":"pair"')) return true;
  try {
    const env = JSON.parse(text) as { t?: unknown };
    return env.t === "frame" || env.t === "pair";
  } catch {
    return false;
  }
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

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, shardId, rooms: rooms.size }));
    return;
  }
  if (req.url === "/metrics") {
    // Prometheus text exposition for Alloy/Prometheus scrapers. Scraped over the
    // internal docker network only — Caddy blocks /metrics publicly. See
    // docs/ops/monitoring.md in bivysh/bivy-cloud.
    res.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE });
    res.end(renderRelayMetrics(metrics, rooms.size, shardId));
    return;
  }
  if (req.url === "/metrics.json") {
    // Backcompat: the pre-Prometheus JSON counters, kept for any tooling that
    // still reads them.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, shardId, rooms: rooms.size, ...metrics }));
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
      if (!accountId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "accountId required" }));
        return;
      }
      let delivered = 0;
      for (const r of rooms.values()) {
        if (r.nodeAccountId === accountId && r.node?.readyState === WebSocket.OPEN) {
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
    const info = await introspect("/internal/introspect/node", { token: ticket });
    if (!info?.nodeId) {
      metrics.rejectedAuth += 1;
      send(ws, { t: "error", error: "Unauthorized node" });
      ws.close(1008, "Unauthorized");
      return;
    }
    if (enforceEntitlements && info.entitlements?.relayEnabled !== true) {
      send(ws, { t: "error", error: "Hosted relay is not enabled for this account" });
      ws.close(1008, "Relay disabled");
      return;
    }
    attachNode(ws, info.nodeId, info.accountId);
  } else {
    const nodeId = url.searchParams.get("nodeId");
    const info = await introspect("/internal/introspect/session", { token: ticket });
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
    if (enforceEntitlements && info.entitlements?.relayEnabled !== true) {
      send(ws, { t: "error", error: "Hosted relay is not enabled for this account" });
      ws.close(1008, "Relay disabled");
      return;
    }
    attachClient(ws, nodeId, info.accountId);
  }
}

function allowMessage(
  ws: WebSocket,
  data: Buffer | ArrayBuffer | Buffer[],
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
  send(ws, { t: "ready", role: "node", nodeId });
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
    const text = data.toString();
    // Node → all clients. Payload forwarded verbatim for frames.
    if (isForwardable(text)) {
      metrics.framesForwarded += 1;
      for (const client of r.clients) {
        if (forwardOrEvict(client, text, maxBufferedBytes) === "evicted") metrics.evictedSlow += 1;
      }
    }
  });

  ws.on("close", () => {
    if (r.node === ws) {
      r.node = undefined;
      void setNodeStatus(nodeId, false);
      for (const client of r.clients) send(client, { t: "peer.offline" });
    }
    if (!r.node && r.clients.size === 0) rooms.delete(nodeId);
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
    if (!r.node && r.clients.size === 0) rooms.delete(nodeId);
    return;
  }

  r.clients.add(ws);
  send(ws, { t: "ready", role: "client", nodeId });
  send(r.node, { t: "peer.online", clients: r.clients.size });

  ws.on("message", (data) => {
    if (!allowMessage(ws, data, maxClientMessagesPerMinute, { role: "client", nodeId, accountId })) return;
    const text = data.toString();
    // Client → node. Payload forwarded verbatim for frames.
    if (isForwardable(text) && r.node) {
      metrics.framesForwarded += 1;
      if (forwardOrEvict(r.node, text, maxBufferedBytes) === "evicted") metrics.evictedSlow += 1;
    }
  });

  ws.on("close", () => {
    r.clients.delete(ws);
    if (r.node) send(r.node, { t: "peer.offline", clients: r.clients.size });
    if (!r.node && r.clients.size === 0) rooms.delete(nodeId);
  });
}

httpServer.listen(port, () => {
  console.log(`Relay listening on http://localhost:${port}  (control plane: ${controlPlaneUrl}, max frame: ${maxFrameBytes} bytes, max buffered: ${maxBufferedBytes} bytes, rate: client ${maxClientMessagesPerMinute}/min, node ${maxNodeMessagesPerMinute}/min)`);
});
