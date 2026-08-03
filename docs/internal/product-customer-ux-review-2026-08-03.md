# Bivy product, customer, UI/UX, and robustness review

**Date:** 2026-08-03  
**Reviewed revision:** `0009cb0` (`@bivy/bivy` 0.5.1)  
**Scope:** node/CLI, React PWA, shared core, relay/control plane, product docs, tests, security model, automation, ephemeral runners, and session replication.

## Executive summary

Bivy already has a rare and valuable technical core: it can route many coding agents to user-owned machines, keep sessions durable, reach them securely from a phone, govern risky activity, continue work from queues, and preserve a strong data-residency boundary. Reconnect handling, session deduplication, E2E transport, follow-up queuing, attachments, approvals/questions, cross-agent forks, and the global attention inbox show unusually thoughtful agent-system engineering.

The main risk is **not lack of power**. It is that breadth, caveats, and implementation complexity are outrunning the simple customer promise. Bivy currently reads as several products at once:

1. a remote control for local coding-agent sessions;
2. a universal multi-agent client;
3. an unattended issue-to-PR automation system;
4. a BYOC ephemeral compute orchestrator;
5. a self-hostable agent control plane;
6. an early multi-node continuity/failover system.

That breadth is strategically interesting but makes setup, trust, UI information architecture, support expectations, and quality assurance harder. Several important product claims also conflict across documentation. The most material example is “local-only use must not require a Bivy Cloud account” (`CORE.md`) versus setup documentation saying relay/control-plane enrollment is required and the node hosts no UI. Another is a headline of nineteen supported agents while only Pi and Claude are marked Supported in the runtime matrix and almost all others are Beta.

### Overall assessment

| Dimension | Score | Assessment |
|---|---:|---|
| Customer value / differentiation | **8/10** | Strong, distinctive value for developers who want remote, governed, private agent execution on their own infrastructure. |
| Core agent experience | **8/10** | Excellent session continuity, steering, tool visibility, approvals, follow-ups, forks, terminal handoff, and attachments. |
| Simplicity / positioning | **5/10** | Too many simultaneous promises and configuration concepts; important distinctions are not obvious before use. |
| UI / interaction quality | **7/10** | Thoughtful responsive chat and many recent UX fixes; settings and infrastructure workflows remain dense. |
| Onboarding / activation | **6/10** | Guided setup and app-first path exist, but Node/native build/auth/relay/agent-provider concepts create a high-friction chain. |
| Robustness / engineering | **8/10** | Strong tests and defensive distributed-system behavior; browser QA, live provider validation, dependency hygiene, and scale limits need work. |
| Safety / trust clarity | **6/10** | Excellent transparency and E2E design, but autonomous-by-default plus partial containment is easy to overestimate. |
| Team / enterprise readiness | **4/10** | Product boundary anticipates teams, but expected RBAC, policy administration, audit, SSO/SCIM, support, and compliance evidence are not productized. |

**Recommendation:** make “the private command center for coding agents running on your infrastructure” the single product spine. Default the product to a **simple, supported path** (Pi/Claude/Codex, one node, one repo, interactive session). Reveal automation, multi-node, self-hosting, generic agents, rulesets, and ephemeral substrates progressively. Spend the next release cycle on trust, activation, observability, and live end-to-end validation before adding more agent/provider breadth.

---

## Method and evidence

This review included:

- product and architecture docs (`README.md`, `CORE.md`, `CLOUD.md`, quickstart, install, security, runtime matrix, automations, ephemeral sessions, replication, rulesets, FAQ);
- UI architecture and implementation (`App.tsx`, `ChatView`, `Composer`, `SessionList`, `Settings`, styles, shared UI package);
- store/controller and direct/relay transport design;
- runtime and session architecture, security boundaries, CI, and representative tests;
- repository scale and maintenance shape;
- local verification at this revision.

### Verification results

- Root TypeScript: **pass**.
- Core/web TypeScript: **pass**.
- Web production build: **pass**.
- Lint: **pass with 406 warnings** (including React hook dependency warnings in active UI code).
- Root unit runner: **160/161 suites passed** after dependencies were installed with scripts disabled; `terminal.test.ts` could not load `node-pty` because its native postinstall/build had intentionally not run. This is an environment limitation, not evidence of a product regression. The normal CI path uses `npm ci` with scripts.
- Production dependency audit: **fails at high severity** at review time (`fast-uri`; nested `undici` through `@earendil-works/pi-coding-agent`). CI is configured to reject this.
- Web build output: initial JS approximately **684 kB minified / 192 kB gzip**, shared chunk **152 kB / 52 kB gzip**; terminal is lazy-loaded at **596 kB / 152 kB gzip**. Vite reports chunks over 500 kB.
- Browser suite exists but contains only two component specs and **is not run by CI**. No automated axe, Lighthouse, visual-regression, or responsive screenshot gate was found.
- A live app screenshot/smoke pass was not completed in this environment because Playwright’s browser binary was not installed. Relay/provider/cloud behavior was therefore assessed from code, tests, and documentation rather than a production account.

This is a product/code review, not customer research. Scores and competitor comparisons should be validated with activation analytics, support data, and interviews with at least five users in each target segment.

---

## The customer promise

### Best concise positioning

> **Bivy is the private command center for coding agents running on your machines and cloud accounts. Start work from chat, terminal, GitHub, Slack, or a schedule; monitor, steer, approve, and recover it from anywhere.**

This is stronger than “a wrapper for nineteen agents.” Agent breadth is an implementation advantage, not the primary benefit. Customers buy outcomes:

