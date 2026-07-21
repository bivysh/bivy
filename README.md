# Bivy

Run coding agents on machines you own.

Bivy runs Claude Code, Codex, Gemini CLI, Aider and other agent CLIs on your own
laptop or server — with your keys, your repository, and your toolchain — then
makes those sessions reachable from your phone, browser, or another terminal.

Your code is never uploaded. Agents run in real terminals on hardware you
control. Bivy adds the session layer, approvals, and remote access around them.

- **Website:** [bivy.sh](https://bivy.sh)
- **Documentation:** [`docs/`](docs/README.md) — start with the [quickstart](docs/quickstart.md)
- **License:** [FSL-1.1-ALv2](LICENSE) (source-available; converts to Apache-2.0 two years after each release)

> Bivy is 0.x software. The core loop is solid and used daily, but interfaces
> and behaviour can change between releases.

## Install

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

macOS and Linux. Requires Node 22.19 or newer; the installer sets it up if
missing. It installs Bivy, then runs the guided `bivy setup` wizard — workspace,
model login, optional remote access, and an auto-start background service
(launchd on macOS, systemd on Linux).

Already have the repository checked out:

```bash
npm install
npm run setup
```

See [`docs/install.md`](docs/install.md) for service management and uninstall.

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

Ten agents are available in the picker, each driven through its native CLI:

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

Any other command works via `bivy run -- ./your-agent --flags`.

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

See [`docs/github-work-queue.md`](docs/github-work-queue.md).

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
- `site/` — the marketing and install site

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Self-hosting

Node, relay, and control plane are all in this repository, and the CLI accepts
flags to point at your own deployment:

```bash
bivy relay:setup --relay wss://relay.example.com \
                 --control-plane https://bivy.example.com
```

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
