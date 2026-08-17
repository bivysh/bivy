# Relay

Routes frames between remote clients and nodes through NAT. The **node dials
outbound**, so no inbound ports or port-forwarding are needed. Remote access
through the self-hosted relay has no commercial admission policy.

## Privacy invariant (the selling point)

The relay reads **only** the envelope routing field (`t`). For data frames
(`t === "frame"`) the opaque `p` payload is forwarded **verbatim** and never
parsed, logged, or stored. Session content is encrypted by the node + client
with a key established during pairing (AES-256-GCM, see `../../src/e2e.ts`).
The relay does not have that key, so it **cannot read session content**.

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
`error`.

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
