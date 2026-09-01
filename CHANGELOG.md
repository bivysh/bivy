# Changelog

All notable changes to Bivy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.16.2] - 2026-09-01

### Changed

- Machine connection instructions now use one consistent card across onboarding
  and Add a Machine, show both sign-in options, and keep the dialog centered.
- The installer now streams npm progress and lifecycle output while retaining it
  for fallback diagnostics; verbosity can be adjusted with `BIVY_NPM_LOGLEVEL`.

## [0.16.1] - 2026-09-01

### Changed

- Documentation now distinguishes Bivy's local agent runtime, remote browser
  access, and optional hosted control plane more clearly.

### Fixed

- Native terminal handoffs now discover and resume agent sessions reliably,
  including Claude Code, Pi, Gemini CLI, and Qwen Code sessions.
- `bivy update` now recognizes scoped global npm installs and restarts an
  existing service even when its stored configuration hint is stale.
- Tool calls and results from agents that omit correlation IDs now remain paired
  in live and persisted transcripts instead of appearing as duplicate or
  indefinitely running tool cards.

## [0.16.0] - 2026-08-31

### Changed

- Control-plane and relay containers now run as an unprivileged user, drop Linux
  capabilities, prevent privilege escalation, and serve a host-scoped HSTS policy.
- Production dependencies were refreshed, including TypeBox, Highlight.js,
  Mermaid, PostgreSQL, Sentry, and cron-parser.

### Fixed

- Model-auth key requests no longer create a relay feedback loop, repeatedly
  write unchanged requests, or inadvertently trigger hosted machine provisioning.
- Scheduled automations now update PostgreSQL timestamp fields without parameter
  type-inference errors that caused due runs to retry indefinitely.

## [0.15.0] - 2026-08-31

### Added

- Self-hosted control planes can use AWS KMS as the hosted keyring source for
  encrypted machine enrollment credentials.
- Automation setup now includes source readiness checks, clearer trigger
  templates, scoped run history, and a dedicated Runs destination.
- Accounts can be permanently deleted from Accounts & Billing settings, including
  deployment-owned billing data, after any hosted machines are removed.

### Changed

- Installation now supports Node.js 20+, skips optional agent bridges and native
  terminal dependencies on the fast path, and installs only the selected agent
  integration when needed while preserving existing agent installs and logins.
- The PWA has a more focused mobile and desktop shell, simpler new-session and
  automation flows, improved workspace navigation, and more consistent sheets,
  menus, touch targets, and attention states.
- First-session onboarding now starts by connecting a machine, offers its default
  workspace without requiring GitHub, and limits the post-activation automation
  suggestion to a one-time next step.
- Add Machine now presents clearly labeled auto sign-in and regular sign-in
  commands with separate copy actions and explicit token-safety guidance.
- Maintained agent support is now reported separately from release-tested
  capability certification, so support status does not disappear when an
  upstream version moves beyond the latest certified range. Release-tested pins
  were refreshed for Claude Agent SDK 0.3.251, Codex 0.151.0, Pi 0.84.4, and
  OpenCode 1.18.25.
- The agent picker prioritizes Claude Code, Codex, Grok, OpenCode, and Pi while
  keeping the full catalog searchable, and uses an explicit confirmation when
  switching to an agent whose sign-in or protection level cannot be verified.
- Session and automation polling payloads are smaller to reduce routine control
  plane traffic.
- Direct GitHub queue runs now honor project and node rulesets for retries and
  fallback routing, matching hosted queue behavior.

### Fixed

- Session switching, closed-session resume, and async handoffs now keep prompts
  and follow-ups attached to the intended session and preserve native resume
  references; changing agents in a blank session remains a draft instead of
  creating an empty fork.
- Reasoning, structured tool calls, tool results, failures, and workspace changes
  are preserved consistently in stored and resumed transcripts.
- Webhook automations preserve signing settings, accept provider-native JSON
  payloads, and generate idempotency keys when providers cannot send custom
  headers.
- Signing out clears the account-bound browser device key and remote pairing, so
  the same browser can sign in and pair successfully with a different account.
- Concurrent automation and vault operations now share one device identity and
  tolerate stale recipients, avoiding save races and spurious sync failures.
- Token and claim-based machine installs now use the standard installer and a
  non-interactive enrollment path that works correctly on headless machines.
