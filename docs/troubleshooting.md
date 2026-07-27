# Troubleshooting

Symptom-first fixes for a Bivy node. Everything here runs on your own machine.

## First, run these three

```bash
bivy doctor      # deps, node reachability, model auth, relay, agents on PATH
bivy status      # config, service state, sessions, paired devices
bivy logs --n 100 # the last 100 lines the node printed
```

`bivy doctor` exits non-zero when Node.js is too old or the node is unreachable,
so it also works as a monitoring gate. `bivy status` exits non-zero when the node
is not reachable.

Useful paths:

- Node state (config, keys, sessions, logs): `~/.bivy`
  (in a git checkout it is `<checkout>/.bivy/`; older tarball installs kept it
  at `~/.bivy/app/.bivy/`)
- CLI config: `.bivy/cli.json` — workspace, port, env
- Relay enrollment: `.bivy/relay.json`
- Background log fallback: `.bivy/node.log`

---

## Install fails

**Symptom.** `curl … | bash` stops with an error before setup starts.

Diagnose the common causes in order:

```bash
node -v          # must be >= 22.19.0
command -v curl  # required by the installer
command -v git
```

**Fixes.**

- The installer needs `curl`. Install it and re-run.
- On Debian/Ubuntu it can install Node.js 22 for you. On other systems, install
  Node.js 22.19+ yourself and re-run.
- "Could not download release manifest for verification" — the installer refuses
  to install an unverified archive. Re-run; if you are deliberately installing a
  private or local artifact, that is what `BIVY_MANIFEST_URL` and
  `BIVY_RELEASE_VERIFY_KEY_PEM` are for.
