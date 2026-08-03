# Product roadmap implementation plan — Phases 0–2

**Started:** 2026-08-03
**Owner:** Bivy product/engineering
**Strategy source:** [`product-review-synthesis-2026-08-03.md`](product-review-synthesis-2026-08-03.md)
**Decision record:** [`product-roadmap-decisions.md`](product-roadmap-decisions.md)

## Objective

Make Bivy's existing power trustworthy, quickly reachable, and reviewable before expanding the agent/provider matrix. This plan is the execution checklist for Phases 0–2 of the unified roadmap.

The source reviews are snapshots, not an authoritative defect list. Every work item is re-checked against current `main` before implementation; already-landed behavior is tested or refined rather than rebuilt.

## Delivery rules

1. Safety, persistence, and cost containment precede growth or polish.
2. Extend existing capability, inbox, evidence, and manifest models; do not create parallel systems.
3. Every behavior change ships with focused tests and user-facing documentation where applicable.
4. Claims describe tested behavior, not intended architecture.
5. No billable resource is created merely because a UI panel rendered.
6. No unattended run is called successful solely because an agent process ended.
7. Large modules are split only along bounded domains touched by this work; no big-bang rewrite.
8. Decisions with material product or compatibility trade-offs are appended to the decision record.

## Workstream A — Phase 0: product truth and stop-loss controls

### A1. Release integrity

- [x] Resolve all high-severity production dependency advisories or record a time-bounded, exploitability-reviewed exception.
- [x] Keep `npm audit --omit=dev --audit-level=high` in CI.
- [x] Disable failed ephemeral-machine retention in production; make diagnostics an explicit build/env opt-in.
- [x] Reconcile ephemeral feature comments, runtime maturity, local-mode, and safety documentation with behavior.

### A2. Runtime truth and safe defaults

- [ ] Extend the existing runtime catalog/manifest with an authoritative enforcement summary and tested-version/certification fields.
- [x] Group the picker into Recommended and More agents instead of one equal alphabetical list.
- [x] Surface support tier and protection in customer language.
- [x] Require informed confirmation for unattended/full-access execution where Bivy lacks a native or external isolation boundary.
- [x] Harden catastrophic-command accident prevention while explicitly documenting its heuristic limits.

### A3. Bounded execution and durable failure

- [x] Add a configurable per-turn watchdog for interactive and automation turns.
- [x] Abort the runtime/process group on timeout and emit a durable, visible timed-out outcome.
- [x] Ensure a timed-out turn releases ephemeral teardown and queue ownership.
- [x] Distinguish missing event logs from unreadable/corrupt logs.
- [x] Surface event-log write failures, retain pending records for retry, and expose health in diagnostics.

### A4. Explicit cost and acknowledged mutations

- [ ] Move queue auto-provisioning out of component-mount effects into the queue/control-plane policy path.
- [ ] Show provider, region, rate hint, TTL, and teardown policy when enabling/launching billable runners.
- [ ] Require confirmation for the first interactive billable launch.
- [x] Await and display provider/API-key save acknowledgements in every entry point.
- [ ] Remove swallowed errors from high-value automation and terminal actions.

### A5. Minimum browser release gate

- [x] Run browser tests in CI.
- [x] Cover one desktop and one mobile critical path, including reconnect and attention navigation.
- [ ] Add an accessibility smoke gate for the app shell and modal focus behavior.

## Workstream B — Phase 1: first value, attention, and UI confidence

### B1. One golden onboarding path

- [x] Offer explicit Local CLI, Bivy Cloud remote, and self-hosted remote modes.
- [x] Never require an account for Local CLI mode.
- [ ] Make setup resumable and report a checklist of node, runtime, credential, repo, and first-task readiness.
- [ ] Validate model access rather than credential presence alone where a safe provider probe exists.
- [ ] Do not print setup success as equivalent to agent readiness.
- [ ] Provide a low-risk starter task and direct remediation for each failed stage.

### B2. Progressive disclosure

- [ ] Reduce first-session context to machine, repo, agent/model, and protection.
- [ ] Hide filters and advanced catalog entries until they are useful.
- [ ] Reorganize Settings around Models & agents, Machines, Integrations, Automation & policy, App, and Account.
- [ ] Make Settings search include field names and common synonyms.

### B3. Attention loop

- [x] Preserve the existing global Inbox as the single attention aggregator.
- [x] Add document-title and installed-app badge counts.
- [ ] Verify push and Inbox deep-links focus the exact approval/question/outcome.
- [ ] Add clear Needs approval, Needs answer, Failed, and Completed—unreviewed categories.
- [ ] Keep attention metadata content-free across the hosted boundary.

### B4. UI quality and diagnostics

- [ ] Add critical Playwright flows at desktop/mobile widths to CI.
- [ ] Add axe, keyboard/focus, light/dark visual, service-worker update, and reconnect tests.
- [ ] Add long-transcript and initial-bundle budgets.
- [ ] Eliminate React hook warnings and fail CI on new production warnings.
- [ ] Add a redacted diagnostics export and privacy-safe activation stage/failure instrumentation.

## Workstream C — Phase 2: trustworthy, reviewable outcomes

### C1. Outcome contract

- [ ] Define one shared outcome vocabulary: changes ready, PR open, checks failed, needs review, no changes, agent failed, timed out, cancelled.
- [ ] Fold existing queue evidence and session checkpoint/PR state into that vocabulary.
- [ ] Never map `agent_end` alone to success.
- [ ] Show duration, cost, policy/enforcement, checks, artifact, and retry path.

### C2. Deterministic checks

- [ ] Allow automations to declare bounded required checks.
- [ ] Run checks after the turn under explicit timeout/output limits.
- [ ] Store only privacy-safe check metadata in hosted evidence.
- [ ] Mark checks failed independently of agent prose and offer retry/fix/fork actions.

### C3. Review surface

- [ ] Promote the existing checkpoint diff into a changed-file tree with unified/side-by-side modes.
- [ ] Distinguish working-tree, checkpoint, branch, commit, and PR state.
- [ ] Place check results beside changes.
- [ ] Add safe per-file revert and “ask agent about this” where the underlying checkpoint supports it.

### C4. Reliable automation ownership

- [ ] Add queue claim leases/heartbeats, expiry, and safe reclaim.
- [ ] Make external effects idempotent across retry/reclaim.
- [ ] Represent waiting/rate-limited work separately from running work.
- [ ] Certify GitHub issue/comment → worktree → checks → PR as the first unattended golden path.

### C5. Bounded durable storage

- [ ] Enforce per-file, per-request, and global attachment limits on client and node.
- [ ] Add reference-aware attachment garbage collection and a retention policy.
- [ ] Expose attachment/transcript disk usage and cleanup in doctor/settings.
- [ ] Use atomic blob/sidecar writes and repair partial state at startup.

## Cross-phase acceptance metrics

- Activation: successful install to useful first response, p50/p90 and failure stage.
- Reliability: session creation, prompt delivery, reconnect/resume, timeout, and persistence-error rates.
- Attention: unresolved-item notification and exact deep-link success.
- Outcomes: unattended runs with explicit artifact and deterministic check status.
- Cost: provision/teardown success, idle spend, and leaked runner count (target: zero).
- Trust: runs and failures by enforcement tier; security remediation age.
- Simplicity: visible decisions to first task (target: at most four).

## Completion definition

Phases 0–2 are complete when all applicable boxes above are checked, tests and docs pass, and any intentionally deferred item has a named reason, owner, acceptance condition, and review date in the decision record. “Code exists” is not completion without an understandable product state and a regression test.
