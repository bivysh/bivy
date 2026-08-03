# Bivy — Deep Product Review & Roadmap

*August 2026 · review across value, UX, simplicity, robustness, and competitive position*

---

## 0. TL;DR

Bivy is a genuinely differentiated product built with unusual engineering care. It
occupies an intersection **no competitor fully covers**: run *any* of ~19 coding
agents, on *your own* infrastructure, with *your own* keys, governed by approvals
you can drive from a phone — while a hosted control plane coordinates routing and
work queues **without ever seeing your code, prompts, transcripts, or keys**.

The core loop (run an agent locally, reach and steer it remotely) is solid and, per
the team's own docs, used daily. The web/PWA client solves genuinely hard problems
(iOS keyboard/viewport pinning, reconnect-without-losing-focus, a visible followup
queue) better than most competitors. The CLI's install and error-handling are more
careful than most best-in-class dev tools.

**The gap between "solid" and "the powerful, simple, trustworthy system we want" is
concentrated in five themes:**

1. **A promise-vs-reality gap on the core safety story.** The product advertises a
   universal "hard floor" (catastrophic commands blocked, no writes outside the
   workspace) that is *not actually enforced* for a large class of agents, and is a
   narrow regex even where it is. This undermines the single most important reason a
   customer would trust Bivy over a hosted competitor.
2. **Silent failures everywhere.** Invalid API keys loop with no error; settings
   saves are fire-and-forget; a dropped terminal socket still shows "Connected";
   event-log write errors are swallowed. Each erodes the trust the product is selling.
3. **Money can leak.** A single hung agent pins a paid cloud machine until a 24h TTL;
   opening a settings panel can auto-provision a billable VM; dismissing a dialog
   strands an idle billable runner. Combined with the ephemeral feature being
   *shipped-but-flagged-off and unverified*, the highest-stakes surface is the least
   proven.
4. **Time-to-first-value has hidden gates.** Setup forces a control-plane account
   sign-in (contradicting the "local-only" promise) and then *silently defers* the
   model sign-in that's actually required to get an answer, so setup declares success
   on a node that can't yet run anything.
5. **Attention & discoverability debt.** You can't see that a *background* session
   needs your approval — no tab title, no app badge, no global "needs you" surface —
   which is the whole point of a "watch and approve from your phone" product. And a
   deep feature set is crammed behind a single settings gear with search that only
   matches labels.

None of these are architectural dead-ends. The foundations are strong. This document
maps the landscape, assesses each dimension, and proposes a phased roadmap to close
the gap.

---

## 1. What Bivy is

**Core value loop.** Route coding-agent work — from GitHub issues, Linear issues,
Slack, signed webhooks, schedules, or a live prompt — to a **node** (a daemon on your
laptop, server, or cloud) that holds your repo, model keys, and tools and runs the
agent process locally. A hosted (or self-hosted) **relay** forwards end-to-end
encrypted frames, and a **control plane** holds accounts, the node/session registry,
and serves the web/PWA client — so you can watch, steer, and approve from a phone,
browser, or another terminal. The relay and control plane never receive repo
contents, prompts, transcripts, or model keys.

**Who it's for.** Developers and teams who want autonomous / async coding-agent runs
but need code and credentials to stay on infrastructure they own — for privacy,
compliance, cost control, or because they already run agents locally and want to
reach them from anywhere.

**Where it is in its life.** Self-described 0.x; shipping fast (0.2 → 0.5 across two
weeks of late July / early Aug 2026, almost entirely UX polish). The core is real;
the edges are a mix of solid, partial, and nascent (§5).

---

## 2. Competitive landscape & positioning

The 2026 market has four rough camps. Bivy is legible only when you see that it spans
the boundary between them:

