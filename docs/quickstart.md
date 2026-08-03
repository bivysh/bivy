# Quickstart

Zero to your first agent reply. Roughly five minutes.

Bivy runs a **node** on your own machine. The node is a data plane: it serves an
HTTP API and a WebSocket at `http://localhost:4317` and hosts no web UI. You
drive it from the terminal with the `bivy` CLI. A browser or phone UI is served
by a control plane — see [remote-access.md](remote-access.md).

## Prerequisites

- **Node.js 22.19 or newer.** Check with `node -v`. `npm` ships with it.
- **macOS or Linux.** The installer is a bash script, and the background service
  supports launchd (macOS) and `systemd --user` (Linux) only. Windows is not
  supported.
- **git** — recommended. Repo-backed sessions, worktrees, and `--clone` need it.
- **Build tools**, because Bivy compiles the native `node-pty` module if no
  prebuilt binary matches: `xcode-select --install` on macOS,
  `sudo apt-get install -y build-essential python3` on Debian/Ubuntu.

On Debian/Ubuntu the installer can install Node.js 22 for you if it is missing.

## 1. Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

This ensures a supported Node.js is present (installing it for you on
Debian/Ubuntu if needed), runs `npm install -g @bivy/bivy`, then launches the
`bivy setup` wizard. Node state lives at `~/.bivy`. (If the package isn't yet
on the registry, the installer falls back to a checksum-verified release
tarball — but npm is the primary path.)

If `~/.local/bin` is not on your `PATH` the installer warns you; add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

Already have the repo checked out?

```bash
git clone https://github.com/bivysh/bivy.git
cd bivy
npm install
npm run setup     # same wizard, via the bundled bivy CLI
```

## 2. What `bivy setup` asks

The wizard is short and account-free when you choose Local CLI. It picks defaults
for everything it can and asks how you want to use Bivy. Chosen for you, no prompt:

- **Workspace**: `~/bivy-workspace`. Changeable later in Settings.
- **Local port**: `4317`.
- **Default agent**: Pi. Changeable per session (`bivy run <agent>`) or in Settings.

Asked once, only if remote access is not configured yet:

1. **Usage mode** — `Bivy Cloud` (default; phone/browser access and one node is
   free), `self-hosted remote`, or `Local CLI only` (no account).
2. **Remote login** — only for a remote mode: GitHub (default) or an email
   sign-in link. Self-hosted mode also asks for the control-plane and relay URLs.

Local CLI mode skips account and relay enrollment entirely; enable remote access
later with `bivy relay:setup`. For remote modes, setup opens your browser (or
prints the URL on a headless box), enrolls this node, and writes
`.bivy/relay.json`. Finally, setup installs the background service so the node
keeps running after you close the terminal. It prints model-login and first-task
commands; remote mode also opens the app and prints a pairing QR.

## 3. Sign in to a model provider

Who owns model auth depends on the agent. **Pi (the default) and Aider** use
Bivy's credential vault:

```bash
bivy login
```

It asks whether to use a subscription (OAuth) or an API key, then which
provider. Skip the menu with `bivy login <provider>`.

**Claude Code, Codex, Gemini CLI, Qwen Code** own their own auth. Run their CLI
once and complete their login:

```bash
claude    # or: codex, gemini, qwen
```

Keys stay on the node. Never paste one into a chat or a support thread.

## 4. Run your first agent

```bash
bivy
```

Bare `bivy` launches the default agent as a managed, relay-visible session in
your terminal. Type a prompt, get a reply. Other useful forms:

```bash
bivy run claude              # a specific agent's native CLI/TUI
bivy run claude --name api   # name the session
bivy exec "what does src/server.ts do?"   # one-shot, prints to stdout
bivy sessions                # list live + saved sessions, pick one to resume
bivy resume                  # resume the most recent session
```

## 5. Reach it from a browser or phone

The node has no web UI. To get one, use the control plane you signed into during
setup:

```bash
bivy open     # open the web/PWA app in a browser
bivy link     # print a QR that pairs a phone or laptop with this node
```

The full story — architecture, PWA install, self-hosted relay, security model —
is in [remote-access.md](remote-access.md).

## 6. Next

```bash
bivy doctor    # deps, node reachability, model auth, relay, agents on PATH
bivy status    # config, service state, session and device counts
bivy logs -f   # tail the node logs
```

Something broken? [troubleshooting.md](troubleshooting.md). Want to run your own
control plane and relay? [self-host-quickstart.md](self-host-quickstart.md).
Curious what Bivy explicitly does *not* do yet? [faq.md](faq.md).
