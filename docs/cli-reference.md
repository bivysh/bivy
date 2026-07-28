# `bivy` CLI reference

Complete reference for the `bivy` command. Every command here is dispatched by
`bin/bivy.mjs`.

Run `bivy help` for the short version. Run `bivy completions <bash|zsh|fish>` to
get shell completion.

## I want to…

| I want to… | Command |
| --- | --- |
| Set up a new node | `bivy setup` |
| Start an agent in my terminal | `bivy` or `bivy run <agent>` |
| See what's running and rejoin it | `bivy sessions` |
| Rejoin the last session | `bivy resume` |
| Ask one question and get one answer | `bivy exec "…"` |
| Continue an existing session non-interactively | `bivy send <id> "…"` |
| Stop a session | `bivy kill <id>` |
| Use the web/PWA app | `bivy relay:setup` then `bivy open` |
| Pair my phone | `bivy link` |
| Run an agent on another machine | `bivy nodes add …` then `bivy run <agent> --node <name>` |
| Make typing `claude` remote-visible | `bivy shim install claude` |
| Keep the node running in the background | `bivy service install` |
| See why something is broken | `bivy doctor`, then `bivy logs -f` |
| Store an API token safely | `bivy secrets set <id>` |
| Turn on voice input | `bivy voice key groq` |
| Connect GitHub issue pickup | `bivy github:app-create` |
| Reclaim disk | `bivy prune` |
| Upgrade | `bivy update` |
| Remove Bivy | `bivy uninstall` |

## Conventions

- Flags are parsed positionally by each command. Most accept both `--flag value`
  and `--flag=value`.
- Commands that talk to the node will start it if it is not already running
  (via the installed background service, or as a detached background process).
- Commands that need the node authenticate with a device token minted from
  `<data-dir>/bootstrap.json`. If that file is missing, restart the node.
- `<data-dir>` is the Bivy state directory. See
  [configuration.md](configuration.md) for how it is resolved.

## Getting started

### `bivy setup`

Aliases: `bivy init`.

First-run wizard. Not idempotent-hostile — safe to re-run.

Steps, in order:

1. Checks Node.js >= 22.19.0 and installs npm dependencies if needed.
2. Picks a workspace (defaults to `~/bivy-workspace`, created if absent) and a
   local port (default `4317`). Written to `<data-dir>/cli.json`.
3. Records the default agent (`pi` unless already set) and installs its CLI if
   it is not Pi.
4. If `<data-dir>/relay.json` does not exist yet, asks for a remote sync target
   (hosted or self-hosted) and a sign-in method (GitHub or email link), then
   runs `relay:setup`.
5. Installs the background service (launchd on macOS, systemd `--user` on
   Linux) and starts it.
6. Opens the remote web app in a browser if one is available.

Takes no flags. Warns if run as root.

```bash
bivy setup
```

### `bivy` (no arguments)

If `<data-dir>/cli.json` exists, this is the same as `bivy run` with no agent —
it launches the default agent. If it does not exist, it runs `bivy setup`.

### `bivy completions <bash|zsh|fish>`

Alias: `bivy completion`.

Prints a completion script to stdout. Completes top-level commands, and agent
ids after `run`.

```bash
eval "$(bivy completions bash)"    # ~/.bashrc
eval "$(bivy completions zsh)"     # ~/.zshrc
bivy completions fish > ~/.config/fish/completions/bivy.fish
```

## Running agents

### `bivy run [agent] [flags] [-- command…]`

Launches an agent inside a PTY owned by the node. The agent's real TUI runs in
your terminal, but because the node owns the PTY the same live session is
visible and drivable from the web/PWA app, and resumable later with
`bivy resume`.

Built-in runnable agent ids: `pi`, `claude`, `openclaw`, `codex`, `opencode`,
`aider`, `hermes`, `goose`, `gemini`, `qwen`, `cline`, `crush`, `cursor`,
`copilot`, `grok`, `amp`, `auggie`, `droid`, `continue`, `kilocode`, `rovodev`,
and `codebuff`. Run `bivy agents` for the live list, installation status, and
binary names; the web picker intentionally hides experimental agents that do not
yet meet its headless-session requirements.

If an agent's CLI is missing and its manifest declares an npm package, Bivy
installs it on first use into `~/.local`. Other agents must already be on PATH.

Flags (consumed by Bivy; everything else is forwarded to the agent):

