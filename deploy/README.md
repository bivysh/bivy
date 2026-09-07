# Self-host Bivy

**The portable interface is two public images + Postgres + environment variables.**
Deploy them on any server or long-running container platform. The control-plane
image includes the web app; your platform or reverse proxy supplies HTTPS.
Browser owner setup needs no SSH or external authentication provider.

Start with [Deploy Bivy anywhere](../docs/deploy-images.md),
[`control-plane.env.example`](control-plane.env.example) and
[`relay.env.example`](relay.env.example). There are no provider-specific templates.

The Compose installer below is an **optional VPS convenience**: it runs those
same images and automates Postgres, Caddy/TLS, generated secrets and push keys.

## Optional VPS release install

Point a DNS record at your VPS and open TCP ports 80/443, then:

```bash
curl -fsSL https://github.com/bivysh/bivy/releases/latest/download/install.sh | bash -s -- bivy.example.com
```

Requires a release containing the self-host bundle (older releases lack it).
Docker installation is offered on Debian/Ubuntu with explicit permission and root
access. On other Linux distributions, install Docker Engine + Compose first.
2 GB RAM is recommended. The bundle is checksummed and pins prebuilt AMD64/ARM64
service images to the release SHA; no Node.js or source build is needed on the VPS.

Open the private 15-minute link printed after readiness checks pass, then choose
**Connect a Machine → Auto sign-in** in the web app. Treat both the link and the
machine enrollment command as secrets.

## Source checkout / existing Docker host

```bash
bash deploy/self-host.sh bivy.example.com
# Optional separate relay hostname:
bash deploy/self-host.sh app.example.com relay.example.com
```

Source checkouts default to the exact HEAD image tag: its service-image publication
must have completed. Override with `BIVY_IMAGE_TAG=X.Y.Z` for a published release.
For modified source, layer `docker-compose.build.yml` and build it yourself.

The helper preserves `.env`, custom Caddyfiles, and data. Changing the domain
arguments alone does not migrate a deployment. On first run, set `DATABASE_URL`
to use managed Postgres (Compose v2.24+); later operations remember this mode.

## Operations

From the installation directory (`/opt/bivy` for root, otherwise
`~/bivy-self-host`, overridable with `BIVY_SELF_HOST_DIR`):

```bash
bash deploy/manage.sh login   # another single-use owner sign-in link
bash deploy/manage.sh status
bash deploy/manage.sh logs
bash deploy/manage.sh check
bash deploy/manage.sh backup  # DB + secrets/config; copy securely off-server
bash deploy/manage.sh update  # release bundles only; backs up bundled DB first
```

Source checkouts update by checking out a desired release and rerunning setup.
Managed DB updates require a provider snapshot and a separate configuration backup.
There is no automatic schema rollback.

See [the numbered quickstart](../docs/self-host-quickstart.md) and
[the operations reference](../docs/self-host.md) for external sign-in, backups,
restore, secret rotation, and the security boundary. Self-hosting is
community-supported beta software; you own its operation and server security.
