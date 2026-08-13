# Revised strategy implementation plan

**Started:** 2026-08-12
**Owner:** Bivy product/engineering
**Strategy:** [`revised-product-strategy-2026-08-12.md`](revised-product-strategy-2026-08-12.md)
**Product contract:** [`product-contract.md`](product-contract.md)
**Receipt contract:** [`receipt-v1.md`](receipt-v1.md)
**Decision record:** [`product-roadmap-decisions.md`](product-roadmap-decisions.md)

## North-star outcome

```text
Install Bivy
→ use Claude Code or Codex in a real environment
→ continue from phone
→ leave work running
→ receive checked changes or a PR
→ review a clear Receipt
```

This is an assembly, reliability, and validation plan. It extends existing
Session, queue, evidence, Inbox, worktree, and Machine primitives; it does not
create parallel systems.

## How to use this checklist

- Check a box only when behavior is implemented, covered by focused tests,
  documented with truthful claims, and verified against the phase gate.
- “Present in the foundation” is not completion. Re-test it through the
  customer path before checking the delivery item.
- Add the validating PR/commit or metric dashboard in the item text when it is
  checked.
- Record material scope or trust changes in the decision record.
- Advance on gates and observed customer behavior, not dates.

## Current repository baseline (audited 2026-08-12)

Present and to be reused:

- agent-agnostic runtime catalog with Claude Code and Codex integrations;
- remote Sessions, account-free pairing, PWA, history, reconnect, and resume;
- approvals, sandbox/effect-level protection reporting, and watchdog recovery;
- durable automation queue with claims and renewable leases;
- GitHub, Linear, Slack, schedule, and webhook triggers;
- worktrees, deterministic checks, conservative outcome derivation, PR detection;
- Inbox attention aggregation and exact-item deep-link helpers;
- BYO-cloud provider adapters, snapshots, restore, teardown, and hosted Machine UI;
- bounded run evidence and early local governance audit events.

Known coherence gaps found in the same audit:

- customer UI still exposes **Work Queue**, **Nodes**, and **Outcome report**;
- Automation recent activity and queue reports are separate Run projections;
- the in-Session run sheet is useful but is not a complete Receipt v1;
- hosted run evidence and node audit events are not fully correlated;
- product metrics include enrollment and `run_started`, but not the complete
  activation, remote-intervention, and explicit-outcome funnels;
- isolated-provider code exists, but a provider is not yet certified by a
  sustained live lifecycle test.

## Phase 0 — Freeze the product contract

**Goal:** one model drives CLI, PWA, documentation, and future APIs.

- [x] Commit the revised strategy and north-star outcome.
- [x] Define canonical Session / Run / Automation / Machine / Inbox / Receipt vocabulary and relationships.
- [x] Define trusted-workstation, isolated customer-cloud, and restricted execution profiles.
- [x] Define E2E relay-blind, hosted-custody, trusted-inbound-plaintext, and customer/device-held-key trust modes.
- [x] Define Receipt v1 fields, redaction boundary, evidence classes, gaps, and integrity language.
- [x] Record breadth freezes and explicit non-priorities in strategy/product contract.
- [ ] Audit every customer-facing PWA string and flow against the canonical model; attach screenshots and a migration list.
  **Progress:** primary Settings, Automations, queue, Machine picker, and onboarding
  surfaces now use Runs, Machines, and isolated Machine profiles; a source-level
  regression test protects the migrated labels. Screenshot/flow audit remains.
- [ ] Audit CLI help, setup output, README, docs, and API response labels against the canonical model.
- [ ] Replace primary UI terms Work Queue, Nodes, and Outcome report with Runs, Machines, and Receipt; retain legacy API/storage names only behind adapters.
  **Progress:** legacy labels are now Runs, Machines, and Run details. The final
  Receipt label remains intentionally blocked until Receipt v1 correlation is
  complete; current UI must not overclaim it.
- [ ] Add privacy-safe metrics for activation, first useful response, remote reconnect/intervention, Run acceptance/outcome, Receipt review, and failure stage.
  **Progress:** durable `succeeded`, `failed`, and `needs_attention` Run results
  are aggregate counters. The metrics contract documents unobservable gaps.
