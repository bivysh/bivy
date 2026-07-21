# Install notes

The recommended path is:

- Mac/local: run the daemon locally and use the browser UI.
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
2. downloads the prebuilt release **tarball** and installs it into `~/.bivy/app`
   (staged first, so a failure leaves your existing install untouched; your
   local state in `.bivy/` is preserved across updates),
3. installs production dependencies (`npm ci --omit=dev`),
4. symlinks a `bivy` command into `~/.local/bin`,
5. launches the interactive `bivy setup` wizard (or, on an existing install,
   restarts the service). Setup asks which agent you want as the default and
   installs only that agent for a fast first run. Set `BIVY_INSTALL_ALL_AGENTS=1`
   if you want the installer to preinstall every bundled runtime.

Override defaults with environment variables:

```bash
# Point at your own release artifact / install location:
BIVY_TARBALL_URL=https://example.com/bivy-latest.tar.gz BIVY_HOME=~/.bivy/app \
  bash install.sh
```

`BIVY_MANIFEST_URL` overrides the checksum/signature manifest. The installer
requires a manifest with a matching `sha256` by default and is wired to require
an Ed25519 manifest signature for production releases. Until Bivy's production
release public key is embedded in the served installer, trusted internal tests can
set `BIVY_ALLOW_UNSIGNED_MANIFEST=1`; set `BIVY_ALLOW_UNVERIFIED_INSTALL=1` only
for a fully trusted internal artifact. `BIVY_RELEASE_VERIFY_KEY_PEM` overrides
the embedded public key for private/self-hosted release channels.

## The setup wizard

`bivy setup` (run by the installer, or `npm run setup` in an existing checkout)
asks a few questions and leaves you with a running node:

- default workspace folder and UI port,
- default agent: Pi, Claude Code, Codex, OpenCode, Gemini CLI, or Aider,
- model/provider credentials only when the chosen default agent needs Bivy-managed auth (Pi/Aider); Claude Code/Codex/Gemini can use their own CLI login,
- secure remote web/PWA access by default (one-click GitHub/email sign-in; free accounts include one hosted relay node),
- optional auto-start background service (launchd/systemd).

It writes CLI config to `.bivy/cli.json` (chmod 600) so `bivy start` and
the background service reuse the same workspace/port/credentials.

## App-first setup path

You can start from the hosted app first:

1. Open the Bivy PWA and sign in with GitHub or email.
2. If no runner is connected, the app shows two paths:
   - **Connect your own computer** — run `curl -fsSL https://bivy.sh/install.sh | bash` on macOS/Linux. Setup signs the node into the same account and enrolls it on the hosted relay.
   - **Quick ephemeral server** — use the in-app ephemeral machine flow to launch a short-lived server for trial work.
3. Free accounts include one hosted-relay node, so the first computer can connect without upgrading.

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
`BIVY_HOSTED_DOMAIN=bivy.sh` (the node derives `app.` and `relay.`
subdomains), or override individually with `BIVY_CONTROL_PLANE_URL` /
`BIVY_RELAY_URL`.

To pair a remote browser/PWA, open the local UI sidebar → **Link remote device** → scan the QR or open the link. To revoke a linked device, remove it under Settings → **Signed-in devices** (the room key rotates for the remaining devices); remove them all to revoke everyone.

## Mac development install

```bash
git clone <repo>
cd bivy
npm install
npm run setup     # or: npm start
```

Open:

```txt
http://localhost:4317
```

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
2. Open the local UI with `bivy open`.
3. Choose **Link remote device** and scan/open the hosted sign-in link.
4. On iOS Safari, tap Share → Add to Home Screen.

The phone/browser never connects directly to the node over LAN/Wi-Fi; it uses the hosted control plane + relay path.
