# Scaling Bivy across servers

The control plane and relay have different scaling models:

- **Control plane:** ordinary stateless HTTP replicas behind one load balancer.
- **Relay:** deterministic WebSocket shards. A node and every client controlling
  it must use the same shard because each relay keeps its live room in memory.

A generic round-robin pool is correct for the control plane and **not** correct
for relays. Relay sharding supplies the horizontal scaling boundary without
putting session traffic or room state in Redis.

## Recommended topology

```text
                    app.example.com
                           |
                    HTTP load balancer
                    /        |        \
                  cp-0      cp-1      cp-2
                    \        |        /
                      managed Postgres

 control plane hashes nodeId and returns one of these stable URLs:

 relay-0.example.com  -> relay server/shard 0
 relay-1.example.com  -> relay server/shard 1
 relay-2.example.com  -> relay server/shard 2
```

The public load balancer terminates TLS. Backends may use private HTTP/WS, but
its network policy must only admit traffic from the load balancer and fleet.
`/metrics` and `/readyz` must remain private.

## Control-plane replicas

Every replica must use the same:

- managed `DATABASE_URL`;
- `RELAY_SECRET`, OAuth, Stripe, VAPID, and other application secrets;
- `PUBLIC_CONTROL_PLANE_URL`; and
- ordered `RELAY_SHARD_URLS` list.

All durable application state, single-use OAuth state, relay tickets, and auth
rate-limit counters are in Postgres. GitHub OAuth callbacks therefore require
no sticky sessions. Scheduled automation uses database dedupe/compare-and-set,
so schedulers may run on every replica.

Configure the load balancer to:

1. probe `GET /readyz` and only route a 200 response;
2. preserve `Host`, `X-Forwarded-Proto`, and the original client address in the
   first `X-Forwarded-For` entry;
3. allow normal requests and Web Push APIs, with no session affinity; and
4. drain a backend before replacing its container.

Each replica opens up to `DATABASE_POOL_MAX` connections. Keep
`replicas × DATABASE_POOL_MAX` below the database limit, or use PgBouncer.
Schema initialization is idempotent and runs before readiness.

## Relay shards

Set the same ordered list on every control-plane replica:

```env
RELAY_PUBLIC_URL=wss://relay-0.example.com
RELAY_SHARD_URLS=wss://relay-0.example.com,wss://relay-1.example.com
```

The control plane hashes `nodeId`, then returns the selected URL with both node
and client tickets. Each hostname must route to its corresponding relay process.
Set a diagnostic `RELAY_SHARD_ID` on that process.

Do not round-robin one shard hostname over independent active relay processes:
rooms are process-local, so a node and phone could land in different rooms.
For now a shard is one active process. A load balancer may front it for TLS,
health checks, and controlled failover to a replacement, but not active/active
fan-out. Losing a shard briefly disconnects its sockets; nodes and clients
reconnect and rebuild rooms after the replacement is healthy.

Changing the number or order of shard URLs changes placement and reconnects part
of the fleet. Use a maintenance window. Prefer adding enough shards ahead of a
traffic step and monitor each shard's connection, room, memory, and rejection
metrics.

## Deploying a fleet node

The single-host `deploy/docker-compose.yml` remains the easiest self-host setup.
For multi-host deployments, `deploy/docker-compose.cluster.yml` intentionally
contains only application processes: managed Postgres and the external TLS/load
balancer are operator-owned.

On each server:

```bash
cp deploy/.env.cluster.example deploy/.env.cluster
chmod 600 deploy/.env.cluster
# Fill shared values and immutable image tags. On relay hosts set that host's
# RELAY_SHARD_ID; route the corresponding shard hostname to it.

bash deploy/cluster-node.sh control-plane deploy/.env.cluster
# or
bash deploy/cluster-node.sh relay deploy/.env.cluster
```

The compose file publishes port 4400 or 4500 on all interfaces by default.
Override `CONTROL_PLANE_BIND_ADDRESS` / `RELAY_BIND_ADDRESS` when the load
balancer reaches a specific private interface, and enforce access with the host
firewall/security group.

For rolling control-plane updates, update and drain one replica at a time. For a
relay update, remove/drain that shard, replace it, and allow WebSocket clients to
reconnect; do not run old and new processes as a round-robin pair.

## Single-host relay sharding

To exercise the same placement model on one machine, use
`deploy/docker-compose.shards.example.yml` with
`deploy/Caddyfile.shards.example`. This is useful before splitting shards onto
separate servers.
