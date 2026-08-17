# Bivy

[![npm](https://img.shields.io/npm/v/@bivy/bivy?color=2b6cb0&label=%40bivy%2Fbivy)](https://www.npmjs.com/package/@bivy/bivy)
[![license: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-2b6cb0)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-2b6cb0)](https://nodejs.org)

**Run coding agents on the machines you already own — then reach them from your
phone, browser, or another terminal.**

Start Claude Code on your workstation, right where the repo, the running dev
server, and the staging database already live. Walk away. On the train, open
your phone: read what the agent did, answer its question, approve the migration
— over a link only your devices can decrypt. The work never left your machine.

```bash
curl -fsSL https://bivy.sh/install.sh | bash   # install + guided setup
bivy run claude                                 # start an agent in your repo
bivy open                                        # pick it up from your phone or browser
```

**[Quickstart](docs/quickstart.md)** ·
**[Docs](docs/README.md)** ·
**[Why Bivy](docs/why-bivy.md)** ·
**[Security model](docs/security-model.md)** ·
**[bivy.sh](https://bivy.sh)**

> **0.x software.** The core loop is solid and used daily. Interfaces and
> cross-runtime fidelity still change between releases — check the
> [runtime support matrix](docs/runtime-support-matrix.md) before you depend on
> a specific agent capability.

## Why not just a cloud sandbox?

A hosted sandbox starts from an *approximation* of your environment. A Bivy
Machine **is** your environment — the actual working tree, the services already
running, the caches already warm.

|  | Cloud sandbox | Bivy Machine |
|---|---|---|
| Your repository | a cloned copy | the real working tree, uncommitted changes and all |
| Dev server & database | mocked, or absent | already running, right beside the agent |
| Private networks & internal APIs | out of reach | reachable |
| Toolchains, package caches | cold, reinstalled each time | warm, already installed |
| GPUs / local inference | rented separately | the ones on your box |
| Where your code sits | someone else's infrastructure | the machine you already trust |

You keep the environment. Bivy adds the part that was missing: **reaching that
environment from anywhere, and leaving it working while you're gone.**

## What you can do

Bivy gives you two ways to put an agent to work.

### Sessions — interactive, and portable

Start an agent, watch it work, jump in to steer, stop, or approve. Then leave
your desk and keep going:

```bash
bivy run claude              # or codex, pi, gemini, and a dozen more
bivy open                    # continue the same session in the browser or PWA
bivy resume                  # pick it back up in the terminal
bivy run claude --no-follow  # start it in the background instead of attaching
bivy run claude --chat       # start the governed app session and open it in the browser
```

- **Reconnect from anywhere** — phone, browser, or another terminal — to the
  same live Session. The PWA adds voice input, read-aloud, phone-to-agent
  file/image uploads, and agent-to-phone attachments.
- **Move work without starting over.** Import existing Claude Code and Codex
  Sessions, or fork, copy, and move a Bivy Session to another agent, model, or
  Machine.
- **Run more than one Machine** — a workstation, a private-network server, a GPU
  box — on one account, and pick the environment each Session needs.

### Runs — unattended, and accountable

Queue one on demand, or let an event kick it off — either way it returns
immediately and reports back:

```bash
bivy runs start "..."    # queue a one-off unattended Run, then `bivy runs wait <id>`
bivy automation init     # or define governed jobs in .bivy/automations.yaml
```

- **Trigger from real events** — a failed CI job, a GitHub or Linear issue,
  Slack, a schedule, or a signed webhook.
- **Pin the guardrails** — Machine, agent, model, sandbox, approval mode, and a
  hard attempt ceiling — right next to the job.
- **Get a Receipt** — every Run reports the checks it ran and how it turned out,
  not just a wall of output.

Try the [capability recipes](docs/capability-recipes.md) to see each of these
end to end, or the [runtime support matrix](docs/runtime-support-matrix.md) for
exactly what each agent supports.

## Bring your own stack

Use provider subscriptions through native agent logins, API keys stored in
Bivy's vault, or local / OpenAI-compatible inference. Add any ACP or headless
agent with a single command — no per-agent adapter to write:

```bash
bivy agent add       # register an existing ACP or process agent
```

## Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

macOS and Linux. Requires Node.js 22.19 or newer; the installer installs it for
you on Debian/Ubuntu and otherwise points you at nodejs.org. It installs the
[`@bivy/bivy`](https://www.npmjs.com/package/@bivy/bivy) package from npm, puts
the `bivy` command on your `PATH`, then runs the guided `bivy setup` wizard —
agent choice, relay/control-plane sign-in, and an auto-start background service
(launchd on macOS, systemd on Linux). Re-running it on a machine that already
has Bivy just applies the latest build and restarts the service.

Already have Node.js 22.19+? The installer is optional:

```bash
npm install -g @bivy/bivy && bivy setup     # install globally
npx @bivy/bivy setup                         # or try it once, no install
```

Releases are published from CI with provenance attestations; verify a build's
origin with `npm audit signatures`. See [`docs/releasing.md`](docs/releasing.md).

### Your first session

Once `bivy setup` finishes, the whole loop is three commands — start local,
reconnect remote:

```bash
bivy run claude    # start an agent as a durable session in the current repo
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
| Install without sudo, into a user-owned prefix | `BIVY_NPM_PREFIX=~/.local` |
| Preinstall every known upstream agent | `BIVY_INSTALL_ALL_AGENTS=1` |

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

`bivy update` detects how Bivy was installed and does the right thing, then
waits for any active session to finish its current turn and restarts the
background service so the node reconnects on the new build:

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

The daemon also checks the registry periodically and posts an in-session notice
when a newer build is available.

## Architecture

Bivy has three parts. **Only the first one holds your data.**

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

Because the node serves no UI, a browser or phone needs a control plane — hosted
at `app.bivy.sh`, or one you deploy yourself. The terminal CLI needs neither.
Interactive Session traffic is end-to-end encrypted between a Machine and its
paired devices, so the relay cannot decrypt it.

See [`docs/remote-access.md`](docs/remote-access.md) and
[`docs/security-model.md`](docs/security-model.md).

## Supported agents

**Claude Code and Codex are the recommended, release-certified paths.** The
broader catalog stays available under **More agents**; capabilities and fidelity
vary by runtime.

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

Any other command works via `bivy run -- ./your-agent --flags`. ACP-capable
agents can be promoted to Bivy's governed protocol path for per-tool approvals
and native resume. To add a reusable process or ACP agent to both the CLI and web
picker without changing Bivy, run `bivy agent add`, or scaffold and install a
declarative [plugin manifest](docs/plugins.md) with `bivy plugin init`
(declarative plugins are Experimental, `v1alpha1`, and run out of process).

[`docs/runtime-support-matrix.md`](docs/runtime-support-matrix.md) lists exactly
what each agent supports — resume, model selection, approvals, sandboxing.

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

Create and inspect the typed node configuration, or add repository-owned
safety/check/retry policy:

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

The default approval mode is **`autonomous`**: agents act without per-action
prompts. How much that actually protects you depends on the runtime. Native-sandbox
agents enforce the chosen access tier; structured runtimes also pass tool calls
through Bivy's policy and approval layer. Process agents that Bivy cannot
intercept run with your OS user permissions — the picker flags this and requires
confirmation before you pick that path.

Where Bivy receives structured shell/file calls, a heuristic floor blocks known
catastrophic commands and structured writes outside the workspace, and a
backstop set (force-push, publish, deploy, sudo) pauses for a human. This catches
accidents; **it is not an adversarial isolation boundary.**

Want to be asked about more? Set the mode explicitly:

```bash
BIVY_APPROVAL_MODE=risky    # prompt on risky shell commands and file edits
BIVY_APPROVAL_MODE=always   # prompt on all shell commands and file edits
BIVY_APPROVAL_MODE=never    # no prompts; structured-tool heuristic blocks still apply where available
```

Approve from the terminal, browser, or phone.

Sandbox tiers (`read-only`, `workspace-write`, `danger-full-access`) are enforced
natively by agents that support them — Codex, Claude Code, Gemini CLI, Qwen Code.
Agents without a native sandbox may expose structured tool or MCP controls, but
those don't cover activity the agent performs outside those channels; some
process adapters run entirely with your user permissions. Check the picker's
Protection label. **Bivy does not currently ship its own OS-level jail.**

## Credentials

Interactive prompts, transcripts, and workspace files stay encrypted across the
relay. Credentials can remain on a Machine or in a vault you control:

```bash
bivy secrets list
bivy secrets set github.repo-token
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets doctor
```

`secret://`, `env://`, and `op://` (1Password) references resolve on demand when
the daemon provisions an agent run, so raw values never sit in your config.

**One deliberate exception to relay blindness:** if you explicitly enable hosted
unattended provisioning, Bivy Cloud may store encrypted cloud, repository,
model, or key-escrow material that the service can technically access. Treat this
as an explicit hosted-custody mode. See the
[security model](docs/security-model.md#what-the-control-plane-sees) and
[`docs/key-management.md`](docs/key-management.md).

## Automations as code

Define governed jobs in `.bivy/automations.yaml`, validate them, and simulate
trigger events locally before applying anything:

```bash
bivy automation init
bivy automation validate
bivy automation test --event .bivy/events/failed-ci.yaml
bivy automation apply
```

Instructions are encrypted on the applying node before upload. Safety policy
lives beside the job — sandbox, approval mode, and a hard attempt ceiling that
retry/fallback rules cannot exceed. See
[`docs/automations-as-code.md`](docs/automations-as-code.md).

## GitHub Runs

Label an issue `bivy` (or `bivy/<machine>` to target a Machine), or mention the
Bivy GitHub App in a comment. Bivy creates a Run on the selected Machine, uses an
isolated worktree, executes configured checks, and reports an explicit outcome.

Core applies no commercial usage limits. Bivy Cloud billing and commercial
policy live in the separate Cloud repository.

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

**Self-hosting is unsupported** — no SLA, community best-effort via GitHub
issues. You own TLS, backups, upgrades, and hardening. See
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
