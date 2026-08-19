# Self-host Bivy Cloud-equivalent infrastructure

Bivy Core runs the node + CLI locally without any hosted account (drive it from the terminal, or run agents headless). The browser UI (web/PWA) is served by a control plane — not by the node — so to get a browser UI, plus remote access, webhooks, push, and account/node registry, either use Bivy Cloud or self-host the same control-plane + relay stack described here.

**Just want the fastest path to a running stack?** See [self-host-quickstart.md](self-host-quickstart.md). This doc is the deeper operational reference — read it before you rely on a self-hosted deployment for anything that matters.

## Maturity and support

**Bivy is beta software (v0.x).** Interfaces and behavior can change between releases, and it is not production-hardened yet.

**We do not provide support for self-hosting.** There is no SLA and no support queue for self-hosted deployments — if you run Bivy yourself, you own it end to end. Questions can go to GitHub issues, but answers are community best-effort and not guaranteed. Support and managed reliability are what **Bivy Cloud** is for.

The two self-host surfaces differ only in how much you have to operate:

| Component | What it is | Operating it |
| --- | --- | --- |
| **Node + CLI** | The local agent daemon you run on machines you own | Runs locally — no server stack to operate. |
| **Control plane + relay** (Cloud-equivalent stack) | The self-hosted account/registry/relay/PWA-serving service described below | You run and operate the whole server stack yourself (see below). Bivy Cloud is the managed alternative. |

**Operating the control-plane + relay stack yourself means:**

- It is **open-source under AGPL-3.0-only**, not a managed product. You may use, modify, and run it under the terms of the [license](../LICENSE); modified network deployments must offer their users corresponding source as required by AGPL section 13.
- **No uptime, response-time, or data-durability guarantees.** Breaking changes between versions and manual upgrade/migration steps are likely.
- **You own operations:** TLS, backups, restore drills, secret rotation, monitoring, abuse prevention, and security hardening are your responsibility. This doc gets you started; it does not make them turnkey.

**When to self-host the control plane + relay:** when you specifically need full data-plane ownership, air-gapped/on-prem deployment, or you're comfortable operating beta infrastructure with no support. Otherwise use **Bivy Cloud** and skip the ops.