| Flag | Meaning |
| --- | --- |
| `--name <label>` | Session label shown in `bivy sessions` and the app |
| `--model <model>` | Recorded as run-terminal metadata **and** prepended to the agent's args as `--model <model>`. Not injected for the `-- <command>` form |
| `--node <name>` | Start the session on another registered node instead (see `bivy nodes`) |
| `--workspace <dir>` | Start in an existing directory. Must exist |
| `--clone` | Clone the current folder's `origin` remote (or the local checkout if there is no remote) into `<data-dir>/workspaces/<repo>-<rand>` and start there |
| `--clone <remote>` | Clone that remote instead. A value is treated as a remote if it looks like a URL, `owner/repo`, a path, or ends in `.git` |

Everything after a bare `--` is passed through untouched.

`--clone` and `--workspace` cannot be combined with `--node` — the checkout
would only exist on the local machine.

For `claude`, Bivy pins a session UUID at launch (`--session-id`) unless you
already passed `--session-id`, `--resume`, `-r`, `-c`, or `--continue`. It
prints the pinned id so you can resume in a plain terminal later.

```bash
bivy run claude
bivy run codex --name "auth refactor"
bivy run gemini --model gemini-2.5-pro
bivy run claude --clone git@github.com:acme/api.git
bivy run aider --workspace ~/src/api
bivy run claude --node work
bivy run -- npm run my-agent
```

### `bivy agents [--json]`

Lists the built-in agent ids, their display names, whether the CLI is installed,
and its resolved path. `--json` prints a machine-readable object.

```bash
bivy agents
bivy agents --json
```

### `bivy agents:install`

Alias: `bivy runtimes:install`.

Installs the bundled agent runtimes: the Claude Agent SDK (into the Bivy
install), and — as user-global npm/pip installs under `~/.local` — Claude Code,
Codex, OpenCode, Aider, Hermes and Gemini CLI. Failures are non-fatal.

Skipped entirely when `BIVY_SKIP_AGENT_PREINSTALL=1`.

```bash
bivy agents:install
```

### `bivy exec "<prompt>" [flags]`

One-shot headless run. Creates (or resumes) a session, sends one prompt, waits
for the turn to end, prints the final answer to stdout, exits. Progress goes to
stderr, so stdout is pipe-clean.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a`, `--agent <id>` | node default | Agent to run |
| `--session <ref>` | — | Resume an existing session instead of creating one |
| `--json` | off | Print `{"sessionId":…,"answer":…}` instead of raw text |
| `--timeout <seconds>` | 600 | Give up after this long. Env: `BIVY_EXEC_TIMEOUT_MS` |
| `--url <url>` | node URL | Node base URL. Env: `BIVY_URL` |
| `--token <token>` | minted | Device token. Env: `BIVY_DEVICE_TOKEN` |

A prompt of `-`, or no prompt with non-TTY stdin, reads the prompt from stdin.

Exit codes: `0` on a completed turn, `1` on timeout/error/disconnect, `2` when
no prompt was supplied.

```bash
bivy exec "summarize README.md"
bivy exec --agent claude "what does src/server.ts do?"
echo "explain this diff" | git diff | bivy exec -
bivy exec --json "list the open TODOs" | jq -r .answer
```

### `bivy send <id> "<message>"`

Sends a prompt to an existing session and streams the reply. Thin wrapper over
the same client `bivy exec` uses, with `--session <id>`.

```bash
bivy send 3f1c9a02-… "now add a test for that"
```

### `bivy takeover <termId|session-id>`

"Continue as chat." Stops the native TUI running in a pinned run-terminal
(started by `bivy run` or an agent shim) and reopens its pinned session as a
governed chat you can drive from the app. A bare UUID is treated as a session
id; anything else as a run-terminal id.

```bash
bivy takeover 3f1c9a02-6b41-4a0f-9c2e-5d7f1b0a8e33
```

## Sessions

### `bivy sessions [selector] [flags]`

Alias: `bivy ls`.

Lists live run-terminals first, then every saved session (most recently active
first) — not just the currently active ones, so any of them can be resumed.
With no selector and no `--json`, prompts you to pick one to resume.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--limit <n>` / `--n <n>` | unlimited | Cap how many saved sessions to list |
| `--json` | off | Print the list as JSON and exit without resuming |

`selector` is either a 1-based index into the printed list, or a session
id / terminal id.

Note: the short form is `--n`, not `-n`.

```bash
bivy sessions
bivy sessions --limit 40
bivy sessions --json | jq '.[] | select(.kind=="live")'
bivy sessions 3
```

### `bivy resume [selector]`

