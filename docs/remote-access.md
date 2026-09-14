# Remote access

How to reach a Bivy node from a browser, a phone, or another machine.

## Three parts

Bivy splits into three pieces. Understanding the split explains almost every
question people have about remote access.

```
   YOUR MACHINE                  TRANSPORT                 CONTROL PLANE
+------------------+        +----------------+        +--------------------+
|  bivy node       |        |     relay      |        |  accounts          |
|  DATA PLANE      |        |                |        |  node registry     |
|                  |        |  forwards      |        |  session index     |
|  runs agents     |        |  sealed frames |        |  mints tickets     |
|  holds your keys |        |  holds no keys |        |  SERVES THE WEB/   |
|  /api + /ws on   |        |                |        |  PWA UI            |
|  localhost:4317  |        |                |        |                    |
+--------+---------+        +-------+--------+        +---------+----------+
         |                          ^                           ^
         |  outbound wss            |                           |
         +------------------------->+                           |
                                    |                           |
                                    |  outbound wss             |  https
                          +---------+---------------------------+--------+
                          |     browser  /  installed PWA  /  phone      |
                          +----------------------------------------------+
```

- **Node** — the daemon on your computer. It runs the agents, holds your model
  credentials and repo tokens, and serves an HTTP API plus a WebSocket at
  `http://localhost:4317`. This is the data plane.
- **Relay** — a dumb pipe. Both the node and your browser dial *out* to it. It
  forwards encrypted frames between them and holds no keys.
- **Control plane** — accounts, the registry of your nodes, the session index,
  and the thing that actually serves the web/PWA UI. Hosted at `app.bivy.sh`, or
  run your own.

### The node hosts no UI

Point a browser at `http://localhost:4317` and you get one line of plain text
saying so. The React/Vite PWA is built and served by the control plane, not by
the node.

In practice this means:

- There is no "local UI" to open. `bivy open` opens the *control plane's* app.
- You need remote access configured to get a browser UI at all — even on the
  same machine as the node.
- A headless server works exactly like a laptop. There was never a local browser
  in the picture.
- The node exposes nothing to the internet. It only dials out.

## Walkthrough

### 1. Enable remote access

`bivy setup` does this for you. To enable it later, or to change it:

```bash
bivy login
```

With no flags it asks whether to sign in with GitHub (default) or by email link,
then opens your browser. It health-checks the control plane first, signs you in,
enrolls this node, and writes `.bivy/relay.json`. Use `bivy relay:setup` for the
advanced self-hosted and existing-session options:

```bash
bivy login --github                           # GitHub sign-in
bivy login --email you@example.com            # email magic link
bivy relay:setup --session-token <token>      # reuse an existing account session
bivy relay:setup --control-plane https://app.example.com
bivy relay:setup --relay wss://relay.example.com
bivy relay:setup --client https://app.example.com   # where the web app is served
```

Afterwards the command restarts the background service, or hot-reloads a running
node, so the relay connection comes up without a manual restart.

### 2. Open the app

```bash
bivy open
```

Opens the control plane's web app in a local browser, and prints the URL if there
is no browser to open (headless servers). Sign in with the same GitHub account or
email you used during `bivy login`, and your nodes are listed.

### 3. Pair another device

```bash
bivy link
```

Prints a QR code and a URL. Scan it with the phone, or open the URL on the
laptop you want to pair. The link is a control-plane URL with everything after
the `#`:

```
https://app.bivy.sh/#<base64url payload>
```

The payload carries the control-plane URL, the relay URL, a node-scoped session
grant, this node's id, name and X25519 public key, and a **single-use pairing
secret**. The room key that actually encrypts your traffic is *not* in the link
— the device derives it through an ECDH handshake with the node over the relay.

The pairing secret expires after five minutes and is held only in the node's
memory, so restarting the node invalidates any outstanding QR. Just run
`bivy link` again.

You can also paste the link text into the app instead of scanning it.

### 4. Install the PWA

**iPhone / iPad.** Open the control-plane URL in **Safari** (other iOS browsers
cannot install web apps). Tap the **Share** button, scroll down, tap **Add to
Home Screen**, then **Add**. Launch it from the home screen icon.

