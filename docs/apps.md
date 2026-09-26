# Session apps and views

Bivy apps group interfaces to what an agent is building. An app is **not** an
HTML document or a particular framework: it has named, typed views. Version 1
supports web, interactive terminal and desktop (display) views. A desktop view
is shown through the same web preview, so it adds no new app category.

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

### Detected servers (no manifest)

A manifest is optional for a single live server. When a process whose working
directory is inside the session workspace listens on loopback (`127.0.0.1`,
`::1`) or all interfaces, session menu → **Apps** lists it under **Running in
this workspace**. Tapping **Preview** publishes it as a one-view app and opens
it. Detection grants nothing on its own: access starts only when someone taps,
and the node re-checks that the port is still a workspace listener before it
publishes (`apps.offers` / `apps.adopt`). Detection reads `/proc` on Linux and
uses `lsof` on macOS. It sees only processes owned by the node's user and ports
from 1024 up. Use a manifest to name views, add terminals or publish static
snapshots.

Inside an agent session, `--session` defaults to the same session environment used
by `bivy attach`. No per-agent adapter or special model tool is required.
`bivy app --help` describes the contract. The CLI prints JSON, including app and
view IDs. API callers can use the same `apps.publish/list/open/remove` commands.

Publishing adds a durable **Open app** button to the chat. You can also use the
session menu → **Apps**. Both open the same view selector. **Open preview**
**peeks**: the preview opens in a drawer over the chat, with Bivy's controls in a
floating pill (see [Preview controls](#preview-controls)) and the composer still
reachable. **Open in tab ↗** opens the same preview in a separate tab. If the
browser blocks popups, a normal link is offered instead. In a tab, **Back to
chat** closes it where permitted, otherwise navigates to the originating
session. Closing the view does not stop an external app server.

The drawer and the tab both host a Bivy-owned shell on its own origin, and the
generated app is framed on a separate, same-site origin, so app code never
reaches Bivy's controls. Inside the drawer, the app's access cookie is a
third-party cookie. The embedded launch therefore sets it `SameSite=None;
Partitioned`, keyed to Bivy's top-level site, so no other site can use it. The
shell may be framed only by the configured Bivy client origins. Browsers that
refuse framed cookies are detected on the first try. That device then opens
previews in a tab from then on. The Bivy client's CSP allows HTTPS frames
(`frame-src 'self' https:`) for this. Terminal views ask for confirmation,
then open inside Bivy's existing terminal with input, output, resizing and mobile
controls. Chat launchers survive reload, but opening a removed app or one cleared
by a machine restart reports that it needs republishing.

Publishing never starts terminal commands. Opening a terminal view starts its
program once; concurrent opens and subsequent opens reconnect to it. Once the
program exits, opening the view again starts a new instance. Closing the terminal
UI detaches; ending the terminal stops it. An exited app never silently becomes a
shell. Commands are executables plus argument arrays, not implicitly shell-parsed
strings. For shell syntax, explicitly choose a shell and `-c` arguments.

### Agent screenshots (`bivy app shot`)

```sh
bivy app shot                       # every web view: 390 and 1280 px, light
bivy app shot <app-id> --widths 390 --themes light,dark --path /settings
```

Any agent can screenshot its session's web views to check its own UI (desktop
apps: see [Desktop apps](#desktop-apps-display)). The
command prints JSON with one PNG path per view, width and theme. Phone widths
(< 600 px) render at 2×. Themes are emulated for the page
(`prefers-color-scheme`). It uses Chrome or Chromium on the machine
(`BIVY_CHROME` to pick one; a Playwright install also works), one browser at a
time, and needs a few hundred MB of memory while it runs. Service views load
straight from loopback; static views from a temporary loopback server. Where
Chromium's sandbox is unavailable (as root, or where AppArmor blocks user
namespaces), it runs without it. The pages are the session's own apps, already
running as the node user.

**Off by default.** Turn it on in Bivy → Settings → this machine, *Let agents
screenshot their app previews*. From a terminal, run
`bivy config set sessions.appScreenshots true` (or set
`BIVY_APP_SCREENSHOTS=1`). While it's off, the command explains how to turn it
on.

### Review cards (`bivy app present`)

```sh
bivy app present                                  # the view opened last
bivy app present Storefront --path /checkout --note "New pay button"
```

A review card shows the running app in the chat when there is something to
judge: the app at phone width, a **Before / Now** switch when the run changed
it, and **Open preview**, which opens the live preview on that page. There is
one card per app per run; later changes in the same run update it in place.
A card appears when:

1. **The agent presents it.** `bivy app present` means "this is ready to look
   at". Any agent can run it, and users can ask for it ("show me when it's
   ready"). It first picks up files written since the turn began, so the
   picture and any open preview show them. It prints JSON with the card and a
   message saying what the user will see.
2. **A run ends with a visible change.** When the agent stops (done, or
   waiting for the user), each web view whose revision changed during the run
   is screenshotted and compared with the page before the run. A card is made
   only if enough pixels differ. A backend-only run makes no card.
3. **The user asks.** *Show me the app* in the session menu, or on a
   "finished" notification (where the device supports notification actions),
   takes one now.

**Preview cards: When ready · Every change · Off**, per app, in the app's ⋯
menu (Apps sheet) or the card's ⋯ menu, and remembered with the app. *When
ready* is the default (triggers 1 and 2, above a small threshold of changed
pixels, about a changed label). *Every change* also shows small visual tweaks.
*Off* makes no cards on its own; Show me still works. **Mute for this run** on
a card stops further cards until the agent's next run.

Cards need agent screenshots (see above). While they're off, a presented or
requested card has no picture and offers **Turn on**; Bivy never turns
screenshots on by itself. To measure a change, Bivy needs the page as it was
before the run: the screenshot from the previous run or Compare, or, the first
time, one taken when the run starts.

**Notifications.** There is no new notification. When nobody has the session
open, the existing "finished" notification says the app changed and opens the
card. It carries IDs only, never the image: the screenshot is an encrypted
chat attachment the device fetches over the session channel. It waits up to
30 seconds for the card.

**Storage.** Screenshots are stored like other chat attachments (end-to-end
encrypted in transit, in the node's attachment store). Each view keeps only
its latest card's pictures: an older card shows "Screenshot no longer stored".

### Share links (`bivy app share`)

```sh
bivy app share                          # the web view opened last
bivy app share Shop --view Storefront   # an app and view, by name or ID
```

Mints the same reusable link as **Copy link** in the Apps sheet (see
[Automatic web preview delivery](#automatic-web-preview-delivery)), so an agent
can hand a preview to people outside Bivy: in a pull request, an issue, or a
Basecamp or Slack thread an automation came from. `[app-id]` is an app ID or
name and `--view` a view ID or name within it; with neither, it picks the view
opened last, like `bivy app present`. Only web views have links. It prints JSON
with `url`, `expiresAt` (epoch milliseconds), `expires` (ISO 8601) and the app
and view it picked:

```json
{ "url": "https://<view>.preview.example.net/__bivy/open#…", "expiresAt": 1790532000000,
  "appId": "…", "viewId": "…", "app": "Shop", "view": "Storefront",
  "expires": "2026-09-27T18:00:00.000Z" }
```

The link works for 24 hours, until **Revoke access** in the Apps sheet, until
the app is removed, or until the machine restarts. People who open it can leave
reviewer notes, which come back under the view in **Apps**.

> **Security:** a share link is a bearer capability. **Anyone who has the link
> can use the app, including its live backend, until it expires or you revoke
> it.** Posting it in a thread, issue or chat gives it to everyone who can read
> that place, and to any integration or log that stores it. Only share previews
> whose data and actions are fine for those people, and revoke access when the
> review is done. The command prints this reminder on stderr, so the JSON on
> stdout stays clean for scripts.

### Servers Bivy runs (`start`)

A service view can say how to start its server:

```json
{ "kind": "service", "port": 5173, "start": { "command": "pnpm", "args": ["dev", "--port", "5173"] } }
```

Publishing still starts nothing. The first **Open preview** starts the command
in the session workspace, in a Bivy terminal, with the node user's permissions,
the same as a terminal view. The preview shows *Nothing is answering* until the
server listens, then reloads. If the server exits, Bivy restarts it. After five
restarts in ten minutes it is left down until someone opens the view again.
**Logs** in the Apps sheet attaches to its output. Removing the app stops it.

### Desktop apps (`display`)

A desktop GUI program (GTK, Qt, Electron, Tauri, Flutter desktop, Java, SDL…)
is a view too:

```json
{ "kind": "display", "name": "Editor", "command": "cargo", "args": ["run"], "restartOnChange": true }
```

Without a manifest: `bivy app run -- cargo run` publishes the same thing
(`--name` names it, `--restart-on-change` sets the flag).

The first **Open preview** starts a private display for the view, then runs the
command on it in a Bivy terminal, like a server with `start`: **Logs** shows its
output, it restarts if it exits, and removing the app stops both. With
`restartOnChange`, an agent turn that changed files restarts it too, so it runs
the new code, and Compare gets a before/after pair. The preview streams the
display into the usual shell, so Peek, **Open in tab**, the stable address and
**Copy link** work as for web views. **Point**, **Console** and reviewer notes
need a page to inspect, so they're not offered.

The display follows the viewer: it takes the preview's size (a phone gets a
phone-sized screen), each app window fills it, and dialogs stay their own size,
centered. A window that can't shrink that far makes the display larger instead,
and the preview scales it down to fit, so nothing is cut off. On a
high-density screen the display starts at 2× (toolkits get `GDK_SCALE=2`,
`QT_SCALE_FACTOR=2`, `J2D_UISCALE=2`, and `Xft.dpi: 192` for Chromium/Electron),
so text stays sharp; the density is fixed when the display starts, by the first
device that opens it.

- **Clipboard:** text the app copies shows **Copy from app**; tap it to put it
  on your device. **Paste** sends your device's text to the app and presses
  Ctrl+V. Where the browser won't share its clipboard, a field opens to paste
  into. Nothing crosses without a tap.
- **Keyboard:** on touch screens, **⌨** opens the on-screen keyboard.
- **Screenshots:** `bivy app shot` captures the display as it is, without a
  browser: one PNG at its current size (`"theme": "native"`); `--widths` and
  `--themes` don't apply. It waits up to 15 seconds for the app's first window.
- **Stream stats:** each viewer reports input-to-frame latency (median and
  p95) and bandwidth every 10 seconds while you use it; `bivy app list` shows
  the latest as the view's `stats`.

Requirements: **Linux**, with TigerVNC's X server on the machine (Debian/Ubuntu:
`sudo apt install tigervnc-standalone-server`, or set `BIVY_XVNC` to an `Xvnc`
binary). Publishing says so when it's missing. Programs get `DISPLAY`,
`XAUTHORITY` and toolkit hints (`GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`,
`SDL_VIDEODRIVER=x11`, `ELECTRON_OZONE_PLATFORM_HINT=x11`), so they use the
preview display rather than the machine's own. Each display costs about 30 MB
plus the app. Not yet: sound, Wayland-only apps, and macOS apps.

### Static sites

Replace the web source with:

```json
{ "kind": "static", "directory": "./dist" }
```

The CLI resolves directories relative to the manifest; direct API callers use
paths relative to the session workspace. The directory must be inside that
workspace and contain `index.html`. Bivy snapshots its bytes at publication, so
edits in the middle of a turn never change the published view. When an agent turn
finishes with file changes, Bivy re-takes the snapshot and open previews reload,
returning to the page you were on. A build that no longer produces `index.html`
keeps the last good snapshot. Publish again to update between turns.
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
Long-lived HTTP streams time out after 60 seconds of inactivity. If nothing is
answering on the port, the preview shows **Nothing is answering on port N**
instead of a blank frame. It reloads by itself once the server is back, and
**Ask agent to fix** opens the session with a drafted request (nothing is sent
until you send it). Service previews also reload after an agent turn that changed
files, for servers without hot reload. Static views
serve client-side routes: an extensionless page load that matches no file gets
`404.html` (with status 404) if the snapshot has one, otherwise `index.html`.
The static server does not provide range requests or directory listings.

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

**Copy address** in the Apps sheet gives a web view's stable address, e.g.
`https://<view>.preview.example.net/`. The address grants nothing by itself, so
it is safe to put on a home screen. A visit without access is sent to the Bivy
client (`/sessions/<id>?node=<node>#preview=…`). There you sign in if needed, and
the client opens that session on its machine. It then asks the node for a
one-use direct link and returns to the same page of the app. So the address
works on devices signed in to the account that owns the machine, and nowhere
else. Addresses stay the same across node restarts, because apps keep their IDs.

**Copy link** in the Apps sheet mints a separate, reusable link for one web view.
It points at the app's own origin rather than the shell, so it opens unframed in
any browser (useful for devtools or another device). Every visit exchanges it for
the same host-only cookie, capped so a browser session never outlives the link.
It stays valid for 24 hours, until **Revoke access**, until the app is removed,
or until the machine restarts. Revoke access ends every link, browser session and
open connection for that view without removing the app. A copied link is a
bearer capability: anyone holding it can use the app, including a live server's
backend, until it lapses or is revoked. Agents mint the same link with
[`bivy app share`](#share-links-bivy-app-share).

**Reviewer notes.** A copied link opens the app with one extra control,
**Leave a note**. It sits in a shadow root so the app's styles don't touch it.
The visitor points at an element and writes a note. The note is stored with the
element's selector and text, the page and the viewport. The owner sees notes
under the view in **Apps**, with **Add to message** (drafts them into the
composer) and **Clear**. Notes are untrusted text: at most 1,000 characters
each, 50 per view (oldest dropped), same-origin POSTs from a valid link only,
kept in memory. They never reach the agent unless the owner sends them.

The app iframe is sandboxed: scripts, forms, same-origin app storage, downloads
and sandboxed popups are allowed; top-level navigation is not. Upstream
`X-Frame-Options` and CSP `frame-ancestors` are replaced with a policy allowing
only that view's shell; other CSP directives are preserved. If an app depends on
escaping its frame or unsandboxed OAuth popups, it needs its normal development
URL outside this preview mode. The controls remain available even when app access
expires. Reload reloads the page the app is on.

### Preview controls

The preview shell floats one pill over the app, so the app keeps the whole
screen. **⌄** collapses it to a small **Bivy** button when it covers the app's
own bottom bar.

- **Point**: tap any element in the app. A draft for the agent opens with the
  element's selector, text, size and position, the page, the viewport and
  recent errors. You add what should change, then **Add to chat** puts it in the
  session's composer. The tap you point with is not passed to the app.
- **Point and speak** (in the preview drawer inside Bivy): the draft box has a
  mic. Hold it and speak, then let go; or tap to start and tap again to stop.
  **Long-press** an element while pointing to open its draft already
  listening; letting go stops. What you said goes first in the draft, and stays
  editable, followed by the element's context. Bivy does the listening, not
  the preview: the shell asks the Bivy page that frames it to listen, and only
  the transcript comes back. Audio goes to the node for transcription over the
  encrypted session channel (Settings → Voice input), or to the browser's own
  dictation when no key is set. It never passes through the preview origin. A
  preview opened in a tab has no mic; use the composer's.
- **Draw** (in the preview drawer inside Bivy): the app freezes under a
  marking layer — nothing you draw reaches it — and you circle, scribble
  (**Pen**) or **Box** what's wrong; **Undo**, **Clear**, **Done**. Two fingers
  (or a mouse wheel) scroll the page, and marks stay on the content. Done opens
  the draft box (type, or use the mic): its context names the elements inside
  your marks (by their content, so circling "Total $102" names that line, not
  the whole row), the page and viewport, and each mark's bounds. **Add to
  chat** puts your words and that context in the composer with a picture of
  what you marked, as an ordinary image attachment you can open or remove.
  - The picture is made on the machine and fetched by the Bivy page over the
    encrypted session channel: for a web page, the local Chrome retakes it at
    your viewport, pixel ratio and scroll, and the marks are drawn on top. It
    is labelled **approximate** when the page may hold state a fresh browser
    doesn't (storage, cookies, typed input, an open menu or dialog, anything
    you did since the page loaded) or couldn't scroll to where you were; the
    marks and elements are exact either way. A desktop app's picture is its
    current frame, and **Draw on "now"** in Compare marks that screenshot
    itself, so both are exact.
  - Needs agent screenshots for the picture. With them off, you choose: turn
    them on, or add your words, marks and elements without a picture.
  - Strokes, elements and pictures never go through the preview origin: the
    shell hands them to the Bivy page by `postMessage`. The marks use the
    `--annotate` design token, the same colour in both themes.
- **Console**: errors and warnings from the page, with a count on the pill.
  **Send to agent…** drafts them the same way.
- **Full / Tablet / Phone** (wide screens): constrains the app to 768 or 390 px.
- **Compare** (with agent screenshots on): before/after screenshots at phone
  width around the agent's last change (review cards reuse these shots), with a handle to reveal either. Bivy
  takes a baseline the first time a view is opened, and one after each turn that
  changes files, of the page last viewed. The last four are kept in memory.

**Sharing into a session.** In the installed app (Android and desktop Chrome),
Bivy is in the system share sheet for text, links and images. A shared
screenshot waits on the device (the service worker keeps it in Cache Storage;
nothing is uploaded) while you pick a session. Sessions with an app preview
show it, and the last page viewed. Picking one opens it with the image as an
ordinary composer attachment and a draft line naming the preview — "Shared a
screenshot — compare it with the Storefront preview (/checkout)." — which you
edit or replace. Nothing is sent until you send it. (iOS: the "Send to Bivy"
Shortcut shares text; a native share extension is separate work.)

These work through a small inspector script that the gateway adds to the app's
HTML page loads, served from the app's own origin (`/__bivy/inspector.js`). The
gateway requests uncompressed HTML for page loads, and adds that exact script URL
to the app's `script-src` (or `default-src`) CSP directive; other directives are
unchanged. A CSP delivered in a `<meta>` tag, `'strict-dynamic'`, or HTML over
5 MiB leaves the inspector out; the preview still works without it. The
inspector only reports to the framing shell. Everything it reports is untrusted
app data, and becomes a draft you review — never a message sent for you.

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
- A desktop view's display is an Xvnc server with no network port: its VNC
  socket is a private file (mode 0600) only the node reads, and X clients need
  a per-display cookie that only the view's program is given. It is still not
  a sandbox: the program runs as the node user, like a terminal view.
- A web service is a program you or the agent already started. Registering it
  grants preview access, not ownership of the process. Removing its app does not
  kill that external server. Check port ownership: a service that later reuses
  the same port would be reachable through the registration. Remove stale apps.
- Generated apps do not receive Bivy's device token or preview cookie. Their own
  APIs, credentials and mutations remain their responsibility. No API credential
  broker or transaction-approval layer is implemented by this preview feature.
- Apps persist across node restarts with the same IDs, so chat launchers and
  preview addresses keep working. The data is in `apps.json` in the node's data
  directory, mode 0600. Static views are re-snapshotted, and terminal views and
  managed services come back. **Service views without `start` are not
  restored**: after a restart their port could belong to any process. Detection
  offers them again, one tap to preview. Access grants never persist. After a
  restart, open the preview again from Bivy.
- Share links (**Copy link**, `bivy app share`) are bearer capabilities, not
  identities: anyone who has one can use the app and its live backend until it
  expires (24 h), is revoked, the app is removed or the machine restarts. An agent
  can mint one without asking, so instruct it where it may post links.
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
- `src/apps/review.ts` and `ReviewCard.tsx`: review cards. When a card is made
  is a table of modes (`REVIEW_MODES`); the service tracks runs and reuses
  Compare's shots; the server stores screenshots as attachments and logs the
  card (`app-review`), which updates in place by ID.
- `src/apps/display.ts`, `x11.ts`, `rfb.ts`, `display-viewer.ts`: desktop
  views — a private Xvnc display per view, a minimal window manager that fits
  windows to the viewer, VNC capture for screenshots, and the noVNC viewer the
  gateway serves. The gateway only relays the viewer's WebSocket to the
  display's socket; it knows nothing about X.
- `src/apps/preview-shell.ts`: trusted preview controls on a separate origin from
  generated content. It uses the canonical styles and design tokens, also copied
  into standalone node releases.
- `AppsSheet.tsx`: app discovery and view selection; terminal views delegate to
  the existing `TerminalOverlay` instead of duplicating a terminal renderer.

A new view kind needs a validated descriptor, an execution/transport provider,
and a client renderer. Unsupported kinds fail closed. Another display provider
(e.g. macOS window capture for native Mac and iOS Simulator apps) would supply
the same thing the Linux one does: a VNC-speaking socket per view, plus the
program's environment. Automatic HTTP tunneling, persistent
app deployments, embedded web panels, managed service launch/restart/logs and API
broker capabilities are separate additions, not implied by the current contract.