- leave an agent working and safely walk away;
- see what needs attention without watching a terminal;
- resume from a phone or another computer;
- route work to the right machine/repo/model;
- keep source, transcripts, and keys off a hosted vendor’s data plane;
- convert requests/issues into governed, reviewable changes;
- recover from disconnects, restarts, rate limits, and failed machines.

### Primary customer segments

#### 1. Individual power developer — best near-term fit

**Job:** run one or more agents on a workstation/server, leave them working, monitor and steer remotely, and preserve sessions.  
**Value:** high and immediate. Remote PWA, terminal handoff, durable sessions, inbox, follow-ups, attachments, and provider choice are compelling.  
**Main objections:** setup complexity, trust in remote access, unclear differences among runtimes, and whether Bivy is safer/reliable enough to sit between developer and agent.

#### 2. Small engineering team / tech lead — strong expansion fit

**Job:** turn issues and requests into controlled agent runs with consistent policy and visible outcomes.  
**Value:** routing, worktrees, queueing, run evidence, approvals, and self-owned execution are attractive.  
**Main objections:** missing team roles/policies, ambiguous ownership, no mature audit/compliance story, no clear review/check gate, and support maturity.

#### 3. Privacy/security-sensitive organization — differentiated but not ready to promise broadly

**Job:** gain agent productivity while keeping code and credentials in controlled infrastructure.  
**Value:** node-as-data-plane, E2E relay, local credentials, self-host option.  
**Main objections:** no external audit, no Bivy-owned OS isolation, heuristic enforcement for many agents, pattern-only redaction, no enterprise identity/control plane, and unsupported self-hosting.

#### 4. Agent/platform enthusiast — high feature fit, lower commercial focus

**Job:** compare agents/models, connect local models, use ACP/MCP, BYOC runners, rulesets, and custom commands.  
**Value:** unusually broad.  
**Risk:** optimizing the default product for this segment creates complexity for everyone else.

### Jobs Bivy should explicitly not optimize as the default

- “Give me a fully managed autonomous software engineer with no infrastructure setup.” Devin/Codex-cloud-style products own that expectation.
- “Give me an IDE-first coding experience.” Cursor, Windsurf, Copilot, Cline/Roo and editor agents own that interaction.
- “Give me a certified zero-trust sandbox.” Bivy currently does not provide that boundary.
- “Give my enterprise turnkey SSO/RBAC/compliance.” Not yet.

Bivy can integrate with or grow toward these jobs, but its differentiated wedge is private orchestration and continuity, not IDE completion or vendor-hosted compute.

---

## What is already excellent

### 1. The architecture creates real differentiated value

The node retains repos, tools, transcripts, and model credentials; relay traffic is E2E encrypted; the hosted plane coordinates metadata. This is a substantive architectural benefit, not a cosmetic privacy claim. It compares favorably with cloud-first agent products for customers with data-residency concerns.

Particularly strong:

- X25519 pairing and wrapped room-key design;
- single-use relay tickets and replay protection;
- no inbound node port requirement;
- encrypted credential/device vault designs;
- sanitized, metadata-only run evidence;
- explicit documentation of exceptions and limitations.

### 2. The agent interaction model reflects modern expectations

Customers now expect agent systems to support more than “send prompt, wait for answer.” Bivy covers most expected behaviors:

- streaming prose and reasoning;
- grouped, expandable tool activity;
- code/diff display and copy actions;
- user questions distinct from permission approvals;
- stop, pause/resume, steering, and queued follow-ups;
- draft persistence and reconnect-safe send deduplication;
- file/image input and agent-sent output attachments;
- per-session model/agent/repo/sandbox selection;
- terminal takeover and chat/TUI single-writer handling;
- session forks and cross-agent context handoff;
- inbox and push-oriented attention handling;
- usage/cost and run/source/status context.

The follow-up queue is especially good. Most agent UIs either interrupt the current turn unpredictably or reject new input while busy. Bivy makes deferred work visible and editable.

### 3. Distributed-session robustness is thoughtful

The code explicitly addresses races that many early agent products ignore:

- `session.new` and prompt idempotency;
- append/hash transcript synchronization;
- persistent transcript cache;
- deferred history during live streaming;
- connection backoff and foreground/liveness recovery;
- stale status refresh;
- all-node session merge;
- interrupted-turn notices;
- process-group termination;
- warm replication with epoch fencing;
- snapshot/rebuild primitives for ephemeral sessions.

This is a major asset. Preserve it while simplifying the customer-facing surface.

### 4. The UI has received serious interaction-level care

Recent changes addressed real product issues: keyboard focus, mobile drawer overlays, iOS visual viewport behavior, streaming performance, nested buttons, contrast, focus rings, reduced motion, status semantics, blocked OAuth tabs, stuck approvals, attachment feedback, draft persistence, and consistent action menus.

The current app shell follows familiar expectations:

- ChatGPT-style session sidebar;
- prominent composer with metadata pills;
- mobile drawer/edge swipe;
- per-session status indicators;
- inline approvals/questions at the relevant transcript tail;
- settings as a two-pane desktop / drill-in mobile surface;
- persistent attention inbox.

### 5. Documentation is unusually candid

The security model and FAQ state difficult truths: no OS jail, autonomous default, traffic metadata, push text exception, file-based vault, no audit, unsupported self-hosting. That candor is trust-building and should be reflected in onboarding/product UI, not confined to docs.

---

## Material gaps and risks

## P0 — fix before claiming a “really solid” general release

### P0.1 Resolve contradictory product contracts

The repo currently makes incompatible statements:

- `CORE.md`: local-only use must not require a Bivy Cloud account.
- `docs/quickstart.md` / `docs/install.md`: relay/control-plane enrollment is required; the node hosts no web UI.
- `README.md`: “The terminal CLI needs neither,” which suggests local CLI operation is possible.

This distinction can be made coherent, but it is not coherent now. Define and test three modes:

1. **Local CLI mode:** no account, no relay, no web UI; durable managed sessions and governance still work.
2. **Hosted remote mode:** account + hosted control plane/relay + PWA.
3. **Self-hosted remote mode:** operator’s control plane/relay + PWA.

Setup should offer these plainly. If local CLI mode is intentionally not supported, change `CORE.md` and the README promise. Do not say both.

Other doc/product drift to resolve:

- README presents nineteen agents as “supported”; runtime matrix says only two are Supported and most are Beta.
- `packages/web/STATUS.md` still describes `/next` migration/cutover as future despite the current product architecture needing a single canonical path.
- `packages/core/src/store.ts` says transcript arbitration/cache refinements are not reproduced, while the controller and status doc say they have landed.
- `docs/ephemeral-sessions.md` contains old tables saying rebuild is unimplemented, followed by later sections saying it is implemented; it also retains a stale “wiring is missing” plan after describing hosted restore as landed.
- security limitations are titled “for 0.1” while the package is 0.5.1.

**Acceptance:** one generated capability/status source powers README agent summary, picker tiers, runtime docs, and in-app labels; docs CI rejects stale version/status markers.

### P0.2 Close current dependency security failures

`npm audit --omit=dev --audit-level=high` fails on this revision. Because CI explicitly blocks high production advisories, this is a release blocker and a customer-trust issue. Upgrade/override `fast-uri`; work with or update the Pi dependency so nested `undici` is at a patched version. Add an exception process only if exploitability is assessed, documented, time-bounded, and owner-assigned.

### P0.3 Make the safety posture impossible to misunderstand

Bivy defaults to `autonomous`, while most Beta agents lack a native sandbox and Bivy has no OS-level jail. Effect-level checks can be bypassed by an agent shelling out. The documentation is honest, but the default UI can still produce a stronger feeling of containment than exists.

Required changes:

- On first run, show a plain-language policy choice: **Balanced (recommended for trusted repos)**, **Ask on risky actions**, **Read-only**, and **Unrestricted**. Map these onto technical settings but explain actual guarantees.
- For each selected runtime, show a compact “Protection” row: `Native sandbox`, `Bivy tool controls`, or `Runs as your user`; link to details.
- Do not use the same confidence language for native-intercepted and boundary-only agents.
- Require an explicit confirmation the first time a user chooses Full access or enables unattended automation on a boundary-only agent.
- Provide a “dry run / plan only” starting mode for automation and unfamiliar repos.
- Treat OS-isolated runners as the recommended unattended path, not just one infrastructure option.

### P0.4 Establish live end-to-end support certification

The runtime matrix is honest about Beta/best-effort flags, but the product picker still exposes a very wide surface. Agent CLIs evolve quickly; a parser or launch flag can silently drift.

Create a certification matrix executed on every release candidate:

- install/auth preflight;
- create, stream, tool call, question, approval, stop;
- reconnect and resume;
- attachment in/out;
- model select if advertised;
- fork if advertised;
- terminal handoff if advertised;
- sandbox behavior with a negative escape test;
- version range tested and last certification date.

Default picker should show **Recommended** (fully certified), then **More agents (Beta)**. Never make users choose among nineteen equal-looking names on first run.

### P0.5 Put browser quality into CI

The PWA is the principal product UI, yet browser tests are sparse and not run in CI. Add:

- critical Playwright flows at desktop and mobile widths;
- axe accessibility checks on sign-in, shell, composer, settings, sheets, approval, and error states;
- visual snapshots for light/dark and mobile/desktop;
- keyboard-only modal focus/escape tests;
- service-worker update/offline-shell test;
- a long-transcript/streaming performance budget;
- bundle size budgets.

Minimum critical flow: sign in/mock account → select/connect node → create draft → pick repo/runtime/model/sandbox → send → stream tool/reasoning → approval/question → attachment → reconnect → resume → open changes/PR.

### P0.6 Define reliable run completion, not just “agent stopped”

For unattended work, customer value is a trustworthy outcome, not a completed chat turn. Bivy has evidence and PR references, but the product needs a clear completion contract:

- configurable required checks (tests/lint/typecheck);
- explicit statuses: `Done`, `Done with uncommitted changes`, `PR open`, `Checks failed`, `Needs review`, `No changes`, `Agent failed`;
- deterministic post-run validation run by Bivy, not only claimed by agent prose;
- links to diff, commit/PR, checks, cost, duration, policy decisions, and retry path;
- one-click retry/fork/fix-failing-check action;
- no “succeeded” state solely because the runtime emitted `agent_end`.

The run pill, inbox, and evidence timeline are the right UI foundations.

---

## P1 — major usability and product-value improvements

### P1.1 Simplify onboarding around one golden path

Current activation can involve Node 22, native build tools, global npm/PATH, setup wizard, account login, relay enrollment, background service, agent installation, and model-provider authentication. Each step is defensible; the sequence is still fragile.

Target golden path:

1. Sign in (or explicitly choose Local CLI only).
2. Install/connect one runner with one copyable command.
3. Automatic doctor verifies Node, service, relay, git, agent, and provider.
4. Choose a repo.
5. Choose one recommended agent/provider combination.
6. Send a starter task.
7. See tool activity and a completed outcome.
8. Prompt to install PWA / enable notifications only after value is demonstrated.

Improvements:

- Make setup resumable with a visible checklist shared by CLI and app.
- Use a short-lived enrollment code so app-first install visibly binds to the waiting account.
- Detect model auth and route directly to the right native/Bivy login; avoid making users understand auth ownership.
- Offer “Try in read-only mode” with a low-risk first task.
- Time every activation step and show specific remediation, never generic offline/reconnecting copy.
- Publish supported OS/architecture and native-module availability before install.

**North-star activation metric:** percentage of new accounts receiving a useful agent response on a selected repo within 10 minutes. Track median and p90 time-to-first-response and failure stage.

### P1.2 Replace feature-first settings with task-first progressive disclosure

Settings currently has roughly eighteen destinations across General, Integrations, Automation, Infrastructure, and Account. This is manageable for experts but heavy for a new individual user. `Settings.tsx` is also ~3,300 lines and handles many unrelated remote workflows.

Recommended IA:

- **Account** — profile, plan, signed-in devices.
- **Models & agents** — provider login, API keys, local models, agent installations.
- **Machines** — nodes and ephemeral runners.
- **GitHub & integrations** — GitHub, Slack, Linear, webhooks.
- **Automation & policy** — automations, rulesets, notifications.
- **App** — appearance, voice, import.

Then expose common tasks contextually:

- provider connection from model picker;
- install agent from agent picker;
- runner connection from node picker;
- repo authorization from repo picker;
- policy explanation from sandbox pill;
- integration setup from an empty automation flow.

Keep advanced settings hidden behind “Advanced” until users need them.

### P1.3 Make runtime capability differences legible

The current system is capability-driven internally; the picker should communicate that in customer language. Each runtime row should show at most three meaningful badges:

- **Recommended / Beta / Experimental**;
- **Resumes sessions**;
- **Protection:** Native / Tool-level / Limited.

A details disclosure can include model selection, terminal handoff, native discovery, usage, and ACP mode. Disable or explain unsupported controls before the user hits them. Save the last known-good agent/model pairing per node/repo.

### P1.4 Strengthen the “attention and outcomes” home experience

The inbox is strategically important: it turns Bivy from a chat window into an agent operations product. Make it a first-class command center:

- counts by Needs approval, Needs answer, Failed, Completed/unreviewed;
- SLA/age sorting;
- bulk dismiss/retry only where safe;
- outcome summary without opening every transcript;
- cross-node and cross-integration filters;
- links that reliably focus the exact card/event;
- explicit empty state (“Nothing needs you”).

Consider making Inbox the default return surface when unresolved work exists, while preserving the session sidebar.

### P1.5 Improve change review

Coding-agent customers expect a review surface approaching an IDE/PR:

- changed-file tree with counts;
- side-by-side and unified diff;
- syntax-aware diff and whitespace toggle;
- per-file accept/revert (only when safely supported);
- comments or “ask agent about this selection”;
- test/check results adjacent to changes;
- commit/branch/PR state;
- clear distinction between working-tree diff, checkpoint, pushed branch, and PR diff.

Bivy already captures worktree changes and has a diff viewer. Promote this from a card/detail into a dependable review workflow.

### P1.6 Create a dependable recovery center

The product has sophisticated recovery mechanisms but they are scattered. Add a “Recovery” section to session/run details:

- last durable transcript/checkpoint time;
- owning node and current reachability;
- whether warm replica or encrypted snapshot exists;
- what will be lost on promotion/rebuild;
- Retry connection, Promote replica, Rebuild runner, Fork to another machine;
- human-readable failure timeline.

Automatic “send to wake/rebuild” is elegant, but hidden magic needs an explanatory state before the user sends into an offline session.

### P1.7 Add attachment lifecycle controls

The global content-addressed attachment store has no GC or size cap. This is a robustness, privacy, and disk-exhaustion risk. Add:

- reference-aware GC after session deletion/pruning;
- global size cap and per-file/count limits enforced on node and client;
- disk usage in `doctor` and Settings;
- clear-data controls;
- retention policy for transcript caches and attachments;
- atomic writes and startup repair for partial sidecars/blobs.

---

## P2 — scale, team, and enterprise readiness

### P2.1 Team control plane

Before selling team/enterprise value, implement:

- organizations/workspaces;
- roles: owner, admin, operator, approver, viewer;
- node/repo/integration scoping;
- centralized policy with local minimum/floor and auditable overrides;
- approval delegation and on-call routing;
- audit log for auth, node enrollment, policy changes, approvals, run lifecycle, and secret references (never secret values/content);
- retention controls;
- SSO/SAML/OIDC and SCIM as demand warrants;
- export and account deletion workflows.

### P2.2 Real isolation profiles

Offer clearly named execution profiles:

- **Trusted workstation** — current local behavior, fastest.
- **Isolated local** — container/VM where available.
- **Ephemeral isolated runner** — recommended for unattended/untrusted tasks.
- **Full access** — explicit advanced opt-out.

A Bivy-owned portable sandbox is a large investment. If not built, integrate and certify containers, macOS VMs, devcontainers, E2B/Daytona-style sandboxes, and cloud VMs with honest guarantees.

### P2.3 Operability and SLOs

The hosted product should publish and measure:

- relay/control-plane availability;
- connect/reconnect latency;
- command delivery and duplicate rate;
- session creation success;
- queue claim latency and stuck-claim rate;
- runner provision/teardown success and leaked-runner count;
- push delivery rate;
- encrypted snapshot restore success;
- per-runtime success by certified version.

Self-hosting needs migration policy, backup/restore drills, health dashboards, rate/connection limits, horizontal relay architecture, and a supported upgrade window before it can be more than community best effort.

---

## UI/UX deep review

### App shell and navigation

**What works**

