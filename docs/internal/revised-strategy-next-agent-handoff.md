# Revised strategy — next-agent implementation handoff

**Prepared:** 2026-08-12  
**Baseline:** `main` at or after `74a9658` (`feat(run): implement end-to-end cancellation (#501)`)  
**Governing documents:**

- [`revised-product-strategy-2026-08-12.md`](revised-product-strategy-2026-08-12.md)
- [`revised-strategy-implementation-plan.md`](revised-strategy-implementation-plan.md)
- [`product-contract.md`](product-contract.md)
- [`receipt-v1.md`](receipt-v1.md)
- [`product-metrics-contract.md`](product-metrics-contract.md)

## Mission

Advance the north-star path without creating parallel product models:

```text
Install Bivy
→ use Claude Code or Codex in a real environment
→ continue from phone
→ leave work running
→ receive checked changes or a PR
→ review a clear Receipt
```

The next engineering priority is one coherent, routable **Run** experience over
the existing automation/work-item records, followed by evidence correlation for
Receipt v1. Setup, remote-reliability validation, metrics, and user recruitment
can proceed in parallel when independent.

## Non-negotiable constraints

1. Customer vocabulary is **Session, Run, Automation, Machine, Inbox, Receipt**.
   Keep `work item`, `node`, routing labels, claims, and leases behind
   compatibility/diagnostic boundaries.
2. Do not label current Run details a Receipt until Receipt v1 correlation and
   completeness handling meet the contract.
3. Process exit alone never proves success. Ambiguous completion is **Needs
   review**.
4. Reuse `work_items`/automation Runs, Session records, Inbox primitives, audit
   events, and Machine records. Do not add another queue or customer-visible job
   model.
5. Hosted metadata must not contain prompts, transcripts, reasoning, diffs, file
   contents, check output, raw tool payloads, secrets, account ids in metrics, or
   other prohibited Receipt fields.
6. Every protection or governance signal is explicitly `enforced`, `observed`,
   or `unavailable`. Do not claim attestation.
7. Keep legacy API/storage identifiers compatible unless a migration is included
   and tested.
8. Use focused local tests, then push each bounded commit and treat PR CI as the
   authoritative full validation.
9. Update the main implementation checklist truthfully after each accepted
   slice. “Projection exists” is not equivalent to passing a customer-path gate.
10. Do not fabricate provider measurements, customer research, or live-agent
    certification. Record those items as blocked until real evidence exists.

## Current state to preserve

- PR #501 added account-scoped cancellation for pending, claimed, running, and
  attention Runs; active runtime abort; lease release; bounded evidence; targeted
  Machine wake-up; cancellation metrics; and confirmed PWA controls.
- `packages/web/src/runDetail.ts` already conservatively projects outcome,
  checks, artifacts, and available recovery actions.
- `AccountAutomationRun` and `GithubQueueItem` still expose overlapping Run
  projections in `packages/core/src/account.ts`.
- Automation recent activity and queue Run details both use the shared web
  projection, but there is no canonical account Run resource or routable detail
  screen.
- `packages/core/src/receipt-v1.ts` is an allowlisted partial projection. It must
  stay partial while approvals, bounded changes, and node-audit health are not
  correlated.
- Local node audit events exist in `src/audit/index.ts` and are emitted in
  `src/server.ts`; they are not yet safely correlated into hosted Run evidence.
- Provider certification and customer validation require external evidence and
  are not code-only completion items.

## Delivery sequence

Implement the work as separate reviewable PRs. Do not combine all phases into a
single branch.

### PR A — Canonical account Run projection and route

**Goal:** one source of truth and one deep-linkable Run details experience.

#### A1. Define the canonical projection

- Add a canonical account-facing Run type in `packages/core`; adapt both
  `AccountAutomationRun` and legacy `GithubQueueItem` at compatibility edges.
- Include only existing bounded fields: id, lifecycle, explicit outcome,
  attempt, source reference, Automation id, Session id, Machine id/name when
  known, routing explanation, timestamps/duration, checks, bounded events,
  branch/commit/PR/checkpoint/artifact references, failure summary, and
  cancellation availability.
- Put conservative outcome derivation in core, not duplicated React components.
- Preserve unknown/missing evidence instead of manufacturing successful values.
- Either make `/account/automation-runs` the canonical endpoint or introduce an
  account Run endpoint backed by the same `work_items` table. Do not maintain two
  independent query implementations.
- Keep `/account/work-items` as a compatibility adapter while old clients need it.

#### A2. Add exact routing

- Extend `packages/web/src/router.ts` and route helpers with a stable route such
  as `/runs/:runId`.
