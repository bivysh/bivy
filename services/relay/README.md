# Relay

Routes frames between remote clients and nodes through NAT. The **node dials
outbound**, so no inbound ports or port-forwarding are needed. This is a paid
convenience feature (free tier is local/LAN only).

See `../../CLOUD.md` for the open-core boundary and how the relay fits in.

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

## TODO before production

1. TLS termination (`wss://`) in front of the relay.
2. Pairing-based E2E key exchange (currently the key is provisioned via
   `.bivy/relay.json` / env on the node; the matching client key comes
   from pairing). Wire a real X25519 handshake at pairing time.
3. Per-account connection caps. Basic frame-size and per-socket message-rate
   limits exist, but live beta should add account-aware quotas/metrics.
4. Horizontal scale: rooms are in-process. For multiple relay instances, add a
   shared pub/sub (e.g. Redis) keyed by `nodeId`, or use sticky routing.
5. Add relay/node heartbeat monitoring beyond disconnect-based offline marking.