| Camp | Examples | What they own | The tradeoff |
|---|---|---|---|
| **Hosted autonomous** | Devin, Cursor background agents, GitHub Copilot coding agent | Their cloud, their sandbox, their orchestration | Your code/keys run on *their* compute; you're locked to one agent |
| **Phone command-center** | **Omnara** | Watch/steer/approve Claude Code & Codex from a phone, voice | Relays to *your laptop*; no work queues, no governance, no fleet |
| **Self-hosted orchestrator** | **OpenHands**, Vibe Kanban, Conductor, Sculptor | A self-hostable control center driving agents on your infra | Governance/RBAC/audit is Enterprise-gated (OpenHands); Slack cloud-only; mostly drives *its own* agent; desktop-bound (Conductor/Sculptor) |
| **Terminal-first** | Claude Code, Codex, Aider | One excellent agent in your terminal | No remote reach, no routing, no cross-agent, no queues |

**Bivy's position — the intersection nobody else holds:**

- **Agent-agnostic** (~19 agents through their native interfaces) — vs. Devin/Copilot
  (one agent), Omnara (Claude/Codex), OpenHands (mostly its own).
- **Your infra + your keys, E2E** — the control plane provably never sees data. This
  is stronger than *any* hosted competitor and stronger than OpenHands' default posture.
- **Governance in the box, not gated** — approval modes, a safety floor, rulesets,
  outcome reports on *every* plan. OpenHands gates the control layer behind Enterprise.
- **Multiple work queues** — GitHub, Linear, Slack, webhooks, schedules all converge
  on one durable automation queue. Omnara/Conductor/Sculptor have none of this.
- **Phone-native steering + approvals** — Omnara's core competency, but Bivy pairs it
  with the queues and governance Omnara lacks.
- **BYO-cloud burst** — spin up a short-lived runner in *your* cloud account, pay the
  provider directly, control plane never holds the token.

**The one-line positioning to sharpen:**
> *"The agent you want, on the infrastructure you own, governed the way you need —
> reachable from your pocket. We route and coordinate; we never see your code."*

**Competitive risks to respect:**
- **Copilot coding agent** is the default for GitHub-centric teams and is "seamless"
  *because* it doesn't ask you to own infra. Bivy's answer must be that owning infra
  is *easy* (see time-to-first-value, §4.3) and buys real things (privacy, any agent,
  any model, cost).
- **Omnara** is a sharp, focused wedge on exactly Bivy's most demoable feature. Bivy
  wins on breadth (queues, governance, fleet) but must not lose the phone-steering
  polish that is Omnara's whole product.
- **OpenHands** is the most direct architectural competitor and is well-funded with an
  Enterprise motion. Bivy's edge is the *default* E2E no-data-sharing posture and
  agent-agnosticism; that edge evaporates if the safety/governance story has holes
  (§3), because governance-without-teeth is exactly what an OpenHands Enterprise pitch
  would attack.

---

## 3. Assessment by dimension

### 3.1 Value & customer expectations — *Strong thesis, undermined by a trust gap*

The value thesis is excellent and the feature breadth backs it up: agent-agnostic
execution, four credential classes handled distinctly, per-turn diffs + rewind across
*every* agent, a visible followup queue, outcome reports that are provably
metadata-only. A customer who wants "autonomous agents but my code stays home" has, on
paper, no better option.

**But the central promise has a hole.** The product page and the node's own
`/api/node/info` advertise a universal safety floor: *"Writes outside the active
workspace are denied; catastrophic/destructive commands are blocked."* In reality:

- The floor is only wired when a runtime has `toolInterception: true`. For generic
  CLI / process agents — **OpenHands, SWE-agent, generic-cli, and non-ACP Codex** —
  there is **no Bivy governance at all**: no catastrophic block, no workspace boundary.
  Default mode is `autonomous`. The OS jail was removed for 1.0. So for these agents,
  the *only* containment is the agent's own native sandbox — and the docs claim
  otherwise. (`server.ts:7261/7787`, `runtime/index.ts:1520/1532`, `server.ts:8596-8597`)
