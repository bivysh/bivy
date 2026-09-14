# Optional VPS self-host quickstart

**Using a container platform or your own deployment tooling?** Start with
[Deploy Bivy anywhere](deploy-images.md). It uses the same images and provides
browser owner setup without SSH. This guide is the optional Compose convenience
path for a bare VPS.

Run Bivy's web app, control plane, relay, and database on your own Linux server.
**One domain, one installer, no GitHub OAuth app or email provider required.**
Your agents still run on Machines you connect afterward.

## Before you start

- A Linux VPS: AMD64 or ARM64, **2 GB RAM recommended**, 1 vCPU minimum.
- One DNS record, such as `bivy.example.com`, pointing at its public IP.
  Only add an AAAA record if IPv6 actually reaches this server.
- Inbound TCP ports **80 and 443** open and unused by another web server.
- SSH access with Docker administrative privileges. The guided Docker install
  supports Debian/Ubuntu and requires root; other distributions need Docker
  Engine and the Compose v2 plugin installed first.

You still need to provision the server and configure DNS yourself. This is not
a cloud-provider marketplace deployment button.

## 1. Install on the server

SSH into the VPS, then run:

```bash
curl -fsSL https://github.com/bivysh/bivy/releases/latest/download/install.sh | bash -s -- bivy.example.com
```

The installer offers to install Docker when needed. To explicitly authorize that
step on a fresh Debian/Ubuntu VPS, run as root with `bash -s -- --install-docker
bivy.example.com` on the right-hand side of the pipe.

Prefer to inspect it first?

```bash
curl -fsSL https://github.com/bivysh/bivy/releases/latest/download/install.sh -o install-bivy.sh
less install-bivy.sh
bash install-bivy.sh bivy.example.com
```

**Release availability:** this path requires a stable release containing the new
self-host bundle. Older releases do not have these assets; until the first such
release is published, use the source-checkout path below.

The installer checks prerequisites, downloads a checksummed release bundle,
pins public service images to that release's exact commit, generates secrets and
push keys, and starts Postgres, control plane, relay, and Caddy. Caddy handles TLS.
The relay shares your domain at `wss://bivy.example.com/relay`.

Success is printed only after container health and public HTTPS checks pass.
No Node.js, repository checkout, or application build is required on the VPS.
Checksums detect corruption; HTTPS and the GitHub release are the authenticity
trust boundary.

Files go in `/opt/bivy` when run as root, otherwise `~/bivy-self-host`. Override
with `BIVY_SELF_HOST_DIR=/your/path` on the **bash side** of the pipe. Select a
published version with `BIVY_SELF_HOST_VERSION=vX.Y.Z` there too.

## 2. Open your private sign-in link

The installer prints a **single-use link valid for 15 minutes**. Open it in your
browser to sign into the local `owner@self-host.invalid` account. This is a local
account identity, not a verified external email address or a platform-wide admin
role. The link is generated through server-shell access; there is no public
“claim this server” endpoint and development login remains disabled.

Treat the link as a secret: do not paste it into tickets, logs, or shared chats.
To sign in again, or recover after an expired link, run on the VPS:

```bash
cd /opt/bivy # or your installation directory
bash deploy/manage.sh login
```

If you want routine sign-in without SSH, configure GitHub OAuth or Resend later
as described below. Use the same account identity if you intentionally want to
link that verified email to your owner account; changing the owner identity alone
selects a different account, it does not migrate Machines or sessions.

## 3. Connect a Machine

In the signed-in web app, choose **Connect a Machine** and copy the **Auto
sign-in** command. Run it on the Mac or Linux computer where your agents should
run. It installs Bivy and prerequisites, points it at your server, and uses your
existing account—no second OAuth/email setup required.

The command includes an account token: only run it on a computer you trust.
Finish agent authentication in setup, then start your first session in the web
app. **Regular sign-in** requires a separately configured GitHub/email provider;
use Auto sign-in for the default server-shell owner account.

## Everyday operations

Run from the installation directory:

```bash
bash deploy/manage.sh status # container health
bash deploy/manage.sh logs   # recent logs (review/redact before sharing)
bash deploy/manage.sh check  # public HTTPS checks
bash deploy/manage.sh login  # private recovery/sign-in link
bash deploy/manage.sh backup # bundled DB + secrets + proxy config
bash deploy/manage.sh update # backs up bundled DB, then installs a stable release
```

Backups contain secrets. Copy them to secure off-server storage and test restores.
Updates are not transactional database rollbacks. Managed databases need a
provider snapshot and a separate secret/config backup before updating; acknowledge
that with `BIVY_MANAGED_BACKUP_CONFIRMED=1`. See [operations](self-host.md).

## Advanced options

### Use a source checkout

With Docker Engine and Compose already installed:

```bash
git clone https://github.com/bivysh/bivy.git
cd bivy
bash deploy/self-host.sh bivy.example.com
```

This uses the exact checkout's public images, so wait for its service-image CI
publication. An unpublished branch commit cannot be pulled. To run modified
source, use the build overlay in [self-host.md](self-host.md#image-pins-and-source-builds).
Source checkouts update by checking out a desired release and rerunning setup,
not by replacing them with a bundle.

### Keep separate app and relay domains

Pass both hostnames to either installer:

```bash
bash deploy/self-host.sh app.example.com relay.example.com
```

Existing `.env`, custom Caddyfiles, and data volumes are preserved. Changing the
arguments does not migrate domains: update `.env` and `Caddyfile` together
explicitly. Existing installations are not automatically given owner login.

### Managed Postgres

On the first run, set `DATABASE_URL` on the bash side of the pipe (or when
invoking `self-host.sh`):

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require' \
  bash deploy/self-host.sh bivy.example.com
```

Compose v2.24+ is required. Subsequent operations remember the managed DB mode.

### Optional browser owner password

Set `SELF_HOST_SETUP_TOKEN` to a separate random value (`openssl rand -hex 32`)
in `deploy/.env` and rerun setup. Open the app's main URL without the shell login
link to set a password. The token is usable once; the password works afterward
even if you remove the token. Recovery needs a new token and redeployment.
See [portable owner access](deploy-images.md#3-set-up-owner-access-in-the-browser).

### Optional external sign-in

Configure either pair in `deploy/.env` and rerun setup:

```env
# GitHub OAuth — docs/github-oauth-setup.md
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...

# Or Resend with a verified sender
RESEND_API_KEY=...
AUTH_EMAIL_FROM=Bivy <login@example.com>
```

To use a real, verified email for the owner from the outset, pass
`SELF_HOST_OWNER_EMAIL=you@example.com` on the first invocation. Only a server
administrator can issue its shell sign-in link. Set `SELF_HOST_OWNER_EMAIL=`
explicitly on the first invocation if you want external-provider-only login;
at least one complete provider configuration is then required.

Offline credential storage remains explicit opt-in; follow
[self-host.md](self-host.md#offline-automations-encrypted-credential-storage).

Self-hosting is community-supported beta infrastructure. You own server security,
backup storage, upgrades, monitoring, and recovery—not just initial installation.