- [x] Add a CI vocabulary check for prohibited terms in new customer-facing copy with explicit diagnostics/compatibility exceptions. **Implemented in PR #535:** the required root quality job rejects newly added legacy terms in PWA, CLI, README, and docs copy, reports the exact location and canonical replacement, and requires an explicit inline compatibility exception for deliberate API/storage terminology.

**Gate:** no primary customer screen requires “work item,” “routing label,” or
“ephemeral config”; one product specification governs all clients.

## Phase 1 — Make the capability hook effortless

**Goal:** a developer experiences a useful agent response in the real repository
within ten minutes.

- [ ] Turn setup into one resumable sequence: install → repository → recommended agent → auth validation → remote reach → starter task.
- [ ] Certify Claude Code and Codex versions and move all other agents behind More agents.
- [ ] Preselect the only sensible Machine, agent, model, and protection profile.
- [ ] Present Machine online, agent installed, credential valid, repository ready,
  and ready-to-run as distinct checks.
- [ ] Give each failed check one actionable remediation and verify that setup
  cannot report success before an agent answers.
- [ ] Harden the account-free pairing path against the same activation gate.
- [ ] Add desktop and mobile Playwright coverage for fresh setup and every
  readiness failure class.
- [ ] Instrument install-to-first-response p50/p90 and stage conversion without content or stable user labels.

**Gate:** median useful first response <10 minutes; ≥70% of successful installs
complete the first task; no false-positive readiness.

## Phase 2 — Make remote Sessions excellent

**Goal:** leaving the desk does not interrupt or confuse live work.

- [ ] Run a fault-injection matrix for prompt delivery, reconnect, dedupe,
  background execution, resume, and multi-client handoff on Claude Code/Codex.
- [ ] Verify every approval, question, Stop, and re-auth action remotely on
  desktop and mobile.
- [ ] Ensure notification links land on the exact decision and reconnect to the
  correct Session without duplicate prompts.
- [ ] Show the active execution profile, effective enforcement, and trust mode
  in Session context.
- [ ] Surface event-log persistence and audit-write degradation in the Session
  and diagnostics export.
- [ ] Productize supported native Session adoption and document fidelity limits.
- [ ] Define and measure watchdog termination/recovery SLOs.

**Gate:** correct Session resumes without duplicate prompts; all attention links
are exact; stuck turns settle within contract; work continues safely without an
open client.

## Phase 3 — Perfect one delegated Run

**Golden workflow:** manual task or GitHub issue → persistent user Machine →
Claude Code/Codex → isolated worktree → deterministic checks → checked changes
or PR → Receipt.

- [x] Create one account-level Run projection over existing automation/work-item
  records; do not create another queue. **Implemented in PR #505:** a single
  `Run` type in `@bivy/core` with `runFromQueueItem`/`runFromAutomationRun`
  adapting both legacy shapes through one derivation (reusing `deriveRunOutcome`,
  so outcome truth stays single-sourced). Missing evidence is preserved as
  unknown; a bare `succeeded` process stays Needs review. Tests prove both legacy
  shapes project identically and that Cancel/Retry appear only for the correct
  durable states.
- [x] Build a routable Run detail view with status/attempt, Session, attention,
  changes, checks, branch/commit/PR, recovery, outcome, and Receipt. **PR #505:**
  `/runs/:runId` (id parse/serialize in core, browser-restorable) backed by a
  non-leaking `GET /account/automation-runs/:id` (unknown and cross-account ids
  both 404). The `RunDetails` screen handles loading, offline, not-found,
  unauthorized, and stale explicitly, refreshes durable state after a mutation,
  and shows Receipt as **unavailable** — not overstated — until Receipt v1.
- [x] Link Run → Session and Session → Run in all clients. **PR #505, web PWA:**
  Automation activity, queue/history, and the in-session Run pill deep-link to
  the exact `/runs/:runId`; the Run screen offers "Open Session" only when the
  Session is resolvable. Expo client parity follows when that client lands.
- [x] Make “Continue in background” / “Delegate this Session” preserve context
  and explain any fidelity boundary. **Implemented in PR #522:** delegation targets
  the exact existing Session id, preserves its native context, and discloses that
  continuation stays on the owning Machine rather than implying a transcript copy.
- [x] Ensure every accepted Run reaches exactly one explicit outcome from the
  product contract; preserve ambiguous completion as Needs review. **PR #506:**
  terminal outcomes are immutable (no terminal is a valid transition source), a
  blocked terminal transition returns 409 and records no metric, and terminal
  transitions are node-scoped so a Machine reclaimed mid-execution cannot rewrite
  the new attempt. Adversarial store + server tests cover cancel/complete races,
  stale-Machine completion, and lease loss.