- Even where enforced, the floor is `tool === "bash"`-specific and regex-narrow:
  `rm -rf /etc` doesn't match; writes-outside-workspace *via bash* (`tee`, `cp
  ~/.ssh/…`) aren't covered; `echo <base64> | base64 -d | sh` bypasses it.
  (`guard.ts:44/109/112`)

This is the highest-priority finding in the entire review, because it's not a bug —
it's a **gap between what the product sells and what it does**, on the exact axis
(trust, safety, governance) that justifies choosing Bivy over a hosted competitor. The
mechanism where interception *is* active is sound (fail-closed, timeouts block); the
problem is *reach* and *honesty*.

**Maturity honesty, generally.** Only 2 of the 19 headline agents (Pi, Claude Code
SDK) are truly "solid"; the rest are Beta with known gaps. `fork` to another runtime
isn't supported even for Pi. Ephemeral runners — the "burst onto cloud" pillar of the
pitch — are entirely feature-flagged off, with every provider adapter marked
unverified-live and E2B a "prototype." None of this is wrong to ship; it *is* wrong to
let the top-line marketing outrun it. Expectation-setting is itself a feature.

### 3.2 UI / UX — *Best-in-class client craft, with attention & silent-failure gaps*

**The web/PWA client is a real strength.** The genuinely hard mobile problems are
solved with care that beats most competitors:

- Composer stays typable through the *entire* reconnect window so a blip never drops
  the iOS keyboard or eats a half-written prompt; per-session draft persistence.
- Windowed, identity-preserving transcript with jank-free auto-follow and a "↓ Latest"
  affordance.
- A **visible followup queue** with reorder/edit and a separate "Steer now" that
  appears only when the runtime supports it — better than the send-blindly-into-a-busy-
  turn behavior of most agent UIs.
- Pending-state + stall-timeout + Retry on approvals (compensating for a protocol with
  no ack), universal per-turn diff + rewind, portal-to-body sheets, `visualViewport`
  pinning, coordinated modal-Escape stack.

**The gaps that matter most:**

- **[High] You can't tell a background session needs you.** Approval/question cards are
  filtered to the on-screen session; a blocked background run surfaces only as a
  sidebar dot. There is no `document.title` update and no `navigator.setAppBadge`
  anywhere — so in a background tab or on a phone, a run can silently block on your
  approval. For a "watch and approve from anywhere" product, this is the single most
  important UX gap. (`App.tsx:337-338`)
- **[High] Silent failures on the paths most likely to fail.** An invalid/expired API
  key just re-renders the empty form with no "that key didn't work"
  (`ProviderConnect.tsx:114-133`) — and this is the *first-run* model-auth path. A
  dropped terminal socket still shows a green "Connected" pill while output freezes
  (`Terminal.tsx:1215`). Copy-to-clipboard (including the install command, the
  primary "nothing → a node" path) fails silently in many places.
- **[High] Billable side-effects with no confirm.** Opening the GitHub-queue settings
  panel can auto-provision a paid VM as a mount side-effect (`GithubQueue.tsx:414-436`);
  dismissing the first-run model-auth sheet strands a booted, idle, billable ephemeral
  runner (`FirstRunModelAuth.tsx:38`).
- **[High] Automations "Edit" is a mobile dead-end** (populates a form at the top of a
  long page with no scroll-to / mode indicator), automations can't be deleted (only
  disabled), and Run-now/Toggle/Edit errors are swallowed. (`Automations.tsx:168-209`)
- **[Med] Discoverability debt.** 17 settings sections behind one gear icon; Settings
  search matches only nav labels, not content (searching "cron"/"webhook secret"/
  "billing" finds nothing). No command palette or keyboard shortcuts for a tool that
  invites Linear/Vercel comparison.
- **[Med] Accessibility debt** in the largest surfaces: the Settings modal lacks a
  focus trap (Tab leaks behind the scrim despite a comment claiming otherwise); the
  Terminal overlay isn't an accessible modal and its ~11-control header clips on a
  phone; system-dark-mode renders source marks near-invisible (a missing `--s-*`
  redeclaration, and "system" is the default theme); several tap targets < 44px;
  light-theme accent-as-text ~3.6:1 fails WCAG AA.
- **[Med] Interaction footguns** in the terminal: auto-copy-on-select clobbers the
  clipboard; "End" (kills the PTY) sits next to "×" (closes overlay) with opposite,
  unlabeled consequences; typed command lines (incl. `export TOKEN=…`) are recorded to
  localStorage unredacted.

**The CLI UX** is a quieter strength: multi-tier checksum-verified install, PATH-into-
rc-file, binless-release diagnosis, and error messages that name the next command
almost everywhere; `status`/`doctor` are health-gated with JSON output. Weaknesses:
naming inconsistency (colon namespaces `github:connect` vs. space subcommands `nodes
add`), several undocumented surprising aliases (`dev`, `listen`, `init`, `clean`), and
— covered next — the onboarding gates.

### 3.3 Simplicity & time-to-first-value — *Deliberately low-prompt, but two hidden gates*

Setup is thoughtfully minimal: workspace and port auto-chosen, default agent not
prompted, re-runnable safely. But two gates work against the "simple and local-first"
promise:

- **[High] Setup forces a control-plane account sign-in with no "local only / skip"
  path.** There's only hosted-vs-self-hosted, then GitHub-vs-email; a failed sign-in
  exits setup incomplete. This directly contradicts the CORE.md promise that
  *"local-only use must not require a Bivy Cloud account."* A user who just wants to
  try one agent must create/auth an account and do a browser round-trip *before any
  value*. (`bivy.mjs:3203-3271`)
- **[High] The model sign-in you actually need is silently deferred.** Setup ends with
  a green "✓ Your node is running" — but the default agent still has no model
  credentials, so the very next `bivy` run fails until the user notices `bivy login` in
  the post-setup steps. Best-in-class CLIs make the credential the *first* thing.
  (`bivy.mjs:3299/3388-3393`)

Net: 4 real steps and 2 separate browser/interactive auth round-trips (account, then
model), the second not part of setup — more friction than `vercel` / `stripe login` →
immediate use. And `doctor`/`status` check credential *presence*, not validity, so an
expired token shows a green check while runs fail.

### 3.4 Robustness & reliability — *Careful core, three sharp edges*

The reconnect state machine, replication fencing, secrets vault, atomic metadata
writes, fail-closed interception, and the ephemeral TTL backstop are all
well-designed and well-unit-tested. The serious problems cluster in three places:

- **[High] The safety floor doesn't reach uncontained runtimes** (same as §3.1; it's
  both a value gap and a robustness gap).
- **[High] No per-turn agent watchdog.** `prompt()` has no timeout; nothing reaps a
  stuck turn. A hung agent keeps a session `working` forever — and because
  self-teardown refuses while any session is working, **a single hung turn pins a paid
  cloud machine until the 24h TTL fires.** A money leak from one stuck agent.
  (`process.ts:359`, `ephemeral-teardown.ts:72`)
- **[High/Med] Silent data-drop paths.** `EventLog.flush()` swallows disk errors in a
  `catch {}`; `load()` returns `[]` on a corrupt/unreadable log (an unreadable session
  presents as *empty* — silent history loss); the frame reassembler silently drops
  oversized interleaved frames. The secrets vault, by contrast, correctly fails loud —
  the event log should borrow that discipline. (`event-log.ts:349-352/519`)
- **[Med] Orphaned work & processes.** Detached agent-service sessions keep the child
  running forever unless an env-gated reaper is set; queue items can be stranded
  "running" on a crash and a retry can duplicate PRs/comments (a pushed branch/PR
  before a throw isn't unwound); relay reconnect has no jitter (thundering herd after a
  relay restart); live relay events are best-effort with no replay.

Where interception is active, approval correctness is sound (fail-closed, block on
timeout, deny on detach, cancel-on-teardown). The issue is reach, not mechanism.

### 3.5 Security & trust posture — *A real asset, kept honest by disclosure*

The E2E architecture is the product's crown jewel and is implemented seriously:
AES-256-GCM under a room key the relay never holds; session titles encrypted at rest;
QR pairing with a single-use ECDH secret not carried in the link; removing a device
rotates the room key; credential-sync stores only ciphertext the cloud can't decrypt.
The docs are commendably honest about the exceptions (push-notification title/body is
the one plaintext leak; the deny-list is "trivially bypassable, catches accidents not
attacks"; no third-party audit yet; no OS jail in 1.0).

That honesty is the right instinct — but it needs to be matched by the *product
surface*, so a user can't be told one thing by the marketing and another by the
footnote. Closing §3.1's floor gap is what turns "honest about limitations" into
"trustworthy."

---

## 4. What "as powerful as can be, yet simple and intuitive" requires

Three principles fall out of the findings:

1. **Never let the promise outrun the product.** Every advertised guarantee (the
   safety floor, "burst onto cloud," "$0 when idle") must be true for the path the user
   is actually on, or be visibly scoped. This is the difference between a trusted
   governance product and a leaky one.
2. **Make failure loud and money visible.** Silent saves, silent key errors, silent
   dropped sockets, silent event-log loss, and invisible billable side-effects all
   spend the exact trust the product sells. Every failure should surface; every dollar
   should be confirmed.
3. **Collapse the distance to first value, then to attention.** One command to a
   working agent; one glance to know a run needs you. Power comes from breadth
   (queues, agents, governance); simplicity comes from a short happy path and a single
   "needs you" surface that spans every session and device.

---

## 5. Roadmap

Phased by what most moves "solid, usable, valuable." Each item names the theme it
serves. Effort is rough (S/M/L).

### Phase 0 — Trust & safety integrity *(do first; these are promise-vs-reality gaps)*

| # | Item | Why | Effort |
|---|---|---|---|
| 0.1 | **Enforce the safety floor independent of `toolInterception`** — apply catastrophic/workspace checks to process/CLI runtimes, or refuse `autonomous` mode for uncontained runtimes. Stop advertising a floor those runtimes don't have. | Closes the #1 trust gap (§3.1/§3.4-H1). | M |
| 0.2 | **Harden the floor itself** — match `rm -rf /etc|/usr|/home`, cover writes-outside-workspace via bash, and match shell tools by capability not the name `"bash"`. Document it honestly as best-effort. | The floor should catch the obvious cases it claims to (§3.4-H2). | S |
| 0.3 | **Per-turn agent watchdog** — configurable turn timeout that SIGTERM/SIGKILLs a stuck agent (reuse `killProcessGroup`), which also unblocks ephemeral idle-teardown. | Stops the hung-agent money leak and the forever-`working` session (§3.4-H3). | M |
| 0.4 | **Make the event log fail loud** — surface `flush()` write errors; distinguish "empty session" from "unreadable log"; don't silently drop oversized frames. Mirror the secrets vault's discipline. | Prevents silent history/data loss (§3.4-M4). | S |
| 0.5 | **Reconcile marketing with maturity** — scope the floor/ephemeral/"$0 idle" claims in the README and product page to what's verified; label Beta agents and the flagged-off ephemeral feature clearly. | Expectation-setting is a feature (§3.1). | S |

### Phase 1 — Time-to-first-value & attention *(the two things a new/returning user feels first)*

| # | Item | Why | Effort |
|---|---|---|---|
| 1.1 | **A real local-only path through setup** — offer "local only / skip account for now"; make model sign-in the first, in-setup step so setup never declares success on a node that can't run. Honor the CORE.md local-first promise. | Removes the two hidden onboarding gates (§3.3). | M |
| 1.2 | **Validate credentials in `doctor`/`status`, not just presence** — one live check so an expired key shows red, not green. | Stops the "green check, failing runs" trap (§3.3). | S |
| 1.3 | **Global "needs you" surface** — `document.title` count + `navigator.setAppBadge` + a cross-session approvals/questions affordance that isn't filtered to the active session. | The core "approve from your phone" promise (§3.2-High #1). | M |
| 1.4 | **Kill the silent-failure class in the client** — real error path on invalid API key; live "Reconnecting…" state on the terminal pill; surface copy-to-clipboard failures; unswallow Automations errors. | Trust erosion on the most-hit paths (§3.2). | M |

### Phase 2 — Money safety & the ephemeral pillar *(the highest-stakes, least-proven surface)*

| # | Item | Why | Effort |
|---|---|---|---|
| 2.1 | **No billable action without explicit confirm** — remove auto-provision-on-panel-open; confirm-on-dismiss (or inline warning) for the first-run model-auth sheet that leaves a runner idle. | Money should never spend as a side-effect (§3.2-High #3). | S |
| 2.2 | **Verify ephemeral end-to-end and turn it on deliberately** — live-provision each substrate with a real token, confirm Sprite idle-suspend, resolve the E2B pre-GA blockers, then graduate the flag. Until then, don't lead the pitch with it. | The "burst onto cloud" pillar must be real before it's marketed (§5-catalog / §3.1). | L |
| 2.3 | **Guarantee teardown even on failure** — CP-side sweep as a backstop for the Hetzner device-launched / reconciler-failure paths; default the detached-session reaper on; client-side lease/heartbeat for queue items so a crash doesn't strand "running" work or duplicate PRs. | Closes the residual leak/duplication paths (§3.4-M1/M2/L4). | M |

### Phase 3 — Power & polish *(depth once the foundation is trustworthy)*

| # | Item | Why | Effort |
|---|---|---|---|
| 3.1 | **Command palette + keyboard shortcuts** (⌘K: new session, switch, focus composer, jump to approval) and **content-aware Settings search**. | Power-user parity with Linear/Vercel; tames the 17-section settings sprawl (§3.2-Med). | M |
| 3.2 | **Accessibility pass** — Settings/Terminal focus traps + `role="dialog"`, dark-mode `--s-*` fix, 44px tap targets, WCAG-AA accent contrast, label/input association, define phantom CSS tokens. | The largest surfaces have the biggest a11y debt (§3.2-Med). | M |
| 3.3 | **CLI surface consistency** — pick one grouping convention (spaces, à la `gh`), document or drop the surprising aliases, and secret-input safety (`secrets set` reading from stdin/prompt by default). | Discoverability and least-surprise (§3.2-CLI). | S |
| 3.4 | **Deepen the second-tier agents & fork** — move a few high-demand Beta agents to "solid," and ship `fork` across runtimes (incl. Pi). | Breadth is the moat; make it real (§5). | L |
| 3.5 | **Reconnect jitter, relay-event replay-on-reattach, and reaper/lease tests** — plus tests for the floor-reach, hung-agent, and event-log-durability gaps that currently have none. | Harden the distributed edges and lock in Phase 0/2 fixes (§3.4-M3, test gaps). | M |

### Phase 4 — Differentiation & moat *(where "as powerful as can be" earns the premium)*

| # | Item | Why |
|---|---|---|
| 4.1 | **Team / multi-user governance** — today collaboration is single-account/multi-device. Real RBAC, shared node fleets, per-user access controls on Slack/webhook triggers, and an audited (not just metadata) trail are the natural answer to an OpenHands-Enterprise pitch — deliverable *without* breaking the no-data-sharing posture. |
| 4.2 | **Fleet view & routing intelligence** — a first-class dashboard across sessions/nodes/runs with cost, and richer rulesets (in-session reroute beyond model-swap, node fallback, warm-standby promotion). |
| 4.3 | **Lean into phone-native** — voice, one-tap approve/steer, and a genuinely great mobile "command center" so Bivy owns Omnara's wedge *and* everything Omnara lacks. |
| 4.4 | **Onboarding that sells owning infra** — a guided first-task / sample-run that makes "my code stays home" feel like *less* work than Copilot, not more. |

---

## 6. Closing

Bivy is not a product with a weak core that needs rescuing. It's a product with a
*strong, differentiated* core whose top-line promises have run slightly ahead of what
the edges deliver — most consequentially on the safety/governance story that is the
whole reason to choose it. Close the promise-vs-reality gaps (Phase 0), collapse the
distance to first value and to attention (Phase 1), make money impossible to spend by
accident and prove the ephemeral pillar (Phase 2), then add power and polish
(Phase 3–4). Do that, and Bivy holds an intersection of capabilities that no single
competitor can match — the agent you want, on the infrastructure you own, governed the
way you need, reachable from your pocket.

---

### Appendix — source of findings

This review synthesizes four parallel code/doc audits of the repository (web/PWA
client, CLI & onboarding, robustness/reliability, and a full feature catalog) plus
competitive research across Devin, Cursor background agents, GitHub Copilot coding
agent, Claude Code, OpenHands, Omnara, Conductor, Vibe Kanban, and Sculptor. File:line
citations throughout point at the reviewed source on branch
`bivy/do-a-full-deep-review-of-bbe4ed`.