Same as `bivy sessions`, but with no selector it resumes the most recent entry
instead of prompting.

Resuming a live run-terminal binds your terminal to the existing PTY and
replays scrollback. Resuming a saved session relaunches it through `bivy run`
using the agent's own native resume — currently only Claude Code
(`claude --resume <id>`) and Codex (`codex resume <id>`) have a native terminal
resume. Other runtimes print a note telling you to open the session in the web
app.

```bash
bivy resume
bivy resume 2
bivy resume 3f1c9a02-6b41-4a0f-9c2e-5d7f1b0a8e33
```

### `bivy kill <id> [--delete]`

Stops a session or run-terminal. A live run-terminal's PTY is closed. Otherwise
the id is treated as a durable session id and the current turn is aborted.

`--delete` (alias `--rm`) also removes the saved session.

```bash
bivy kill 7c1f2a
bivy kill 3f1c9a02-… --delete
```

### `bivy promote <session-id>`

Advanced / failover. Promotes a warm-replicated session so it continues on
**this** node — run it on the standby node that holds the replica after the
original owner goes offline. It runs against the local node, which performs the
control-plane epoch compare-and-set and materializes the replica worktree. On
success it prints the new epoch and the `bivy resume` command to continue. See
[session-replication.md](session-replication.md).

```bash
bivy promote 3f1c9a02-6b41-4a0f-9c2e-5d7f1b0a8e33
```

## Nodes and remote access

### `bivy relay:setup [flags]`

Enables remote web/PWA access. Signs into a control plane, enrolls this node,
and writes `<data-dir>/relay.json` with the relay URL, control-plane URL, client
base URL and an enrollment token.

If you pass none of `--email`, `--session-token` or `--github`, it asks
interactively whether to sign in with GitHub.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--github` | chosen when no email/session token | Sign in with GitHub (device flow) |
| `--email <addr>` | `$BIVY_EMAIL` | Sign in with an emailed magic link |
| `--session-token <tok>` | `$BIVY_SESSION_TOKEN` | Skip sign-in; use an existing account session |
| `--control-plane <url>` | `$BIVY_CONTROL_PLANE_URL`, else the baked-in hosted endpoint | Self-host target |
| `--relay <url>` | `$BIVY_RELAY_URL`, else the baked-in hosted endpoint | Relay `ws(s)://` URL |
| `--client <url>` | `$BIVY_CLIENT_BASE_URL`, else the baked-in hosted endpoint | Where the web app is served |
| `--emit-session <path>` | — | Internal. Write the account session to a `0600` file for `bivy setup` to consume |

On plans that cap the number of nodes, if you are at the limit it offers to
remove an existing node first.

After success it restarts the background service, or hot-reloads a running node
via `/api/relay/reload`.

```bash
bivy relay:setup
bivy relay:setup --email you@example.com
bivy relay:setup --control-plane https://cp.example.com --relay wss://relay.example.com --github
```

### `bivy open`

Opens the remote web/PWA app in a local browser. Prefers, in order: an account
sign-in URL (only right after `bivy setup`), a freshly minted node-scoped paired
link, then the plain remote base URL. Prints the URL when there is no browser.

Requires the relay/control plane — run `bivy relay:setup` first. The node itself
does not serve a UI.

### `bivy link`

Prints a QR code (and the URL) for a node-scoped paired link. Scan it with a
phone to pair that device with this node. Requires the node to be running and
the relay to be configured.

```bash
bivy link
```

### `bivy token`

Mints and prints a device token for **this** node to stdout. Copy it to another
machine and register this node there with `bivy nodes add`.

```bash
bivy token
```

### `bivy nodes [add|remove] …`

Manages the direct-node registry in `<data-dir>/nodes.json` — other Bivy nodes
this machine can reach directly over LAN, Tailscale, VPN or an SSH tunnel.

```bash
bivy nodes                                              # list
bivy nodes add work http://10.0.0.5:4317 --token <tok>   # register
bivy nodes remove work                                   # or: rm
```

`bivy nodes` with no subcommand lists direct nodes with a reachability check.
If the relay is configured it also lists the account's nodes from the control
plane.

**Limitation:** `bivy run --node <name>` only works over a *direct* route. A
node that is registered to your account but has no entry in `nodes.json` cannot
be targeted — relay-tunnelled CLI routing is not implemented yet, and the error
message tells you to add a direct URL.

### `bivy shim install|uninstall|status [agent] [flags]`

Alias: `bivy listen`.

