# Session apps and views

Bivy apps group interfaces to what an agent is building. An app is **not** an
HTML document or a particular framework: it has named, typed views. Version 1
supports web and interactive terminal views. A future graphical-display provider
can add another view kind without introducing another app category.

## Publish from any agent

Write `bivy.app.json` in the project:

```json
{
  "version": 1,
  "name": "Accounting app",
  "views": [
    {
      "kind": "web",
      "name": "Website",
      "source": { "kind": "service", "port": 3000 }
    },
    {
      "kind": "terminal",
      "name": "Rails console",
      "command": "bin/rails",
      "args": ["console"]
    }
  ]
}
```

```sh
# Start the web server using your normal development workflow:
bin/rails server --binding 127.0.0.1 --port 3000

# From another terminal, or have the agent publish after starting the server:
bivy app publish bivy.app.json --session <session-id>
bivy app list --session <session-id>
bivy app remove <app-id> --session <session-id>
```

Inside an agent session, `--session` defaults to the same session environment used
by `bivy attach`. No per-agent adapter or special model tool is required.
`bivy app --help` describes the contract. The CLI prints JSON, including app and
view IDs. API callers can use the same `apps.publish/list/open/remove` commands.

Publishing adds a durable **Open app** button to the chat. You can also use the
session menu → **Apps**. Both open the same view selector. **Open preview** opens
a separate preview tab with a Bivy-owned **Back to chat** / **Reload** header.
If the browser blocks popups, a normal link is offered instead. **Back to chat**
closes the preview tab where permitted, otherwise navigates to the originating
session. Closing the view does not stop an external app server.

Web apps do not currently open inside the Bivy PWA itself. The preview tab hosts
a Bivy-owned shell, and the generated app is framed on a separate, same-site
origin. This keeps app code away from the header and avoids depending on
cross-site iframe cookies inside the PWA. Terminal views ask for confirmation,
then open inside Bivy's existing terminal with input, output, resizing and mobile
controls. Chat launchers survive reload, but opening a removed app or one cleared
by a machine restart reports that it needs republishing.

Publishing never starts terminal commands. Opening a terminal view starts its
program once; concurrent opens and subsequent opens reconnect to it. Once the
program exits, opening the view again starts a new instance. Closing the terminal
UI detaches; ending the terminal stops it. An exited app never silently becomes a
shell. Commands are executables plus argument arrays, not implicitly shell-parsed
strings. For shell syntax, explicitly choose a shell and `-c` arguments.

### Static sites

Replace the web source with:

```json
{ "kind": "static", "directory": "./dist" }
```

The CLI resolves directories relative to the manifest; direct API callers use
paths relative to the session workspace. The directory must be inside that
workspace and contain `index.html`. Bivy snapshots its bytes at publication, so
later edits do not silently change the published view. Publish again to update.
Hidden files and `node_modules` are excluded; symlinks and special files are
rejected. Limits: 25 MiB / 2,000 files per snapshot, 100 MiB total static data,
50 apps per node, and 8 views per app. Only publish a dedicated output directory,
not a source tree containing secrets.

Service views instead proxy a live HTTP server on IPv4 loopback. Ports below 1024
and Bivy's API/preview ports are reserved. Use your framework's host allowlist to
permit the preview hostname, configure its external HTTPS URL if required, and
keep the service bound to `127.0.0.1`. HTTP bodies and WebSocket upgrades are
forwarded without an app-specific adapter. Root-relative routes, forms, cookies,
and WebSocket connections can use the view's own origin; hardcoded localhost URLs
and absolute localhost redirects must be fixed in the application's configuration.
Long-lived HTTP streams time out after 60 seconds of inactivity. This initial
static server does not provide SPA fallback, range requests or directory listings.

## Automatic web preview delivery

On a linked machine, `bivy app publish` is sufficient: open the published app
from chat or the session menu. **Users and agents do not configure a preview
domain, DNS, certificates, ports, or tunnels.** The authenticated relay advertises
its preview endpoint and the node automatically connects outbound when a browser
requests a preview. The app gateway runs on private in-process streams, without
binding a network port. Static assets, forms, uploads, cookies and WebSocket/HMR
traffic follow the same path; generated applications need no Bivy adapter.

