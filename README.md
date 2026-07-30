# Bivy

Route coding-agent work to infrastructure you own.

Bivy turns GitHub issues, Slack requests, signed webhooks, schedules, and live
prompts into governed agent runs on your laptop, server, or cloud account. Choose
the node, agent, and model; burst onto a short-lived runner in your own cloud;
then watch, steer, and approve from a phone, browser, or terminal.

Agents run with your repository, keys, and toolchain. Bivy's relay and control
plane do not receive repository contents, prompts, transcripts, or model keys.
Bivy adds routing, durable sessions, approvals, fallback rules, and outcome
reports around agents you already use.

- **Website:** [bivy.sh](https://bivy.sh)
- **Documentation:** [`docs/`](docs/README.md) — start with the [quickstart](docs/quickstart.md)
- **License:** [FSL-1.1-ALv2](LICENSE) (source-available; converts to Apache-2.0 two years after each release)

> Bivy is 0.x software. The core loop is solid and used daily, but interfaces
> and behaviour can change between releases.

## Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

macOS and Linux. Requires Node.js 22.19 or newer; the installer installs it for
you on Debian/Ubuntu and otherwise points you at nodejs.org. It installs the
[`@bivy/bivy`](https://www.npmjs.com/package/@bivy/bivy) package from npm, puts
the `bivy` command on your `PATH`, then runs the guided `bivy setup` wizard —
workspace, relay/control-plane sign-in, and an auto-start background service
(launchd on macOS, systemd on Linux). Re-running it on a machine that already
has Bivy just applies the latest build and restarts the service.

Already have Node.js 22.19+? The installer is optional:

```bash
npm install -g @bivy/bivy
bivy setup
```

Or try it once without installing anything (`npx` always fetches the latest):

```bash
npx @bivy/bivy setup
```

Releases are published from CI with provenance attestations; verify a build's
origin with `npm audit signatures`. See [`docs/releasing.md`](docs/releasing.md).

### Install options

Environment variables passed to the one-line installer change what it does:

| Goal | Variable |
|---|---|
| Track the dev channel (new build on every merge to `main`) | `BIVY_CHANNEL=staging` |
| Pin an exact version | `BIVY_VERSION=0.1.0` |
| Install without sudo, into a user-owned prefix | `BIVY_NPM_PREFIX=~/.local` |
| Preinstall every bundled agent runtime | `BIVY_INSTALL_ALL_AGENTS=1` |

For example: `BIVY_CHANNEL=staging curl -fsSL https://bivy.sh/install.sh | bash`.

Working from a checkout of this repository instead:

```bash
npm install
npm run setup
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
| git checkout | `git pull --ff-only` + `npm ci`, then restart |
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

Bivy has three parts. Only the first one holds your data.

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

See [`docs/remote-access.md`](docs/remote-access.md) and
[`docs/security-model.md`](docs/security-model.md).

## Supported agents

Nineteen agents are available in the picker, each driven through its native interface:

| Agent | Command | Notes |
|---|---|---|
| Pi | `bivy run pi` | Default; bundled |
| Claude Code | `bivy run claude` | Bundled SDK |
| Codex | `bivy run codex` | Installs `@openai/codex` |
| OpenCode | `bivy run opencode` | Installs `opencode-ai/opencode` |
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
and native resume.

[`docs/runtime-support-matrix.md`](docs/runtime-support-matrix.md) lists exactly
what each agent supports — resume, model selection, approvals, sandboxing.

## Common commands

```bash
bivy                  # launch the default agent as a durable session
bivy run claude       # run a specific agent
bivy sessions         # list live and saved sessions
bivy resume           # resume the most recent session
bivy open             # open the web app (requires relay setup)
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

Every environment variable, config file, and precedence rule:
[`docs/configuration.md`](docs/configuration.md).

## Approvals and sandboxing

The default approval mode is **`autonomous`**: agents act without per-action
prompts. Safety comes from a floor that applies in *every* mode — catastrophic
commands and writes outside the workspace are refused outright, and a backstop
set (force-push, publish, deploy, sudo) always pauses for a human.

If you want to be asked about more, set the mode explicitly:

```bash
BIVY_APPROVAL_MODE=risky    # prompt on risky shell commands and file edits
BIVY_APPROVAL_MODE=always   # prompt on every tool call
BIVY_APPROVAL_MODE=never    # no prompts beyond the hard floor
```

Approve from the terminal, browser, or phone.

Sandbox tiers (`read-only`, `workspace-write`, `danger-full-access`) are enforced
natively by agents that support them — Codex, Claude Code, Gemini CLI, Qwen Code.
Agents without a native sandbox are governed at the filesystem, MCP, and network
layer. **Bivy does not ship its own OS-level jail in 0.1.**

## Credentials

Provider credentials stay on the node or in a vault you control. Bivy Cloud does
not receive model keys, GitHub repository tokens, OAuth refresh tokens, prompts,
transcripts, or workspace files.

```bash
bivy secrets list
bivy secrets set github.repo-token
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets doctor
```

`secret://`, `env://`, and `op://` (1Password) references are resolved before the
daemon starts. See [`docs/key-management.md`](docs/key-management.md).

## GitHub work queue

Label an issue `bivy` (or `bivy/<node>` to target a machine), or mention the Bivy
GitHub App in a comment. A node you own claims the work, runs the agent in an
isolated worktree, and the agent opens the pull request itself.

Available on every plan: interactive CLI/app sessions are unlimited. Free
accounts also get 10 unattended automations per rolling 7-day window across
GitHub, Slack, webhooks, and schedules; Pro removes the automation cap.
Self-hosted stacks are unlimited.

A private GitHub App only installs on the account that owns it, so connect one
app per GitHub account — one for your personal repos, one per organization
(`bivy github:app-create --org <org>`). A node can serve several at once, each
with its own key and `@`-mention handle.

See [`docs/github-work-queue.md`](docs/github-work-queue.md).

## Linear work queue

Apply `bivy` or `bivy/<node>` to a Linear issue to dispatch it to the same hosted queue. The node fetches issue content directly from Linear, works in an isolated GitHub worktree, and asks the agent to open a pull request. See [`docs/linear-work-queue.md`](docs/linear-work-queue.md).

## Development

```bash
npm install
npm run dev          # node daemon on http://localhost:4317
npm run dev:web      # web client dev server (proxies /api and /ws to the node)
```

Checks — all of these run in CI:

```bash
npm run typecheck
npm run typecheck:web
npm run lint
npm run test:unit
npm run test:core
npm run check:licenses
npm run check:secrets
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
to skip interactive sign-in. `relay:setup` checks the control plane is reachable, enrolls
this node, and writes the endpoints to `.bivy/relay.json`, so `bivy open`,
`bivy link`, and `bivy update` all keep using your deployment afterwards.

**Self-hosting is unsupported** — no SLA, community best-effort via GitHub
issues. You own TLS, backups, upgrades, and hardening. See
[`docs/self-host.md`](docs/self-host.md).

## Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/bivysh/bivy/security/advisories/new).
Please do not open a public issue. See [`SECURITY.md`](SECURITY.md) for scope,
response times, and safe harbour, and [`docs/security-model.md`](docs/security-model.md)
for the trust model and known limitations.

## License

Bivy Core is licensed under the Functional Source License (FSL-1.1-ALv2): you may
use, modify, and self-host it for any purpose **except a Competing Use** —
offering it to others as a product or service that substitutes for Bivy or Bivy
Cloud. Two years after each release, that version converts to Apache-2.0.

This is a source-available licence, not an OSI-approved open source licence.

See [`LICENSE`](LICENSE), [`CORE.md`](CORE.md), and [`CLOUD.md`](CLOUD.md).
