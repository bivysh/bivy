# Deploying the control plane + relay (real `wss://`)

This is the "as real as possible" topology: phone → public relay → your PC,
over real TLS, working from cellular (true NAT traversal).

```
        phone (cellular)                     your PC (node)
              │                                    │
   https://app.example.com                      │ dials outbound
              │  wss://relay.example.com  ◄─────┘
              ▼                │
        ┌───────────┐   ┌──────────────┐
        │   Caddy    │──▶│ control plane │  (accounts, registry, grants)
        │ auto-TLS   │   └──────────────┘
        │            │──▶│ relay         │  (opaque E2E frame routing)
        └───────────┘    └──────────────┘
```

For the fully numbered walkthrough, see
[`../docs/self-host-quickstart.md`](../docs/self-host-quickstart.md). This page
is the shorter reference for the files in this directory.

## 1. Provision a server

- Create a small Ubuntu VPS (1 vCPU / 1 GB is enough to start).
- Add your SSH key to the server.
- Point two DNS A/AAAA records at the VPS IP:
  - `app.example.com` (control plane + remote web client)
  - `relay.example.com` (relay)
- Open ports 80 and 443 (Caddy needs both for the HTTP→HTTPS redirect and
  Let's Encrypt).
- Install Docker + the Compose plugin:

```bash
ssh root@YOUR_SERVER_IP
apt-get update
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## 2. Get the repo onto the server

`deploy/self-host.sh` resolves its own repo root, so it needs a real checkout,
not just the `deploy/` directory copied over.

```bash
mkdir -p /opt/bivy && cd /opt/bivy
git clone https://github.com/bivysh/bivy.git .
```

## 3. Deploy

One command builds and starts the stack:

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

It writes `deploy/.env` and `deploy/Caddyfile` on first run (generating a random
`RELAY_SECRET` and Postgres password), then starts control-plane + relay + Caddy,
plus a bundled Postgres. Caddy obtains Let's Encrypt certificates automatically,
so you get real `https://` and `wss://` with no extra steps. Re-running the
script rebuilds and restarts in place, keeping the existing `.env` and Caddyfile.

To use a managed/hosted Postgres (DigitalOcean, Render, Neon, Supabase, RDS, …)
instead of the bundled container, set `DATABASE_URL` (keep the `sslmode` your
provider gives you):

```bash
DATABASE_URL=postgres://user:pass@host:25060/db?sslmode=require \
  bash deploy/self-host.sh app.example.com relay.example.com
```

Fill in the optional feature settings in `deploy/.env` when you want them —
login email (`RESEND_API_KEY`), GitHub OAuth, or web push — then re-run the
script to apply them.

Or run Compose directly if you'd rather manage `deploy/.env` and
`deploy/Caddyfile` yourself:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --remove-orphans
```

Check logs:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f control-plane relay postgres caddy
```

See [`../docs/self-host.md`](../docs/self-host.md) for backups, restore drills,
secret rotation, and health checks.

## 4. Connect your PC as a node

```bash
# in the repo root, on your PC
npm run relay:setup -- \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --email you@example.com
npm run dev
```

The daemon dials the relay on start (`[relay] connected`).

## 5. Link your phone

In the PC web UI sidebar → **Link remote device** → scan the QR with your phone
(works from anywhere afterwards, including cellular). The phone opens
`https://app.example.com/#…`, connects through the relay, and controls the node.
The session is end-to-end encrypted; the relay only sees ciphertext.

## Zero-infra alternative: Tailscale

Identical code, no VPS/domain. Install Tailscale on the PC, run the control
plane + relay locally, and use the PC's Tailscale IP/hostname in `relay:setup`
(`--relay ws://<tailscale-host>:4500 --control-plane http://<tailscale-host>:4400`).
Put your phone on the same tailnet. You lose public TLS but get real
cross-network NAT traversal for testing.

## What this deploy includes

- **Postgres** for control-plane metadata (bundled container, or a managed
  database via `DATABASE_URL`). The control plane auto-creates its tables on
  startup.
- **Entitlement enforcement off** (`ENFORCE_ENTITLEMENTS=0`): every feature is
  on for every account on a self-hosted stack, so there is no billing to
  configure.
- **Device pairing over an X25519 handshake** — the room key is delivered
  ECDH-wrapped over the relay, not embedded in the QR — with per-device
  revocation. See [`../docs/security-model.md`](../docs/security-model.md).

Self-hosting is community best-effort and unsupported: you own TLS, backups,
upgrades, and hardening. See [`../docs/self-host.md`](../docs/self-host.md).
