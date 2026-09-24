# Relay

Routes frames between remote clients and nodes through NAT. The **node dials
outbound**, so no inbound ports or port-forwarding are needed. Remote access
through the self-hosted relay has no commercial admission policy.

## Privacy invariant (the selling point)

For the session transport, the relay reads **only** the envelope routing field (`t`). For data frames
(`t === "frame"`) the opaque `p` payload is forwarded **verbatim** and never
parsed, logged, or stored. Session content is encrypted by the node + client
with a key established during pairing (AES-256-GCM, see `../../src/e2e.ts`).
The relay does not have that key, so it **cannot read session content**.

## Automatic app previews

Set `RELAY_PREVIEW_ORIGIN=https://{app}.preview.example.net` on the deployment
and route that dedicated wildcard HTTPS domain to this relay. The relay advertises
preview delivery to admitted nodes, which need no preview configuration or open
ports. A stable node-specific host suffix binds each request to its admitted node.
This is Bivy deployment infrastructure, not an end-user or per-app setup step.

Preview HTTP and WebSocket bytes use separate bounded outbound streams through
`/preview/stream`; a one-use ticket in the Authorization header admits each stream.
Browser requests are authorized by the node's app gateway. Preview hosts never
fall through to the relay's operational or admission routes. There is no generic
TCP port forwarding. See [app delivery and security](../../docs/apps.md).

**Preview content is not session E2E ciphertext.** The HTTPS ingress and relay
operator can see app preview traffic; session frames and pairing remain unchanged.
Do not include preview request bodies, headers, cookies, or tickets in access logs.

## Run

```bash
cd services/relay
npm install
CONTROL_PLANE_URL=http://localhost:4400 RELAY_SECRET=dev-relay-secret npm run dev
# http://localhost:4500   (GET /healthz)
```

The relay verifies connections by calling the control plane's
`/internal/introspect/*` endpoints with `RELAY_SECRET`. Both must share the same
secret.

Connecting parties never hand the relay a reusable bearer. A node/client first
exchanges its long-lived token for a short-lived, single-use **relay ticket**
(`/node/relay-ticket` or `/client/relay-ticket`, called directly over TLS) and
presents only that ticket. The relay's introspection consumes the ticket, so a
compromised relay cannot replay it for anything beyond one routing lookup.

## Connections

| Path | Who | Query | Auth |
|---|---|---|---|
| `ws://relay/node` | node daemon | `ticket=tkt_…` | single-use node ticket (consumed on introspect) |
| `ws://relay/client` | remote client | `ticket=tkt_…&nodeId=…` | single-use client ticket (consumed on introspect) |

Routing: client frames → the node; node frames → all clients in that node's
room. Ownership is enforced — a client may only reach a node owned by the same
account. A node that is offline is unreachable.

Control messages the relay generates: `ready`, `peer.online`, `peer.offline`,
`error`, and (for preview-enabled deployments) `preview.connect`. Client-supplied
preview control messages are never forwarded to nodes.

## Test

```bash
npm run test:e2e
```

Spawns control plane + relay, enrolls a node, connects a mock node and client,
and asserts: encrypted round-trip both directions, ciphertext-only on the wire,
and account ownership enforcement.

## Operational notes

- **TLS.** The relay speaks plain WebSocket; terminate `wss://` in front of it
  with a reverse proxy. The self-host stack does this with Caddy (see
  [`../../deploy/README.md`](../../deploy/README.md)).
- **Rate limits.** Frame-size and per-socket message-rate limits are enforced;
  per-account connection caps are not yet.
- **Horizontal scale.** Rooms are in-process, so one room must stay on one relay
  process. The control plane supports deterministic `nodeId` sharding via
  `RELAY_SHARD_URLS`, placing a node and all of its clients on the same stable
  relay hostname without a shared pub/sub backplane. Do not round-robin one
  shard hostname across active processes.
- **Liveness.** Nodes are marked offline on disconnect; there is no separate
  heartbeat monitor.