- Automations sidebar navigation and voice-provider key actions now open their
  intended destinations directly.
- Mobile overlays, modal history, Settings navigation, automation editor state,
  agent picker selection, actionable authentication errors, and terminal-launched
  updates no longer get stuck or lose user state; automation text fields also no
  longer trigger browser zoom on focus.

## [0.13.0] - 2026-08-27

### Added

- Hosted GitHub App support was extracted into the Cloud integration path.
- Personal machine claims and first-run onboarding now give new installs a
  clearer account-linked setup path.

### Changed

- Machine onboarding is more app-first, first-run launch messaging is sharper,
  Cloud machines are gated behind an explicit settings opt-in, and Free Cloud
  remote sessions now respect plan limits.

### Fixed

- Existing installs re-enroll with an account token so they stay connected after
  the account-linked onboarding changes.
- Blocked hosted automations now surface clearly instead of failing silently.

## [0.12.0] - 2026-08-27

### Changed

- One-off automations are hidden from the main overview so recurring automation
  management stays focused.
- Supported agent certification was refreshed for the latest Codex and OpenCode
  runtimes.

### Fixed

- Active web terminal sessions preserve their handoff path instead of dropping
  terminal continuity.
- Codex transcript repair keeps resumed conversations faithful after runtime
  certification updates.
- Revoked OAuth credentials are refreshed automatically instead of leaving
  connected integrations stuck until manual reconnect.

## [0.11.0] - 2026-08-19

### Added

- Machines can declare owner-asserted capability tags (`bivy config set
  node.capabilities '[gpu, docker]'`); repositories can declare required/
  preferred capability tags and named service health-check/start scripts in
  `.bivy/environment.yaml`. One-off Runs and Automation definitions can
  request required/preferred tags: a required tag honestly parks the Run
  (`needs_attention`) only when no Machine anywhere has ever declared it,
  and never fabricates availability for a preferred tag. CLI-only for now —
  see the capability-routing PR for the PWA-editing follow-up.
- `bivy run <agent> --chat` starts a governed session through the same runtime
  path as the web/PWA app and opens it directly; `--no-open` creates it without
  launching a browser and prints the session URL instead.
- Declarative agent plugins: `bivy plugin init|validate|doctor|test|install|list|remove`
  scaffolds and installs strict `bivy.sh/v1alpha1` manifests from local files.
  Plugins can contribute process or ACP agents to the CLI and web runtime catalog
  without a Bivy source change; executable code remains out of process and
  external rows are always Experimental / Unverified.
- Plugin developer tooling now includes the `@bivy/plugin-sdk` workspace package,
  a generated JSON Schema, `requires.bivy` semver compatibility enforcement,
  executable diagnostics, real ACP handshake conformance, and a runnable example.
- Packaged and node-configured agent integrations now share one ordered registry
  for provenance, aliases, visibility, discovery, connection, conflicts, and
  allowlisted upstream installation. Maintained profiles and Pi/Claude/Codex bridges
  live under `src/agents/` and connect to the operator's installed agent commands.
- `bivy agent add|list|remove` connects a user-owned ACP or headless process agent
  through the same strict manifest/store contract as installed plugin packages.
- Automations is now the **sole place** to connect, add, reconnect, or
  disconnect GitHub Apps, Linear, and Slack — full multi-app GitHub lifecycle
  (create, connect an existing app, install, reconnect a key on this machine,
  disconnect, default machine, who-can-trigger) lives in the Automations setup
  sheet. Settings → GitHub App / Linear / Slack are now thin hand-offs that open
  that same sheet instead of duplicating the flow.
- GitHub automations use structured **event rules** (`on[]`): one GitHub App,
  jobs pick which deliveries fire (issues/PRs labeled, @mentions on issue/PR/
  review comments, failed workflow runs). Outcomes are whatever the instructions
  say — not a special-cased PR path. UI collapses GitHub Actions into GitHub
  with event toggles; labels and @mentions work on PR surfaces too.

- Automations setup stays on the Automations surface end-to-end: outcome-first
  empty hero with featured jobs, whole-card templates with trigger badges, a
  single-page create sheet (name → trigger → instructions → machine), compact
  live source pills, and in-sheet GitHub / Linear / Slack connect so setup never
  dumps people into Settings. Success notices offer a clear next step (Run now /
  Open session); rows use overflow menus; webhook create still reveals the
  one-time signing secret.