Disconnecting the machine closes active tunnels. On reconnection, delivery
recovers automatically; unexpired grants survive ordinary reconnects to the same
relay endpoint. Restarting the node still requires republishing ephemeral apps.
Older deployments without preview delivery report it unavailable; publishing
must not be described as a working preview until the deployment supports it.

### Bivy deployment responsibility (not user setup)

The deployment operator provisions one isolated wildcard HTTPS preview domain
per relay shard and routes it to that relay's existing HTTP/WebSocket listener:

```sh
RELAY_PREVIEW_ORIGIN='https://{app}.preview.example.net'
```

Preserve Host and WebSocket upgrade headers at the TLS proxy. Use a dedicated
registrable domain, separate from the Bivy UI and other authenticated services.
Each view and its trusted shell get distinct origins beneath that wildcard.
The relay derives a stable node-specific hostname suffix from the admitted node
identity; nodes cannot register or claim another node's hostname family.
No per-node DNS, certificate or ingress is required. The hosted Bivy deployment
must ship this infrastructure alongside the feature, rather than asking users
or agents to provide it. For a self-hosted deployment this is a single platform
installation step, not an app-publishing step.

Preview bytes use separate, bounded outbound WebSocket streams, not encrypted
session-frame payloads. Single-use ten-second stream tickets are delivered only
to the authenticated node and presented in request headers, never URLs. Streams
can reach only that node's app gateway, not arbitrary TCP addresses. Limits are
64 simultaneous pending/active streams per node and 1,024 per relay; stream
frames are limited to 64 KiB with bidirectional backpressure. Disconnection
cancels pending requests and active streams. Browser access remains protected
by the gateway's view-scoped grants, cookies and origin checks below.

### Optional direct gateway

Advanced/local-only deployments may bypass automatic relay delivery and expose
a dedicated gateway through their own TLS proxy or VPN. This is an explicit
operator override, **not required on linked user machines**. Configure the node
process (choose a port different from its API port):

```sh
BIVY_APPS_ORIGIN='https://{app}.preview.example.net'
BIVY_APPS_PORT=4318
# Only for a Bivy client origin different from the node's linked control plane:
# BIVY_APPS_RETURN_ORIGINS='https://my-bivy.example.org,http://localhost:5173'
```

`{app}` is replaced with a random **view** ID for app content and `view-<id>`
for the trusted preview shell. Both are covered by the same wildcard DNS and TLS
certificate. Each app view has its own origin, host-only preview cookie and storage;
its generated code cannot read or overwrite the cross-origin shell. Set up wildcard DNS and a wildcard TLS
certificate for `*.preview.example.net`; reverse-proxy that host family to
`127.0.0.1:4318` on the node. Preserve the original `Host` and WebSocket upgrade
headers. The gateway binds **only to loopback** and is disabled without
`BIVY_APPS_ORIGIN`. A TLS proxy must run on the same machine or securely reach
that loopback listener. Every node needs its own preview hostname family.

For example, the relevant Nginx configuration (provide your own certificate):

```nginx
# In the http block:
map $http_upgrade $preview_connection {
  default upgrade;
  '' close;
}

server {
  listen 443 ssl;
  server_name *.preview.example.net;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4318;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $preview_connection;
    proxy_read_timeout 3600s;
  }
}
```

**Use a dedicated registrable domain, separate from Bivy's UI, control plane and
other authenticated services.** Do not serve generated content on Bivy's origin,
and do not configure preview hosts as trusted node API origins. Sharing a parent
domain with an authenticated service can expose domain-scoped cookies. Bivy does
not provision DNS or certificates for this optional direct-gateway mode.

