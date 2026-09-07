# Deploy Bivy anywhere

**Two public images, a Postgres database, and environment variables.** There is
no requirement for Compose, Caddy, Kamal, a particular cloud, or a private registry.
The same images run on your own server or a hosted container platform.

| Component | Image / dependency | Default port | Health endpoint |
| --- | --- | --- | --- |
| Control plane + web/PWA | `ghcr.io/bivysh/bivy-control-plane:<version-or-full-SHA>` | 4400 | `/readyz` (includes DB); `/healthz` (process only) |
| WebSocket relay | `ghcr.io/bivysh/bivy-relay:<same-version-or-full-SHA>` | 4500 | `/healthz` |
| Database | Postgres 16, bundled or managed | 5432 | Provider-specific |

Bivy images support Linux AMD64 and ARM64 and pull anonymously. Pin **both to the
same published release or full commit SHA**; don't use a moving `latest` tag for
production. The control-plane image includes the PWA—there is no frontend build
or separate web service to deploy. The browser owner-setup flow described below
requires images from a release containing this feature; older releases lack it.

## 1. Create a database and two container services

Use any platform that can run long-lived containers and route HTTPS/WebSockets.
Use the images' default commands. Point public endpoints at the correct container
ports (or set `PORT` to your platform's assigned port).

- Allocate at least 512 MB to each Bivy service as a starting point, plus database
  capacity. Allow startup time for initialization and gate traffic on readiness.
- The platform's HTTPS ingress can handle certificates; a server you operate needs
  an HTTPS reverse proxy. **Caddy is optional**, not part of the application.
- Give the two services their own endpoints, such as `app.example.com` and
  `relay.example.com`. Platform-provided HTTPS domains also work. With an existing
  path-aware proxy, `/relay/*` can forward to the relay with `/relay` stripped.
- Keep the relay **always on** and enable WebSocket upgrades. Provider connection
  timeouts may cause reconnects. Do not use request-only/serverless runtimes.
- Start with **one relay instance**. Randomly distributing sockets across multiple
  relay replicas breaks room routing; multi-relay deployments need explicit
  shard routing, not ordinary replica load balancing.
- The control plane needs network access to Postgres; the relay needs access to
  the control plane. Clients and Machines need access to both public endpoints.
- Bivy services need no persistent application disk: Postgres owns durable state.
  Keep normal temporary/runtime filesystem access available. Back up your database
  and deployment secrets. Agent workspaces live on the Machines, not these services.

Provision services without exposing an unconfigured application, set their final
public URLs, then deploy. Generated hostnames are fine; update the environment
once those names are known. Bivy does not guess platform service names or call
provider APIs.

## 2. Configure the environment

Generate **two different secrets** locally (or with your platform's secure secret
generator). No SSH or shell on the deployed service is required:

```bash
openssl rand -hex 32 # RELAY_SECRET: put the same value on both services
openssl rand -hex 32 # SELF_HOST_SETUP_TOKEN: control plane only
```

Store them in your platform's runtime secret settings, never image build args or
frontend variables. Generic copyable files are available:

- [`deploy/control-plane.env.example`](../deploy/control-plane.env.example)
- [`deploy/relay.env.example`](../deploy/relay.env.example)

### Control plane

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Your Postgres connection URL, including the provider's TLS settings |
| `RELAY_SECRET` | First random secret, shared with the relay |
| `PUBLIC_CONTROL_PLANE_URL` | Public HTTPS origin of the control-plane/web service |
| `RELAY_PUBLIC_URL` | Public relay URL using `wss://` |
| `DISABLE_DEV_LOGIN` | `1` (never enable development login for deployment) |
| `SELF_HOST_SETUP_TOKEN` | Second random secret, authorizing browser owner setup |
| `PORT` | Optional; default `4400` |

### Relay

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `RELAY_SECRET` | Exactly the same first secret as the control plane |
| `CONTROL_PLANE_URL` | Reachable control-plane URL: stable internal HTTP address or public HTTPS origin |
| `PORT` | Optional; default `4500` |

Public URLs are where browsers/Machines connect; private service names belong only
in the relay's `CONTROL_PLANE_URL` or the database connection. Public control-plane
URLs should be origins, not subpaths. Preserve `/relay` in `RELAY_PUBLIC_URL` if your
reverse proxy uses path routing. Never expose Postgres publicly just for Bivy.

## 3. Set up owner access in the browser

Open the web service's public HTTPS URL. The sign-in screen detects available
authentication methods. For a new owner setup:

1. Paste `SELF_HOST_SETUP_TOKEN` from your deployment secret settings.
2. Choose and confirm a password (at least 12 characters; maximum 256 UTF-8 bytes).
3. Save it in your password manager and continue into the app.

This is **not first-visitor-wins registration**: knowing the deployment secret is
required before any owner password can be created. The password is salted and
hashed with scrypt in Postgres. Setup-token hashes are permanently marked spent
in that same database, atomically across replicas. Restarts and token changes do
not make a spent token usable again. Password sign-in uses ordinary, revocable
account sessions and is rate-limited; it works directly in installed PWAs too.

After setup, remove `SELF_HOST_SETUP_TOKEN` from your runtime environment and
redeploy if desired. Ordinary password sign-in continues without it. An unused
setup secret has no automatic expiry; remove it if you abandon setup. Never share
it in a URL, screenshot, source file, or support ticket.

The default identity is `owner@self-host.invalid`, a **local account**, not a
verified external email or a platform-wide administrator role. Set optional
`SELF_HOST_OWNER_EMAIL` before first setup if you deliberately want another
identity. The browser cannot claim an arbitrary email. Once configured, password
recovery preserves the existing owner account rather than switching identities.

### Password recovery, without a server shell

Generate a **new** random `SELF_HOST_SETUP_TOKEN`, set it in your deployment
settings, and redeploy. Reload the sign-in page, expand **Forgot your password?**,
choose **Reset owner password**, and supply the new secret and password.

Each setup secret works once, including for resets. Rotating back to an old secret
cannot re-arm it. Resetting revokes existing account sessions; node enrollment
tokens and device pairing keys are separate and are not automatically revoked.
After suspected compromise, also review/remove untrusted Machines and paired
devices. An account deletion preserves spent-token markers; recovery then needs
a new token. Restoring an old database backup also restores its historical auth
state—rotate deployment secrets and review access after a restore.

## 4. Connect a Machine

In the signed-in app, choose **Connect a Machine → Auto sign-in**. Copy the install
command and run it on the Mac/Linux computer where agents should execute. It
installs prerequisites, targets your control plane/relay, and enrolls using your
account. Treat the copied token as a secret and only use it on trusted computers.
Complete the selected agent's authentication, then start a session.

The web app and relay do not execute agents themselves. Hosting those services is
not a substitute for connecting an agent Machine.

## Check the deployment

- Control-plane `/readyz`: HTTP 200 once Postgres is reachable.
- Control-plane `/me` without a bearer: HTTP **401**, not 200.
- Relay `/healthz`: HTTP 200 with `ok: true`.
- Open the real web app over HTTPS, complete sign-in, connect a Machine, and test
  a session. Container health alone does not prove DNS/TLS/WebSockets work.

Upgrades redeploy the matching image pair while preserving database and secrets.
Use your platform's deployment health gates, logs and rollback controls. Take a
consistent database backup/snapshot before upgrades; application-image rollback
is not automatically a database-schema rollback.

## Optional integrations

- **GitHub/email sign-in:** configure GitHub OAuth or Resend instead of, or in
  addition to, owner sign-in. See [GitHub OAuth](github-oauth-setup.md).
- **Push notifications:** set `WEB_PUSH_VAPID_PUBLIC_KEY`,
  `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT`; generate the pair with
  `npx web-push generate-vapid-keys` on your computer. Bare images do not generate
  or persist deployment secrets for you.
- **Offline credential storage:** explicitly configure `HOSTED_CREDENTIAL_KEY`
  and back it up with the database; see [operations](self-host.md).
- **Own VPS, ready-made stack:** the [Compose quickstart](self-host-quickstart.md)
  automates Postgres, proxy/TLS, secrets, and health checks. It is a convenience
  wrapper around these exact images, not a different product or required runtime.

No vendor templates, private registry credentials, Kamal, or Bivy Cloud account
are necessary. Self-hosting remains community-supported beta infrastructure; you
own hosting costs, security, backups, updates and recovery.
