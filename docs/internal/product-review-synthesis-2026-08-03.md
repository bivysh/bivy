# Bivy product review synthesis and unified roadmap

- **Date:** 2026-08-03
- **Current-state spot check:** `f141bdf`
- **Sources:** [PR #329](https://github.com/bivysh/bivy/pull/329), `docs/product-review-2026-08.md`; [PR #330](https://github.com/bivysh/bivy/pull/330), `docs/internal/product-customer-ux-review-2026-08-03.md`

This is a decision brief, not a replacement for the reports' detailed evidence and issue-level backlog.

## Executive decision

Bivy has enough power. The next product cycle should make that power **credible, easy to reach, and easy to understand**, rather than broaden it further.

Position Bivy as:

> **The private command center for coding agents running on infrastructure you control. Start work, leave it running, and monitor, steer, approve, review, and recover it from anywhere.**

The near-term customer is the individual power developer with one machine and one repository. The expansion customer is a small engineering team running governed issue-to-change workflows. Security-sensitive enterprises are a strong future fit, but Bivy should not imply enterprise-grade isolation, identity, compliance, or support before those capabilities exist.

The product strategy is **simple path, deep ceiling**:

- certify a narrow default path;
- progressively reveal agents, infrastructure, automation, and policy;
- state the exact protection and maturity of every runtime;
- organize the product around attention and reviewable outcomes, not feature inventory or token streaming;
- make failures, cost, and recovery explicit.

## Synthesis of the two reviews

The reports strongly agree on the diagnosis. They differ mostly in level and emphasis:

- **PR #329 is the sharper defect audit.** It identifies immediate trust failures: the universal safety-floor claim, silent errors and persistence failures, unbounded turns, accidental cloud cost, and onboarding gates.
- **PR #330 is the broader product operating plan.** It adds the golden path, runtime certification, outcome contracts, browser QA, change review, bounded storage, maintainability, metrics, and a demand-gated team roadmap.

Together they imply that Bivy should first become a trustworthy product around its existing architecture, then turn its orchestration depth into a moat.

### Key findings

1. **The differentiation is real.** User-controlled execution, E2E remote access, durable cross-device sessions, agent choice, follow-up queues, approvals, automations, and recovery form a valuable combination. Bivy should not compete primarily as an IDE, autocomplete tool, or fully managed software engineer.

2. **The core is stronger than the default experience.** Reconnect and deduplication behavior, transcript durability, mobile composer handling, follow-ups, attachments, and the attention inbox show unusually thoughtful engineering. Customers cannot yet perceive all of that strength because setup, capability caveats, settings, and failure states create uncertainty.

3. **Product truth is the highest-priority gap.** Bivy advertises a hard floor in every mode, while enforcement varies from native/tool-level control to observation only, and there is no Bivy-owned OS jail. A regex guard can prevent accidents but cannot be described as isolation. `autonomous` is not an appropriate invisible default for a runtime that Bivy cannot intercept or isolate.

4. **Breadth is now a support and simplicity tax.** Nineteen agents, several execution modes, multiple auth owners, persistent and ephemeral machines, integrations, automation, replication, and self-hosting make Bivy look like several products. The catalog is an advantage only if the default path is narrow and every visible option is honestly tiered and certified.

5. **Activation should end with value, not installation.** Setup leaves model authentication for later, and a green setup result is not meaningful until a selected runtime can answer on a selected repo. Remote (hosted or self-hosted) enrollment stays required: remotely visible, steerable sessions are what Bivy adds over a bare local CLI, so an account-free local-only path is explicitly out of scope.

6. **Attention and outcomes—not chat alone—are the product center.** A customer wants to leave work running, know when it needs help, and understand what happened. The Inbox is the right foundation. The next missing layer is deterministic outcome status, checks, changes, cost, policy decisions, and recovery without reading an entire transcript.

7. **Trust is lost through silent failure and invisible spend.** Blind credential saves, swallowed event-log errors, stale connection states, stuck turns, queue claims without leases, unbounded attachment storage, and provisioning side effects all undermine the promise of dependable unattended work.

8. **UI quality needs a release gate.** The PWA is a principal client, but browser, mobile, accessibility, visual, service-worker, and performance coverage is much lighter than protocol/unit coverage. Large central files and hundreds of lint warnings further reduce regression signal.

9. **Team and enterprise work should follow proof of the individual loop.** RBAC, policy administration, audit, SSO, fleet routing, and external security review are natural extensions, but they should not displace activation, safety clarity, outcomes, or runner reliability.

10. **Code review is not customer evidence.** Both reports are strong repository audits, but positioning and priority assumptions still need activation data and observed customer use. Validate the golden path with individual developers first, then test the outcome/team workflow with small engineering teams.

### Competitive conclusion

| Alternative | Customer expectation | Bivy's response |
| --- | --- | --- |
| Hosted agents such as Devin and Copilot coding agent | Click a task and receive a checked PR with no infrastructure work | Win on data control, agent/model choice, and continuity; close the setup and validated-outcome gap. |
| IDE agents such as Cursor and Copilot | Immediate in-editor context, edits, and review | Integrate with native agents rather than compete on autocomplete or editor polish. Win when work leaves the IDE. |
| First-party terminal agents | Best and fastest access to each vendor's capabilities | Remain a control and continuity layer around the native agent; certify versions instead of pretending adapter parity. |
| Phone control products such as Omnara | Frictionless notification, steering, and approval | Match their mobile focus, then differentiate with queues, governance, recovery, and a fleet-wide Inbox. |
| Self-hosted platforms such as OpenHands | Isolation, customization, automation, and team controls | Lead with E2E/user-owned execution and agent choice, but close the isolation and governance-claim gap before selling security maturity. |

The competitive wedge disappears if Bivy is harder to activate than hosted products, less polished on mobile than phone-first products, or less honest about isolation than self-hosted products.

## Reconciliation against current `main`

The two reviews were produced in parallel while the repository was changing quickly. The unified backlog should account for what already exists:

| Topic | Current synthesis |
| --- | --- |
| Global attention | The global Inbox already aggregates approvals, questions, automation failures, and queue/provider conditions. Do not rebuild it. Add title/app badges, reliable push deep-links, aging and outcome categories, and make unresolved attention the return surface. |
| Model re-authentication | PR #325 now detects many in-session model 401/auth failures and opens re-authentication. Setup still defers initial model auth, and API-key save still uses a timer/re-list rather than a validated acknowledgement. |
| Runtime tiers | Supported/Beta/Experimental labels and capability chips already exist, but all available agents are still presented as one alphabetical list. Add Recommended vs More agents hierarchy and live certification freshness. |
| Ephemeral runners | The user-facing feature flag is currently `true`, while its comment still says hidden; failed-machine retention is also `true` despite being documented as staging-only. This is a release-integrity issue, not a future feature-flag issue. Gate production exposure until cost and lifecycle checks pass. |
| Security audit | The reported release blocker reproduces at this revision: `npm audit --omit=dev --audit-level=high` reports three high-severity dependency paths. Open upgrades should be merged and the audit rerun before release. |
| Safety enforcement | The code already computes `strong`, `boundary`, and `observe_only` enforcement levels, but that distinction is not carried into a simple customer-facing protection contract. Use it rather than inventing another hidden capability model. |

## Unified product shape

### One golden path

A first session should expose at most four decisions:

1. **Machine** — preselect the only online machine; explain cost before an ephemeral launch.
2. **Repository** — choose a repo or clearly explain what “No repo” means.
3. **Agent/model** — default to a live-certified pairing; put the broader catalog under **More agents**.
4. **Protection** — show a customer-language preset and the actual runtime enforcement below it.

Setup is complete only after doctor checks pass and the user receives a useful first response. PWA installation, notifications, integrations, automation, more agents, ephemeral runners, rulesets, replication, and self-hosting come after first value.

**Decision (2026-08-03, supersedes the earlier account-free-local direction; see decision record D-003):** remote enrollment stays **required**. Remotely visible, steerable sessions are what Bivy adds over a bare local CLI, so an account-free "Local CLI only" setup mode is explicitly out of scope. The `bivy setup` remote-access prompt therefore offers only **Bivy Cloud remote** and **self-hosted remote**. Self-hosting is the account-free path: pointing at your own control plane and relay (via the wizard's self-hosted choice, or by setting `BIVY_CONTROL_PLANE_URL` / `BIVY_RELAY_URL`, which default setup to self-hosted) means a Bivy Cloud account is never mandatory — consistent with `CORE.md`.

### Progressive power

- **Recommended:** release-certified runtime/version combinations with a tested auth, stream, tool, stop, reconnect/resume, attachment, and negative sandbox path.
- **Beta:** useful but explicitly caveated; visible under **More agents**.
- **Experimental:** advanced/configuration-only and outside the normal support promise.

Extend the existing runtime catalog and agent-manifest path into the authoritative source for picker tiers, protection summaries, documentation, certification dates, and support diagnostics; do not create a parallel registry.

### A legible protection model

Do not collapse different mechanisms into a generic “safe” label. The session composer and approval cards should state whether protection comes from:

- a native sandbox plus Bivy tool controls;
- Bivy tool/MCP controls without OS isolation;
- an external container/VM boundary;
- or execution as the user's account with limited/observational control.

Offer plain-language presets, with separate approval and sandbox knobs under Advanced. Require informed confirmation for full-machine access and for unattended use on a non-isolated, non-interceptable runtime. Harden the command guard, but continue to describe it as accident prevention—not an adversarial boundary.

### Attention-to-outcome loop

The primary loop should be:

> **Start → leave → get notified → approve/answer if needed → review changes and checks → accept, retry, or fork.**

The Inbox should summarize `Needs approval`, `Needs answer`, `Failed`, and `Completed—unreviewed`. A run is not successful merely because an agent emitted `agent_end`; Bivy should report the artifact and deterministic validation result.

## Unified roadmap

Horizons are indicative. Advance on exit criteria, not dates.

### Phase 0 — product truth and stop-loss controls (0–2 weeks)

**Goal:** no misleading guarantee, silent data loss, or accidental open-ended spend.

1. Pause new agent/provider breadth until the golden path meets its targets.
2. Resolve high production dependency advisories and keep the release audit green.
3. Reconcile local/hosted/self-hosted setup language, stale version docs, runtime support claims, and ephemeral flag comments.
4. Extend the existing runtime catalog/manifest so it is authoritative for support tier, tested version, capabilities, auth owner, and enforcement level.
5. Show runtime-specific protection; require explicit consent for full access or unattended `observe_only` execution. Remove the universal hard-floor claim where it is not true.
6. Harden guard coverage where interception exists, while documenting it as heuristic.
7. Add a configurable per-turn watchdog with process-group termination and a visible timed-out state.
8. Make event-log read/write/corruption failures visible and recoverable; never present an unreadable transcript as an empty one.
9. Move auto-provisioning out of component-mount side effects into an explicit queue policy, show cost/TTL at opt-in, confirm the first interactive billable launch, enforce teardown backstops, and disable failed-machine retention in production.
10. Replace blind provider saves and swallowed automation/terminal errors with acknowledged, actionable states.
11. Put one desktop and one mobile critical-path browser smoke test in CI.

**Exit criteria**

- Production audit passes.
- Every selectable runtime has an accurate support and protection label.
- Boundary-only unattended/full-access use cannot start without informed confirmation.
- A stuck turn reaches a terminal state and cannot pin a paid runner indefinitely.
- Persistence failures are surfaced; opening a panel is never the trigger that creates a paid resource.
- Production does not retain failed ephemeral machines by default.

### Phase 1 — first value, attention, and UI confidence (2–6 weeks)

**Goal:** a new individual developer gets a useful response in under ten minutes and can safely walk away.

1. Implement explicit **Bivy Cloud remote** and **self-hosted remote** setup paths; remote enrollment stays required because remote visibility and steerability are what Bivy adds over a bare CLI.
2. Build one resumable setup checklist shared by CLI and app: install → node online → repo → runtime/provider auth → doctor → starter task.
3. Validate credentials rather than checking only presence; route failures directly to the correct auth owner.
4. Simplify the first composer to one context line and one recommended agent/model pairing.
5. Group the agent picker into Recommended and More agents; automate release-candidate certification for the recommended set.
6. Strengthen Inbox and push behavior with document/app badges, precise deep-links, aging, and clear empty states.
7. Reorganize Settings around tasks—Models & agents, Machines, Integrations, Automation & policy, App, Account—and make search match fields and synonyms.
8. Add Playwright critical flows, mobile/dark visual checks, axe, keyboard/focus, reconnect, service-worker, and performance budgets to CI.
9. Instrument a privacy-safe activation funnel, provide a redacted diagnostics export, and observe at least five onboarding sessions in each active target cohort.
10. Eliminate React hook warnings and ratchet CI so new production warnings fail.
11. Split Settings, controller, server, store, and CSS by bounded domain as those areas are changed; consolidate design tokens and interaction primitives without a big-bang rewrite.

**Exit criteria**

- At least 70% of successful beta installs reach a useful first response within ten minutes; p50/p90 and failure stage are visible.
- Recommended runtimes have a tested version and current certification date.
- Critical desktop/mobile flows and accessibility checks gate release.
- A background approval or question is discoverable and opens at the exact item.

### Phase 2 — trustworthy, reviewable outcomes (6–12 weeks)

**Goal:** unattended work ends in an explicit result a developer can review and act on.

1. Define an outcome state machine: `PR open`, `Changes ready`, `Checks failed`, `Needs review`, `No changes`, `Agent failed`, and `Timed out`.
2. Run configured tests/lint/typecheck deterministically after the turn; never infer success from agent prose.
3. Upgrade Changes into a dependable review surface with file tree, diff modes, check results, branch/commit/PR state, and retry/fork/fix actions.
4. Make Inbox the cross-node attention and completed-unreviewed center, with duration, cost, policy, checks, and outcome summaries.
5. Add queue leases, reclaim, bounded retries, idempotent external effects, and explicit waiting/rate-limit states.
6. Add attachment limits, reference-aware GC, retention controls, disk health, and repair behavior.
7. Certify GitHub issue/comment → worktree → checks → PR as the first unattended golden path.
8. Add command palette and shortcuts only after the default path and task-first IA are clear.

**Exit criteria**

- No automation is labeled successful without an explicit artifact/check outcome.
- Stuck claims recover or alert within a defined SLO.
- A reviewer can understand changes, checks, cost, and policy without reading the transcript.
- Durable stores have documented and enforced bounds.

### Phase 3 — safe unattended execution and recovery (3–5 months)

**Goal:** cloud and long-running work are predictable in cost, isolation, teardown, and recovery.

1. Productize execution profiles: trusted workstation, isolated local, ephemeral isolated runner, and explicit full access.
2. Live-certify one suspend-to-zero provider and one raw-VM provider before adding more substrates.
3. Measure and enforce provisioning, boot, watchdog, teardown, leak, wake, snapshot, and restore SLOs; add budgets and cost visibility.
4. Add a Recovery view showing owner node, checkpoint/snapshot/replica freshness, expected loss, and safe retry/promote/rebuild actions.
5. Test credential/device revocation across cold starts and restored runners.
6. Add relay quotas, account caps, reconnect jitter/storm tests, queue load tests, and hosted operational dashboards.
7. Decide whether Bivy will own an OS sandbox or certify external isolation products; do not imply both.

**Exit criteria**

- Leaked-runner target is zero and lifecycle failures alert automatically.
- Every unattended profile has a precise, tested isolation statement.
- Restore and revocation behavior meet published internal SLOs.

### Phase 4 — team moat, demand-gated (5–9 months)

**Goal:** make private orchestration governable for small engineering teams.

1. Organizations, roles, repo/node scopes, shared ownership, and approver routing.
2. Central policy with local minimums and auditable overrides.
3. Metadata-only audit log, retention, export, and deletion controls.
4. Team Inbox, fleet view, routing, concurrency, and budgets.
5. External security assessment before enterprise security claims.
6. SSO/SCIM and a supported self-hosting tier only with committed demand.
7. Continue phone-first polish—fast one-tap approval, answer, retry, and review—without committing to native mobile until PWA evidence justifies it.

## What to defer

Until Phases 0–2 are healthy, defer:

- additional coding-agent adapters and cloud providers;
- a native mobile app;
- managed Bivy compute;
- a generalized workflow builder;
- automatic warm-standby promotion;
- broad enterprise checklist work.

These increase the support matrix faster than they improve the core customer outcome.

## Product scorecard

Review this weekly during beta:

- **Activation:** install start → node online → provider authenticated → first useful response; p50/p90 and drop-off stage.
- **Reliability:** session creation, prompt delivery, reconnect/resume, runtime/version failures, stuck claims, and surfaced persistence errors.
- **Attention:** unresolved-item notification/deep-link success and time to approval/answer.
- **Outcomes:** percentage of unattended runs with a reviewable artifact and deterministic check result.
- **Cost:** runner provision/teardown success, leaked machines, idle spend, and cost per completed outcome.
- **Trust:** usage/failure by enforcement tier, full-access confirmations, revocation success, and security-remediation age.
- **Simplicity:** decisions to first task, time to value, advanced-setting usage, and support tickets by setup concept.
- **Retention:** useful weekly runs, cross-device resumes, and day-7/day-30 repeat use.

Do not optimize for prompts, tokens, or raw run count. Optimize for **useful, reviewable work completed with the expected privacy, protection, cost, and recovery behavior**.

## Bottom line

Bivy should not become simpler by removing its depth. It should become simpler by giving that depth a clear order:

1. a truthful and certified default;
2. a short path to a working session;
3. one place for attention;
4. one clear outcome and review surface;
5. advanced orchestration only when requested.

Executing Phases 0–2 before expanding the catalog would turn Bivy's strong technical core into a product customers can quickly understand, confidently leave running, and reliably use for real work.