- Familiar sessions/chat split.
- Responsive drawer and edge swipe.
- Search/filter and all-node session merging.
- Compact status/source/PR metadata.
- New session is immediate and draft-only until send.
- Inbox and settings are persistent but not dominant.

**Issues**

- The sidebar mixes chat sessions and raw run terminals, which have different semantics and actions. The source marks help, but novice users may not know why one opens chat and another opens a terminal.
- Status is encoded through several small dots/rings/glows and source tiles. Screen-reader labels exist, but visual semantics require learning.
- “Continue here (promote replica)” appears in every row menu; this is an advanced disaster-recovery action with insufficient context and may fail for most sessions.
- Search/filter controls are useful but take meaningful space before a user has many sessions.

**Recommendations**

- Label terminal rows as a separate “Terminals” subsection or filter.
- Add text labels for urgent/working states where action matters; keep dots for ambient state.
- Show Promote only when a valid standby exists and owner is offline.
- Hide filters until multiple repos/nodes exist.
- Add pinned/recent/project grouping once session volume grows; avoid only paginating by recency.

### New session and composer

**What works**

- Repo, sandbox, agent, model selection is attached to the action that needs it.
- Attachments, drag/drop, voice, slash commands, mobile Enter behavior, autosize, draft persistence, queued follow-ups, and reconnect focus preservation are excellent details.
- Sending as the launch/wake gesture is conceptually simple.

**Issues**

- The number of pills and state-dependent controls can make the composer feel like a cockpit before the first prompt.
- “No repo” is technically valid but its implications are unclear.
- Sandbox names mirror implementation vocabulary; “Workspace write” does not tell a customer whether shell commands can escape.
- Agent/model/provider auth relationships are complex.
- Automatic launch/wake on Send can create cloud cost without a sufficiently prominent pre-send confirmation/cost hint.

**Recommendations**

- Default to one compact context line: `repo · agent/model · protection`; expand on click.
- On first use, guide repo → agent → protection in one lightweight sheet.
- Rename customer-facing tiers: `Read only`, `Work in this repo`, `Full computer access`; show runtime-specific caveat below.
- For ephemeral sends, state “Send will launch X in region Y; estimated rate Z; auto-stop policy Q.” Confirm first launch, remember thereafter.
- Provide starter prompts based on repo state: explain architecture, find failing tests, review changes, implement an issue.

### Transcript and tool activity

**What works**

- Windowing, cached history, memoized rendering, grouped tools, focus mode, syntax highlighting, copy, image hydration, and pinned streaming behavior address genuine performance and usability needs.
- Inline approval/question cards preserve conversational context.

**Issues**

- “Focus view” is an eye icon with non-obvious behavior; users may not know that intermediate assistant prose and tools are hidden.
- Reasoning text can be sensitive, noisy, or unavailable by provider; presentation should not imply consistent model introspection.
- Tool groups summarize activity but do not clearly elevate failed commands or changed files.
- Long-session windowing uses “show earlier” rather than virtualized search/jump; acceptable now but limiting for operational investigation.

**Recommendations**

- Label focus mode in a tooltip/onboarding and show a small “N work steps hidden” disclosure.
- Use “Working notes” rather than making strong claims about internal reasoning.
- Highlight failed tools and policy denials in group summaries.
- Add in-transcript search and jump to next user turn/error/change.
- Let users collapse successful read-only tools by default while keeping writes/failures visible.

### Approvals and questions

**What works**

- Separate mental models, severity formatting, consequence copy, deny-on-timeout, retry after missing resolution, and no remember option for critical actions.

**Issues**

- Approval quality depends on runtime interception capability, which is not always obvious on the card.
- Five-minute expiration can turn unattended runs into failures without a clear policy option.
- “Always allow” scope must be exceptionally explicit: this command, tool, session, repo, runtime, node, or future runs?

**Recommendations**

- Include protection source on card: “Intercepted by Claude SDK” / “MCP tool control” / “Bivy heuristic.”
- Display exact remember scope and expiry.
- Allow policy: deny on timeout, keep waiting, or route to designated approvers (team tier).
- Push notification should deep-link to the precise approval and show expiration countdown.

### Settings

**What works**

- Responsive desktop/mobile pattern, search, URL-backed routes, contextual empty states, and real save acknowledgements.

**Issues**

- Settings is becoming an administrative console inside a chat modal.
- Similar concepts are split: Keys & OAuth, Local models, Voice; Nodes and Ephemeral machines; GitHub App and Work Queue; Automations, Webhooks, Rulesets.
- Search matches only section labels, not fields/tasks.
- Very large component and stylesheet make regressions and inconsistent patterns more likely.
- A second token system exists in `packages/ui`, while `packages/web/styles.css` explicitly mirrors legacy tokens and uses different names/colors. The claimed design-system single source of truth is not consumed by the principal app.
- Settings and app hand-roll many SVG icons despite `packages/ui` documenting Heroicons as the standard.

**Recommendations**

- Adopt the simplified IA above.
- Search settings content and common synonyms (“API key”, “GitHub token”, “runner”, “dark mode”).
- Split panels into modules with shared async-state/form primitives.
- Make `packages/ui/tokens.css` truly canonical or remove the claim/package. One app should not maintain two unrelated token vocabularies.
- Standardize icon source and action-row/button primitives.

### Mobile/PWA

**What works**

- PWA installability, visual viewport handling, safe-area padding, touch targets, mobile Enter behavior, drawer gestures, push notifications, and standalone auth polling show mature mobile-web awareness.

**Gaps relative to customer expectations**