- Forks into OpenCode now open on a full copy of the transcript instead of a
  seeded summary prompt: Bivy materialises the fork's conversation as a real
  session in OpenCode's own store (`$XDG_DATA_HOME/opencode/opencode.db`), so
  `session/load` resumes it and the model replays the whole history — the same
  "replayed" fidelity Codex's rollout forks get.
- Generic process integrations preserve native session identity across turns by
  capturing refs from validated structured output or using declarative
  host-assigned creation args (`resume.newArgs` in plugin manifests).
- Approval cards can now answer "Allow `git status` this session": approve and
  stop asking for the same program+subcommand (or the same tool, for edits)
  until the session closes. Rules live in the node's memory only and never
  reach the catastrophic floor, the backstop set (force-push, publish,
  deploy, `sudo`, …), risky integrations, a paused session, or a
  destructive-severity prompt — those keep asking every time.

### Changed

- The web app's status-bar / splash colors are now derived at build time from
  `--bg` in `packages/ui/tokens.css`, so a cold PWA load no longer paints a
  mismatched band before the theme applies.
- Stop stays reachable while the agent is working even after you start typing
  a follow-up; Send (queue) appears next to it instead of replacing it.
- Removed web components that had no entry point since earlier composer/menu
  simplifications (Inbox dialog, node stats panel, session settings, schedule
  sheet, run-task sheet) and their private CSS. The ☰ attention dot, session-list
  ranking, and the follow-up queue's scheduled rows are unchanged.

- Bivy Cloud billing, plan definitions, commercial metering, upgrade UI, and
  entitlement enforcement were removed from Core. The self-hostable control
  plane and relay now admit authenticated accounts without commercial limits;
  Cloud owns the complete commercial layer in its private repository.

### Fixed

- ACP integrations now distinguish already-running observed activity from
  permission-gated calls, confine filesystem client operations to the workspace
  with symlink-safe checks, approval-gate writes, enforce read-only mode, forward
  images and configured MCP servers, and fail explicitly instead of silently
  replacing a failed resume with an empty conversation.
- Custom `BIVY_CUSTOM_AGENTS` commands no longer inherit maintained agents'
  credential, session-store, discovery, or slash-command host behavior.
- The prebuilt ephemeral runner image (`ghcr.io/bivysh/bivy-ephemeral-runner`)
  is now actually published on every push to `main`. The workflow had failed at
  startup since it was added because it used `docker/*` actions the repository's
  Actions allowlist does not permit; it now drives the Docker CLI directly.

## [0.10.0] - 2026-08-07

### Added

- `BIVY_CUSTOM_AGENTS` registers named custom agents in both the web picker and
  `bivy run`: each entry extends a built-in CLI agent with an overrideable
  label, command, args, and parser, appearing as experimental/unverified while
  inheriting the base agent's execution behavior.
- Sessions keep a durable per-session changes history, openable at any time from
  a new session changes sheet, instead of only the current turn's changes card.

### Changed

- ACP (OpenCode) tool calls now surface structured tool names and real input
  detail (diffs, paths) as they stream, and turn history is persisted as ordered
  text/tool blocks exactly as they streamed instead of one merged block.
- First-run setup opens the self-hosted control plane when you pick self-hosted,
  and preserves your selected agent and node presence when handing off to the
  app.
- Bivy is now licensed under AGPL-3.0.

### Fixed