- Native module build failure (`node-pty`, `node-gyp`): see
  [macOS: xcode-select](#macos-xcode-select-command-line-tools) and
  [Linux build tools](#linux-build-tools-missing) below.

## `bivy` not on PATH

**Symptom.** `bivy: command not found` after a successful install.

**Cause.** The installer symlinks `~/.local/bin/bivy`, but `~/.local/bin` is not
on your `PATH`.

```bash
ls -l ~/.local/bin/bivy
echo "$PATH"
```

**Fix.**

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

Or call it directly: `~/.bivy/app/bin/bivy.mjs status`. From a git checkout:
`npm run bivy -- status`.

## Node.js too old

**Symptom.** `Node.js 22.19+ is required (found v20.x)`.

```bash
node -v
which -a node
```

**Fix.** Install Node.js 22.19 or newer, then re-run the installer or
`bivy setup`. If you use a version manager, make sure the *login shell* the
background service inherits also resolves to the new Node — the service records
an absolute `node` path when it is installed, so re-run `bivy service install`
after upgrading Node.

## macOS: xcode-select Command Line Tools

**Symptom.** Dependency install fails building `node-pty` with a `node-gyp` or
compiler error on macOS.

```bash
xcode-select -p
```

**Fix.**

```bash
xcode-select --install
```

Then re-run the installer, or `bivy setup` if Bivy is already installed.

## Linux: build tools missing

**Symptom.** `Build tools are missing.` or a `node-gyp` failure on Linux.

```bash
command -v make; command -v g++; command -v python3
```

**Fix (Debian/Ubuntu).**

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
```

## Daemon won't start

**Symptom.** `bivy status` shows `not reachable`; commands report
"Could not start the Bivy node".

```bash
bivy service status
bivy logs --n 100
bivy start          # run in the foreground to see the real startup error
```

Running in the foreground is the fastest way to see the actual exception — the
background service swallows it into the log.

**Fixes.**

- Service installed but stopped: `bivy restart`.
- No service installed: `bivy service install`, or just run `bivy start`.
- Linux, node dies after you log out of SSH: the systemd user manager stopped
  with your session. Enable linger:
  ```bash
  sudo loginctl enable-linger "$USER"
  bivy service install
  ```
- Linux, `systemctl --user` cannot reach the user manager: SSH in directly as
  that user (not via `sudo -u`/`su`) and run `bivy service install` again.
- Port already taken: see the next section.

Where the logs live, by platform:

```bash
journalctl --user -u bivy.service -n 100 --no-pager   # Linux (systemd)
tail -n 100 /tmp/bivy.log /tmp/bivy.err.log           # macOS (launchd)
tail -n 100 ~/.bivy/node.log                          # fallback
```

`bivy logs [-f] [--n N]` picks the right one for you.

## Port 4317 in use

**Symptom.** The node exits immediately, and the log shows an
`EADDRINUSE`-style bind error on port 4317.

```bash
lsof -i :4317          # macOS / Linux
ss -ltnp | grep 4317   # Linux
```

**Fix.** Either stop whatever holds the port, or move Bivy. The port comes from
`.bivy/cli.json` (the daemon is started with `PORT` set from that file, so
exporting `PORT` in your shell will not override it):

```bash
# edit the "port" value, then:
bivy restart
```

A stale Bivy process from a previous run is the most common culprit; `bivy stop`
followed by `bivy restart` clears it.

## Agent CLI not found or won't install

**Symptom.** `bivy run codex` reports `Codex command not found: codex`, or
`bivy doctor` shows the default agent as not available.

```bash
bivy agents           # which agents are supported and which are installed
bivy agents --json
bivy doctor
```

**Fix.**

```bash
bivy agents:install         # install the bundled agents
bivy run pi                 # the built-in agent always works
```

Bivy installs agent CLIs globally under `~/.local` (`npm install --global
--prefix ~/.local`), so `~/.local/bin` must be on your `PATH` for them to
resolve. Aider needs `python3` and installs with `pip --user`.

For the built-in agents, Bivy resolves the command from your `PATH` (and from
npm's global bin), so the fix for "installed but not found" is to get the binary
onto `PATH`. To run something Bivy does not know about:

```bash
bivy run -- /full/path/to/agent --some-flag

# or register it under a new id (ID uppercased, non-alphanumerics become _):
BIVY_AGENT_MYAGENT_COMMAND=/full/path/to/agent \
BIVY_AGENT_MYAGENT_ARGS='["--some-flag"]' \
  bivy run myagent
```

## Model auth failures

**Symptom.** The agent replies with an authentication or 401 error, or
`bivy doctor` shows `model not configured`.

First, work out who owns auth for your agent — `bivy doctor` prints it:

- **Bivy-owned** (Pi, Aider): credentials live in Bivy's vault.
  ```bash
  bivy login              # subscription (OAuth) or API key, then pick a provider
  bivy login <provider>   # skip the menu
  ```
- **Agent-owned** (Claude Code, Codex, Gemini CLI, Qwen Code): run the agent's
  own CLI once and complete its login.
  ```bash
  claude    # or: codex, gemini, qwen
  ```

Notes:

- Restart the node after changing credentials: `bivy restart`.
- Never paste a model key into a chat window, an issue, or a support thread. If
  you did, rotate it at the provider immediately.
- API keys can also come from the environment (for example `ANTHROPIC_API_KEY`),
  but the vault is the supported path.

## Relay won't connect

**Symptom.** `bivy doctor` shows `remote local only`, or `relay configured` but
never `relay connected`.

```bash
bivy status
bivy doctor
bivy logs -f    # look for lines tagged [relay]
```

**Fixes.**

- Never set up: run `bivy relay:setup` and sign in.
- Configured but the running node has not picked it up: `bivy restart`.
- The node dials the relay outbound over WSS. If a corporate proxy or firewall
  blocks outbound WebSocket connections, the node will retry with exponential
  backoff (1s up to 30s) and never connect. Allow outbound WSS to your relay
  host.
- Self-hosted: confirm the control-plane URL answers and the relay URL is
  `wss://`. `bivy relay:setup` health-checks the control plane before it does
  anything else and tells you if it is unreachable.
- Work stops being picked up / a run is refused with a quota error: on the free
  plan you get 10 runs per rolling 7-day window, shared across every source (manual,
  app, GitHub work queue). The cap is soft — one run past the limit still
  goes through — but beyond that, wait for capacity to age back in (your oldest runs
  passing 7 days) or upgrade for unlimited runs. (Self-hosted stacks with
  `ENFORCE_ENTITLEMENTS` off are unlimited.)

## Phone can't reach the node

**Symptom.** The web/PWA app loads but shows the node offline, or the QR does
nothing.

```bash
bivy status   # is the node reachable and the relay configured?
bivy doctor   # does it say "relay connected"?
bivy link     # mint a fresh pairing QR
```

**Fixes.**

- The node must be running *and* connected to the relay. A node that is only
  reachable on `localhost` is not reachable from a phone — the node hosts no UI
  and there is no LAN/Wi-Fi direct path.
- Pairing secrets in a link are single-use. If you scanned an old QR, run
  `bivy link` again for a fresh one.
- Make sure you are signed into the same account on the phone that you used
  during `bivy relay:setup`.
- See [remote-access.md](remote-access.md) for the full flow.

## A session is stuck

**Symptom.** A session shows as working and never finishes, or a terminal is
wedged.

```bash
bivy sessions            # list live terminals and saved sessions with ids
bivy kill <id>           # stop a run-terminal, or abort the session's turn
bivy kill <id> --delete  # also delete the saved session
```

If the whole node is wedged:

```bash
bivy restart             # waits for active sessions to finish a turn
bivy restart --force     # don't wait
```

## Sessions missing after a restart or update

**Symptom.** `bivy sessions` and the app show fewer sessions than before.

**Cause.** Session state lives in the node's data directory. It survives updates,
but it does not survive a `bivy uninstall` without `--keep-sessions`, and it does
not follow you if the data directory moves.

```bash
ls ~/.bivy/metadata.json      # the durable session index
ls ~/.bivy/pi/sessions        # Pi transcripts
bivy sessions --json
```

**Fixes.**

- Agents that store sessions in their own locations (Claude Code, Codex, …) keep
  them there; if you reinstalled that agent, its history went with it.
- If you set `BIVY_DATA_DIR` at some point, set it the same way again — the node
  resolves all state from it.
- `bivy prune` deletes old sessions and worktrees by design. Check you did not
  run it with an aggressive `--keep`/`--older-than`; use `--dry-run` first next
  time.

## Update problems

**Symptom.** `bivy update` appears to hang, disconnects your terminal, or the
version does not change.

```bash
bivy update
bivy update:log     # output of the last (or in-progress) update
bivy doctor
```

**Notes and fixes.**

- Running `bivy update` from inside a Bivy web terminal detaches on purpose so
  it can survive the node restart. Progress is shown until the restart; the web
  terminal reconnects automatically. Run `bivy update:log` afterward to see any
  output produced during the restart.
- `bivy update` waits for active sessions to finish a turn. Use
  `bivy update --force` to skip the wait.
- The installer stages the new release and restores the previous one if anything
  fails, so a failed update should leave you running the old version. Check
  `bivy update:log` for the reason.
- Ownership errors during update: see the next section.

## Permissions and ownership

**Symptom.** "Cannot update: `~/.bivy/app` is not writable", or the service will
not start after an install done with `sudo`.

**Cause.** Bivy was first installed as root or as another user, so the install
directory and its state files are not owned by you.

```bash
ls -ld ~/.bivy/app ~/.bivy/app/.bivy
id -un
```

**Fix.** Reclaim ownership, then retry:

```bash
sudo chown -R "$USER" ~/.bivy/app
bivy update
```

Do not run the node as root. If you already did, create a normal user and
install there — `bivy setup` warns when you run it as root.

Bivy writes secrets with mode `600` (`cli.json`, `relay.json`, the credential
vault). If you copied state between machines, re-tighten it:

```bash
chmod 700 ~/.bivy
chmod 600 ~/.bivy/cli.json ~/.bivy/relay.json
```

---

## Starting over

```bash
bivy uninstall --dry-run          # show exactly what would be removed
bivy uninstall --keep-sessions    # remove Bivy, keep your transcripts
```

Then reinstall with the one-liner from [quickstart.md](quickstart.md).

## Reporting a problem

Open an issue at `https://github.com/bivysh/bivy` with:

- OS and CPU (`uname -a`), and `node -v`
- the exact command you ran
- the last ~100 lines of `bivy logs --n 100`
- `bivy doctor` output

Redact anything sensitive first. Logs can contain file paths and prompt text.
Never include model keys, tokens, or the contents of `.bivy/relay.json`.

For a suspected security vulnerability, follow [SECURITY.md](../SECURITY.md)
rather than opening a public issue.
