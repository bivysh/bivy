# Install notes

The recommended path is:

- Mac/local: run the daemon locally, then reach the browser UI with `bivy open`
  (it's served by the control plane, not the node — see
  [remote-access.md](remote-access.md)).
- Server: run the same daemon as a long-running service.
- Phone/tablet/remote desktop: install or open the hosted remote PWA from Safari/Chrome.

## One-click install (recommended)

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

The installer:

1. checks for Node.js 22.19+ (on Debian/Ubuntu it can install it for you; on
   macOS it warns if Xcode Command Line Tools are missing, which the native
   `node-pty` module needs to build),
2. runs `npm install -g bivy`,
3. migrates state from a previous tarball install, if it finds one (see below),
4. launches the interactive `bivy setup` wizard, or restarts the background
   service on an existing install.

Bivy is distributed on npm. npm verifies each package's integrity hash on
install, and releases published from CI carry a provenance attestation you can
check with `npm audit signatures`. See [releasing.md](releasing.md).

If you already have Node.js 22.19+, the installer is optional:

```bash
npm install -g bivy
bivy setup
```

Override defaults with environment variables:

```bash
# Install a specific version rather than the latest.
BIVY_VERSION=0.1.0 bash install.sh

# Install into a user-owned prefix instead of npm's global one (no sudo).
BIVY_NPM_PREFIX=~/.local bash install.sh

# Preinstall every bundled agent runtime rather than just your default.
BIVY_INSTALL_ALL_AGENTS=1 bash install.sh

# Don't touch ~/.bashrc or ~/.zshrc; just print the PATH line to add yourself.
BIVY_NO_RC_UPDATE=1 bash install.sh
```

If npm's global prefix isn't writable, the installer falls back to `~/.local`
automatically rather than escalating with sudo — installing as root leaves files
you can't update later without sudo.

If that install location isn't already on `PATH`, the installer appends a
small, clearly-marked block to `~/.bashrc` or `~/.zshrc` (whichever your
`$SHELL` uses) that puts it there — re-running the installer never duplicates
the block. A script can't change the PATH of the shell that invoked it, so
open a new terminal (or `source` the rc file) afterwards to pick it up. Set
`BIVY_NO_RC_UPDATE=1` to skip this and just get the `export PATH=...` line
printed for you to run manually.

## Where your data lives

Node state — config, node identity, relay keys, sessions, logs — lives in
`~/.bivy`. The npm package directory is replaced on every update, so nothing
durable is kept there.

Installs created by the older tarball installer kept state *inside* the app
directory at `~/.bivy/app/.bivy`. The installer moves it to `~/.bivy` once, and
only when `~/.bivy/cli.json` doesn't already exist, so it can never overwrite
newer state. The old tree is left in place; remove it when you're satisfied:

```bash
rm -rf ~/.bivy/app
```

Override the location with `BIVY_DATA_DIR`.

## The setup wizard

`bivy setup` (run by the installer, or `npm run setup` in an existing checkout)
picks sensible defaults for everything and asks at most two questions:

- **Remote access** — hosted (recommended; one node is free), self-hosted (your
  own control plane + relay), or local terminal only. The local option needs no
  Bivy account and can be upgraded later with `bivy relay:setup`.
- **Remote login** — for hosted/self-hosted only: GitHub sign-in (default) or an
  email magic link.

Everything else is automatic and changeable later in Settings: a dedicated
`~/bivy-workspace` folder and local port, Pi as the default agent (other
agents sign into their own CLI), and a background service (launchd/systemd)
so the node keeps running after you close the terminal.

It writes CLI config to `.bivy/cli.json` (chmod 600) so `bivy start` and
the background service reuse the same workspace/port/credentials.

## App-first setup path

You can start from the hosted app first:

1. Open the Bivy PWA and sign in with GitHub or email.
2. If no runner is connected, the app shows how to connect one:
   - **Connect your own computer** — run `curl -fsSL https://bivy.sh/install.sh | bash` on macOS/Linux. Setup signs the node into the same account and enrolls it on the hosted relay.
3. A free account includes one hosted-relay node; add another plan or self-host
   when you need more.

