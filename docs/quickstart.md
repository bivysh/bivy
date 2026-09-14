# Quickstart

Zero to your first agent reply. Start in your browser or phone.

## Recommended: start in the web app

1. Open **[app.bivy.sh](https://app.bivy.sh)** and sign in (or open your
   self-hosted Bivy app).
2. **Connect a Machine** shows a personalized install command. On your Mac or
   Linux computer, open a terminal inside the repository you want to work on
   and paste it. The single-use command expires after 10 minutes and authorizes
   machine enrollment only—not access to your account. Keep it private.
3. Installation enrolls the machine, chooses an installed agent where available,
   and starts the background service without a second Bivy login. Existing
   agent authentication stays in place; an agent without credentials still
   needs its own login or a supported provider connection.
4. Keep the web app open. It checks for your machine automatically and opens
   the newly enrolled machine when it comes online. If several machines are
   already connected, you can choose one explicitly.
5. Confirm a suggested repository, browse your available GitHub repositories,
   or use the machine's default workspace. **Use starter task** fills in a
   request to explain the repository and its tests without changing files.
   Review or edit the prompt, then send it. A prompt isn't a sandbox guarantee;
   check the session's protection setting before running work.
6. Read the answer, steer the session, and review any changes or artifacts in
   the same interface.

Your agents run on your machine, using your existing environment. **Keep it
awake and online** while work runs. Starting on a phone still requires access
to a computer terminal for the installation step.

If the command expires, choose **Create new install command**. If installation
fails, follow the terminal's recovery instructions; **Other ways to install**
also offers the ordinary installer with sign-in on the machine.

## Alternative: start from the terminal

Bivy runs a **node** on your own machine. The node serves an HTTP API and a
WebSocket at `http://localhost:4317` and hosts no web UI. A browser or phone UI
is served by the hosted or self-hosted app—see [remote-access.md](remote-access.md).
The CLI-only path below does not require an account.

## Prerequisites

- **Node.js 20 or newer.** Check with `node -v`. `npm` ships with it.
- **macOS or Linux.** The installer is a bash script, and the background service
  supports launchd (macOS) and `systemd --user` (Linux) only. Windows is not
  supported.
- **git** — recommended. Repo-backed sessions, worktrees, and `--clone` need it.
- **Build tools** are needed when the required `node-pty` terminal dependency
  has no matching prebuilt binary. On macOS, run `xcode-select --install`.
  On Debian/Ubuntu, the installer installs missing `build-essential` and
  `python3` packages for you. Other Linux distributions need `make`, a C++
  compiler, and Python 3.

On Debian/Ubuntu the installer can install Node.js 22 for you if it is missing.

## 1. Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

This ensures a supported Node.js is present (installing it for you if needed —
the README's [Install](../README.md#install) section lists exactly when it uses
`sudo`), runs `npm install -g @bivy/bivy`, then launches the `bivy setup`
wizard. Node state lives at `~/.bivy`.

If `~/.local/bin` is not on your `PATH` the installer warns you; add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

Already have the repo checked out?

```bash
git clone https://github.com/bivysh/bivy.git
cd bivy
pnpm install
pnpm run setup     # same wizard, via the bundled bivy CLI
```

## 2. What `bivy setup` asks

The wizard is short and picks infrastructure defaults wherever it can. Chosen
for you, with no prompt:

- **Workspace**: `~/bivy-workspace`. Changeable later in Settings.
- **Local port**: `4317`.

The wizard asks:

1. **Default agent** — Claude Code (default), Codex, or another supported
   runtime under *More agents*. Change it later per session
   (`bivy run <agent>`) or in Settings.
2. **Remote access** — `hosted` (default: the control plane at `app.bivy.sh`;
   free tier plus a paid plan, see [bivy.sh#pricing](https://bivy.sh#pricing)),
   `self-hosted` (your own control plane + relay — it then asks for the
   **control plane URL** and **relay `ws(s)://` URL**), or `local only for now`
   (skip enrollment; the CLI works, `bivy open` will tell you to run
   `bivy login` when you want a browser or phone). Skipped when remote
   access is already configured. Whatever you pick, execution and session
   history stay on your machine.
3. **Remote login** (hosted / self-hosted only) — `GitHub` (default) or an
   `email sign-in link`. Choosing email then asks for your **account email**.
4. **Model login** — if the selected agent is not authenticated yet, setup
   offers to open its login flow now. You can decline and authenticate later.

For remote access, setup opens your browser (or prints the URL on a headless box)
so you can authorize, waits for you to finish, enrolls this node, and writes
`.bivy/relay.json`. If it fails it offers to retry; you can decline and run
`bivy login` later. Finally, with no prompt, setup installs the background
service so the node keeps running after you close the terminal. It prints the
model-login and first-task commands, a pairing QR, and opens the app.

## 3. Sign in to a model provider

Most agents own their own auth. **Claude Code, Codex, Pi, Gemini CLI, Qwen
Code** and the other picker agents: run their CLI once and complete their login
(Pi uses `/login` inside `pi`):

```bash
claude    # or: codex, pi, gemini, qwen
```

A few integrations (Aider today) take credentials from Bivy's vault instead:

```bash
bivy provider login
```

It asks whether to use a subscription (OAuth) or an API key, then which
provider. Skip the menu with `bivy provider login <provider>`. `bivy doctor` tells you
which applies to your agent.

Keys stay on the node. Never paste one into a chat or a support thread.

## 4. Run your first agent

Start inside a real repository so the agent immediately has useful context:

```bash
cd your-repo
bivy run claude
```

First prompt to try:

```text
Explain this repository and suggest one small, safe improvement.
```

`bivy run <agent>` launches that agent as a managed, relay-visible session in
your terminal. Type a prompt, get a reply. Bare `bivy` shows the command
overview. Other useful forms:

```bash
bivy run codex               # a different agent's native CLI/TUI
bivy run claude --name api   # name the session
bivy exec "what does src/server.ts do?"   # one-shot, prints to stdout
bivy sessions                # list live + saved sessions, pick one to resume
bivy resume                  # resume the most recent session
```

## 5. Reach it from a browser or phone

The node has no web UI. To get one, use the control plane you signed into during
setup (or, if you chose *local only*, run `bivy login` first):

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