- Add a Run details screen that renders lifecycle/attempt, linked Session,
  Machine, attention, checks, bounded changes/references, recovery actions,
  outcome, cancellation, and a clearly labelled **Receipt unavailable/partial**
  section.
- Make Automation activity, queue/history, Inbox items, and notifications link
  to this exact Run route.
- Loading, not-found, unauthorized, offline, and stale-record states must be
  explicit. Never silently fall back to a generic Automations screen.
- Refresh after mutations; do not optimistically invent terminal state.

#### A3. Link Run and Session

- Persist/expose Run → Session correlation from node evidence.
- Show “Open Session” from a Run only when the referenced Session is resolvable.
- Add Session → Run navigation wherever the Session has a correlated Run.
- Define retry behavior: a Run can have multiple attempts but remains one
  customer-visible Run. Do not create a new Run merely to represent a retry.

#### A4. Tests and acceptance

Add focused tests for:

- both legacy shapes adapting to the same canonical projection;
- process exit/empty evidence producing Needs review, never success;
- exact `/runs/:id` parse/serialize and browser deep-link restoration;
- Automation, queue, Inbox, and Session links targeting the same Run id;
- missing/cross-account Run returning a non-leaking 404;
- cancellation visible only while the durable Run is cancellable;
- no prohibited vocabulary in the new customer surface.

**Acceptance:** a user can copy a Run URL, open it on another device, understand
progress/outcome without opening a transcript, and navigate to the exact Session
when available. Both old feeds produce the same result for the same stored row.

### PR B — Explicit outcome and recovery contract

**Goal:** every accepted Run eventually has one defensible outcome and every
failure has a next action.

- Audit every transition, reclaim, watchdog, required-check, no-change, and
  teardown path against the product outcomes in `product-contract.md`.
- Add invariants preventing two terminal outcomes or a terminal outcome from
  being rewritten (except compatibility normalization at read time).
- Specify retry/reclaim semantics in `docs/automation-runs.md`: attempt numbers,
  lease loss, idempotency keys, and ownership of branch/push/PR/comment effects.
- Prove existing branch and PR discovery is idempotent across reclaim. Add
  adversarial tests for duplicate delivery, cancellation races, stale node
  completion, and retry after an external effect.
- Map each failed/attention condition to a working action: retry, fix setup,
  re-authenticate, review, fork, or cancel. Do not show inert buttons.
- Add aggregate accepted-Run and terminal-outcome/failure-stage instrumentation
  only with fixed low-cardinality enums.

**Acceptance:** terminal state is immutable and exactly-once; stale workers
cannot overwrite cancellation; duplicate/reclaimed attempts do not duplicate a
PR or issue comment; every displayed failure action reaches the promised flow.

### PR C — Receipt evidence correlation and partial Receipt UI

**Goal:** produce a truthful Receipt v1 projection without broadening hosted
content collection.

#### C1. Correlation envelope

- Define a versioned, allowlisted node evidence envelope carrying Run id,
  Session id, attempt, Machine id, event category, timestamp, evidence class,
  and bounded metadata.
- Authenticate evidence with the claiming Machine and account. Reject
  cross-account, non-owner, stale-attempt, unknown-field, and oversized writes.
- Add deterministic event ids/idempotency so reconnect/retry cannot duplicate
  approval or change evidence.
- Keep raw audit JSONL local. Upload only explicitly allowed projections.

#### C2. Required evidence

Correlate these bounded categories:

- execution identity: Machine, agent/runtime/version availability, model;
- requested and effective profile/sandbox/approval mode and trust modes;
- approval request/decision category, actor category, time, and evidence class;
- changed-file count and policy-permitted bounded paths or hashes; explicit
  no-change evidence;
- checks and references already carried by Run evidence;
- audit health: correlation, readable storage, and successful writes;
- missing-evidence categories and runtime observation limitations.

Never upload command arguments, prompts, transcripts, diffs, contents, outputs,
headers, tool payloads, or secrets.

#### C3. Receipt projection and UI

- Extend `packages/core/src/receipt-v1.ts` only through allowlisted bounded types.
- Completeness must be computed from required evidence, never asserted by the
  node or UI.
- Add a Receipt section/view to the Run route. Call it **partial Receipt** while
  any required category or audit-health signal is missing.
- Export exactly the sanitized Receipt object as JSON, not an enclosing Run or
  cached UI model.
- Render `enforced`, `observed`, and `unavailable` distinctly, plus visible
  warnings for missing/corrupt/unwritable/un-correlatable audit evidence.

#### C4. Tests and acceptance

Add adversarial tests for prohibited keys, bounds, duplicate event ids,
cross-account writes, stale attempts, missing audit writes, differing requested
and effective protection, exact approval links, and sanitized export.