Installs a shim that shadows an agent binary on `PATH`, so typing `claude`
launches its native TUI inside a Bivy-owned PTY (remote-visible, resumable)
instead of a bare process. Headless invocations — non-TTY stdin, or a one-shot
flag like `claude -p` — pass straight through to the real binary, so scripts and
CI are never intercepted.

`install` (alias `add`):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dir <dir>` | `~/.local/bin` (or `$BIVY_NPM_GLOBAL_PREFIX/bin`) | Where to write the shim |
| `--headless "<flags>"` | per-agent list | Space-separated flags that mean "this call is headless, pass through" |
| `--force` | off | Install even if the real binary is missing, or overwrite a non-shim file |

Default headless flags: `claude` `-p --print`; `codex` `exec --json`;
`gemini`/`qwen` `-p --prompt`; `aider` `--message --msg`; `goose`/`opencode`/
`crush` `run`; `cline` `-y --yolo --no-interactive --json`; anything else
`-p --print`.

Installing also manages a marked block at the end of your shell rc file so the
shim dir wins on `PATH` in new shells, and verifies that it actually does.

`BIVY_SHIM_DISABLE=1 claude` bypasses an installed shim for one invocation.

`uninstall` (aliases `remove`, `rm`) refuses to delete any file that does not
carry the Bivy shim marker, then reconciles the managed `PATH` block.

With no subcommand, prints the installed shims and whether each one currently
wins on `PATH`.

`pi` cannot be shimmed — it is Bivy's own built-in runtime, not a standalone
binary.

```bash
bivy shim install claude
bivy shim install codex --dir ~/bin
bivy shim
bivy shim uninstall claude
```

## Secrets and credentials

### `bivy login [args…]`

Signs into a model provider and stores the credential in the node's shared,
agent-neutral credential vault (`<data-dir>/credentials`). Interactive: it lists
providers and runs either an OAuth flow or an API-key prompt. Arguments are
passed through to the login helper.

This is for agents whose model auth Bivy owns (Pi, Aider). Agents with their own
native auth (Claude Code, Codex, Gemini CLI, Qwen) should be signed in with
their own CLI.

```bash
bivy login
```

### `bivy secrets <subcommand>`

Alias: `bivy secret`.

The node's secret vault. Local secrets are AES-256-GCM encrypted in
`<data-dir>/secrets.json` with the key in `<data-dir>/secrets.key` (both
`0600`). References are stored instead of values for `op://` (1Password) and
`env://` (environment variable).

| Subcommand | What it does |
| --- | --- |
| `bivy secrets list` | List ids, backends and update times. Values are never printed |
| `bivy secrets set <id> [value]` | Store an encrypted local secret. Prompts (hidden) if the value is omitted |
| `bivy secrets ref <id> <op://…\|env://VAR>` | Store a reference instead of the raw secret |
| `bivy secrets delete <id>` | Remove it (alias `rm`) |
| `bivy secrets resolve <id>` | Verify it resolves; prints the byte length, not the value |
| `bivy secrets doctor` | Run vault health checks. Exits non-zero on failure |

Well-known ids: `github.repo-token`, `model.anthropic`, `model.openai`,
`integration.github`.

```bash
bivy secrets set github.repo-token
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets ref model.openai env://OPENAI_API_KEY
bivy secrets doctor
```

### `bivy voice <subcommand>`

Alias: `bivy stt`.

Configures speech-to-text (voice input in the web app). Keys are stored in the
same encrypted vault.

| Subcommand | What it does |
| --- | --- |
| `bivy voice status` | Show the preferred provider and which keys are set |
| `bivy voice provider <groq\|openai>` | Choose the preferred provider |
| `bivy voice key <groq\|openai> [key]` | Store an API key. Prompts (hidden) if omitted |
| `bivy voice remove <groq\|openai>` | Forget a stored key |

Note: bare `bivy voice` prints usage, not status. Use `bivy voice status`.

```bash
bivy voice key groq
bivy voice provider openai
bivy voice status
```

## GitHub

These wire up the GitHub work queue: Bivy picks up labelled issues, works them
on a node, and opens pull requests.

### `bivy github:app-create [--org <org>]`

One-click GitHub App creation. Opens
`http://localhost:<port>/github/app/manifest/new` in a browser. GitHub creates
the app and hands the code back to the node, which exchanges it and keeps the
private key locally.

Requires the node to be running. On a headless server it prints three
alternatives instead: do it from the web app, drive it through an SSH tunnel, or
create the app manually and use `github:app-connect`.