- PWA background/network behavior remains less predictable than native mobile, especially for auth handoffs, push, file handling, and long-lived sockets.
- No app-store discoverability or native share sheet.
- No QR camera scan in the documented follow-up list.
- Offline mode is an app shell, not meaningful transcript/action availability.

**Recommendation:** keep PWA as the near-term client, but define its support matrix by iOS/Android/browser and test it. Build native only after evidence that push/auth/background constraints materially block activation or retention.

### Accessibility

Recent fixes are positive, but accessibility needs a system rather than issue-by-issue remediation.

Priorities:

- automated axe gate;
- focus trapping (not only Escape/restore) for all nested modals/sheets;
- live-region strategy for streaming text, working status, queued sends, and resolved approvals without excessive announcements;
- non-color state labels;
- 200% zoom/reflow and high-contrast/forced-colors testing;
- keyboard operation for tool sheets, session menus, diff, terminal controls, and settings;
- semantic headings/landmarks across long settings panels.

---

## Robustness and maintainability review

### Strengths

- Approximately 39k lines in node `src`, 11.5k in shared core, 18.4k in web, and 9.1k in control plane are backed by a large test surface (227 test files across root/core/services).
- CI pins actions by immutable SHA, audits production dependencies, checks licenses/secrets, typechecks, tests core/root/services, builds release artifacts, and runs real relay/pairing E2E.
- Protocol boundaries, crypto, store normalization, parsing, reconnect, idempotency, and replication have targeted regression tests.
- Relay is small (~647 source lines), which is good for a content-blind routing service.

### Risks

#### 1. Central files are too large

- `src/server.ts` exceeds 10k lines.
- `Settings.tsx` is about 3.3k lines.
- `controller.ts` exceeds 3k lines.
- `styles.css` exceeds 2k lines.
- `store.ts` exceeds 3k lines.

These sizes increase merge conflict, hidden coupling, review burden, and regression risk. Split by bounded domains while preserving one-way architecture:

- server routers/services: sessions, terminal, auth, settings, integrations, automation, ephemeral;
- controller services: connection/session, account, terminal, automation, ephemeral;
- store slices or event-fold modules with one assembled immutable state;
- settings panel modules;
- layered CSS/components using canonical tokens.

Do not replace explicit code with a generic framework solely to reduce line count; preserve protocol clarity and test seams.

#### 2. Warning debt is now signal-destroying

406 lint warnings make it easy to miss a new meaningful warning. Production code contains hook dependency warnings and large `any` clusters at network/runtime boundaries. Establish a warning baseline and ratchet down:

- zero React hook warnings immediately;
- no unused variables/assignments in production;
- replace `any` at protocol/account boundaries with `unknown` + schema parsing;
- separate test leniency from production rules;
- fail CI on new warnings.

#### 3. Browser and compatibility coverage is disproportionately weak

The reducer/protocol has deep tests, but the product surface has two browser specs and no CI browser job. This is the largest quality imbalance.

#### 4. Live external integration validation is incomplete

Docs repeatedly say “best-effort,” “not verified live,” or “needs live validation” for Codex history, ACP agents, relay migration, Sprites suspend, ephemeral rebuild, and provider launch flags. Unit tests cannot validate fast-moving external CLIs or real cloud lifecycle. Maintain nightly canaries with low-cost test accounts and publish certification freshness.

#### 5. Storage and retention need boundedness everywhere

The attachment store has no GC/cap. Review all durable and in-memory stores for:

- maximum items/bytes;
- atomic write + fsync/rename where identity/session integrity matters;
- corruption behavior (fail loudly vs regenerate);
- prune UX and retention defaults;
- disk-admission backpressure;
- migration/rollback tests.

#### 6. Hosted scale limitations are explicit but commercially important

Relay rooms are in-process; there are no per-account connection caps/quotas; TLS is external; self-host support is absent. Before growth, load-test relay backpressure, shard routing, ticket introspection, reconnect storms, and control-plane queue claiming. Add abuse controls before offering managed compute.

#### 7. “Best effort” capability breadth creates support load

Every exposed runtime/provider/substrate multiplies auth, install, version, parser, resume, attachment, sandbox, and OS combinations. Use support tiers operationally:

- Supported: release-gated canary, support SLA, known-good versions.
- Beta: opt-in section, diagnostics bundle required for issue reports.
- Experimental: env/advanced catalog only, no implied support.

---

## Competitive landscape

**Snapshot:** category-level comparison as of this review date; competitor products change rapidly. Validate exact packaging/security claims before external publication.