**Desktop (Chrome, Edge, Brave).** Open the same URL and use the browser's
install control — the icon in the address bar, or the menu's "Install Bivy" /
"Install this site as an app". Bivy does not add its own install button; you use
the browser's.

The app is a standard installable PWA (`display: standalone`, precached assets, a
service worker). Push notifications are only offered when the control plane
serving the app has web-push VAPID keys configured; if you self-host, set
`WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` or the app will not
let you subscribe.

## Pointing at your own relay and control plane

Two ways, and they compose.

**Per-node flags** on `bivy relay:setup`:

```bash
bivy relay:setup \
  --control-plane https://app.example.com \
  --relay wss://relay.example.com \
  --email you@example.com
bivy restart
```

**Environment variables**, read by the node and CLI:

| Variable | What it sets | Default |
| --- | --- | --- |
| `BIVY_HOSTED_DOMAIN` | Base domain; `app.` and `relay.` are derived from it | `bivy.sh` |
| `BIVY_CONTROL_PLANE_URL` | Full control-plane URL | `https://app.<domain>` |
| `BIVY_RELAY_URL` | Full relay `ws(s)://` URL | `wss://relay.<domain>` |
| `BIVY_CLIENT_BASE_URL` | Where the web app is served | same as the control plane |

So `BIVY_HOSTED_DOMAIN=example.com` is usually enough if you followed the
standard `app.` / `relay.` naming.

The choice is stored in `.bivy/relay.json` once setup completes; the flags and
env vars only matter at setup time.

The browser side has no configuration of its own. It uses whichever control
plane served it, or whatever the link payload told it to use. To run your own
control plane and relay, see [self-host.md](self-host.md) — the server-side
settings are `PUBLIC_CONTROL_PLANE_URL`, `RELAY_PUBLIC_URL` and `RELAY_SECRET`.

## Security model

The node never accepts inbound connections: it dials out to the relay over WSS
using a short-lived, single-use ticket minted by the control plane, so you open
no ports and need no VPN or tunnel. Session traffic between your browser and
your node is end-to-end encrypted with AES-256-GCM under a room key the relay
never holds; devices obtain that key by an ECDH handshake proven with a
single-use pairing secret that travels only in a URL fragment. The relay can see
routing metadata — node and account ids, frame sizes, counts and timing, your IP
— and nothing else; it keeps no persistent state. The control plane sees account
and node metadata: node names, online status, and a session index (session id,
status, source, branch). Session titles are stored encrypted. Your model keys,
repo tokens, interactive prompts, agent output, terminal I/O, and file contents
never leave the node in the clear. Two separate inbound features are not session
traffic: Slack commands and generic webhook instructions arrive at the control
plane in plaintext and are retained with their queue items. Push notifications
are another exception: to render one, the control plane receives its title and
body in plaintext, which can include a session or terminal name. Removing a
paired device rotates the room key and re-wraps it for the devices that remain.

Full details, including known limitations: [security-model.md](security-model.md).
To report a vulnerability, follow [SECURITY.md](../SECURITY.md).

## Troubleshooting

**`bivy open` says "No remote access configured yet."**
`.bivy/relay.json` does not exist. Run `bivy login`.

**`bivy doctor` shows `relay configured` but never `relay connected`.**
The node is not reaching the relay. Check `bivy logs -f` for `[relay]` lines.
The node retries with exponential backoff (1s doubling to 30s), so a blocked
outbound WSS connection looks like silence. Allow outbound WSS to the relay
host. If setup happened while the node was already running and did not
hot-reload, `bivy restart`.

**The app loads but the node shows offline.**
Node online status comes from the relay, so the node must be running *and*
connected. Run `bivy status` and `bivy doctor` on the machine. If the node is
reachable locally but the relay is not connected, that is the previous problem.

**The QR does nothing, or pairing fails.**
Pairing secrets are single-use and expire in five minutes, and they live in the
node's memory — a restart invalidates them. Run `bivy link` again and scan the
fresh code. `bivy link` also fails fast if the node is not reachable; start it
first.

**I signed in but see no nodes, or a different set of nodes.**
You are signed into a different account than the one the node enrolled with, or
into a node-scoped link grant rather than your account. Sign out in the app and
sign in with the same GitHub account or email you used in `bivy login`.

More symptoms: [troubleshooting.md](troubleshooting.md).