**Acceptance:** from the Receipt alone a user can answer what ran, where, what
Bivy enforced or merely observed, what changed at the bounded-summary level,
which checks passed, and what evidence is missing. No attestation claim appears.

### PR D — Setup and vocabulary customer-path audit

This can run in parallel with PR A when a separate agent/worktree owns it.

- Capture desktop and mobile screenshots for primary onboarding, Settings,
  Sessions, Automations/Runs, Machines, Inbox, and Run details.
- Add a migration list of every remaining primary use of Work Queue, Nodes,
  Outcome report, routing label, or ephemeral config.
- Audit CLI help/setup output, README, docs, and public response labels.
- Add a CI vocabulary test with narrow explicit exceptions for storage/API
  compatibility, migration copy, and diagnostics.
- Do not replace Run details with Receipt until PR C meets its acceptance gate.

**Acceptance:** no primary customer path requires internal queue/provider terms;
the audit contains reproducible screenshots and explicit remaining exceptions.

### PR E — Activation and remote reliability

Start after or alongside PR A based on capacity, but keep behavior and metrics
commits separable.

- Turn setup into one resumable sequence with distinct Machine-online,
  agent-installed, credential-valid, repository-ready, remote-reachable, and
  agent-answered checks.
- Certify actual Claude Code and Codex versions; place other agents behind More
  agents without deleting compatibility.
- Ensure each failed readiness check has one tested remediation and setup cannot
  report success before a real agent response.
- Run the remote fault matrix for delivery, reconnect, dedupe, background work,
  resume, Stop, approvals/questions, re-auth, exact Inbox links, and multi-client
  handoff on desktop/mobile.
- Show active execution profile, effective enforcement, trust mode, and audit
  degradation in Session context.
- Add aggregate activation, first-response, reconnect/intervention, and failure
  stage metrics with fixed enums and no stable customer identifiers.

**Acceptance:** complete the Phase 1 and Phase 2 gates with measured evidence;
do not check those boxes from component/unit coverage alone.

## Parallel work allocation

When sub-agents are available, use non-overlapping worktrees:

1. **Run model/API agent:** core types, control-plane projection, adapters, store
   contract, cross-account tests.
2. **Run route/PWA agent:** router, Run page, exact links, browser tests. It codes
   against an agreed core interface and integrates after agent 1.
3. **Outcome/idempotency agent:** transition audit and adversarial reclaim tests;
   avoid editing the new route.
4. **Vocabulary/setup audit agent:** screenshots, source audit, CI vocabulary
   check; avoid Run model files.
5. **Receipt research agent:** map audit emitters to the Receipt allowlist and
   propose the envelope before changing persistence.

Do not run agents concurrently on `src/server.ts`, `packages/core/src/account.ts`,
or `services/control-plane/src/postgres-store.ts` without assigning exclusive
ownership or sequencing their commits.

## Validation and commit protocol

For each bounded slice:

1. Rebase/merge current `main` before implementation and inspect recent Session,
   Run, and Machine changes for overlap.
2. Add the smallest focused tests first or alongside implementation.
3. Run relevant local tests (`git diff --check` at minimum); avoid blocking all
   work on unavailable local dependencies.
4. Commit one coherent behavior with a conventional message.
5. Push immediately to a draft PR and summarize truthfully in a PR comment.
6. Use full CI as authoritative validation; fix failures before starting the next
   dependent slice.
7. Update `revised-strategy-implementation-plan.md` with commit/PR evidence only
   when acceptance behavior exists.
8. Mark ready only when the PR is coherent, green, and its claims match observed
   behavior.

## External/blocking work

The implementation agent must surface, not conceal, these blockers:

- Recruit the first five target developers and gather consented observations.
- Measure useful first response, weekly retention, remote intervention, and
  willingness to pay from real use.
- Select an isolated provider only after comparative live tests.
- Run sustained provision → ready → execute → snapshot → restore → destroy with
  real credentials and publish cold-start/teardown/leak evidence.
- Defer team roles, shared governance, signed Receipts, SSO/SCIM, warm pools, and
  additional providers until the strategy's demand gates are met.

## Definition of the next checkpoint

The next checkpoint is reached when PRs A and B are merged and green:

- one canonical account Run projection;
- one exact Run URL used by Automation, queue/history, Inbox, and Session links;
- one immutable explicit outcome per accepted Run;
- cancellation and recovery actions backed by durable transitions;
- retry/reclaim external effects covered by adversarial idempotency tests;
- current evidence shown as Run details, with Receipt visibly partial or
  unavailable rather than overstated.

After that checkpoint, Receipt correlation (PR C) becomes the primary engineering
critical path while setup/remote validation and customer recruitment continue in
parallel.
