# Deploying the control plane + relay (real `wss://`)

This is the "as real as possible" topology: phone → public relay → your PC,
over real TLS, working from cellular (true NAT traversal).

```
        phone (cellular)                     your PC (node)
              │                                    │
   https://app.bivy.sh                          │ dials outbound
              │  wss://relay.bivy.sh  ◄─────────┘
              ▼                │
        ┌───────────┐   ┌──────────────┐
        │   Caddy    │──▶│ control plane │  (accounts, registry, grants)
        │ auto-TLS   │   └──────────────┘
        │            │──▶│ relay         │  (opaque E2E frame routing)
        └───────────┘    └──────────────┘
```

## 1. Provision Hetzner

- Create a small Ubuntu VPS (1 vCPU / 1 GB is enough for staging).
- Add your SSH key to the server.
- Point two DNS A records at the VPS IP:
  - `app.bivy.sh` (control plane + remote web client)
  - `relay.bivy.sh` (relay)
- Install Docker + Compose on the server:

```bash
ssh root@YOUR_SERVER_IP
apt-get update
apt-get install -y ca-certificates curl gnupg rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Optional but recommended: create a deploy user. This setup uses `github`:

```bash
adduser github
usermod -aG docker github
mkdir -p /home/github/.ssh
cp /root/.ssh/authorized_keys /home/github/.ssh/authorized_keys
chown -R github:github /home/github/.ssh
```

## 2. First-time server config

The GitHub pipeline uploads code and renders `deploy/.env` / `deploy/Caddyfile` from GitHub Environment secrets/vars on every deploy. Create the app directory once during provisioning; the deploy workflow does not use `sudo`.

```bash
ssh root@YOUR_SERVER_IP
mkdir -p /opt/bivy
chown -R github:github /opt/bivy
```

Then continue as the deploy user:

```bash
ssh github@YOUR_SERVER_IP
cd /opt/bivy
```

Set the deploy values in GitHub **Environment: staging** secrets/vars. The pipeline overwrites `deploy/.env` and `deploy/Caddyfile` on the server each deploy.

Use strong secrets:

```bash
openssl rand -base64 48   # RELAY_SECRET
openssl rand -base64 32   # POSTGRES_PASSWORD
```

Caddy obtains Let's Encrypt certificates automatically, so you get real
`https://` and `wss://` with no extra steps.

## 3. Continuous deployment (optional)

Bivy does not ship a production deploy workflow in this repository. Deploying a
self-hosted control plane and relay is your own operation, and the shape of it
depends entirely on where you run it.

If you want CI-driven deploys, a workflow that does the following is enough:

1. run typechecks and the relay + remote-path e2e tests,
2. verify the target directory exists and is writable by the deploy user,
3. rsync (or `git pull`) the repo onto the host,
4. run `docker compose -f deploy/docker-compose.yml up -d --build`.

The secrets such a workflow needs are the same ones `deploy/.env` needs --
`RELAY_SECRET`, `POSTGRES_PASSWORD`, your domains, and whichever of the email,
OAuth, and Stripe values you actually use. Keep them in your CI provider's secret
store, never in the repository.

> Self-hosting is unsupported: no SLA, community best-effort via GitHub issues.
> You own TLS, backups, upgrades, and hardening.

## 4. Manual deploy command

On the server, from the directory you deployed into:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --remove-orphans
```

Check logs:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f control-plane relay postgres caddy
```

See `../docs/staging-ops.md` for backups, restore drill, and health checks.

## 5. Connect your PC as a node

```bash
# in the repo root, on your PC
npm run relay:setup -- \
  --control-plane https://app.bivy.sh \
  --relay wss://relay.bivy.sh \
  --email you@bivy.sh
npm run dev
```

The daemon dials the relay on start (`[relay] connected`).

## 6. Link your phone

In the PC web UI sidebar → **Link remote device** → scan the QR with your phone
(works from anywhere afterwards, including cellular). The phone opens
`https://app.bivy.sh/#…`, connects through the relay, and controls
the node. The session is end-to-end encrypted; the relay only sees ciphertext.

## Zero-infra alternative: Tailscale

Identical code, no VPS/domain. Install Tailscale on the PC, run the control
plane + relay locally, and use the PC's Tailscale IP/hostname in `relay:setup`
(`--relay ws://<tailscale-host>:4500 --control-plane http://<tailscale-host>:4400`).
Put your phone on the same tailnet. You lose public TLS but get real
cross-network NAT traversal for testing.

## Staging status

This deploy uses **Postgres** for control-plane metadata and is suitable for
staging the full hosted relay path. The control plane auto-creates its tables on
startup.

Still harden before real production use: real auth (magic-link/OAuth), Stripe
with signed webhooks, and rate limiting.
Device pairing now uses an X25519 handshake (the room key is delivered ECDH-
wrapped over the relay, not embedded in the QR) with per-device revocation — see
`../docs/security-model.md`.