| Category / examples | What customers expect | Bivy relative position |
|---|---|---|
| **IDE-native agents** — Cursor, Windsurf, GitHub Copilot, Cline/Roo | Near-zero setup, inline edits, codebase context, diff review, terminal, checkpoints, familiar editor UX | Bivy is weaker as an editing environment but stronger for agent-agnostic orchestration, remote/mobile control, queues, user-owned execution, and session continuity outside an IDE. Do not compete on autocomplete/editor polish. |
| **First-party terminal agents** — Claude Code, Codex CLI, Gemini CLI, OpenCode | Best model-specific behavior, native auth, current features, tight tool protocol | Bivy adds remote access, persistence, policy, routing, inbox, cross-agent operation, and automation. It risks lagging native capabilities and versions. The winning posture is “control plane around the native agent,” not pretending every adapter is equivalent. |
| **Cloud coding agents** — Codex cloud/app, GitHub Copilot coding agent, Devin | Click issue/task and walk away; managed compute; PR/check outcome; no local daemon; team collaboration | Bivy asks more setup and compute ownership, but offers stronger data control, BYO agents/models/infrastructure, and interactive terminal continuity. It needs a more dependable issue-to-validated-PR contract and simpler runner provisioning. |
| **Open/self-hosted agent platforms** — OpenHands, SWE-agent ecosystems, agent frameworks | Customization, containerized execution, inspectability, benchmarkability, self-hosting | Bivy has a more polished remote session/control experience and broad native-agent integration. It is weaker on OS isolation, benchmark/eval story, and supported self-host ops. |
| **Developer terminal/workspace platforms** — Warp/Oz-style agents, remote dev environments, Gitpod/Daytona/Codespaces | Fast environment startup, terminal-first UX, workspace templates, collaboration, reliable isolation | Bivy’s terminal takeover and BYOC runners are differentiators, but cloud-provider setup and lifecycle are more complex and less certified. Integrate rather than rebuild every workspace substrate. |
| **Workflow/issue automation** — GitHub agent modes, Linear/Slack agents, custom CI bots | Trigger policy, concurrency, retries, checks, ownership, auditable outcome, low noise | Bivy has strong routing/evidence/privacy foundations. Missing leases, mature fallback, team policy, required checks, and polished outcome review hold it back. |
| **General agent control planes** | Multi-agent routing, MCP/ACP, approvals, observability, evals, cost controls | Bivy is strong in real developer-session control and privacy. It lacks an eval/quality framework, standardized tracing/export, and mature org governance. |

### Defensible differentiators to emphasize

1. **Your infrastructure is the data plane.**
2. **One command center across native coding agents.**
3. **Move between terminal, browser, and phone without losing the session.**
4. **Attention, approvals, and outcomes instead of terminal babysitting.**
5. **Interactive and unattended work share one durable session model.**
6. **Cross-node/ephemeral continuity without sending plaintext work to Bivy Cloud.**

### Areas where parity is expected, not differentiating

- good markdown/code/diff rendering;
- attachments and image input;
- model selection and provider auth;
- stop/steer/follow-up;
- session search/history;
- dark mode/mobile layout;
- GitHub PR links and check results;
- clear cost/usage;
- dependable reconnect.

These must be excellent, but should not dominate positioning.

---

## Recommended product principles

1. **Simple path, deep ceiling.** The first session should expose four decisions at most: machine, repo, agent/model, protection. Everything else is progressive.
2. **Capabilities, never pretend parity.** UI and docs reflect what this exact runtime/version can safely do.
3. **Outcome over activity.** A run is valuable when code/checks/review state are clear, not when tokens streamed successfully.
4. **No invisible safety assumptions.** Always distinguish native sandbox, tool interception, heuristic guard, and full-user access.
5. **Recovery is a product feature.** Show what is durable, where it lives, and what happens when a node disappears.
6. **Private by architecture, clear by UI.** Tell customers what stays local and identify every exception at the moment it matters.
7. **Support fewer things better by default.** Broad catalog remains available, but recommended workflows are release-certified.
8. **Boring operational semantics.** Idempotent sends, explicit statuses, bounded retries, no silent fallback, actionable errors.

---

## Roadmap

## Phase 0 — release integrity and truth (0–2 weeks)

**Goal:** every claim and default is trustworthy.

1. Resolve production audit failures.
2. Decide and implement/document local CLI vs hosted/self-hosted setup contract.
3. Generate agent support docs/picker badges from one manifest; move Beta agents under “More agents.”
4. Clean stale migration/ephemeral/store/security docs.
5. Add first-run protection disclosure and runtime-specific safety labels.
6. Remove all React hook lint warnings; establish warning ratchet.
7. Put current high-severity limitations in an in-product Release maturity panel.
8. Define Supported runtime versions and run manual live certification for Pi, Claude, and Codex.

**Exit criteria**

- CI green including production audit.
- No contradictory local/account requirement.
- Recommended runtimes pass a published acceptance checklist.
- New user cannot start Full access or boundary-only unattended work without informed confirmation.

## Phase 1 — activation and browser quality (2–6 weeks)

**Goal:** a new individual developer reaches value in under ten minutes.

1. Build shared setup checklist/state across app and CLI.
2. Streamline app-first connect command and account-binding feedback.
3. Add contextual provider/agent/repo remediation from pickers.
4. Simplify first-session composer/context display.
5. Add Playwright critical path, mobile/dark snapshots, axe, focus, PWA update, and reconnect flows to CI.
6. Add bundle/performance budgets and split settings/automation code from initial bundle.
7. Instrument privacy-safe activation funnel and failure codes.
8. Add node/app compatibility warning and one-click diagnostics export with redaction.

**Exit criteria**

- ≥70% of successful installs reach first response within 10 minutes in dogfood/beta cohort.
- p90 reconnect returns usable composer within defined SLO.
- Critical UI flows pass desktop/mobile/browser CI.
- Initial JS gzip materially reduced or justified by budget.

## Phase 2 — trustworthy outcomes (6–12 weeks)

**Goal:** unattended work reliably produces a reviewable result.

1. Introduce Bivy-run required checks and outcome state machine.
2. Upgrade Changes into a full review surface.
3. Make Inbox the cross-run attention/outcome center.
4. Add retry/fork/fix-check actions and clear no-change/failure states.
5. Add run duration/cost/check/policy/retry summary.
6. Implement queue leases/reclaim and waiting state for long retry-after.
7. Certify GitHub issue/comment → worktree → checks → PR end to end.
8. Add attachment retention, cap, GC, and disk-health UX.

**Exit criteria**

- No successful automation without explicit artifact/check outcome.
- Stuck claimed runs self-recover or surface within SLO.
- Reviewers can understand changes, checks, cost, and policy without reading full transcript.