A paired client requests a one-use, one-minute launch grant through the normal
Bivy command channel. The grant is carried in a URL fragment (not access logs),
exchanged on the dedicated preview origin for a host-only Secure/HttpOnly cookie,
and removed from browser history before app content loads. The shell stores only
non-secret navigation metadata, never tickets or cookies. Its return-to-chat URL
comes from the authenticated client and must point to that session on the node's
linked client/control-plane origin (or an explicitly configured
`BIVY_APPS_RETURN_ORIGINS` origin), over HTTPS or loopback HTTP for development.
Arbitrary external return destinations are rejected. The cookie expires
after one hour and is stripped before forwarding to the app. Grants are scoped
to one view. Removing an app revokes grants and closes active gateway connections.
Reopen from Bivy after expiry. Launch links are bearer capabilities until redeemed;
do not share them.

The app iframe is sandboxed: scripts, forms, same-origin app storage, downloads
and sandboxed popups are allowed; top-level navigation is not. Upstream
`X-Frame-Options` and CSP `frame-ancestors` are replaced with a policy allowing
only that view's shell; other CSP directives are preserved. If an app depends on
escaping its frame or unsandboxed OAuth popups, it needs its normal development
URL outside this preview mode. The header remains available even when app access
expires. Reload resets the app frame to its root URL.

Preview data uses HTTPS to the deployment's preview ingress and, in automatic
mode, a separate outbound WebSocket tunnel to the node, **not Bivy session E2E
encryption**. The preview ingress/relay operator can see preview traffic. The
existing encrypted chat, terminal and pairing frame transport is unchanged. Generated
service workers are disabled to prevent an offline worker from bypassing the
preview gate; PWA/offline behavior must be tested outside this preview mode.

## Runtime and security boundaries

- Terminal programs use the existing node PTY runtime and the machine user's
  permissions/environment. **This is not a new process sandbox.** Only run code
  you trust; use a dedicated runner for untrusted projects. Bivy doesn't project
  model-vault credentials into app terminals, but the user's inherited environment
  and filesystem can still contain credentials.
- A web service is a program you or the agent already started. Registering it
  grants preview access, not ownership of the process. Removing its app does not
  kill that external server. Check port ownership: a service that later reuses
  the same port would be reachable through the registration. Remove stale apps.
- Generated apps do not receive Bivy's device token or preview cookie. Their own
  APIs, credentials and mutations remain their responsibility. No API credential
  broker or transaction-approval layer is implemented by this preview feature.
- Apps and static snapshots are currently in memory. A node restart clears them,
  invalidates all access grants and requires republishing. This avoids restoring
  stale port registrations. Project manifests remain in the workspace.
- Removing an app stops terminal processes started through its views, not unrelated
  terminals. It cannot retract bytes already downloaded or undo side effects.

## Extending the architecture

- `packages/core/src/apps.ts`: versioned manifest and typed view/result contracts.
- `src/apps/registry.ts`: validated, session-scoped app metadata and snapshots;
  publication is atomic and does not start programs.
- `src/apps/service.ts`: composes view providers and owns terminal start/reconnect
  lifecycle. Terminal execution is injected, rather than coupled to a framework.
- `src/apps/gateway.ts`: optional web-only origin, access grants and HTTP/WebSocket
  transport. It knows nothing about agent runtimes or terminals.
- `src/controllers/app-commands.ts`: one command implementation for direct HTTP
  and relay control. The CLI uses these same endpoints.
- `AppMessage.tsx`: durable, ID-based chat launcher; the event log and live
  transcript reducer carry references, never access grants.
- `src/apps/preview-shell.ts`: trusted preview header on a separate origin from
  generated content. It uses the canonical styles and design tokens, also copied
  into standalone node releases.
- `AppsSheet.tsx`: app discovery and view selection; terminal views delegate to
  the existing `TerminalOverlay` instead of duplicating a terminal renderer.

A new view kind needs a validated descriptor, an execution/transport provider,
and a client renderer. Unsupported kinds fail closed. Future remote-display
providers will need explicit viewing/control permissions, isolated graphical
sessions and appropriate platform runners. Automatic HTTP tunneling, persistent
app deployments, embedded web panels, managed service launch/restart/logs and API
broker capabilities are separate additions, not implied by the current contract.
