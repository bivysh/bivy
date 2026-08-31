# Bivy

[![npm](https://img.shields.io/npm/v/@bivy/bivy?color=2b6cb0&label=%40bivy%2Fbivy)](https://www.npmjs.com/package/@bivy/bivy)
[![license: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-2b6cb0)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-2b6cb0)](https://nodejs.org)

**Run coding agents on your machines and use them from anywhere — from a phone,
browser, terminal, GitHub issue, Slack message, schedule, or webhook.**

Start Claude Code on your workstation, next to the repo, dev server, and
database you already use. Walk away. From your phone, you can see what it did,
answer a question, or approve a migration. CI or a webhook can start the next
job on the right Machine without waiting for you to return.

```bash
curl -fsSL https://bivy.sh/install.sh | bash  # install + guided setup
cd your-repo
bivy run claude                                # start an agent in this repo
bivy open                                      # open it in a browser or on your phone
```

Bivy does not replace Claude Code, Codex, or the other agents you use. It keeps
their Sessions running, routes work to the right Machine, and gives you one place
to start, join, approve, and review work.

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

## Why not just a cloud sandbox?

A hosted sandbox clones your repo into a clean environment. Bivy runs in the
environment you already use: the current working tree, running services, and
warm caches.

|  | Cloud sandbox | Bivy Machine |
|---|---|---|
| Your repository | a cloned copy | the real working tree, uncommitted changes and all |
| Dev server & database | mocked, or absent | already running, right beside the agent |
| Private networks & internal APIs | out of reach | reachable |
| Toolchains, package caches | cold, reinstalled each time | warm, already installed |
| GPUs / local inference | rented separately | the ones on your box |
| Where your code sits | someone else's infrastructure | the machine you already trust |

Bivy lets you leave that environment running and reach it from anywhere.

## What you can do

Every task in Bivy becomes a Session on a Machine you choose. Start it from the
terminal, browser, phone, or an external trigger. Join it while it runs, or let
it finish in the background.

### Sessions

Start an agent, watch it work, steer it, stop it, or approve a tool call. You can
leave your desk and keep the Session open:

```bash
bivy run claude              # or codex, pi, gemini, and a dozen more
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
[self-host one](docs/self-host-quickstart.md). You can switch later with
`bivy relay:setup`.

Self-hosted Bivy Core is open source and has no usage limits. Bivy Cloud offers
a managed app, relay, and hosted Machines; see
[bivy.sh#pricing](https://bivy.sh#pricing) for details.

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
| Track the dev channel (new build on every merge to `main`) | `BIVY_CHANNEL=staging` |
| Pin an exact version | `BIVY_VERSION=0.1.0` |
| Install the npm package into a user-owned prefix | `BIVY_NPM_PREFIX=~/.local` |
| Preinstall every known upstream agent | `BIVY_INSTALL_ALL_AGENTS=1` |
| Install optional Bivy bridges/native terminal dependency up front | `BIVY_INSTALL_OPTIONAL_DEPS=1` |
| Don't touch `~/.bashrc` / `~/.zshrc`; print the PATH line instead | `BIVY_NO_RC_UPDATE=1` |

For example: `BIVY_CHANNEL=staging curl -fsSL https://bivy.sh/install.sh | bash`.

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
| npm global (`npm i -g`) | `npm install -g @bivy/bivy@<channel>`, then restart the service |
| installer / packaged | re-runs `install.sh` (migrating to npm if needed), then restart |
| git checkout | `git pull --ff-only` + `pnpm install --frozen-lockfile`, then restart |
| `npx` run | nothing to update — each run already fetches the latest |

Updates follow the release **channel** recorded at install time — `latest`
(production) by default, or `staging` if you installed with
`BIVY_CHANNEL=staging`. Switch channels (the choice is remembered for next
time), or skip the wait for a busy session:

```bash
bivy update --staging   # move to the dev channel
bivy update --stable    # move back to production (latest)
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

Hosted unattended provisioning is different from normal interactive Sessions.
If you enable it, Bivy Cloud may hold encrypted cloud, repository, model, or
key-escrow data that the service can access. See the
[security model](docs/security-model.md#what-the-control-plane-sees) and
[key-management guide](docs/key-management.md).

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

Core has no usage limits. Hosted pricing is managed in the separate Cloud
repository.

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

Node, relay, and control plane are all in this repository. Point a node at your
own deployment by passing URLs to `bivy relay:setup` — re-running it switches an
existing node over to the new endpoints:

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

## Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/bivysh/bivy/security/advisories/new).
Please don't open a public issue. See [`SECURITY.md`](SECURITY.md) for scope,
response times, and safe harbour, and [`docs/security-model.md`](docs/security-model.md)
for the trust model and known limitations.

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
