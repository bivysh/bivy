# Changelog

All notable changes to Bivy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub App runs can now be restricted to contributors or collaborators only,
  via **Settings → GitHub App → Who can trigger runs**. Previously, anyone
  could `@`-mention the bot in an issue/comment on a public repository and
  queue a run; the new setting gates the mention trigger on GitHub's own
  `author_association` for the issue/comment author. Defaults to "everyone"
  (unchanged behavior). (#259)

## [0.1.2] - 2026-07-30

### Fixed

- Work queued for a node renamed while running is now picked up immediately; the
  hosted queue poller updates its `bivy/<node>` route without requiring a daemon
  restart. (#261)
- Git operations no longer fail with `Unable to read current working directory`
  after an npm update replaces the daemon's install directory. The daemon and its
  credential helper now anchor themselves in durable directories. (#261)

### Changed

- Settings now uses the official Slack and Linear logo geometry instead of
  approximate line-art icons. (#261)

## [0.1.1] - 2026-07-30

### Fixed

- Repository cloning now recovers when the daemon inherited a stale or deleted
  working directory. Clone destinations are resolved from a stable base, and the
  web client surfaces the self-healing retry instead of leaving the operation
  stuck on an opaque failure. (#256)

## [0.1.0] - 2026-07-30

First public release.

Bivy runs coding agent CLIs on machines you own and makes those sessions
reachable from a phone, browser, or another terminal. This release marks the
point at which the node daemon, CLI, relay, control plane, and web client are
published as source-available software.

### Highlights

- **Ten agents through one interface** — Pi, Claude Code, Codex, OpenCode,
  Gemini CLI, Qwen Code, Goose, Aider, Cline and Crush, each driven through its
  native CLI in a real PTY. Any other command runs via `bivy run -- ./your-agent`.
- **Durable sessions** — an append-only event log and a dedicated git worktree
  per session. Sessions survive detach, daemon restart, and reconnection from a
  different device.
- **Remote access without inbound ports** — the node dials out to a relay that
  forwards end-to-end encrypted frames. Device pairing uses X25519 + HKDF; the
  relay and control plane see ciphertext only.
- **Approvals** — risky shell commands and file edits pause for in-chat
  approval; safe read-only commands run automatically. Modes: `never`, `risky`,
  `always`, `autonomous`.
- **Session forking** — continue a session on a different agent, model, or
  machine, carrying the transcript and uncommitted work.
- **GitHub work queue** — label an issue `bivy` or mention the GitHub App, and a
  node you own claims it, works in an isolated worktree, and opens the PR.
  Multiple GitHub Apps per account are supported — one per personal account or
  organization, each with its own key and `@`-mention handle.
- **Terminal takeover** — `bivy shim install <agent>` makes the native TUI start
  inside a Bivy PTY, so an ordinary terminal session becomes remotely drivable.
- **Credentials stay local** — encrypted vault with `secret://`, `env://`, and
  `op://` (1Password) references resolved before the daemon starts.
- **Any model endpoint** — thirteen providers by API key or OAuth, plus
  self-hosted OpenAI-compatible, Azure, Ollama, LM Studio, vLLM and SGLang.
- **Bring-your-own-cloud runners** — short-lived machines on Fly.io, Hetzner, or
  AWS EC2 using a provider token that stays on your device.
- **Published on npm with provenance** — releases are published from CI via npm
  [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no
  long-lived token) and carry a signed provenance attestation; verify with
  `npm audit signatures`.

### Added

- **True cross-agent session forks.** Forking a session onto a *different* agent
  or model no longer drops the new agent into a 12-turn summary prompt. When the
  target runtime can import portable history (a new `forkHistoryImport`
  capability), the fork now materialises the *whole* transcript as real prior
  turns in the target's own store and resumes it — so a `pi → claude` (or
  model-swap) fork opens on an actual copy of the conversation, a third fidelity
  tier `"replayed"` between `"full"` (byte-exact same-runtime native replay) and
  `"seeded"` (the summary-prompt fallback). The replayed history is rendered as
  plain-text turns with tool activity inlined — never provider-specific
  `tool_use`/`tool_result` blocks — so it stays valid on any target model, and a
  runtime that can't import history (or an import that fails at run time) still
  falls back cleanly to the seeded continuation. Pi, Claude Code, and Codex all
  implement it (`AgentRuntime.importHistoryForFork`) — Codex by synthesising a
  resumable rollout under `$CODEX_HOME/sessions` (`writeCodexRollout`; best-effort
  against a live Codex resume, opt out with `BIVY_CODEX_NO_FORK_REPLAY=1`), wired
  through the shared `ProtocolRuntime.writeHistory` hook so any protocol/ACP agent
  with a writable store can opt in the same way. See `src/session/fork.ts` and
  `buildForkHistory` in `src/session/transcript-normal.ts`. The *source*
  side now works for **every** agent, not just those with a `readMessages` fast
  path: `buildForkBundle` falls back to the live session's transcript, so a fork
  *from* a wrapped CLI agent (which keeps its transcript only on the live
  session) carries its real history instead of an empty one — a true replay into
  pi/Claude/Codex, and a richer seeded prompt into any other target. The seeded
  fallback (for agents with no writable resume store) is now **budget-adaptive**
  rather than a fixed 12-turn tail: `buildSeedPrompt` packs verbatim recent turns
  up to a character budget (default ~3k tokens), so a long run of short turns
  carries far more context, while verbose turns stay bounded for the target's
  context window; anything that doesn't fit is reported as an omission count that
  points at the full transcript.

- **Ten more coding agents in the picker, and a general path to more capability.**
  The agent selector gains nine of the most-used CLIs — Cursor, GitHub Copilot,
  Grok, Amp, Auggie, Droid, Continue, Kilo Code, and Rovo Dev — plus a hidden
  Codebuff runtime (no verified non-TTY headless mode upstream yet). All are wired
  purely as data on the shared ProcessRuntime + CliParser path (resume/model
  advertised only where the CLI actually drives it), and the selector now sorts
  A→Z. Beyond breadth, five general levers push agents *up* the capability ladder
  without per-agent code: (1) a unified agent manifest — one `CLI_AGENT_SPECS`
  entry now drives the catalog, picker visibility (`hidden`), install
  (`cliInstallSpec`, shared with the server auto-installer), and the terminal CLI
  (`bin/agent-manifest.json`, sync-tested); (2) **MCP tool approvals**
  (`BIVY_MCP_PROXY`) — an agent's MCP `tools/call`s get real Approve/Deny via the
  same guardian path as native interception; (3) **tolerant structured parsers**
  (`generic-stream-json` / `generic-json`) that add transcript fidelity opt-in
  (`BIVY_AGENT_STRUCTURED=1`) and never lose output; (4) **capability probing**
  (`BIVY_AGENT_PROBE=1`) that runs `<cli> --help` and downgrades any resume/model
  capability the installed binary no longer evidences; and (5) a **general ACP
  adapter** (`bin/acp-shim.mjs`, runtime `acp`) that drives any Agent Client
  Protocol agent through the governed ProtocolRuntime for per-tool approvals,
  streaming, and resume — the preferred way to wrap agents that speak it, with
  per-agent promotion as data (Gemini CLI declares `acp` and promotes via
  `BIVY_GEMINI_ACP=1`; `BIVY_PREFER_ACP=1` promotes all ACP-capable agents,
  honestly gaining Approvals + Resume). See `docs/runtime-support-matrix.md` and
  `docs/agents/`.

- **Seven more agents promotable to the governed ACP path.** A systematic review
  of every supported agent for a native Agent Client Protocol server found seven
  beyond Gemini that ship one, and each now declares `acp` as data so it can be
  driven through `bin/acp-shim.mjs` → the governed `ProtocolRuntime` (per-tool
  Approve/Deny + `session/load` resume) instead of the one-shot pipe: **Qwen
  Code** (`--experimental-acp`/`--acp`), **OpenCode** (`acp`), **Goose** (`acp`),
  **Kilo Code** (`acp`), **Cursor** (`acp`), **Cline** (`--acp`), and **GitHub
  Copilot** (`--acp`). Promote one with `BIVY_<ID>_ACP=1`, or all at once with
  `BIVY_PREFER_ACP=1`; each stays off by default (on the honest pipe path) until
  validated for the installed version. Agents with no first-party ACP server
  (Aider, Amp, Crush, Continue, Grok) stay on the pipe — promoting them later is a
  one-line `acp` field, no runtime code.

- **Privacy-safe run evidence and outcome reports** — every automation run
  (GitHub issue/comment, Slack, manual, or scheduled) now carries a structured,
  allowlisted evidence record on top of its routing/status: why this node/
  runtime/model was chosen, declared-check pass/fail/exit status, and a
  capped, ordered event timeline (claimed, attempts, retries/fallback with a
  reason, branch, pull request, completion) — most of it stamped automatically
  by the control plane, with a node able to layer richer events on top through
  a new `POST /node/work/:id/evidence` endpoint. The GitHub queue view renders
  it as a per-run "Outcome reports" timeline with a **Copy sanitized report**
  export. The sanitizer (`services/control-plane/src/run-evidence.ts`) rejects
  prompt, transcript, diff, file-content, secret, token, and raw command/tool-
  output fields outright — no server-side transcript indexing, ever. GitHub
  issue/comment title and body are also no longer retained on the control
  plane at all: the claiming node now fetches them directly from GitHub,
  immediately before use. (#153)
- **Discover and adopt existing Claude Code / Codex sessions** — a node now
  advertises provider-native sessions its Claude Code or Codex adapters can
  see (a bare `claude`/`codex` run started outside Bivy), and the app can
  import one via a new "Import existing session" sheet, filterable by node,
  provider, repository, and recency. Discovery is capability-driven
  (`capabilities.nativeSessionDiscovery`/`nativeSessionAdoption`) and returns
  bounded metadata only — id/ref, cwd, updated time, a truncated first-prompt
  title, and an active/resumable flag — never transcript content, and never
  duplicates a session Bivy already manages. Importing resumes the session
  natively through the ordinary open/resume path without rewriting or
  deleting the provider's own history whenever the runtime supports it (the
  case for every Claude Code / Codex session today); a runtime that can only
  discover but not natively resume a session instead falls back to a fresh,
  seeded continuation — and the node refuses that fallback until the app
  shows the disclosure and the user explicitly confirms "Import anyway". A
  session with a live external process is never importable — Bivy has no safe
  way to take over a process it doesn't own — and instead surfaces the
  provider's own resume command (`claude --resume <id>` / `codex resume <id>`)
  so it can be followed read-only in a terminal. Other runtimes stay hidden
  from the discovery UI until their adapter earns the capability. (#156)

- **Scheduled automations** — Settings → Automations lets you create a
  recurring (cron, with an explicit IANA timezone) or one-time schedule that
  runs an end-to-end encrypted instruction template on an assigned node, with
  its own runtime/model/approval/sandbox defaults, run-now, enable/disable,
  next-run preview, and recent results. Schedules generate runs through the
  same automation-run lifecycle as GitHub/Slack/manual triggers — an offline
  node's due occurrence stays pending until it reconnects, restarting the
  control plane or running several instances can't duplicate an occurrence,
  and hosted entitlement checks happen at run admission, not schedule
  creation. The control plane only ever holds routing metadata plus the
  ciphertext; it cannot read the instructions. (#148)

- **GitHub App key sync across nodes** — `bivy github:app-sync on` opts a node
  into pulling/pushing a connected GitHub App's private key E2E-encrypted
  through the control plane, so connecting an app on one node makes it usable
  on the account's other opted-in nodes without re-uploading the `.pem`. Off
  by default and per node; the control plane never holds a plaintext key.
  Removing a node from the account flags its apps for rotation, so a
  surviving node mints a fresh vault key on its next sync. (#88)

### Changed

- **Free interactive sessions are now unlimited; Pro meters the operations layer.**
  The free rolling allowance now counts only unattended GitHub, Slack, webhook,
  and scheduled jobs. CLI, phone, browser, and interactive ephemeral-runner
  sessions no longer consume it. Free includes 10 automations per rolling seven
  days; Pro keeps automation unlimited. This aligns pricing with the product's
  differentiated queue rather than charging for basic remote control.
- **Automations panel: node selector instead of free text, plus an ephemeral
  fallback toggle** — the generic webhook automations panel's "Default node"
  field used to be a plain text box you had to type a node's label into
  correctly, unlike the GitHub App panel's dropdown of known nodes; it's now
  the same dropdown (falling back to text only when the account has no known
  nodes yet), for both creating a webhook and editing an existing one's
  routing. The account-wide "auto-provision an ephemeral server when nothing's
  online" toggle — previously only visible in GitHub App settings — is also
  now shown here, since the shared automation-run queue already picks up
  webhook-triggered work the same way it picks up GitHub work. (#166)
- **Nodes settings panel: fields grouped into labeled sections** — the panel
  used to list a dozen unrelated fields (node name, default agent/model,
  sandbox mode, GitHub session limit, GitHub issue prompt, session sync) as
  one continuous flat list with no visual separation, which read as a wall of
  text, especially in the mobile drill-in view. Fields are now grouped under
  labeled sections (Node, Identity, Session defaults, GitHub, Session sync)
  with divider lines between them, matching the grouping already used by the
  GitHub App and GitHub Queue panels. (#74)

### Security

- Updated the bundled Pi runtime to 0.82.1 and pinned patched MCP/Hono
  transitive releases, clearing the protobuf and MCP HTTP-server advisories from
  the release tree. One upstream `brace-expansion` advisory remains
  inside Pi's published shrinkwrap and is tracked pending an upstream package release.
- The node no longer authorizes bare loopback callers (no token) by default on
  a host it detects as multi-user — every local account shares `127.0.0.1`, so
  loopback alone let any other OS user on a shared host drive the agent (shell
  + file edits) without a token. Detection (`isMultiUserHost` in `src/auth.ts`)
  counts real login accounts via `/etc/passwd` on Linux or `dscl` on macOS;
  single-user hosts (the common case) keep today's zero-friction loopback
  bypass unchanged. Override with `BIVY_REQUIRE_LOCAL_AUTH=1`/`=0` or
  `BIVY_MULTI_USER_HOST=1`/`=0` if detection guesses wrong for your box. The
  CLI transparently bootstraps a device token when the daemon requires one, so
  `bivy status`/`bivy doctor`/etc. keep working unchanged. (#111)

### Fixed

- **Multiple nodes on one machine no longer collide on port 4317.** Running a
  second node on the same box — a staging + production node, or one node per OS
  user — used to fail: `bivy setup` always defaulted the local port to `4317`,
  never checked whether it was free, and even ignored `PORT=… bivy setup`
  (it only read `cli.json`). The loopback address `127.0.0.1:4317` is
  machine-wide, not per-user, so whichever node started second failed to bind —
  and worse, the daemon's catch-all `uncaughtException` net swallowed the
  `EADDRINUSE`, leaving a process that was "running" but listening on nothing.
  Setup now auto-selects the first free port at or above `4317`
  (`bin/port-picker.mjs`), so additional nodes land on `4318`, `4319`, …
  automatically; an explicit `PORT` is still honored verbatim. And the daemon now
  fails loudly on a taken port with an actionable message instead of wedging
  silently.

- **Port-collision detection now also covers install, restart, and update — not
  just `bivy setup`.** The auto-avoidance above only ran during `bivy setup`;
  `bivy service install`, `bivy restart`, and `bivy update` baked the *saved*
  `cli.json` port into the systemd/launchd unit (and restarted into it) verbatim.
  So a node whose `4317` had since been claimed by a second node on the same box
  — e.g. a root install plus a per-user install, or a second OS user who ran
  setup while the first node was down — would keep colliding across every restart
  and update, with no re-check. These paths now re-validate the port right before
  writing the unit / restarting: a free port is kept, a port still held by *this
  install's own* node is kept (a plain restart never relocates a node off the port
  it already owns — the occupant is identified by comparing its `/api/status`
  `appDir` to ours), and a port taken by a *foreign* node rolls forward to the
  next free one, is persisted to `cli.json`, and the unit is rewritten to match.
  An explicit `PORT` is still honored verbatim. New pure helper `reconcilePort`
  in `bin/port-picker.mjs`, unit-tested alongside `findAvailablePort`. (Detecting
  a *stopped* peer's pinned port still isn't possible from a live socket probe —
  that would need reading another user's `cli.json`, which a per-user install
  can't do — so give distinct installs distinct ports up front if they may be
  down at install time.)

- **OpenCode runs fail loudly, not opaquely, when a provider key is missing.**
  `opencode run` boots OpenCode's own server, which returns an opaque
  `UnknownError: Unexpected server error. Check server logs for details.`
  (with an `err_…` ref pointing at a log Bivy can't read) when the selected
  provider has no credential — so a user with, say, GPT-5 selected but no
  OpenAI key just saw a cryptic 500. A provider-aware credential preflight
  (`src/runtime/opencode-preflight.ts`, mirroring the Codex one) now catches the
  missing key up front and returns an actionable message naming the provider and
  the env var to set. Bivy also strips ANSI escape codes from relayed CLI output
  (`src/runtime/ansi.ts`), so dumb-pipe agents no longer render their colorized
  errors as `[91m[1m…` garbage in the agent-output pane. (#205)
- **Ephemeral machines now actually come online.** The bootstrap installed
  Bivy but never *started* the node on a headless, pre-enrolled machine (no TTY
  → the installer just prints "run `bivy setup`"), so the node never dialed the
  relay and stayed offline. The bootstrap now writes `/etc/bivy/start.sh` and
  launches the daemon (`bivy start`, reading the baked `relay.json`) — via a
  transient `systemd-run` unit on VM providers (Hetzner/EC2). **Fly.io was doubly
  broken:** a Fly Machine is an OCI image in a microVM, not a cloud-init VM, so
  the `#cloud-config` user-data was never executed and the bare `ubuntu:24.04`
  ran `/bin/bash`, which exits instantly — with `restart: no` + `auto_destroy`
  the machine self-destructed on boot ("this app has no machines" / node
  offline). Fly now boots from machine `files` + a **foreground** init process
  that installs `curl` (absent from the bare image) and Bivy, then runs the
  daemon under a TTL `timeout`. Also added an official-nodejs.org Node 22
  fallback to `install.sh` since `deb.nodesource.com/setup_22.x` now returns
  `403` (apt otherwise falls back to Node 18, which is too old for Bivy).
  Launching also self-heals the fallout from the above: every self-destructed
  machine left an orphaned `eph-*` node enrolled on the account, and enough of
  them tripped the plan's node limit so new launches failed enrollment with a
  generic "Could not enroll the machine". A node-limit-blocked launch now reaps
  its own orphaned ephemeral nodes (offline `eph-*` nodes past their boot grace,
  never a persistent or still-booting node) — and drops any lingering local
  "Launched machines" row for them — then retries.
- **Transient CLI/relay clients no longer clutter "Signed-in devices".**
  `bivy run --node` bridges and sibling-node replicas paired with a node via
  the same `pair.account` handshake a phone/browser uses, so the control plane
  recorded each one as a durable paired device. Because these tools can mint a
  fresh device keypair per invocation (probes, tests, one-off runs), the
  account's Account & billing → Signed-in devices list filled up with rows
  like "Bivy CLI probe" and "Bivy CLI (run --node)" that never got cleaned up.
  These transient connections now mark their pairing `ephemeral`: the node
  still authorizes them and hands over the room key, but the control plane
  skips the paired-device record, so only real user devices are listed (and
  the account's device count stays accurate). Genuine app/QR devices are
  unaffected.
- The GitHub issue queue's per-node concurrency cap now actually lets issues
  run in parallel up to the configured limit. `GitHubTaskPoller` (and the
  hosted work-queue's `ControlPlaneTaskPoller`) used to `await` each claimed
  issue/item to completion before even considering the next one in the same
  poll tick, so — regardless of the concurrency setting — only one ran at a
  time; the cap only ever appeared to do anything when two `setInterval` ticks
  happened to overlap by luck. Issues/items now start concurrently (still
  capped) within a single tick. (#116)
- `bivy relay:setup` now honors `BIVY_DATA_DIR` like every other entry point
  instead of hardcoding `<repoRoot>/.bivy`. On a global/packaged install
  (where the CLI resolves the data dir to `~/.bivy`) it used to write
  `relay.json` and the node identity into the install directory, which is
  wiped on update, silently breaking remote access after `bivy update`. (#2)
- The sidebar no longer drops another node's `bivy run` terminals when you
  switch nodes — e.g. from the "New session" header switcher. Run terminals
  are now tagged and merged by node the same way chat sessions already were,
  so the sidebar keeps showing every node's sessions regardless of which node
  is currently selected. (#99)
- `bivy sessions` / `bivy ls` now lists every saved session by default instead
  of only the 15 most recent, so older sessions are visible and resumable
  again. Use `--limit`/`--n` to cap the list. (#71)
- `install.sh` now persists a PATH fix into `~/.bashrc`/`~/.zshrc` when the
  npm (or fallback `~/.local`) bin directory isn't already on `PATH`, instead
  of only printing an `export PATH=...` line — which fixed nothing beyond the
  terminal that ran the installer, leaving `bivy` unrecognized in every new
  shell afterwards. Opt out with `BIVY_NO_RC_UPDATE=1`. (#69)

### Known limitations

- Bivy does not ship an OS-level sandbox jail. Sandbox tiers are enforced
  natively by agents that support them; others are governed at the filesystem,
  MCP, and network layer.
- Queued GitHub issue titles and bodies are stored in plaintext by the control
  plane until a node claims them.
- Credential sync between your own nodes covers Bivy-managed provider keys;
  agent-native logins remain per-machine.
- Aider and Crush cannot resume a session (upstream gaps).
- Self-hosting is unsupported: no SLA, community best-effort.

For the complete trust model and the full list of 0.1 limitations, see
[`docs/security-model.md`](docs/security-model.md).
