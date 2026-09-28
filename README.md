# Bivy

[![npm](https://img.shields.io/npm/v/@bivy/bivy?color=2b6cb0&label=%40bivy%2Fbivy)](https://www.npmjs.com/package/@bivy/bivy)
[![license: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-2b6cb0)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-2b6cb0)](https://nodejs.org)

**Build, try, and review apps from your phone. Your coding agent and dev
environment stay on your own machines.**

Bivy is an open-source remote development environment built around coding
agents. Ask for a change, try the running app, and point to or draw on what
needs fixing. Send that feedback to the agent and try again—all in the same
session, without going back to your computer.

Live previews bring your app to your phone or browser without deploying it to
Render, building a Docker image, or setting up a separate preview server.
Share a preview link so someone else can try it and leave notes, too.

Keep Claude Code, Codex, Pi, OpenCode, or another supported agent. Keep your
repos, tools, databases, and development environment. Bivy connects them to
chat, a terminal, app previews, and code review wherever you are. Start work
yourself, or let an issue, CI failure, message, schedule, or webhook start it.

**[Start free on Bivy Cloud](https://app.bivy.sh)** ·
**[Quickstart](docs/quickstart.md)** ·
**[Documentation](docs/README.md)** ·
**[Self-host](docs/deploy-images.md)** ·
**[Website](https://bivy.sh)**

**Recommended:** sign in at [app.bivy.sh](https://app.bivy.sh), then copy your
personalized **Connect a Machine** command into a terminal on your Mac or Linux
computer. It installs and enrolls the machine without another Bivy login. The
browser connects automatically; choose a repository and send your first task
right there.

Prefer starting from the terminal?

```bash
curl -fsSL https://bivy.sh/install.sh | bash  # install + guided setup
cd your-repo
bivy run claude                            # or codex, pi, opencode
bivy open                                  # continue in the web app (needs remote setup)
```

Bivy Cloud hosts the app, control plane, and relay—not the machines running your
agents. Connect a Mac, Linux computer, or existing server and bring your own
agent subscription, model API key, or local model. You can also self-host the
entire remote-access stack.

> **Bivy is 0.x software.** Claude Code, Codex, Pi, and OpenCode are the
> release-tested paths. Credential sync, resume, handoffs, approvals, and
> sandboxing depend on the runtime. See the
> [runtime support matrix](docs/runtime-support-matrix.md).

## Build → preview → mark up → iterate

Remote chat lets you ask an agent for a change. Bivy also lets you **use what
it built and show it what to fix**, without a separate deployment step.

1. **Ask for a change.** The agent works in your repo with your existing tools
   and local services.
2. **Try the app.** Open a live preview from the session. Use the running app,
   not just a screenshot of what the agent says it finished. Bivy can discover
   dev servers running in the session workspace; tap **Preview** to open one.
3. **Mark up what needs work.** Point at an element or circle and draw on the
   preview. Add a note, then send the draft to the agent with the element and
   page context. Marked-up screenshots and before/after comparison are available
   when agent screenshots are enabled.
4. **Iterate and review.** Try the next version, inspect the diff, review checks,
   and decide when the work is ready—not just when the agent stops.
5. **Bring someone else into the review.** Copy a public preview link so they
   can use the app without a Bivy account and leave notes on specific elements.
   Bring their notes into the session when you're ready to act on them.

On Bivy Cloud, preview delivery is built in: no per-app domains, certificates,
public ports, or tunnels to configure. Self-hosters configure preview delivery
once for their Bivy deployment, not for every app. The app still needs its normal
build or dev-server setup, and **the machine serving it must stay awake and
online**. These are development previews, not production hosting.

**Share deliberately:** anyone with a preview link can use that app, including
its live backend. Links expire after 24 hours and can be revoked sooner.
Reviewer notes aren't sent to the agent automatically; you send them or explicitly
allow agent access. Preview traffic uses HTTPS through the preview relay, not
session end-to-end encryption; the relay operator can see it.

[App previews, visual feedback, and sharing →](docs/apps.md)

## Your agents and machines, one workspace

| Capability | What it means for you |
|---|---|
| **One workspace, multiple agents** | Use different agents and models for different tasks without maintaining a separate workflow for each. |
| **Your machines and environment** | Work beside your existing repos, dev servers, databases, private networks, toolchains, and GPUs. |
| **Automations and triggers** | Let issues, failed CI, messages, schedules, and webhooks start work instead of copying requests into a chat. |
| **Encrypted key and OAuth sync** | Reuse Bivy-managed provider credentials across enrolled machines and compatible runtimes, with less repeated setup. |
| **Live sessions from anywhere** | Build and review from your phone, browser, or terminal; answer questions and approve supported actions in the same session. |
| **Live app previews** | Try the running app without deploying it to a separate hosting service. |
| **Visual feedback and sharing** | Point, draw, and send specific feedback to the agent; share a preview link for outside review. |
| **Reviewable results** | Inspect the app, changes, declared checks, artifacts, and pull requests—not just an agent's claim that it finished. |
| **Hosted convenience or self-hosting** | Use Bivy Cloud for managed remote access, or run the same open-source core yourself. |

## One workflow, from trigger to review

```text
Prompt · GitHub issue · CI failure · Linear · Slack · Schedule · Webhook
                                 │
                                 ▼
                   Choose machine + agent + model
                     + supported credentials
                                 │
                                 ▼
                         Live agent session
                     Join · steer · approve · stop
                                 │
                                 ▼
                  Try app · inspect changes · checks
                                 │
                                 ▼
                  Mark up · send feedback · iterate
                                 │
                                 ▼
                      Share preview · review PR
```

A **Machine** is a computer or server you connect. A **Session** is live agent
work on that machine. A **Run** is delegated background work that creates a
session and tracks its outcome. An **Automation** is a reusable definition that
creates runs when an event matches.

Manual and automated work use the same kind of live session. You can join a run
when it needs help rather than wait for a black-box job to finish.

### Work in the environment you already have

A clean cloud sandbox isn't always enough. Your agent may need the database
running on localhost, an uncommitted change, an internal API behind your VPN,
or a model running on your GPU. Bivy runs the agent where those things already
exist, subject to that machine's permissions and the runtime's protection.

Connect several machines to the same account: a laptop for interactive work,
a Linux server for background jobs, or a GPU box for local inference. Choose
the machine for each session or pin it in an automation. Repository runs can
use isolated Git worktrees without rebuilding the whole development environment.

**The execution machine must stay awake and online.** To close your laptop and
leave work running, run the agent on a different, always-on machine.

[Environment and multi-machine recipes →](docs/capability-recipes.md)

### Use multiple agents, not multiple disconnected workflows

Run Claude Code for one task, Codex for another, and Pi or OpenCode where they
fit. Bivy supplies the shared session, remote-access, automation, and review
surfaces; your chosen agent still does the coding and uses your model provider.

- Choose an agent and, where supported, a model for each session or run.
- Import existing Claude Code and Codex sessions.
- Fork or move work to another agent or machine when a different setup fits
  better. Continuation fidelity varies: some paths preserve native history,
  while others replay portable turns or seed the destination with context.
- Use agent-native logins, Bivy-managed credentials, or local inference.
  Bivy's custom OpenAI-compatible endpoint registry currently feeds Pi;
  other agents may need their own provider configuration.
- Register your own ACP or headless process agent with `bivy agent add`.

Bivy does not replace your agent, provide model inference, or make every agent's
features identical. Consult the [support matrix](docs/runtime-support-matrix.md)
and [handoff recipes](docs/capability-recipes.md#fork-or-move-a-session).

### Less signing in. Less copying secrets.

Bivy syncs **Bivy-managed API keys and supported OAuth credentials** across
enrolled machines for compatible runtimes. Connect supported credentials once
and reuse them where you run work, rather than manually distributing keys to
each machine.

For ordinary account sync, credentials are encrypted on the node before upload.
The control plane stores ciphertext and wrapped-key metadata; enrolled nodes
share access by wrapping the vault key to one another. Bivy Cloud does not
receive plaintext credentials through this sync path.

You can also keep credentials local, use labeled keys and project presets, or
reference environment variables and 1Password instead of embedding secrets in
configuration:

```bash
bivy provider login
bivy credentials add anthropic work
bivy secrets ref github.repo-token op://Bivy/GitHub/repo-token
```

**Not every CLI login syncs.** Native agent logins may still be per-machine;
GitHub App private-key sync is separately opt-in. If you lose every node and
device able to unwrap a vault, you must sign in to providers again. Explicit
hosted-provisioning custody grants are separate from ordinary encrypted sync.

[Credential sync and runtime coverage →](docs/credential-sync.md) ·
[Credentials guide →](docs/credentials-guide.md) ·
[Key storage →](docs/key-management.md)

### Let events start the work

Automations turn recurring or incoming work into sessions you can join,
supervise, and review. Choose the repository, machine, agent, model, approval
mode, sandbox setting, and maximum attempts.

| Trigger | Example workflow |
|---|---|
| **GitHub issues and mentions** | Label an issue `bivy` or `bivy/<machine>`, or mention your Bivy GitHub App, to work toward a pull request. |
| **Failed CI** | Match a failed workflow, ask the agent to reproduce it, make a fix, and run the affected checks. |
| **Linear** | Label an issue to start work without copying its description into an agent. |
| **Slack** | Send a request from the conversation where the work came up. |
| **Schedules** | Run a weekly dependency review, recurring maintenance, or a one-time task. |
| **Signed webhooks** | Connect alerts, internal tools, or your own event sources. |

Configure automations in the app or version them with your repository in
`.bivy/automations.yaml`:

```bash
bivy automation init
# Edit the generated definition for your repository and workflow.
bivy automation validate
bivy automation test --event .bivy/events/failed-ci.yaml  # supply a local event fixture
bivy automation apply
```

Or delegate a one-off job without creating an automation:

```bash
bivy runs start "Review outdated dependencies and propose a small, tested update."
bivy runs wait <id>
```

Runs keep routing and lifecycle evidence, check results, and output references
in a reviewable Receipt. For unattended issue work, Bivy runs declared repository
checks after the agent's turn; failed required checks fail the run even if the
agent reports success. A completed process alone is not proof that the task
succeeded.

[Automation recipes →](docs/capability-recipes.md#let-events-start-runs) ·
[Automations as code →](docs/automations-as-code.md) ·
[Run outcomes and reliability limits →](docs/automation-runs.md)

### Start at your desk. Continue anywhere.

Open the same session in the browser, phone PWA, or terminal. Watch work live,
answer questions, approve supported tool calls, or stop the agent.

- Send screenshots, images, logs, and other files from your phone.
- Download reports and artifacts the agent creates.
- Open [session apps](docs/apps.md) from chat or the **Apps** menu: live web
  previews, desktop app views, and CLI/TUI tools. Agents can publish views with
  `bivy app publish bivy.app.json` and create share links with `bivy app share`.
- Use voice input and read-aloud where supported; provider-backed voice may
  send audio or text to the selected provider.
- Keep a native terminal workflow or use structured chat, depending on the agent.

```bash
bivy run claude --no-follow  # start without attaching
bivy open                    # open the web app
bivy resume                  # return to the session in your terminal
bivy link                    # pair a device directly via QR
```

No phone app installation is required. Open [app.bivy.sh](https://app.bivy.sh)
in your browser; adding it to your home screen is optional.

[Remote access →](docs/remote-access.md) ·
[Voice, files, and terminal recipes →](docs/capability-recipes.md)

## Get started

### Install

Bivy supports **macOS and Linux with Node.js 20+**. The installer installs the
`@bivy/bivy` package, runs guided setup, and starts a launchd or systemd service:

```bash
curl -fsSL https://bivy.sh/install.sh | bash
```

Setup helps you choose an agent and configure remote access. Existing agents
keep their command, login, and configuration. The installer may use `sudo` to
install a missing Node.js, but never for `npm install`. To inspect it first,
download it with `curl -fsSL https://bivy.sh/install.sh -o install.sh`.

Already have Node.js and want to avoid sudo?

```bash
npm install -g @bivy/bivy
bivy setup
```

Then try one small task:

```bash
cd your-repo
bivy run claude
# Ask: "Explain this repo and make one small, safe improvement. Run the relevant checks."
bivy open
```

Open that same session on your phone while it runs. For a web app, ask the agent
to start its dev server, then open **Apps → Running in this workspace → Preview**.
Try a page, point to something you'd change, and send the feedback back to the
agent. No separate preview deployment needed.

Once that works, share a preview for review, connect another machine, or add
your first automation.

**Local-only works too.** `bivy run`, `bivy resume`, and `bivy sessions` need no
account or server. Choose **local only for now** during setup; use `bivy login`
later. Browser and phone access need a hosted or self-hosted control plane;
the node itself does not serve a web UI.

[Full quickstart →](docs/quickstart.md) ·
[Installer options, service management, and uninstall →](docs/install.md)

### Choose hosted or self-hosted

| Option | What you get |
|---|---|
| **Free Cloud — $0** | Every launch feature, including automations; 10 new remote sessions per rolling seven days. No credit card required. |
| **Cloud — $15/month** | The same features with unlimited remote sessions. |
| **Self-hosted Core** | Operate the app, control plane, and relay yourself, with no Bivy usage limits. |

Manual and automated sessions share the Cloud allowance. Resuming existing
sessions and viewing history do not consume it. Agent subscriptions and model
provider charges are separate. See [current pricing](https://bivy.sh#pricing).

**Self-host anywhere:** deploy the public control-plane (including the web app)
and relay images with Postgres and [a small set of environment variables](docs/deploy-images.md).
Your server or container platform handles HTTPS. Set up owner access in the
browser—no SSH, external authentication provider, or Bivy Cloud account required.
For a bare VPS, the [Compose installer](docs/self-host-quickstart.md) automates the
same stack. These onboarding features require a release containing them.

Start on Cloud and self-host later if you prefer. Deploy the stack, reconnect
machines with `bivy relay:setup`, and pair devices to your server. This is not a
one-click migration of your Cloud account; your local repos and agent
configuration stay in place.

```bash
bivy relay:setup \
  --control-plane https://bivy.example.com \
  --relay wss://relay.example.com
```

Self-hosting is community-supported: you own TLS, backups, upgrades, and
hardening. Public multi-architecture images are available as
`ghcr.io/bivysh/bivy-control-plane` and `ghcr.io/bivysh/bivy-relay`; pin a release
version or full commit SHA.

[Deploy the images anywhere →](docs/deploy-images.md) ·
[Optional VPS installer →](docs/self-host-quickstart.md) ·
[Operations reference →](docs/self-host.md)

## Architecture

Your environment, with clear security boundaries:

```text
Your machine                         Hosted or self-hosted
┌──────────────────────┐             ┌──────────────────────┐
│ Node daemon          │──outbound──▶│ Relay                │
│ Agents, repos, tools │             │ Encrypted frames     │
│ Local credentials    │             └──────────┬───────────┘
└──────────────────────┘                        │
                                    Browser / phone
                                    + control plane
                                    (app, accounts, metadata)
```

- **Execution stays on your machine.** Bivy Cloud does not run your agents.
  Your model provider still sees whatever the agent sends it.
- **Interactive session traffic is end-to-end encrypted** between the node and
  paired devices. The relay forwards opaque session frames; your node dials out,
  so no inbound public port is required.
- **App previews have a separate security boundary.** Preview traffic uses HTTPS
  and an outbound tunnel, not session E2E encryption. The preview ingress/relay
  operator can see it. Public preview links grant anyone holding them access to
  that view and its live backend until expiry or revocation. See
  [preview security and sharing](docs/apps.md#runtime-and-security-boundaries).
- **Ordinary credential sync uploads ciphertext, not plaintext keys.**
  Supported credentials and recovery limits are documented separately.
- **Encryption is not universal across integrations.** Slack commands and
  generic webhook instructions reach the control plane in plaintext. Do not
  put secrets in them. Routing and bounded run metadata are also visible there.
- **Device authorization matters.** QR pairing authorizes a device directly
  through the node. Hosted account pairing trusts the control plane to authorize
  devices and serve the web app that holds client keys.
- **Bivy is not an OS-level sandbox.** The default approval mode is
  `autonomous`; protection depends on the runtime. Some agents enforce sandbox
  tiers, while process agents may run with your full user permissions.
  Heuristic tool checks help prevent accidents but are not isolation.

Review the runtime's Protection label and configure approval/sandbox settings
for the task, especially before enabling unattended work.

[Security model and known limitations →](docs/security-model.md) ·
[Runtime protection matrix →](docs/runtime-support-matrix.md) ·
[Configuration →](docs/configuration.md)

## Agents and everyday commands

**Claude Code, Codex, Pi, and OpenCode are release-tested.** Additional adapters
include Gemini CLI, Qwen Code, Goose, Aider, Cline, Crush, Cursor, GitHub Copilot,
Grok, Amp, Auggie, Droid, Continue, Kilo Code, and Rovo Dev. Installation,
resume, model selection, and tool protection vary—see the
[support matrix](docs/runtime-support-matrix.md) and [agent guides](docs/agents/README.md).

Run an arbitrary command with `bivy run -- ./your-agent --flags`, register a
reusable entry with `bivy agent add`, or package a declarative integration with
experimental [plugins](docs/plugins.md).

```bash
bivy run claude       # launch a durable session; also codex, pi, opencode
bivy sessions         # list live and saved sessions
bivy resume           # resume the most recent session
bivy open             # open the web app (requires remote setup)
bivy nodes            # list connected account machines
bivy runs list        # inspect delegated work
bivy automation init  # scaffold repo-owned automations
bivy provider login   # connect supported model credentials
bivy agent add        # register an ACP or process agent
bivy doctor           # check installation and connectivity
bivy logs -f          # follow node logs
bivy update           # update and restart the service
```

`bivy update` uses your original installation method and waits for an active
turn to finish before restarting. Use `--force` to skip that wait.

[CLI reference →](docs/cli-reference.md) ·
[Node and project configuration →](docs/config-as-code.md) ·
[GitHub setup →](docs/github-setup.md) ·
[Linear setup →](docs/linear-work-queue.md)

## Development and contributions

```bash
pnpm install
pnpm run dev          # node daemon on http://localhost:4317
pnpm run dev:web      # web client dev server
```

| Directory | Contents |
|---|---|
| `src/`, `bin/` | Node daemon, CLI, runtime adapters, sessions, approvals, secrets |
| `packages/core/` | Shared protocol, pairing, and wire format |
| `packages/web/`, `packages/ui/` | React PWA and shared design system |
| `services/relay/` | Self-hostable encrypted relay |
| `services/control-plane/` | Self-hostable control plane |
| `deploy/` | Deployment examples |

```bash
pnpm run typecheck
pnpm run typecheck:web
pnpm run lint
pnpm run test:unit
pnpm run test:core
pnpm run check:licenses
pnpm run check:secrets
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Releases
are published from CI with provenance attestations; see
[release verification](docs/releasing.md).

**Found a security issue?** Use
[GitHub private vulnerability reporting](https://github.com/bivysh/bivy/security/advisories/new),
not a public issue. See [SECURITY.md](SECURITY.md).

### In development—not available at launch

Automatically provisioned, short-lived **ephemeral machines** are in development
for hosted and bring-your-own-cloud deployments. Neither path is ready or
supported for this launch. Use an existing computer or server you operate.
Experimental provisioning has different credential-custody and encryption
boundaries; see the [provisioning trust model](docs/hosted-provisioning-trust-model.md).

## License

Everything in this repository—node, CLI, web/PWA, relay, and control plane—is
free and open-source **AGPL-3.0-only Core**, with no Bivy usage limits. You may
use, modify, and self-host it under that license. If users interact with your
modified version over a network, section 13 requires you to offer its
corresponding source. See [LICENSE](LICENSE).

Bivy Cloud is the hosted operation of that stack plus billing and plans, in a
separate private repository. Contributions use the
[DCO](CONTRIBUTING.md#certificate-of-origin); there is no CLA.
