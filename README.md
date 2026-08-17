# Bivy

**Give coding agents your real environment, then reach them from anywhere.**

A provider sandbox starts from an approximation. A Bivy Machine can use the
repository, local services and databases, private networks, existing tools and
caches, and GPUs or local inference already available on your workstation or
server. Bivy turns that local capability into Sessions you can continue remotely
and Runs you can leave working unattended.

## What Bivy lets you do

- **Work where the full environment lives.** Run Claude Code, Codex, Pi, or
  another agent beside real repos, dev servers, databases, internal APIs,
  toolchains, package caches, and specialized compute.
- **Continue from a phone, browser, or terminal.** Reconnect to the same Session,
  steer or stop it, answer questions, and approve supported tool calls. The PWA
  supports voice input and read-aloud, phone-to-agent file/image uploads, and
  agent-to-phone attachments. Native terminal Sessions can stay remote-visible;
  supported runtimes can hand work between terminal and structured chat.
- **Move work without starting over.** Import existing Claude Code and Codex
  Sessions, or fork/copy/move a Bivy Session to another agent, model, or Machine.
  Fidelity is runtime-dependent: a fork may use a native transcript, replayed
  history, or a bounded seeded continuation, and cross-Machine moves require the
  destination's repo access, agent, and credentials.
- **Operate more than one Machine.** Keep a workstation, private-network server,
  and GPU box on one account; select the environment a Session or Run needs.
  Optional warm Session replication is Beta, off by default, and manually
  promoted rather than automatic failover.
- **Let events start checked work.** Create Runs manually or from failed CI,
  GitHub/Linear issues, Slack, schedules, and signed webhooks. Automations can
  pin a Machine, agent, model, sandbox, approval mode, and attempt ceiling, then
  report bounded check and outcome evidence in a Receipt.
- **Bring your own stack.** Use provider subscriptions through supported native
  agent logins, API keys in Bivy's vault, or local/OpenAI-compatible inference.
  Add an existing ACP or headless process agent with `bivy agent add`; declarative
  agent plugins are Experimental (`v1alpha1`) and run out of process.

Start with the [five-minute quickstart](docs/quickstart.md), then try the
[capability recipes](docs/capability-recipes.md) or check the exact
[runtime support matrix](docs/runtime-support-matrix.md).

Interactive Session traffic is end-to-end encrypted between a Machine and its
paired devices, so the relay cannot decrypt it. The seatbelt has a precise edge:
explicitly enabled hosted provisioning may give the control plane technical
access to encrypted cloud, repository, or key-escrow material, while Slack and
generic webhook instructions reach it in plaintext. See [Why Bivy](docs/why-bivy.md)
and the [security model](docs/security-model.md) for the complete trust model.

- **Website:** [bivy.sh](https://bivy.sh)
- **Documentation:** [`docs/`](docs/README.md)
- **License:** [AGPL-3.0-only](LICENSE)

> Bivy is 0.x software. The core loop is solid and used daily, but interfaces,
> cross-runtime fidelity, and behaviour can change between releases. Check the
> support matrix before depending on a particular agent capability.

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

**Claude Code and Codex are the recommended, release-certified paths.** The
broader catalog remains available under **More agents** for users who need it;
capabilities and fidelity vary by runtime:

| Agent | Command | Notes |
|---|---|---|
| Pi | `bivy run pi` | Uses the operator-installed `pi` command and Pi auth/config |
| Claude Code | `bivy run claude` | Uses the operator-installed `claude` command through an SDK bridge |
| Codex | `bivy run codex` | Installs `@openai/codex` |
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
declarative [plugin manifest](docs/plugins.md) with `bivy plugin init`. Both use
the same schema/store; the plugin SDK, diagnostics, and ACP conformance fixtures
support distributable or custom protocol bridges.

[`docs/runtime-support-matrix.md`](docs/runtime-support-matrix.md) lists exactly
what each agent supports — resume, model selection, approvals, sandboxing.

## Common commands

```bash
bivy                  # show the command overview
bivy run pi           # launch Pi as a durable session
bivy run claude       # run a different agent
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

### Foreground, background, or remote

`bivy run <agent>` attaches your terminal to the agent (Ctrl-\ Ctrl-\ detaches,
leaving it running). Two flags start a session without taking over your
terminal:

```bash
bivy run claude --no-follow   # start a native session in the background; rejoin with 'bivy resume' or open it in the app
bivy run claude --chat        # start the governed app session and open it in the browser (--no-open just prints its URL)
```

For unattended, checked work, queue a **Run** instead — it returns immediately
and reports a Receipt when it finishes:

```bash
bivy runs start "upgrade the http client and get the tests passing"
bivy runs wait <id>           # follow it to completion (exit 0 = succeeded)
```

Unlike `bivy run`, `bivy runs` operates on governed background Runs with checks,
evidence, and Receipts — the same machinery event triggers use (see
[GitHub Runs](#github-runs) and [Linear Runs](#linear-runs)).

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
variable and precedence rule remains in
[`docs/configuration.md`](docs/configuration.md).

## Approvals and sandboxing

The default approval mode is **`autonomous`**: agents act without per-action
prompts. The actual protection depends on the selected runtime. Native-sandbox
agents enforce the chosen access tier; structured runtimes also pass tool calls
through Bivy's policy and approval layer. Process agents that Bivy cannot
intercept run with your OS user permissions. The picker shows this distinction
and requires confirmation before selecting that limited path.

Where Bivy receives structured shell/file calls, a heuristic floor blocks known
catastrophic commands and structured writes outside the workspace, and a
backstop set (force-push, publish, deploy, sudo) pauses for a human. This catches
accidents; it is not an adversarial isolation boundary.

If you want to be asked about more, set the mode explicitly:

```bash
BIVY_APPROVAL_MODE=risky    # prompt on risky shell commands and file edits
BIVY_APPROVAL_MODE=always   # prompt on all shell commands and file edits
BIVY_APPROVAL_MODE=never    # no prompts; structured-tool heuristic blocks still apply where available
```

Approve from the terminal, browser, or phone.

Sandbox tiers (`read-only`, `workspace-write`, `danger-full-access`) are enforced
natively by agents that support them — Codex, Claude Code, Gemini CLI, Qwen Code.
Agents without a native sandbox may expose structured tool or MCP controls, but
those controls do not cover activity the agent performs outside those channels;
some process adapters run entirely with your user permissions. Check the
picker's Protection label. **Bivy does not currently ship its own OS-level jail.**

## Credentials

Interactive prompts, transcripts, and workspace files stay encrypted across the
relay. Credentials can remain on a Machine or in a vault you control. If you
explicitly enable hosted unattended provisioning, Bivy Cloud may instead store
encrypted cloud, repository, model, or key-escrow material that the service can
technically access. Treat this as an explicit hosted-custody mode, not as relay
blindness. See the
[security model](docs/security-model.md#what-the-control-plane-sees).

```bash
bivy secrets list
bivy secrets set github.repo-token
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
bivy secrets doctor
```

`secret://`, `env://`, and `op://` (1Password) references are resolved on demand
when the daemon provisions an agent run, so the raw values never sit in your
config. See [`docs/key-management.md`](docs/key-management.md).

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
lives beside the job—sandbox, approval mode, and a hard attempt ceiling that
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

Bivy Core is free and open-source software licensed under the GNU Affero General
Public License, version 3.0 only (AGPL-3.0-only). You may use, study, modify, and
self-host it under that license. If you modify Bivy and let users interact with
it over a network, section 13 requires you to offer those users the corresponding
source code.

See [`LICENSE`](LICENSE).
