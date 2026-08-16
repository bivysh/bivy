# Self-host Bivy

This directory contains the single-server Docker Compose setup for Bivy's
control plane, relay, web app, Postgres database, and automatic TLS.

For a numbered walkthrough, see
[`../docs/self-host-quickstart.md`](../docs/self-host-quickstart.md).

## Prerequisites

- A Linux server with Docker and the Compose plugin
- Two DNS records pointing to the server:
  - `app.example.com` for the web app and control plane
  - `relay.example.com` for the relay
- Ports 80 and 443 open

## Start the stack

Clone the repository on the server and run:

```bash
git clone https://github.com/bivysh/bivy.git
cd bivy
bash deploy/self-host.sh app.example.com relay.example.com
```

The first run creates `deploy/.env`, generates the required secrets, and
configures `deploy/Caddyfile`. It stops before starting Docker until you add one
sign-in method to `deploy/.env`:

- `RESEND_API_KEY` and a verified `AUTH_EMAIL_FROM`, or
- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`

See [`../docs/github-oauth-setup.md`](../docs/github-oauth-setup.md) for GitHub
OAuth setup. Run the same command again after configuring sign-in. Caddy obtains
TLS certificates automatically.

To use a managed Postgres database instead of the bundled container:

```bash
DATABASE_URL='postgres://user:pass@host:5432/db?sslmode=require' \
  bash deploy/self-host.sh app.example.com relay.example.com
```

## Connect your computer

On the computer where Bivy and your agents run:

```bash
# Use --email you@example.com instead for email sign-in.
bivy relay:setup \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --github
bivy start
```

Run `bivy link` to pair a phone, or `bivy open` to open the hosted web app.

Self-hosting is community-supported. You are responsible for TLS, upgrades,
backups, and server security. See [`../docs/self-host.md`](../docs/self-host.md).