```bash
bivy github:app-create
bivy github:app-create --org acme
```

### `bivy github:app-connect --app-id <id> --key <path.pem>`

Connects an existing GitHub App. The private key goes into the node's secret
vault; only a `secret://` reference is written to `cli.json`.

```bash
bivy github:app-connect --app-id 123456 --key ~/Downloads/bivy.private-key.pem
```

### `bivy github:app-sync [on|off]`

Opts this node into (or out of) cross-node GitHub App private-key sync
(issue #88): apps connected on one opted-in node are pushed, E2E-encrypted,
to the account's other opted-in nodes, and this node pulls apps connected
elsewhere. The control plane only ever stores ciphertext and per-node wrapped
vault keys — never a plaintext key — the same guarantee `github:app-connect`
already gives a single node. Off by default: a GitHub App key is a repo-write
credential, so which nodes hold it is a deliberate per-node opt-in, not
automatic like model/provider auth sync. See
[credential-sync.md](credential-sync.md#3-github-app-private-keys).

No argument prints the current on/off status and which apps this node holds.

```bash
bivy github:app-sync         # status
bivy github:app-sync on
bivy github:app-sync off
```

Restart the node (`bivy restart`) to apply a change.

### `bivy github:connect [owner/repo]`

Alias: `bivy connect-repo`.

Runs a GitHub OAuth device flow and stores a repo-scoped token in the vault as
`github.repo-token`; `cli.json` gets only the `secret://` reference. Pass
`owner/repo` to also set that repo for issue pickup.

```bash
bivy github:connect
bivy github:connect acme/api
```

## Service management

The background service is a launchd user agent (`dev.bivy`, macOS) or a systemd
user unit (`bivy.service`, Linux). Windows is not supported — use `bivy start`.

The unit is generated from `cli.json` at install time and bakes in `PORT`,
`BIVY_WORKSPACE`, `BIVY_DATA_DIR`, everything in `cli.json`'s `env` block, and a
`PATH`. Secret references in `env` are resolved before the process starts.

### `bivy start`

Alias: `bivy dev`.

Runs the node daemon in the foreground. Ctrl+C stops it. Exits with the
daemon's exit code.

### `bivy stop`

Stops the background service.

### `bivy restart [--force|--no-wait]`

Restarts the background service. First waits for in-flight agent turns to
finish, polling `/api/status`; `--force` (or `--no-wait`) skips the wait. The
wait is capped by `BIVY_UPDATE_WAIT_TIMEOUT_MS` (default 30 minutes; `0`
disables waiting).

### `bivy service install|uninstall|status`

- `install` — writes the unit/plist, enables and starts it, records
  `service: true` in `cli.json`. On Linux it also tries `loginctl enable-linger`
  so the node survives logout. Refused for ephemeral `npx bivy` runs.
- `uninstall` (alias `remove`) — stops, disables and deletes the unit.
- `status` — prints a one-line service status.

```bash
bivy service install
bivy service status
```

## Diagnostics

### `bivy status [--json]`

Prints the node URL and reachability, workspace, service status, whether the
relay is configured, and — when reachable — session/device/approval counts and
the guard mode. With the relay configured it also shows the account plan and
node count.

**Exits non-zero when the node is not reachable**, so it works as a health gate
in scripts.

```bash
bivy status
bivy status --json | jq .reachable
```

### `bivy doctor`

Health screen: Node.js version, `git`, node reachability, background service,
default agent availability, model credential, relay, and which agent CLIs are on
`PATH`.

Exits non-zero when a **hard** check fails (unsupported Node.js, or the node is
unreachable). `git`, the service, the model and the agent list only warn.

```bash
bivy doctor
```

### `bivy logs [-f] [--n <lines>]`

Tails the node's output from wherever it lands: the systemd journal
(`journalctl --user -u bivy.service`), the launchd log files (`/tmp/bivy.log`,
`/tmp/bivy.err.log`), or `<data-dir>/node.log` from a background `bivy start`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-f`, `--follow` | off | Stream new output |
| `--n <n>`, `--lines <n>` | 80 | How many lines of history |

Note: the short form is `--n`, not `-n`.

```bash
bivy logs
bivy logs -f
bivy logs --lines 500
```

## Maintenance

### `bivy update [--force|--no-wait]`

Updates Bivy, reinstalls dependencies, installs bundled agents, and restarts the
service. Waits for busy sessions first unless `--force`/`--no-wait`.

What it actually does depends on how Bivy was installed:

- **git checkout** — `git pull --ff-only`, then `npm ci`/`npm install`.
- **`npm i -g bivy`** — `npm install -g bivy@latest`.
- **`npx bivy`** — nothing; explains that npx always fetches the latest.
- **installer tarball** — re-runs `curl -fsSL https://bivy.sh/install.sh | bash`
  with `BIVY_HOME` pointing at the current install. The restart happens inside
  the installer.

Inside a Bivy web/PWA terminal (`BIVY_TERMINAL=1`) the update re-execs itself
detached, logs to `<data-dir>/update.log`, and mirrors live progress into the
terminal until the node restarts. The web terminal reconnects automatically;
the detached process survives the restart and finishes the update.

```bash
bivy update
bivy update --force
```

### `bivy update:log [-f]`

Prints the tail (last 64 KiB) of `<data-dir>/update.log`. `-f`/`--follow`
streams new output. This is how you confirm a detached `bivy update` finished.

```bash
bivy update:log
bivy update:log -f
```

### `bivy prune [flags]`

Alias: `bivy clean`.

Reclaims disk on this node: saved sessions (the metadata index plus the owning
agent's transcript), ephemeral `--clone` checkouts under
`<data-dir>/workspaces`, and git worktrees under `*/.bivy/worktrees`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--keep <n>` | see below | Keep the newest N of each selected kind |
| `--older-than <spec>` | — | Only remove items older than this. `7d`, `12h`, `30m`, `45s`, `2w`, or a bare number = days |
| `--sessions` | all kinds | Limit to saved sessions |
| `--workspaces` | all kinds | Limit to `--clone` checkouts |
| `--worktrees` | all kinds | Limit to git worktrees |
| `--data-dir <dir>` | resolved data dir | Where to look |
| `--workspace <dir>` | configured workspace | Extra root to scan for worktrees |
| `--dry-run` | off | List, delete nothing |
| `-y`, `--yes` | off | Skip the confirmation prompt |
| `--json` | off | Machine-readable output. Implies `-y`, and still deletes unless `--dry-run` |
| `-h`, `--help` | — | Detailed help |

With both `--keep` and `--older-than`, an item is removed only when it is
**both** beyond the newest N **and** older than the age — the safe intersection.

With neither, the default is keep newest **10 sessions**, **3 workspaces**,
**3 worktrees**. Workspaces and worktrees are full checkouts, so a uniform
keep-10 reclaims almost nothing.

Worktrees backing a live agent are never pruned while the node is reachable.
Session deletion is routed through the running node when possible so its
in-memory index cannot resurrect deleted rows.

```bash
bivy prune --dry-run
bivy prune --keep 10
bivy prune --older-than 7d --yes
bivy prune --worktrees --keep 1
```

### `bivy uninstall [flags]`

Removes Bivy and its data from this machine.

| Flag | Meaning |
| --- | --- |
| `-y`, `--yes` | Skip the confirmation prompt |
| `--dry-run` | Show what would be removed, delete nothing |
| `--keep-sessions` | Keep the Pi transcripts and the session index |
| `--keep-worktrees` | Leave git worktrees in your repos untouched |
| `-h`, `--help` | Detailed help |

It offers to deregister the node from your Bivy account, stops and removes the
background service, kills a running node, removes Bivy-created git worktrees
(and prunes their git registration), deletes the app install plus all local
state, and removes the `~/.local/bin/bivy` symlink.

A git checkout keeps its source — only the `.bivy` state directory is removed.

```bash
bivy uninstall --dry-run
bivy uninstall --keep-sessions -y
```

## Internal

### `bivy mcp-proxy [args…]`

The Universal Agent Harness MCP proxy. Launched by an agent in front of its MCP
servers; its stdin/stdout **are** the JSON-RPC stream. Not intended to be run by
hand.

## Notes on requirements

- **Needs the relay / control plane:** `relay:setup`, `open`, `link`. Also the
  account-nodes listing in `bivy nodes` and the plan line in `bivy status`.
- **Needs the node running:** `token`, `takeover`, `exec`, `send`, `kill`,
  `sessions`, `resume`, `link`, `github:app-create`. Most of these will start it
  for you.
- **Experimental / incomplete:** `bivy run --node <name>` requires a direct
  route registered with `bivy nodes add`; relay-tunnelled routing is not
  implemented. `bivy github:app-create` needs a browser that can reach the
  node's local port.
- **Not supported on Windows:** the background service (`service install`,
  `stop`, `restart`). Use `bivy start`.
