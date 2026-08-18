# Self-host quickstart

This guide takes a new Linux VPS to a running Bivy control plane, relay, and web
app — the AGPL control-plane and relay stack from this repo (Bivy Cloud layers
billing on top of it in a private repository). Self-hosting
is community-supported (no SLA; best-effort help via GitHub issues — you own
TLS, backups, upgrades, and hardening) and intended for people comfortable
operating their own server. If you only want to run agents on your computer, use
the regular [quickstart](quickstart.md) instead — the CLI needs no server at all.

## Prerequisites

- A Linux VPS with at least 1 vCPU and 1 GB RAM
- Two DNS A/AAAA records pointing to it:
  - `app.example.com` for the web app and control plane
  - `relay.example.com` for the relay
- Ports 80 and 443 open

## 1. Install Docker

The server needs Docker Engine and the Compose plugin. On Ubuntu:

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

## 2. Clone Bivy

```bash
mkdir -p /opt/bivy && cd /opt/bivy
git clone https://github.com/bivysh/bivy.git .
```

## 3. Generate configuration

Replace the example domains with your DNS names:

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

The command creates a private `deploy/.env`, generates relay and database
secrets, and configures Caddy for automatic TLS. On the first run it stops before
starting Docker so you can configure sign-in.

## 4. Configure sign-in

Choose one method in `deploy/.env`:

```env
# Email magic links
RESEND_API_KEY=...
AUTH_EMAIL_FROM=Bivy <login@app.example.com>
```

Or configure GitHub OAuth:

```env
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

For GitHub, follow [github-oauth-setup.md](github-oauth-setup.md) and use
`https://app.example.com/auth/github/callback` as the callback URL.

## 5. Start Bivy

Run the deployment command again:

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

This starts Postgres, the control plane, relay, and Caddy. Open
`https://app.example.com` in a browser.

To use a managed Postgres database instead of the bundled container, provide its
connection URL on the first run:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require' \
  bash deploy/self-host.sh app.example.com relay.example.com
```

## 6. Connect a node

On the computer where your agents run:

```bash
# GitHub sign-in:
bivy relay:setup \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --github

# For email sign-in, replace --github with --email you@example.com.
bivy start
```

Run `bivy link` to pair a phone or `bivy open` to open the web app.

For backups, upgrades, secret rotation, and the security model, read
[self-host.md](self-host.md).
