# Self-host with Kamal

Run Bivy's web app, control plane, relay and Postgres on your own server with
[Kamal](https://kamal-deploy.org). Kamal installs Docker on the server if it's
missing, gets TLS certificates from Let's Encrypt, and swaps containers only
once the new one is healthy. Your agents still run on the Machines you connect
afterwards.

Prefer one command on the server itself? The
[Compose installer](self-host-quickstart.md) runs the same images.

## What you need

- A Linux server you can SSH into as root (or as a user that can already run Docker),
  AMD64 or ARM64, with **2 GB RAM** and ports **80** and **443** free.
- A DNS name, e.g. `bivy.example.com`, pointing at it.
- Kamal 2 (`gem install kamal`; tested with 2.12), Docker and a checkout of this
  repository on your computer.

No container registry account is needed: Kamal runs a registry on your computer
and the server pulls from it through the SSH connection.

## 1. Settings and secrets

From the repository root, write `deploy/kamal/.env` (git-ignored) once:

```bash
cat > deploy/kamal/.env <<EOF
BIVY_HOST=203.0.113.10
BIVY_DOMAIN=bivy.example.com
BIVY_VERSION=v0.20.0
BIVY_RELAY_SECRET=$(openssl rand -hex 32)
BIVY_POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF
```

`BIVY_VERSION` is the release you run; pin it, and change it to upgrade. Set
`BIVY_ARCH=arm64` for an ARM server and `BIVY_SSH_USER` if you don't deploy as
root. Keep a copy of the two secrets somewhere safe: the database needs the same
password on every deploy.

## 2. Deploy

```bash
set -a; . deploy/kamal/.env; set +a
kamal setup -c deploy/kamal/deploy.yml         # Postgres, control plane, web app
kamal setup -c deploy/kamal/deploy.relay.yml   # relay, at wss://bivy.example.com/relay
```

## 3. Sign in

```bash
kamal owner-login -c deploy/kamal/deploy.yml
```

This prints a single-use sign-in link, valid for 15 minutes, for the server's
local owner account. Open it, then connect a Machine from the app. Run it again
whenever you need a new link.

## Upgrading

Change `BIVY_VERSION` in `deploy/kamal/.env`, then:

```bash
set -a; . deploy/kamal/.env; set +a
kamal deploy -c deploy/kamal/deploy.yml
kamal deploy -c deploy/kamal/deploy.relay.yml
```

To go back, `kamal app containers -c deploy/kamal/deploy.yml` lists earlier
versions and `kamal rollback <version> -c deploy/kamal/deploy.yml` returns to one.

## How it fits together

| | Kamal app | Serves |
|---|---|---|
| `deploy/kamal/deploy.yml` | `bivy` | `https://<domain>/`: control plane and web app. Postgres runs as its accessory (`bivy-postgres`, data in a volume on the server). |
| `deploy/kamal/deploy.relay.yml` | `bivy-relay` | `wss://<domain>/relay`: kamal-proxy strips `/relay` and passes the WebSocket stream through unbuffered. |

Both images are the published `ghcr.io/bivysh/bivy-control-plane` and
`ghcr.io/bivysh/bivy-relay` at `BIVY_VERSION`. Kamal only adds its `service`
label on top (`deploy/kamal/Dockerfile.*`), so what runs is exactly the release
you named. Bivy isn't built from source here.

Secrets are read from your environment through `deploy/kamal/secrets`, which holds
no values. Point them at a password manager with Kamal's `kamal secrets`
helpers if you prefer.

## Optional

Add these to `deploy/kamal/.env` and redeploy the control plane:

| Variable | Turns on |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | GitHub sign-in ([setup](github-oauth-setup.md)) |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Email sign-in links |
| `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` | Push notifications (`npx web-push generate-vapid-keys`) |
| `HOSTED_CREDENTIAL_KEY` | Encrypted credentials for [offline automations](self-host.md#offline-automations-encrypted-credential-storage) (`openssl rand -base64 32`) |

Live app previews through the relay need a wildcard preview domain
(`RELAY_PREVIEW_ORIGIN`); see [apps](apps.md). For backups, restores and the security
boundary, the [self-host reference](self-host.md) applies unchanged.