- [x] Complete cancellation: pending removal, active abort, evidence event,
  lease release, external-effect safety, and teardown eligibility. **Implemented
  2026-08-12:** account-scoped cancellation now atomically terminates pending,
  claimed, running, and attention Runs; clears renewable leases; retains only a
  scoped owner tombstone for immediate cancellation acknowledgement; wakes and
  aborts the active Machine runtime; suppresses later retry/fail/complete work;
  and exposes confirmed cancellation actions backed by refreshed durable state.
  Already-started third-party effects cannot be rolled back, so existing
  idempotent branch/PR/comment boundaries remain required.
- [x] Specify retry/reclaim semantics and prove PR/push/comment effects are
  idempotent. **PR #506:** `docs/automation-runs.md` now specifies outcome
  finality, attempt numbering, lease-loss fencing, cancellation precedence, and
  idempotent intake. Duplicate delivery collapses via the source key; issue/Linear
  branches are deterministic and push is naturally idempotent; pickup and outcome
  issue comments are made idempotent via a hidden marker (`commentIssueOnce`). A
  fixed `bivy_run_failure_stage_total{stage}` counter joins the outcome counter.
  Known gap documented: random-branch Slack/schedule/webhook runs.
- [x] Give every failed outcome a working next action (fix, retry, fork, review,
  re-auth, or cancel as applicable). **Implemented in PRs #521 and #524:** actions
  are derived from durable evidence; failed checks, authentication failures,
  ambiguous completion, active cancellation, and retryable terminals each lead
  to a real surface or mutation rather than an inert generic button.
- [x] Add end-to-end tests for the golden workflow on both recommended agents.
  **Implemented in PR #526:** one shared contract now certifies the real Claude
  Code and Codex adapter identities/version pins/capabilities, then carries each
  deterministic agent boundary through an isolated worktree, checks, commit,
  push, idempotent PR creation, explicit outcome, correlated audit evidence, and
  the bounded Receipt projection. Live provider calls remain an opt-in release
  exercise because CI must not hold customer model credentials.

**Gate:** 90–95% of accepted beta Runs reach an explicit outcome; process exit
alone never means success; users understand results without transcripts; every
failure has a next action.

## Phase 4 — Ship Receipt v1

**Goal:** useful individual governance, without premature audit claims.

- [x] Implement the allowlisted, bounded Receipt v1 schema independently of
  legacy queue transport fields. **Progress:** a core-only allowlisted projection
  and sanitized JSON exporter now reject prohibited/oversized fields. Every
  current projection remains partial because approval decisions, bounded
  file/change summaries, and complete check/audit evidence are not correlated.
- [ ] Correlate local node audit events with Run, Session, attempt, and Machine.
- [ ] Aggregate execution identity, requested/effective protection, approvals,
  observed decisions, checks, changes, artifacts, retries, duration, and outcome.
- [ ] Mark every control/signal enforced, observed, or unavailable.
- [x] Mark Receipts partial and visibly warn when audit storage is missing,
  corrupt, unwritable, or cannot be correlated.
- [x] Keep prompts, transcripts, reasoning, diffs, files, check output, raw tool
  payloads, and secrets out of hosted metadata.
- [x] Add PWA Receipt view and sanitized JSON export. **Implemented in PR #519.**
- [x] Add adversarial sanitizer, bounds, cross-account, and observation-gap tests.
  **Implemented across PRs #519/#520 and the authoritative-evidence follow-up:**
  prohibited nested keys fail closed, values/lists are bounded, Run reads are
  account-scoped, and missing/corrupt evidence remains an explicit limitation.
- [x] Remove “attestation” claims until the future signed-evidence gate is met.
  Receipt v1 is explicitly an observation report, not an attestation.

**Gate:** a developer can answer what ran, what Bivy allowed, what it could not
observe, what changed, and whether checks passed from the Receipt alone.

## Phase 5 — Productionize one isolated runner

**Goal:** one trustworthy customer-cloud alternative to the workstation path.

- [ ] Select one raw-VM provider only after measured live reliability tests.
  **Evidence:** adapters and a credential-gated smoke exist, but no comparative
  live results or selection are recorded.
