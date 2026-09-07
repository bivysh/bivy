# Bivy

[![npm](https://img.shields.io/npm/v/@bivy/bivy?color=2b6cb0&label=%40bivy%2Fbivy)](https://www.npmjs.com/package/@bivy/bivy)
[![license: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-2b6cb0)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-2b6cb0)](https://nodejs.org)

**Run coding agents on your machines and use them from anywhere — from a phone,
browser, terminal, GitHub issue, Slack message, schedule, or webhook.**

Start Claude Code or Codex in the development environment you already use —
with your repo, running services, tools, and credentials. Leave your desk,
open the session on your phone, and answer a question, approve an action, or
review the diff. GitHub issues, CI, schedules, and webhooks can start work on
those same machines.

```bash
curl -fsSL https://bivy.sh/install.sh | bash  # install + guided setup
cd your-repo
bivy run claude                            # start an agent in this repo
bivy open                                  # open the web app (requires remote setup)
```

Bivy does not replace your coding agent or provide model inference. It keeps
Sessions running, routes work to connected Machines, and gives you one place to
start, join, approve, and review work. A **Machine** is a Mac, Linux computer,
or existing server you operate; a **Session** is the agent work running there.
Your machine must stay awake and online for remote access.

First thing to try: ask the agent to explain the repository, make one small safe
change, then open the same Session in the web app or on your phone while it runs.

**[Quickstart](docs/quickstart.md)** ·
**[Docs](docs/README.md)** ·
**[Why Bivy](docs/why-bivy.md)** ·
**[Security model](docs/security-model.md)** ·
**[bivy.sh](https://bivy.sh)**

> **Bivy is 0.x software.** Claude Code, Codex, Pi, and OpenCode are the
> release-tested paths. Support for other agents varies; check the
> [runtime support matrix](docs/runtime-support-matrix.md) before relying on a
> specific feature.

## Why run on your own machines?

A fresh cloud sandbox can be useful, but it is not always the environment your
work needs. Bivy connects to the machines you already operate, so your agent can
use:

- Your existing working tree, including uncommitted changes.
- Running dev servers, databases, installed toolchains, and warm caches.
- Private networks and internal APIs that machine can reach.
- Your GPUs and local model servers.

You bring the environment; Bivy makes the work accessible from anywhere.
Background Runs can use isolated worktrees without rebuilding the whole machine.

## What you can do

Every task in Bivy becomes a Session on a Machine you choose. Start it from the
terminal, browser, phone, or an external trigger. Join it while it runs, or let
it finish in the background.

### Sessions

Start an agent, watch it work, steer it, stop it, or approve a tool call. You can
leave your desk and keep the Session open:

```bash
bivy run claude              # or codex, pi, opencode
bivy open                    # continue the same session in the browser or PWA
bivy resume                  # pick it back up in the terminal
bivy run claude --no-follow  # start it in the background instead of attaching
bivy run claude --chat       # start a chat session and open it in the browser
```

- Reconnect to the same Session from a phone, browser, or terminal.
- Upload files and images from your phone, or download files the agent creates.
- Import existing Claude Code and Codex Sessions.
- Fork or move a Session to another agent, model, or Machine.
- Connect several Machines, such as a workstation, server, or GPU box.

### Runs

A Run is a Session started as a background job. Start one yourself or trigger it
from another service; Bivy queues it and returns immediately:

```bash
bivy runs start "..."    # queue a one-off unattended Run, then `bivy runs wait <id>`
bivy automation init     # define jobs in .bivy/automations.yaml
```

- Trigger Runs from GitHub, Linear, Slack, a schedule, CI, or a signed webhook.
- Choose the Machine, agent, model, sandbox, approval mode, and retry limit.
- Review the changed files, checks, and final result in a Receipt.

See the [capability recipes](docs/capability-recipes.md) for examples and the
[runtime support matrix](docs/runtime-support-matrix.md) for per-agent support.

## Bring your own agents and models

Use your existing agent login, an API key in Bivy's vault, or a local
OpenAI-compatible server. Claude Code, Codex, Pi, and OpenCode have release-tested
integrations. Other agents run through ACP or a headless process adapter. Add
your own with:

```bash
bivy agent add       # register an existing ACP or process agent
```

## Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

Bivy supports macOS and Linux and requires Node.js 20 or newer. The installer
adds the [`@bivy/bivy`](https://www.npmjs.com/package/@bivy/bivy) package and
`bivy` command, then runs `bivy setup`. Setup asks which agent to use, installs
it if needed, configures remote access, and starts a launchd or systemd service.

If an agent is already installed, Bivy uses its existing command, login, and
configuration. Re-running the installer updates Bivy and restarts the service.

**Local and remote use.** `bivy run`, `bivy resume`, and `bivy sessions` work
without an account or server. During setup, choose **local only for now** to skip
remote access. The browser and phone apps need a control plane: use
[app.bivy.sh](https://app.bivy.sh) or
[self-host one](docs/self-host-quickstart.md). You can sign in later with
`bivy login` (or use `bivy relay:setup` for self-hosted endpoint options).

**What Cloud hosts.** Bivy Cloud runs the web app, control plane, and encrypted
relay — not your agents or their machines. Connect a computer or server you
already operate and bring your own agent subscription or model API key.

- **Free Cloud:** every launch feature, including automations, with 10 new remote
  Sessions per rolling seven days. Manual and automated Sessions share this
  allowance; resuming existing Sessions and viewing history do not consume it.
  No credit card required.
- **Cloud — $15/month:** unlimited remote Sessions, with the same features.
- **Self-hosted Core:** run the app, control plane, and relay yourself, with no
  Bivy usage limits.

Agent subscriptions and model-provider charges are separate. See
[bivy.sh#pricing](https://bivy.sh#pricing) for current hosted pricing.

Prefer to inspect the installer first?

```bash
curl -fsSL https://bivy.sh/install.sh -o install.sh
less install.sh
bash install.sh
```

**When the installer uses sudo:**

- Debian/Ubuntu without a suitable Node.js: `sudo apt-get install curl
  ca-certificates`, then NodeSource's Node 22 setup script via `sudo`.
- Other Linux, or macOS, without a suitable Node.js: downloads the official
  Node 22 tarball from nodejs.org (sha256-checked) and installs it under
  `/usr/local` with `sudo`.
- If npm's global prefix isn't writable it falls back to `~/.local` — it never
  runs `npm install` under `sudo`.
- It appends a marked PATH block to `~/.bashrc` or `~/.zshrc`
  (`BIVY_NO_RC_UPDATE=1` to opt out).

Want no sudo at all? Bring your own Node.js 20+ and skip the script:

```bash
npm install -g @bivy/bivy && bivy setup     # install globally
npx @bivy/bivy setup                         # or try it once, no install
```

Releases are published from CI with provenance attestations; verify a build's
origin with `npm audit signatures`. See [`docs/releasing.md`](docs/releasing.md).

### Your first session

After setup, start Bivy inside an existing repo:

```bash
cd your-repo
bivy run claude    # start an agent as a durable session in the current repo
# Try: "Explain this repo and suggest one small, safe improvement."
bivy open          # open that same session in the web app (needs relay setup)
bivy resume        # or pick it back up here in the terminal
```

From here the [quickstart](docs/quickstart.md) walks through Runs, multiple
Machines, and automations.

### Install options

Environment variables passed to the one-line installer change what it does:

| Goal | Variable |
|---|---|
| Pin an exact version | `BIVY_VERSION=0.1.0` |
| Install the npm package into a user-owned prefix | `BIVY_NPM_PREFIX=~/.local` |
| Preinstall every known upstream agent | `BIVY_INSTALL_ALL_AGENTS=1` |
| Install optional Bivy bridges/native terminal dependency up front | `BIVY_INSTALL_OPTIONAL_DEPS=1` |
| Don't touch `~/.bashrc` / `~/.zshrc`; print the PATH line instead | `BIVY_NO_RC_UPDATE=1` |

Working from a checkout of this repository instead:

```bash
pnpm install
pnpm run setup
```

See [`docs/install.md`](docs/install.md) for where data lives, service
management, and uninstall.

## Updating

```bash
bivy update
```

`bivy update` uses the same install method you used originally. It waits for an
active turn to finish, updates Bivy, and restarts the background service:

| Install kind | What `bivy update` does |
|---|---|
| npm global (`npm i -g`) | updates the global npm package, then restarts the service |
| installer / packaged | re-runs `install.sh` (migrating to npm if needed), then restart |
| git checkout | `git pull --ff-only` + `pnpm install --frozen-lockfile`, then restart |
| `npx` run | nothing to update — each run already fetches the latest |

The standard installer uses stable releases (`latest` on npm). Use
`bivy update` to keep that installation current.

To skip the wait for a busy session:

```bash
bivy update --force     # don't wait for an in-flight turn to finish
```

The daemon checks for new releases and posts an update notice in the Session.

## Architecture

Bivy has three parts. For normal interactive Sessions, code, credentials, and
transcripts stay on the node.

```text
  your machine                     hosted or self-hosted

  ┌──────────────┐               ┌─────────┐        ┌───────────────┐
  │ node daemon  │  ──dials──▶   │  relay  │ ◀────▶ │ control plane │
  │ agents, keys │    outbound   │ opaque  │        │ accounts, web │
  │ repo, tools  │               │ frames  │        │ app, metadata │
  └──────────────┘               └─────────┘        └───────────────┘
         ▲                                                  ▲
         └────────── end-to-end encrypted session ───────────┘
                     phone · browser · another terminal
```

- **Node** — a daemon on your machine. Owns the workspace, credentials, and agent
  processes. Serves an API and WebSocket on `http://localhost:4317` plus a
  `/healthz` probe. **It hosts no web UI.**
- **Relay** — forwards encrypted frames between your node and your devices. Your
  node dials out, so no inbound port is opened. The relay cannot read the frames.
- **Control plane** — holds your account, node registry, and session index, and
  serves the web/PWA client. Use the hosted one or run your own.

The node has no web UI. The browser and phone apps come from `app.bivy.sh` or
your own control plane; the terminal CLI needs neither. Session traffic is
end-to-end encrypted between the node and paired devices, so the relay cannot
read it.

QR pairing with `bivy link` lets the node authorize the device directly. Hosted
account pairing trusts the control plane to authorize devices and serve the web
app that holds the keys. Read the
[known limitations](docs/security-model.md#known-limitations-for-0x) before using
Bivy with sensitive work.

See [`docs/remote-access.md`](docs/remote-access.md) and
[`docs/security-model.md`](docs/security-model.md).

## Supported agents

**Claude Code, Codex, Pi, and OpenCode are the release-tested paths.** The other
adapters are maintained, but their features vary. Check the
[runtime support matrix](docs/runtime-support-matrix.md) for resume, models,
approvals, sandboxing, and test status.

| Agent | Command | Notes |
|---|---|---|
| Claude Code | `bivy run claude` | Uses the operator-installed `claude` command through an SDK bridge |
| Codex | `bivy run codex` | Installs `@openai/codex` |
| Pi | `bivy run pi` | Uses the operator-installed `pi` command and Pi auth/config |
| OpenCode | `bivy run opencode` | Installs `opencode-ai` |
| Gemini CLI | `bivy run gemini` | Installs `@google/gemini-cli` |
| Qwen Code | `bivy run qwen` | Installs `@qwen-code/qwen-code` |
| Goose | `bivy run goose` | Requires `goose` on PATH |
| Aider | `bivy run aider` | No session resume (upstream gap) |
| Cline | `bivy run cline` | Installs `cline` |
| Crush | `bivy run crush` | No session resume (upstream gap) |
| Cursor | `bivy run cursor` | ACP-capable |
| GitHub Copilot | `bivy run copilot` | ACP-capable |
| Grok | `bivy run grok` | Model selection |
| Amp | `bivy run amp` | Native thread resume |
| Auggie | `bivy run auggie` | Headless CLI |
| Droid | `bivy run droid` | Model selection |
| Continue | `bivy run continue` | Headless CLI |
| Kilo Code | `bivy run kilocode` | ACP-capable |
| Rovo Dev | `bivy run rovodev` | Installed out of band |

Codebuff, Hermes, and OpenClaw are experimental and hidden from the picker.
Run them with `BIVY_RUNTIME=<id>`.

Run any command with `bivy run -- ./your-agent --flags`. For a reusable entry in
the CLI and web picker, use `bivy agent add`. You can also create an experimental
`v1alpha1` [plugin manifest](docs/plugins.md) with `bivy plugin init`.

See the [runtime support matrix](docs/runtime-support-matrix.md) for details.

## Common commands

```bash
bivy                  # show the command overview
bivy run claude       # launch Claude Code as a durable session
bivy run codex        # run a different agent
bivy sessions         # list live and saved sessions
bivy resume           # resume the most recent session
bivy open             # open the web app (requires relay setup)
bivy automation init  # create .bivy/automations.yaml
bivy agent add        # connect an existing ACP or process agent
bivy plugin list      # installed declarative integration packages
bivy status           # config summary and node reachability
bivy doctor           # health check
bivy logs -f          # tail node logs
bivy update           # update Bivy and restart the service
```

Full command list, flags, and examples: [`docs/cli-reference.md`](docs/cli-reference.md).

## Configuration

The common knobs:

```bash
BIVY_WORKSPACE=/path/to/repo    # default workspace
BIVY_SANDBOX=read-only          # read-only | workspace-write (default) | danger-full-access
BIVY_APPROVAL_MODE=risky        # never | risky | always | autonomous (default)
```

Manage node settings or add repo-specific checks and safety rules:

```bash
bivy config init
bivy config set defaults.agent codex
bivy config explain defaults.sandbox
bivy config init --project       # .bivy/policy.yaml
```

See [`docs/config-as-code.md`](docs/config-as-code.md). Every environment
variable and precedence rule lives in
[`docs/configuration.md`](docs/configuration.md).

## Approvals and sandboxing

The default approval mode is **`autonomous`**, so most actions do not prompt.
Protection depends on the agent. Some agents enforce Bivy's sandbox setting;
others expose tool calls that Bivy can approve or deny. A process agent that
Bivy cannot intercept runs with your user permissions. The picker shows which
case applies and asks for confirmation on unprotected paths.

For tool calls it can see, Bivy blocks destructive system commands and writes
outside the workspace. It asks before force pushes, publishing, deployments,
and `sudo`. These checks help prevent accidents. **They are not a security
sandbox.**

To see more prompts, change the approval mode:

```bash
BIVY_APPROVAL_MODE=risky    # prompt on risky shell commands and file edits
BIVY_APPROVAL_MODE=always   # prompt on all shell commands and file edits
BIVY_APPROVAL_MODE=never    # no prompts; structured-tool heuristic blocks still apply where available
```

Approve from the terminal, browser, or phone.

Codex, Claude Code, Gemini CLI, and Qwen Code enforce the `read-only`,
`workspace-write`, and `danger-full-access` tiers themselves. Other agents may
run with your full user permissions even when Bivy can inspect some tool calls.
Check the Protection label in the picker. **Bivy does not provide an OS-level
sandbox.**

## Credentials

Interactive prompts, transcripts, and workspace files stay encrypted across the
relay. Credentials can remain on a Machine or in a vault you control:

```bash
bivy secrets list
bivy secrets set github.repo-token
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets doctor
```

`secret://`, `env://`, and `op://` (1Password) references are resolved only when
an agent needs them, so the raw values do not appear in config files.

Optional credential sync uploads encrypted vault data and per-machine wrapped
keys, not plaintext credentials. See the
[credential-sync guide](docs/credential-sync.md) for supported credentials and
recovery limits, and the [key-management guide](docs/key-management.md) for
storage options.

Interactive session encryption does not cover every integration: Slack commands
and generic webhook instructions reach the control plane in plaintext. Do not
put secrets in them. The [security model](docs/security-model.md#what-the-control-plane-sees)
explains what each path exposes.

## Automations as code

Define jobs in `.bivy/automations.yaml`, validate them, and test trigger events
locally:

```bash
bivy automation init
bivy automation validate
bivy automation test --event .bivy/events/failed-ci.yaml
bivy automation apply
```

Bivy encrypts instructions on the node before upload. Each job records its
sandbox, approval mode, and maximum number of attempts. See
[`docs/automations-as-code.md`](docs/automations-as-code.md).

## GitHub Runs

Label an issue `bivy` (or `bivy/<machine>` to target a Machine), or mention the
Bivy GitHub App in a comment. Bivy creates a Run on the selected Machine, uses an
isolated worktree, runs the configured checks, and posts the result.

On Bivy Cloud, a new automation Session counts toward the same allowance as a
manually started remote Session. Self-hosted Core has no Bivy usage limits.

A private GitHub App only installs on the account that owns it, so connect one
app per GitHub account — one for your personal repos, one per organization
(`bivy github:app-create --org <org>`). A node can serve several at once, each
with its own key and `@`-mention handle.

See [`docs/github-work-queue.md`](docs/github-work-queue.md).

## Linear Runs

Apply `bivy` or `bivy/<machine>` to a Linear issue to create a Run on the selected
Machine. The Machine fetches issue content directly from Linear, works in an
isolated GitHub worktree, and asks the agent to open a pull request. See
[`docs/linear-work-queue.md`](docs/linear-work-queue.md).

## Development

```bash
pnpm install
pnpm run dev          # node daemon on http://localhost:4317
pnpm run dev:web      # web client dev server (proxies /api and /ws to the node)
```

Checks — all of these run in CI:

```bash
pnpm run typecheck
pnpm run typecheck:web
pnpm run lint
pnpm run test:unit
pnpm run test:core
pnpm run check:licenses
pnpm run check:secrets
```

Repository layout:

- `src/` — node daemon, runtime adapters, approvals, secrets, sessions
- `bin/` — the `bivy` CLI
- `packages/core` — shared protocol, pairing, wire format
- `packages/web` — the React/Vite PWA client (`@bivy/web`)
- `services/relay` — self-hostable relay
- `services/control-plane` — self-hostable control plane
- `deploy/` — self-host deployment examples

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Self-hosting

The node, web/PWA client, relay, and control plane are all in this repository.
Self-hosting means operating the remote-access infrastructure yourself; agents
still run on computers or servers you have set up and connected.

Point a node at your own deployment by passing URLs to `bivy relay:setup` —
re-running it switches an existing node over to the new endpoints:

```bash
bivy relay:setup \
  --control-plane https://bivy.example.com \
  --relay wss://relay.example.com
```

Each URL has a flag and an environment-variable equivalent (the flag wins):

| Flag | Environment variable | Points at | Default |
|---|---|---|---|
| `--control-plane <url>` | `BIVY_CONTROL_PLANE_URL` | accounts, node registry, and the web-app API | hosted (`app.bivy.sh`) |
| `--relay <wss-url>` | `BIVY_RELAY_URL` | the encrypted-frame relay your node dials out to | hosted |
| `--client <url>` | `BIVY_CLIENT_BASE_URL` | base URL used when building app/PWA links | the `--control-plane` URL |

Sign-in defaults to GitHub device login (`--github`); pass
`--email you@example.com` for an email magic-link, or `--session-token <token>`
to skip interactive sign-in. `relay:setup` checks the control plane is reachable,
enrolls this node, and writes the endpoints to `.bivy/relay.json`, so `bivy open`,
`bivy link`, and `bivy update` all keep using your deployment afterwards.

**Self-hosting is community-supported** — no SLA, best-effort help via GitHub
issues. You own TLS, backups, upgrades, and hardening. Start with the
one-command VPS path in
[`docs/self-host-quickstart.md`](docs/self-host-quickstart.md); the ops
reference (backups, rotation, security boundary) is
[`docs/self-host.md`](docs/self-host.md).

Prebuilt Core service images are public on GHCR:

```text
ghcr.io/bivysh/bivy-control-plane:<version-or-full-commit-sha>
ghcr.io/bivysh/bivy-relay:<version-or-full-commit-sha>
```

Use a release version for self-hosting or a full commit SHA for an immutable
build. `latest` moves only when a production release is promoted. Each tag
supports `linux/amd64` and `linux/arm64`; the images are built from this
repository with SBOM and provenance attestations.

## Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/bivysh/bivy/security/advisories/new).
Please don't open a public issue. See [`SECURITY.md`](SECURITY.md) for scope,
response times, and safe harbour, and [`docs/security-model.md`](docs/security-model.md)
for the trust model and known limitations.

## In development

Ephemeral Machines — automatically provisioned, short-lived servers for agent
work — are in development. The code includes provisioning work for both
Bivy-hosted and self-hosted/bring-your-own-cloud deployments, but **neither path
is ready or supported for this launch**. Bivy Cloud does not offer hosted agent
Machines at launch. Use an existing computer or server you operate instead.

Experimental provisioning has different credential-custody and encryption
boundaries; see the [provisioning trust model](docs/hosted-provisioning-trust-model.md)
before evaluating that code. Its presence in the repository is not a readiness
or availability promise.

## License

Bivy Core is free and open-source software under the GNU Affero General Public
License, version 3.0 only (AGPL-3.0-only). You may use, study, modify, and
self-host it under that license. If you modify Bivy and let users interact with
it over a network, section 13 requires you to offer them the corresponding
source code. See [`LICENSE`](LICENSE).

**Where the open-core line is.** Everything in this repository — node, CLI,
relay, control plane, and the web/PWA client — is AGPL Core, with no usage
limits. **Bivy Cloud** is the hosted operation of that stack plus billing and
plans, and lives in a separate private repository. Contributions are accepted
under the [DCO](CONTRIBUTING.md#certificate-of-origin); there is no CLA.