- Wedged sessions — a runtime that stops responding or stops emitting `agent_end`
  (opencode's ACP server, a frozen Pi) — are now force-recovered by a stall
  watchdog and a periodic sweep, and a new prompt to a hung session runs fresh
  instead of vanishing into the dead turn.
- Reasoning-log growth is bounded: a length-capped head with a truncation marker
  is persisted, so a stuck turn can no longer balloon the on-disk transcript.
- A flapping node no longer trips the relay's rate limiter and shows clients
  "Rate limit exceeded".
- Forks are portable across runtimes: resuming a fork restores the correct
  runtime and transport instead of clobbering the model and stream.
- Global npm install no longer bundles the Pi package, which broke the published
  `@bivy/bivy` install.

## [0.9.0] - 2026-08-06

### Added

- TUI-locked sessions now open into a dedicated handoff view with actions to
  attach the browser terminal or take the session back into chat. Chat sessions
  also expose a copyable `bivy resume <id>` command for continuing locally.

### Changed

- First-run setup is now agent-first: it detects and imports compatible Claude
  and Codex credentials into Bivy's encrypted vault, favors normal account
  sign-in, presents clearer choices, and hands users directly to their selected
  agent or the remote app. Missing-agent-auth errors now include actionable,
  agent-specific recovery steps.
- Hosted trial session locks are preserved across later node refreshes, and a
  newly opened client now receives the current terminal lock state immediately.

### Fixed

- The agent picker now stays aligned with the active session's runtime when the
  node's runtime list refreshes, while new-session drafts continue to use the
  selected default.
- Uninstalling an npm-global installation now removes its separate `~/.bivy`
  state directory. Tarball installs and `--keep-sessions` retain their existing
  state-preservation behavior.

### Security

- Removing a node now atomically rotates the model-credential sync key and wraps
  the replacement only for surviving nodes. Provider sign-outs propagate as
  encrypted, timestamped tombstones so stale credentials cannot be restored by
  another device.

## [0.8.2] - 2026-08-05

### Changed

- **Ephemeral machines are now opt-in and off by default.** The
  bring-your-own-cloud short-lived runners (Fly.io, Hetzner, AWS EC2) are a
  not-fully-developed Beta surface, so a deploy gets them only when it sets
  `EPHEMERAL_MACHINES_ENABLED=1` (web build: `VITE_EPHEMERAL_MACHINES_ENABLED=1`).
  This is fail-closed — production is off unless it explicitly opts in — while
  local `vite dev` keeps the surface on so development isn't gated. The flag gates
  all three layers: the web UI entry points, the control plane's server-initiated
  auto-provision (`planAutoProvision`), and the device-launch `/api/ephemeral/exec`
  relay. A machine's own idle self-teardown is intentionally unaffected, so any
  already-running machine still reaps itself.

### Fixed

- The PWA's status bar / browser-chrome color now matches the app background
  (`--bg`: `#f5f3ee` light, `#14171a` dark) instead of a pure white/black band —
  the static `theme-color` tags and `theme.ts` were still `#ffffff`/`#111111`.

## [0.8.0] - 2026-08-05

### Changed

- **Codex and OpenCode are now Supported-tier agents**, alongside Pi and Claude
  Code. Codex already cleared the bar on the app-server shim (per-tool
  Approve/Deny, model + reasoning-effort selection, thread resume, usage
  reporting, native session discovery) — the catalog just hadn't said so, and the
  support matrix wrongly listed its model picker as missing. Both now pin the
  exact CLI release they were certified against (Codex 0.145.0, OpenCode 1.18.13).
- **OpenCode runs over its native ACP server (`opencode acp`) by default**, which
  is what earns it the tier: per-tool Approve/Deny instead of effect-level
  sandbox governance only, plus `session/load` resume. Force the previous
  one-shot pipe path with `BIVY_OPENCODE_ACP=0`.

### Added

- ACP agents get **real model selection**: the shim reads the session's model
  config option, publishes it to Bivy as a post-`hello` `runtime.models` event,
  and applies a choice with `session/set_model` (falling back to
  `session/set_config_option`). The list comes from the live session, so it
  reflects the providers that node has actually authenticated rather than a
  hardcoded guess. Previously a promoted agent still advertised the pipe path's
  model picker while the shim silently ignored `model.set`.
- Default-on ACP promotion is **gated on a cached `--help` probe** for the
  agent's ACP subcommand. ACP has no mid-session fallback, so a node whose CLI is
  too old keeps the pipe path and honestly advertises the lower capabilities
  instead of opening a session that hangs and dies. `BIVY_<ID>_ACP=1` skips the
  probe; `=0` forces the pipe path.

### Fixed

- `bin/acp-shim.mjs` no longer hangs when the wrapped agent dies or never speaks
  ACP: in-flight JSON-RPC requests are rejected on child exit, `initialize` is
  bounded by a timeout, and the child's stdin has an error handler so an EPIPE
  reports the cause instead of crashing the shim. A non-ACP binary now fails in
  milliseconds with the real reason rather than timing out after 30s.
- The CLI capability help-probe cache is keyed by the resolved binary path rather
  than the bare command name, so upgrading or installing a CLI while the daemon
  is running no longer serves a stale capability answer.

## [0.7.0] - 2026-08-04

### Added

- Phase 7: connect-computer/credential-sync design doc + rotation-safe merge tiebreak (#344)
- Phase 6: per-session egress proxy/decider for workflow/sandbox network isolation (#343)
- Integrations as chat: Linear follow-up routing + provider-agnostic Case B (Phase 5) (#342)
- Phase 4: Codex/opencode slash commands + Codex TUI hand-off & usage (agents) (#341)
- Faster model switch: per-runtime scratch cache + client cache + prefetch (Phase 3) (#340)
- Fork reliability: fix 6 stand-up bugs + add integration coverage (Phase 2) (#339)
- Core-flow UX polish: attention list, queue auto-send, slash UI, update banner, terminal menu (#338)
- Remove local-CLI setup direction; complete Phases 0–2 (supersedes #333) (#334)

### Fixed

- Fix scrolling in expanded code changes card (#346)
- Fix Codex fork rollout metadata (#345)

## [0.6.0] - 2026-08-03

### Added

- **`attach_to_chat` reaches every agent, not just Claude/Pi** (#290). A new
  Bivy-owned MCP server, `bivy mcp-serve`, exposes the outbound-attachment
  capability as a first-class tool. It's auto-injected into a non-SDK agent's
  session-local JSON MCP config at session start (created when absent, restored
  on close), so codex/gemini/opencode/aider/… discover `attach_to_chat` in their
  own tool list instead of having to be told about a shell command. The tool
  POSTs to the same `POST /api/session/:id/attach` endpoint `bivy attach` uses.
  Injected into JSON MCP configs (claude/gemini/opencode/generic `.mcp.json`) and
  Codex's TOML (`~/.codex/config.toml`, `[mcp_servers.bivy]`). Claude and Pi keep
  their native in-process registration; tool-interception runtimes are skipped to
  avoid a duplicate. Goose YAML config is a follow-up.

- **Native `attach_to_chat` tool** for Claude and Pi sessions — the stronger,
  tool-based sibling of #297's discoverability hint. Claude sees it as a real
  MCP tool (an in-process server registered via the SDK's
  `createSdkMcpServer`/`tool`); Pi sees it through the same node-hosted
  `ToolProvider` mechanism connected integrations already use. Both call the
  same `attachToChat()` helper `bivy attach`/`POST /api/session/:id/attach` use,
  so a native tool call renders identically to the CLI path and goes through the
  same approval governance as any other tool call. No wiring needed per agent —
  the daemon threads one `attachToChat(sessionId, opts)` callback through both.

### Changed

- **Dependency updates** (batched Dependabot bumps). Production: `@anthropic-ai/claude-agent-sdk`
  0.3.199 → 0.3.220, and `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`
  0.82.1 → 0.83.0. Services: control-plane `stripe` 22.2.2 → 22.4.0; relay
  `@sentry/node` 10.67.0 → 10.69.0 (control-plane was already on 10.69.0). Tooling:
  `@types/node` → 26.1.2 and `tsx` → 4.23.1 in both services; transitive `postcss`
  → 8.5.25. CI actions: `actions/checkout` → v7.0.1, `actions/setup-node` → v7.0.0,
  `dorny/paths-filter` → v4.0.2.

### Security

- Bumped `fast-uri` → 3.1.5 and `ip-address` → 10.4.0 to clear their high-severity
  advisories in the production tree.
- The production audit gate now runs through `scripts/audit-prod.mjs` (wired into
  CI's `core` job as `npm run audit:prod`). It is `npm audit --omit=dev
  --audit-level=high` with a small, documented allowlist: it still fails on any
  high/critical advisory except the two `undici` advisories
  (GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272) that are shrinkwrapped inside
  `@earendil-works/pi-coding-agent@0.83.0`, which no npm `override` or current
  upstream release can move. Scheduled for review by 2026-09-03; remove the
  allowlist entries once pi-coding-agent ships a patched `undici`.

## [0.5.0] - 2026-08-02

### Changed

- Agent-sent chat attachments now render **grouped under the turn's final
  assistant message** instead of as a standalone entry at the point `bivy attach`
  ran (which could strand a chip mid-turn, between tool cards and the reply). Both
  the live reducer and history replay attach the chip(s) to the final reply
  bubble — mirroring how the composer renders your own uploads under your message
  — falling back to a standalone entry only when a turn has no prose to hang them
  on. Client-only change (no wire/node change).

### Fixed

- Claude agents can now **discover** how to send a file/image to the user. The
  outbound attachment path (`bivy attach`) is a shell command with no tool, so
  the agent had no way to know it existed — "send me X as an attachment" was
  answered "I have no way to do that". The Claude Code system prompt now carries a
  short note teaching the agent to run `bivy attach <path> [--caption "…"]`, which
  pairs with the `BIVY_SESSION_ID` the node injects into the agent subprocess.

## [0.4.0] - 2026-08-01

### Added

- **Agents can now send attachments into the chat.** An agent surfaces a file it
  produced — an image renders inline as a thumbnail, anything else as a
  downloadable chip — via `bivy attach <file> [--caption "…"]`, the reverse of
  the composer paperclip. Works across runtimes (any agent that can run a shell
  command), reusing the existing content-addressed AttachmentStore, relay
  chunking, and rehydrate-by-hash rendering. The file is confined to the session
  workspace. Assistant messages now also render inline markdown images
  (`![alt](https://…)`, https-only). Backed by `POST /api/session/:id/attach`
  and a durable, position-anchored outbound-attachment projection in the event
  log so a reload or another device shows the attachment too.

## [0.3.0] - 2026-07-31

### Added

- Ephemeral machine configs are now first-class, routable **nodes**: they appear
  as selectable targets in the work-queue router and the new-session picker, and
  the control plane can **provision one unattended** when work arrives and no
  device is online — closing the device-offline path that previously required a
  signed-in device. Adds account-level `EphemeralNodeConfig` runner templates
  (provider/region/size/ttl/teardown), stored as JSONB on the account, with CRUD
  endpoints. (#276)
- The collapsed in-session run pill now shows the session's **PR badge** (open /
  merged / closed) when the session has a primary PR, matching the badge already
  rendered on the expanded run card — so you can see PR status without opening
  the card. (#277)

### Changed

- Polished the in-session run pill and its action sheet: the pill now reuses the
  sidebar `PrBadge` (GitHub mark + `PR`) instead of the wordy "Open PR" text,
  status labels drop the redundant "on node" ("Open on node" → **Open**,
  "Saved · not open on node" → **Saved**), and app sessions read **App** instead
  of "Session". (#278)
- Made the App-session sheet coherent — unified the GitHub link rows, aligned
  labels and icons, and added a repo link alongside the branch link — so the
  sheet reads as one system rather than a mix of idioms. (#279)

## [0.2.1] - 2026-07-31

### Added

- `bivy rename <name>` (alias `bivy node:rename`) renames the current node from
  the terminal, reusing the same local device-token auth as every other CLI
  command. The change takes effect immediately with no restart — the daemon
  persists it and live-updates relay presence and the `bivy/<node>` work-queue
  label. Previously renaming was only possible from the app UI. (#272)
- The in-session run card now shows a **"Forked from …"** marker when a session
  was forked from another, resolving the parent's name from the local session
  list (and degrading to a shortened id when the parent lives on another node or
  is gone). The sidebar row carries a matching **"Forked"** flag. (#270)

### Changed

- The in-session run card now appears for **every** session, not just
  automation-triggered ones, and carries the session's token/cost usage
  (previously a separate bar pinned under the top bar). Its detail sheet also
  surfaces the run's finished time, the routing/ruleset reason it was routed by,
  and the approval and sandbox policy it ran under. (#266)

### Fixed

- **Continue in chat** on a freshly-launched Pi or Codex run-terminal is now
  disabled until the agent has actually assigned its session, with a
  plain-language **"Send a message first"** caption, instead of enabling the
  button early and dumping a raw 409 error into the terminal. (#269)
- Edge-swiping to open the sidebar in the PWA no longer also triggers the
  browser's native back navigation. The gesture is now claimed on the first hint
  of horizontal intent, so `preventDefault()` fires while the system
  back/forward swipe is still cancelable. (#268)

## [0.2.0] - 2026-07-30

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
