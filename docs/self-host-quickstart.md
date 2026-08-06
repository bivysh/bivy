# Self-host quickstart

The fast, numbered path from an empty VPS to a running Bivy control plane +
relay stack, tied to the actual files in [`deploy/`](../deploy). For the
operational deep-dive — backups, restore drills, secret rotation, what the
security boundary is — see [self-host.md](self-host.md). For "should I even do
this," see [self-host.md § Maturity and support](self-host.md#maturity-and-support)
and [faq.md](faq.md): self-hosting the control plane + relay is source-available
and unsupported — no SLA, community-only Q&A.

If you just want to run agents on your own machine with a browser UI via the
*hosted* control plane, you don't need any of this — see
[quickstart.md](quickstart.md). This doc is only for operating your own
control-plane + relay stack instead of Bivy Cloud.

## Prerequisites

- A Linux VPS (1 vCPU / 1 GB RAM is enough to start).
- Docker + the Compose plugin installed on it.
- Two DNS A/AAAA records pointing at the VPS's IP:
  - one for the control plane + web app, e.g. `app.example.com`
  - one for the relay, e.g. `relay.example.com`
- Ports 80 and 443 open (Caddy needs both for HTTP→HTTPS redirect and
  Let's Encrypt).

## 1. Provision the box and install Docker

```bash
ssh root@YOUR_SERVER_IP
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

([`deploy/README.md`](../deploy/README.md) is the shorter reference for the
files in the `deploy/` directory; this quickstart is the fully numbered
walkthrough.)

## 2. Get the repo onto the server

```bash
mkdir -p /opt/bivy && cd /opt/bivy
git clone https://github.com/bivysh/bivy.git .
```

`deploy/self-host.sh` expects to run from inside a checkout (it resolves its
own repo root from `$0`), so this has to be a real clone, not just the `deploy/`
directory copied over.

## 3. Point the checked-in Caddyfile at your domains

This is the one step people miss: **`deploy/Caddyfile` is not a template you
copy — it's already tracked in git**, pre-filled with placeholder domains
(`app.example.com` / `relay.example.com`). `deploy/self-host.sh` only *writes*
`deploy/Caddyfile` if the file is missing, so on a fresh clone it already
exists and the script silently keeps it as-is — your real domains never get
written unless you happen to be using `app.example.com`/`relay.example.com`
literally.

Do one of:

- Edit `deploy/Caddyfile` in place, replacing both hostnames with your real
  domains, **or**
- `rm deploy/Caddyfile` and let step 4 generate a fresh one from the domains
  you pass it.

## 4. Run the one-command installer

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

Reading [`deploy/self-host.sh`](../deploy/self-host.sh), here is exactly what
it does, in order:

1. Normalizes both domain arguments (strips a leading `http(s)://` and any
   trailing path).
2. Writes `deploy/.env` **only if it doesn't already exist** — see the full
   variable checklist below. It generates `RELAY_SECRET` (48 random bytes,
   base64) and `POSTGRES_PASSWORD` (32 random bytes, base64) with `openssl
   rand`, falling back to Node's `crypto.randomBytes` if `openssl` isn't on
   the box. The file is `chmod 600`.
3. Writes `deploy/Caddyfile` **only if it doesn't already exist** (see the
   caveat in step 3 above).
4. Runs [`deploy/prune.sh`](../deploy/prune.sh) if a previous Bivy stack is
   already running (skipped on a genuinely first deploy, since there's nothing
   of ours to reclaim yet). Force it with `BIVY_PRUNE=1`, skip with
   `BIVY_PRUNE=0`.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
   --build` — builds and starts Postgres, the control plane, the relay, and
   Caddy (which obtains a Let's Encrypt certificate automatically for both
   domains).

It is idempotent and safe to re-run: re-running after editing `deploy/.env` or
`deploy/Caddyfile` picks up the changes without touching secrets that already
exist.

## 5. Verify the stack is healthy

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
```

`control-plane`, `relay`, and `postgres` should all show `healthy` (the
control plane's health check hits `/readyz`, which fails closed if Postgres is
unreachable — a DB outage shows up here instead of a green light over a
control plane that 500s every request). Then, from your own machine:

```bash
curl -sI https://app.example.com/          # 200
curl -si https://relay.example.com/healthz # 200 JSON
```

If either domain doesn't resolve or the TLS handshake fails, see
[troubleshooting.md § Relay won't connect](troubleshooting.md#relay-wont-connect).

## 6. Connect a node

From your development machine (not the server):

```bash
bivy relay:setup \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --email you@example.com
bivy start
```

`bivy doctor` should report `relay configured` and, once the daemon is
running, `relay connected`.

## 7. Link a phone or browser

In the node's local web UI sidebar, choose **Link remote device** and scan the
QR with your phone — or run `bivy link` for a printable QR/URL. This works
from anywhere afterwards, including cellular, because the phone reaches your
node through the relay rather than your LAN. See
[remote-access.md](remote-access.md) for the full pairing/security model.

## 8. Next steps

- **Backups, restore drills, secret rotation:** all covered in
  [self-host.md](self-host.md) — this quickstart deliberately stops at "it's
  running."
- **GitHub sign-in and the GitHub work queue:** [github-setup.md](github-setup.md)
  and [github-oauth-setup.md](github-oauth-setup.md).
- **Scaling the relay past one CPU core:**
  [`deploy/docker-compose.shards.example.yml`](../deploy/docker-compose.shards.example.yml)
  and [`deploy/Caddyfile.shards.example`](../deploy/Caddyfile.shards.example) —
  see the note on `RELAY_SHARD_URLS` in the advanced table below before you
  reach for this.
- **What Bivy self-hosting does *not* include:** [faq.md](faq.md).

---

## Environment variable checklist

This list is derived directly from what `services/control-plane/src` and
`services/relay/src` actually read from `process.env` — not from another doc —
and cross-checked against what `deploy/docker-compose.yml` actually forwards
into each container. A variable set in `deploy/.env` only reaches a container
if that container's `environment:` block in `docker-compose.yml` references it;
otherwise it's inert no matter what you put in the file.

### Written for you by `deploy/self-host.sh` (do not need to touch)

| Variable | Value written | What it does |
| --- | --- | --- |
| `NODE_ENV` | `production` | Flips on both services' production safety checks: the control plane refuses to boot without `DATABASE_URL`, a non-default `RELAY_SECRET`, and (if `STRIPE_SECRET_KEY` is set) a `STRIPE_WEBHOOK_SECRET`; the relay refuses to boot with the default `dev-relay-secret`. |
| `PUBLIC_CONTROL_PLANE_URL` | `https://<app-domain>` | The control plane's own public URL. Used to build the GitHub OAuth `redirect_uri` and magic-link URLs — it must byte-match your real domain or GitHub sign-in and email links break. |
| `RELAY_PUBLIC_URL` | `wss://<relay-domain>` | The public `wss://` address handed to nodes and phones in relay tickets and pairing QR codes. |
| `DISABLE_DEV_LOGIN` | `1` | Disables the unauthenticated dev sign-in endpoint. Belt-and-suspenders: `NODE_ENV=production` already disables dev login and refuses to boot at all if `ALLOW_DEV_LOGIN=1` is set. |
| `ENFORCE_ENTITLEMENTS` | `0` | Self-host default: there's no paid tier here, so nothing is gated — push notifications, etc. work for every signed-in account. **Note:** `docker-compose.yml` currently only forwards `ENFORCE_ENTITLEMENTS` into the **relay** container's environment, not the control plane's — harmless at the `0` default, but if you set it to `1` to gate the control plane too, add it to the `control-plane` service's `environment:` block yourself. |
| `RELAY_SECRET` | random, `openssl rand -base64 48` | Shared control-plane↔relay secret used to mint and verify relay tickets. Rotate both services together — see [self-host.md § Secret rotation](self-host.md#secret-rotation). |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `bivy_control_plane` / `bivy` / random, `openssl rand -base64 32` | Postgres role and database for the **bundled** `postgres` container. `docker-compose.yml` builds `DATABASE_URL` for the control plane from these three at container-start time — don't set `DATABASE_URL` directly in `deploy/.env` in this mode; it isn't read from there. To use a **managed/hosted** Postgres instead (DigitalOcean, Render, Neon, …), layer `deploy/docker-compose.hosted-db.yml` and set `DATABASE_URL` directly — see [self-host.md § Using a managed/hosted Postgres](self-host.md#using-a-managedhosted-postgres). |

### Left blank — fill in only for features you want

`deploy/self-host.sh` writes these as empty keys in `deploy/.env`; the
services run fine without them, just without the feature.

| Variable(s) | Feature | Notes |
| --- | --- | --- |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Magic-link email sign-in | Without this *and* without GitHub OAuth configured below, nobody can sign in at all — dev login is off in production and there's no other login path. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | "Sign in with GitHub" | See [github-oauth-setup.md](github-oauth-setup.md), now parameterized for self-hosted domains. |
| `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` | Web push notifications | Generate with `npx web-push generate-vapid-keys`. Push is silently disabled until **both** are set. Older `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` names are still read as a fallback if you have them from an older setup. |
| `WEB_PUSH_SUBJECT` | Push contact address | The `mailto:` (or `https:`) subject required by the Web Push protocol. `deploy/self-host.sh` defaults it to `mailto:admin@<app-domain>`; falls back to `mailto:support@bivy.sh` in code if unset entirely. |
| `BIVY_GITHUB_BOT_MENTION` | Work-queue `@mention` trigger word | Defaults to `bivy` if unset. Not pre-seeded in `deploy/.env` by the script — add it yourself to change the mention handle (e.g. if `bivy` collides with another bot in your org). |

### Advanced / relay tuning (optional; not written by `deploy/self-host.sh`)

| Variable | Code default | Wired into `deploy/docker-compose.yml`? |
| --- | --- | --- |
| `RELAY_MAX_FRAME_BYTES` | 262144 (256 KiB) | Yes — compose sets it to `1048576` (1 MiB) unless overridden. |
| `RELAY_MAX_CLIENT_MESSAGES_PER_MINUTE` | 600 | Yes — compose sets `600`. Per-minute message cap on phone/browser sockets; keep it well above a normal session's burst or the app shows "Rate limit exceeded". |
| `RELAY_MAX_MESSAGES_PER_MINUTE` (legacy, deprecated) | none (fallback only) | No longer set by compose. Only used as a fallback for the client limit when `RELAY_MAX_CLIENT_MESSAGES_PER_MINUTE` is unset; explicitly ignored for node sockets. |
| `RELAY_MAX_NODE_MESSAGES_PER_MINUTE` | 6000 | **No** — same as above. Agent sessions can legitimately stream hundreds of events/minute; don't reuse the legacy client limit for nodes. |
| `RELAY_MAX_CONNECTIONS_PER_IP` | 50 | Yes. |
| `RELAY_IDLE_TIMEOUT_MS` | 120000 | Yes. |
| `RELAY_MAX_BUFFERED_BYTES` | 16777216 (16 MiB) | **No.** High-water mark before the relay evicts a slow socket rather than buffering unboundedly. |
| `RELAY_SHARD_URLS` | falls back to the single `RELAY_PUBLIC_URL` | **No** — read by the control plane (`services/control-plane/src/relay-shards.ts`), but neither `docker-compose.yml` nor `docker-compose.shards.example.yml` sets it on the `control-plane` container. Wire it in yourself alongside the shards override, or sharding silently no-ops back to one relay. |
| `RELAY_SHARD_ID` | unset | Only set by `docker-compose.shards.example.yml`, for observability (`/healthz`, `/metrics`) — it doesn't affect routing. |
| `LINK_GRANT_TTL_MS` | 2592000000 (30 days) | **No.** TTL for a device-linking grant minted from a pairing QR. |
| `DATABASE_POOL_MAX` | 10 | Yes — per control-plane instance. Keep `instances × DATABASE_POOL_MAX` under Postgres's `max_connections` if you ever run more than one control-plane replica. |

`PORT` (4400 for the control plane, 4500 for the relay) and the relay's
internal `CONTROL_PLANE_URL` (hardcoded to `http://control-plane:4400`, the
Docker network hostname) are also read from the environment but are fixed by
`docker-compose.yml`'s networking — there's no reason to override either one
in a Compose deployment.
