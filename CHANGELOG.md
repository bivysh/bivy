# Changelog

All notable changes to Bivy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.1.0] - 2026-07-24

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