## Secure remote web/PWA access (hosted relay)

If you say yes to remote access, setup uses GitHub sign-in by default (email
magic-link fallback) — no URLs, no ports, no VPN. Authorize in the browser and
setup continues automatically, enrolls this node, and writes `.bivy/relay.json`.

The node then dials the hosted relay **outbound** (so nothing is exposed to the
internet), and session traffic is **end-to-end encrypted** — the relay only
routes opaque frames. You can enable this later on an already-set-up node with:

```bash
bivy relay:setup            # one-click sign-in, then enroll this node
```

The hosted endpoints are baked in. To point at your own deployment, set
`BIVY_HOSTED_DOMAIN=example.com` (the node derives `app.` and `relay.`
subdomains), or override individually with `BIVY_CONTROL_PLANE_URL` /
`BIVY_RELAY_URL`.

To pair a remote browser/PWA, run `bivy link` and scan the QR or open the
link — or use the **Link remote device** button in the app (`bivy open`).
To revoke a linked device, remove it under Settings → **Signed-in devices**
(the room key rotates for the remaining devices); remove them all to revoke
everyone.

## Mac development install

```bash
git clone <repo>
cd bivy
npm install
npm run setup     # or: npm start
```

The node has no local UI — `http://localhost:4317` is the data plane (API +
WebSocket) and returns one line of plain text confirming it's up. Use
`bivy open` to reach the browser/PWA UI, served by the control plane just
like any other install (see [remote-access.md](remote-access.md)).

Optional workspace:

```bash
BIVY_WORKSPACE=/path/to/workspace npm start
```

## Background service (one command)

Instead of writing launchd/systemd files by hand, let the CLI generate and load
them:

```bash
bivy service install     # launchd (macOS) or systemd --user (Linux)
bivy service status
bivy service uninstall
```

On Linux, run `loginctl enable-linger $USER` once so the node keeps running
after you log out.

## Uninstall (one command)

To remove Bivy and all of its data from a machine:

```bash
bivy uninstall                  # remove everything (asks first)
bivy uninstall --dry-run        # preview what would be removed
bivy uninstall -y               # skip the confirmation prompt
bivy uninstall --keep-sessions  # preserve sessions (picked back up on your next install)
bivy uninstall --keep-worktrees # leave git worktrees in your repos untouched
```

This stops and deletes the background service, kills the running node, removes
the `~/.local/bin/bivy` symlink, and deletes the app install plus all local
state — config, credentials, session transcripts, and `--clone` workspaces —
along with the git worktrees Bivy created in your repos (`*/.bivy/worktrees`).
It also deregisters the node from your Bivy account. A source (git) checkout
keeps its code; only the `.bivy` state directory is removed. Note that
`bivy service uninstall` (above) removes only the background service, leaving
your data and the CLI in place.

> **Note:** the hand-written launchd/systemd templates below run `npm start`
> from a source checkout and are kept only as a reference for custom setups.
> The supported service is the one `bivy service install` generates (it runs the
> packaged app); prefer it unless you specifically need a source-run service.

## macOS launchd example

Create `~/Library/LaunchAgents/dev.bivy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.bivy</string>

  <key>WorkingDirectory</key>
  <string>/Users/YOU/projects/bivy</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npm</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4317</string>
    <key>BIVY_WORKSPACE</key>
    <string>/Users/YOU/projects</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/bivy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/bivy.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/dev.bivy.plist
launchctl start dev.bivy
```

## Linux/server systemd example

Create `/etc/systemd/system/bivy.service`:

```ini
[Unit]
Description=Bivy prototype
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bivy
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=PORT=4317
Environment=BIVY_WORKSPACE=/srv/workspaces

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bivy
sudo journalctl -u bivy -f
```

## Remote PWA

1. Enable hosted relay access with `bivy relay:setup`.
2. Open the app (served by the control plane, not the node) with `bivy open`.
3. Choose **Link remote device** and scan/open the hosted sign-in link.
4. On iOS Safari, tap Share → Add to Home Screen.

The phone/browser never connects directly to the node over LAN/Wi-Fi; it uses the hosted control plane + relay path.