**What does _not_ change between Cloud and self-host:** the security boundary is identical either way — model keys and repo tokens stay on your node, the control plane sees only metadata + encrypted routing state, and normal relay payloads are E2E encrypted between your clients and nodes. See [Security boundary](#security-boundary) below. Self-hosting changes *who operates the service*, not *what the service can see*.

## One-command VPS path

Prereqs:

- Docker + Docker Compose plugin
- two DNS records pointing at the VPS:
  - `app.example.com` for the control plane and hosted PWA
  - `relay.example.com` for the WebSocket relay
- ports 80/443 open

Run from the repo root on the server:

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

The script:

- writes `deploy/.env` if missing;
- replaces the untouched example Caddyfile with your domains, while preserving
  customized Caddyfiles on later runs;
- generates strong `RELAY_SECRET` and Postgres password;
- requires either Resend email or complete GitHub OAuth configuration;
- starts Postgres, control-plane, relay, and Caddy with auto-TLS.

On a first run without auth settings, it writes the setup files and stops before
Docker. Configure one sign-in path in `deploy/.env`, then run the command again.
You can instead provide the auth variables through the environment on the first
invocation. Existing `deploy/.env` files are never overwritten.

## Connect a node

On your development machine:

```bash
# For GitHub OAuth deployments (use --email you@example.com for Resend):
bivy relay:setup \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --github
bivy start
```

## Required production settings

`deploy/self-host.sh` writes safe defaults for core relay use:

```env
NODE_ENV=production
DISABLE_DEV_LOGIN=1
PUBLIC_CONTROL_PLANE_URL=https://app.example.com
RELAY_PUBLIC_URL=wss://relay.example.com
RELAY_SECRET=...
POSTGRES_PASSWORD=...
```

Configure at least one of the following production sign-in paths:

```env
# Magic-link email
RESEND_API_KEY=...
AUTH_EMAIL_FROM=Bivy <login@app.example.com>

# GitHub OAuth sign-in
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...

# Web push (phone/PWA notifications). Push stays disabled until BOTH VAPID keys
# are set; generate a pair with `npx web-push generate-vapid-keys`. Push works
# for every account on a self-hosted stack.
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_SUBJECT=mailto:admin@app.example.com
```

## Offline automations (encrypted credential storage)

**Settings → Cloud machine profiles → "Run automations while I'm offline"** lets
the control plane start a cloud profile on a schedule or webhook when none of your
devices are online. To do that the server has to hold your cloud-provider
credential itself, so it refuses to enable the feature until it has a key to
encrypt that credential at rest. Until then the toggle is disabled and the panel
shows *"Your Bivy server must enable encrypted credential storage"* — this is a
**server-side setting, not something in the app**.

There is no UI for it. Set one environment variable on the control plane:

```bash
# 1. Generate a 32-byte master key
openssl rand -base64 32

# 2. Put it in deploy/.env
HOSTED_CREDENTIAL_KEY=<the base64 output>

# 3. Restart the control plane
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d control-plane
```

Reload the app; the toggle and **Save credential** unlock immediately.

What the key does: every hosted credential (provider token, GitHub App key,
escrowed session room keys) is sealed with AES-256-GCM under a per-account subkey
derived from this master key (`services/control-plane/src/hosted-crypto.ts`,
design in [`hosted-provisioning-trust-model.md`](hosted-provisioning-trust-model.md)).
No plaintext credential is ever written to Postgres, and with no key configured
the endpoints fail closed rather than storing anything.

**Back the key up alongside the database.** If you lose it, stored credentials
cannot be decrypted; the account has to re-enter them. Treat it like
`RELAY_SECRET` — it lives in `deploy/.env` (mode `600`) and nowhere else.

The feature also needs ephemeral machines enabled, which is the default:
`EPHEMERAL_MACHINES_ENABLED` and the build-time `VITE_EPHEMERAL_MACHINES_ENABLED`
are on unless set to exactly `0`.

## Using a managed/hosted Postgres

By default the stack runs its own `postgres` container. If you'd rather use a
managed database — DigitalOcean, Render, Neon, Supabase, Amazon RDS, etc. — you
don't need any code changes: the control plane talks to whatever `DATABASE_URL`
points at and creates its own tables on first boot (idempotent `CREATE TABLE IF
NOT EXISTS`), so there's no separate migration step.

**One-command path.** `deploy/self-host.sh` takes a managed database directly —
set `DATABASE_URL` in the environment and it writes `deploy/.env`, skips the
local Postgres password, and layers the overlay for you:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require' \
  bash deploy/self-host.sh app.example.com relay.example.com
```

**Manual path.** Or layer the checked-in `deploy/docker-compose.hosted-db.yml`
overlay over the base file yourself. It removes the bundled `postgres` service
and points the control plane at your provider's connection string:

1. Create a Postgres database in your provider's console and copy its connection
   string. Hosted providers require TLS, so keep the `sslmode` parameter they
   give you (usually `?sslmode=require`).
2. In `deploy/.env`, set `DATABASE_URL` (the `POSTGRES_*` lines are unused in
   this mode; leave them as-is — deleting them just prints a harmless "variable
   is not set" warning from the base compose file):

   ```env
   DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
   ```

3. Start the stack with **both** compose files:

   ```bash
   docker compose \
     -f deploy/docker-compose.yml \
     -f deploy/docker-compose.hosted-db.yml \
     --env-file deploy/.env up -d --build
   ```

Notes:

- The overlay uses the `!reset` YAML tag, which needs Docker Compose **v2.24.0+**
  (`docker compose version`).
- **Connection pooling:** managed tiers often cap `max_connections` low. Keep
  `instances × DATABASE_POOL_MAX` (default 10) under that cap, or front the
  database with the provider's pooler (PgBouncer, Neon's pooled endpoint).
- **Backups** are now the provider's job — use its managed snapshots/PITR
  instead of the `docker compose ... exec postgres pg_dump` recipe below (there
  is no local `postgres` container to exec into). You can still run `pg_dump`
  against the connection string from any host that can reach the database.

## Backups

> Using a managed/hosted Postgres (above)? Use your provider's snapshots/PITR
> instead — there is no local `postgres` container for these commands to reach.

The stack stores hosted metadata in Postgres. Back it up with:

```bash
cd /opt/bivy
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T postgres \
  pg_dump -U bivy -d bivy_control_plane --clean --if-exists \
  | gzip > "backups/bivy_control_plane_$STAMP.sql.gz"
```

Restore drill:

```bash
cd /opt/bivy
BACKUP=backups/bivy_control_plane_YYYYMMDDTHHMMSSZ.sql.gz

docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop control-plane relay
gunzip -c "$BACKUP" | docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T postgres \
  psql -U bivy -d bivy_control_plane
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d control-plane relay
```

For production, copy backups off-server and test restore monthly.

## Secret rotation

All secrets live in `deploy/.env` (mode `600`). Rotate them on a schedule and immediately after any suspected exposure. Commands below assume the compose project in `deploy/` (`docker compose -f deploy/docker-compose.yml --env-file deploy/.env ...`).

### `RELAY_SECRET` (shared control-plane ↔ relay secret)

The control plane mints relay tickets that the relay verifies with this shared secret, so **both services must rotate together**:

1. Generate a new value: `openssl rand -base64 48`
2. Replace `RELAY_SECRET=` in `deploy/.env`.
3. Restart both services so neither holds the old value:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d control-plane relay
   ```

Expect a brief reconnect blip: in-flight relay tickets are invalidated and connected nodes/phones re-establish automatically. Node data-plane keys are unaffected (E2E payloads never used this secret).

### `POSTGRES_PASSWORD` (database role) — read this before rotating

**Gotcha:** `POSTGRES_USER`/`POSTGRES_PASSWORD` only take effect on a *first* `initdb` against an empty data volume. On an existing box, editing `POSTGRES_PASSWORD` in `.env` does **not** change the real role password — it just makes the control plane connect with the wrong one and crash-loop. Rotate the role first, then the file:

```bash
# 1. Change the actual role password inside Postgres:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec postgres \
  psql -U bivy -d bivy_control_plane -c "ALTER USER bivy WITH PASSWORD 'NEW_STRONG_PASSWORD';"

# 2. Set the SAME value as POSTGRES_PASSWORD= in deploy/.env, then restart the control plane:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d control-plane
```

(The `DATABASE_URL` in the compose file is derived from `POSTGRES_PASSWORD`, so you only edit the one variable.)

### `HOSTED_CREDENTIAL_KEY` (encrypted credential storage)

Only relevant if you enabled [offline automations](#offline-automations-encrypted-credential-storage). Every stored envelope records the id of the key it was sealed with, so you can introduce a new key without breaking existing ciphertext:

1. Generate a new key: `openssl rand -base64 32`
2. Switch `deploy/.env` to the keyring form. The old single key keeps the id `default`; give the new one any id and mark it primary:
   ```env
   HOSTED_CREDENTIAL_KEYS=v2:<NEW_KEY>,default:<OLD_KEY>
   HOSTED_CREDENTIAL_KEY_PRIMARY=v2
   # HOSTED_CREDENTIAL_KEY=   (remove or leave blank)
   ```
3. Restart the control plane (`... up -d control-plane`). New writes are sealed under `v2`; old ciphertext still decrypts under `default`.
4. Re-seal each account's stored credentials under the new primary — a signed-in device calls `POST /account/hosted-provisioning/rotate` (`rotateHostedProvisioning` in `packages/core`); the response's `keyId` shows the key now in use, and the account's hosted audit log records `credential_rotated`.
5. Once no envelope references `default` any more, drop it from `HOSTED_CREDENTIAL_KEYS` and restart again.

Never delete a key that still has ciphertext sealed under it — those credentials become unrecoverable and the account has to re-enter them.

### Provider credentials (optional features)

These are rotated in the provider's dashboard, then mirrored into `deploy/.env` and applied with a control-plane restart (`... up -d control-plane`):

- `RESEND_API_KEY` — magic-link email.
- `GITHUB_OAUTH_CLIENT_SECRET` — GitHub sign-in (rotate under the OAuth app's settings).
- `WEB_PUSH_VAPID_PRIVATE_KEY` (+ public) — rotating the VAPID pair invalidates existing push subscriptions; clients re-subscribe on next load. Regenerate with `npx web-push generate-vapid-keys`.

After rotating anything, confirm the containers are running with `docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps`.

## Security boundary

Self-hosting does not change the product boundary:

- nodes run the agents and model calls;
- model keys/OAuth and GitHub repo tokens stay on the node or in your vault;
- the control plane stores metadata and encrypted relay routing state;
- normal relay payloads are E2E encrypted between your clients and nodes.