- [ ] Publish one versioned certified image with Bivy, Git, Claude Code/Codex,
  readiness probes, and no embedded credentials. **Evidence:** the GHCR image
  workflow is versioned; certification and provider-live readiness remain open.
- [ ] Define authoritative Machine states and preserve unresolved records.
  **Evidence:** hosted inventory now shows durable lifecycle phases, cost/TTL,
  teardown failure, reconciliation, and missing-credential retention; these are
  not yet provider-confirmed live/absent/unresolved states.
- [ ] Before claim, validate agent/version, model credential, repository access,
  and required protection. **Evidence:** online/routing checks and short-lived
  hosted GitHub App credentials exist, not the complete readiness contract.
- [ ] Expose TTL, available cost estimate, provider, image, and hosted credential
  custody before launch. **Evidence:** lifecycle inventory shows TTL and
  estimated accrued/max cost, and credential controls exist; image/custody
  disclosure is not complete across launch paths.
- [ ] Make delete failure retain a visible unresolved Machine with emergency
  teardown and credential-required recovery. **Evidence:** records now survive
  destroy failure and missing credentials; explicit unresolved recovery UX and
  live retry proof remain open.
- [ ] Run provision → ready → execute → snapshot → restore → destroy continuously
  with live credentials and alert on unresolved resources. **Evidence:** the
  manual smoke stops at execute/destroy and has no continuous result record.
- [ ] Publish measured cold-start/teardown percentiles and leaked-resource count.
  **Evidence:** no sustained measurements are published.

Ready capacity remains experimental and is not a Phase 5 milestone: it conflicts
with the warm-pool non-priority until measured latency demand justifies idle
capacity. See the [2026-08-12 audit](ephemeral-strategy-audit-2026-08-12.md).

**Gate:** every Machine is confirmed live, confirmed absent, or visibly
unresolved; zero silently forgotten or leaked resources through the sustained
live-test period.

## Phase 6 — Validate and monetize the individual product

- [ ] Recruit 10–20 target power developers; recruit the first five before Phase 1 completes.
- [ ] Observe onboarding and real weekly Session/Run use with consent.
- [ ] Test free/open local foundation versus paid remote continuity,
  Automations, notifications, recovery, and multi-Machine coordination.
- [ ] Keep compute directly billed by infrastructure providers.
- [ ] Interview retained and churned participants.
- [ ] Test whether Receipt review changes willingness to delegate risky work.
- [ ] Measure repeat weekly use, unattended work, successful remote intervention,
  task-to-PR completion, willingness to pay, and disappearance pain—not prompt/token volume.

**Gate:** repeated individual use and willingness to pay for reach, unattended
outcomes, and trust.

## Phase 7 — Team expansion only after pull

Do not start until several active individual users request shared governance and
will pay for it.

- [ ] Organizations, roles, and shared Machine/repository ownership.
- [ ] Central policy with local minimums and approver routing.
- [ ] Team Inbox, budgets, concurrency, and fleet status.
- [ ] Evidence retention/deletion controls.
- [ ] Hash-chained signed Receipts, verification, attestations, and audit export.
- [ ] SSO/SCIM only with committed demand.

## Cross-phase scorecard

| Funnel | Primary measures |
| --- | --- |
| Capability | install → ready → first task → useful first response; p50/p90 and failure stage |
| Remote trust | reconnect success, duplicate-prompt rate, exact attention deep-link rate, remote intervention success |
| Unattended outcome | accepted Runs reaching explicit outcomes, task-to-PR, check pass/fail, cancellation/recovery SLO |
| Receipt | complete/partial rate, missing evidence by runtime, Receipt opens/exports, delegation confidence |
| Machines | readiness failures, cold-start/teardown p50/p90, unresolved/leaked resources |
| Validation | weekly active Session/Run users, unattended use, retention, willingness to pay |

All hosted metrics are aggregate and low-cardinality. They contain no prompt,
transcript, diff, file content, secret, email, account id, Session id, or Run id.

## Next execution slice

1. PWA vocabulary/surface audit with screenshots.
2. Activation and task-to-outcome metric contract.
3. Highest-friction setup and remote failure fixes, selected from observed data.
4. Unified Run projection and detail route over existing records.
5. First five target-developer recruitment in parallel.
6. Provider selection only after persistent-Machine Runs meet their gate.