## Phase 3 — safe execution and recovery (3–5 months)

**Goal:** make “walk away” safe and predictable.

1. Productize execution profiles and recommend isolation for unattended work.
2. Live-certify one deterministic suspend provider and one raw-VM provider.
3. Finish and test rebuild/resume UX and hosted inbound-thread continuation.
4. Add recovery center with snapshot/replica freshness and loss semantics.
5. Validate device-vault revoke rotation and cold-start behavior.
6. Add relay quotas, per-account caps, reconnect-storm/load tests.
7. Decide whether to build a Bivy-owned sandbox or certify external isolation substrates.

**Exit criteria**

- Ephemeral launch, teardown, leak prevention, wake, and restore meet measured SLOs.
- Revoked devices cannot use retained wrapped provider credentials after rotation.
- Every unattended profile has a precise, tested isolation statement.

## Phase 4 — team readiness (5–9 months, demand-gated)

**Goal:** controlled adoption by small engineering teams.

1. Organizations, roles, repo/node scoping, approver routing.
2. Central policies and auditable overrides.
3. Audit log, retention controls, export/deletion.
4. Shared automation ownership, concurrency/budgets, team inbox.
5. SSO/SCIM only with committed customers.
6. External security review before enterprise security claims.
7. Define supported self-host tier or keep it explicitly community-only.

**Exit criteria**

- A team admin can answer who ran what, where, under which policy, who approved it, and what artifact/check resulted—without exposing prompt/transcript content to the control plane.

## Defer until the above is healthy

- more coding-agent adapters;
- more raw cloud providers;
- native mobile app;
- automatic warm-standby promotion;
- generalized workflow builder;
- managed Bivy compute;
- broad enterprise feature checklist.

Each adds substantial matrix/support burden and less near-term value than making the current core reliable and simple.

---

## Metrics and operating review

### Customer value

- Weekly active developers who complete at least one useful run.
- Runs ending in reviewed PR/commit/check outcome.
- Sessions resumed from another device.
- Minutes of unattended work completed without intervention.
- Repeat use at day 7/day 30.

### Activation

- Install start → node online.
- Node online → provider authenticated.
- Provider authenticated → first prompt.
- First prompt → useful response/check/changes.
- Drop-off and p50/p90 duration by OS and agent.

### Quality

- Session creation success.
- Prompt delivery duplicate/loss rate.
- Resume/reconnect success.
- Runtime failure by agent/version.
- Approval deep-link and resolution success.
- Queue stuck/retry/reclaim rate.
- Ephemeral leaked machine and restore success rate.
- Browser uncaught errors and service-worker update failures.

### Trust and safety

- Runs by protection profile/runtime enforcement tier.
- Policy denials and approval timeout rate.
- Full-access first-use conversion/cancellation.
- Secret-redaction detections and postmortems.
- Dependency/security remediation age.
- Device/key revocation propagation success.

### Simplicity guardrails

- Decisions/clicks to first task.
- Percentage using advanced settings.
- Support tickets per 100 activated users by setup concept.
- Recommended-vs-Beta runtime usage and failure delta.
- Number of default-visible settings/picker options.

Review these weekly during beta. Do not optimize merely for run count; a runaway or repeatedly failing automation can increase run count while destroying value.

---

## Concrete prioritized backlog

| Priority | Item | Why |
|---|---|---|
| P0 | Fix high production dependency advisories | Current release gate/customer trust failure. |
| P0 | Reconcile local-only/account requirement | Core product contract is contradictory. |
| P0 | Runtime tiering from one manifest | Prevent overpromising and docs/UI drift. |
| P0 | Runtime-specific safety labels + first-run policy choice | Prevent false containment expectations. |
| P0 | Browser critical path + axe in CI | Principal UI lacks proportional regression coverage. |
| P0 | Live certify recommended runtime matrix | Fast-moving CLIs cannot be guaranteed by unit tests alone. |
| P0 | Deterministic outcome/check state | Agent completion is not customer success. |
| P1 | Setup checklist and activation telemetry | Find and fix the real onboarding bottleneck. |
| P1 | Simplify Settings IA and contextual setup | Preserve power without default complexity. |
| P1 | Full changes/check review experience | Expected for coding-agent trust and PR quality. |
| P1 | Attachment cap/GC/retention | Prevent disk/privacy failure. |
| P1 | Warning ratchet and large-module decomposition | Restore maintainability and warning signal. |
| P1 | Recovery center and honest durability display | Turn advanced replication/snapshot work into customer value. |
| P1 | Queue lease/reclaim/waiting semantics | Required for dependable unattended operations. |
| P2 | Execution profiles / isolated runner recommendation | Safer unattended default. |
| P2 | Team RBAC/policy/audit | Required before team/enterprise promise. |
| P2 | External security assessment | Required for sensitive/enterprise trust. |

---

## Final judgment

Bivy is not a shallow prototype. Its core architecture and session behavior are ahead of many young agent products, particularly around remote continuity, privacy boundaries, reconnect correctness, follow-up semantics, and cross-agent operation. There is enough real value here for a strong product.

The path to “as powerful as possible, yet simple and intuitive” is **not adding more power to the default surface**. It is:

1. choose one crisp promise;
2. certify a narrow golden path;
3. expose exact capability and safety truth;
4. measure activation and outcomes;
5. turn sophisticated recovery/orchestration internals into simple customer states;
6. progressively reveal the deep platform only when the customer asks for it.

If Bivy executes the P0–P1 roadmap before expanding the matrix, it can occupy a defensible category: **the private, agent-agnostic operations layer between coding-agent CLIs and the developer/team responsible for their outcomes.**
