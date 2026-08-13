# Automation runs

Bivy has one durable execution queue. GitHub labels and mentions, Slack commands,
manual dispatch, and future webhook or schedule triggers all create an automation
run; they do not create separate provider-specific queues.

The domain separates four records:

- An **automation definition** is an optional reusable, end-to-end encrypted
  template plus plaintext execution defaults. The control plane cannot inspect
  its instructions.
- A **trigger event** records how a run was requested and its idempotency/source
  key. GitHub delivery IDs and equivalent source keys remain unique per account.
- An **automation run** is the durable lifecycle and routing record. Its states
  are `pending`, `claimed`, `running`, `waiting`, `needs_attention`, `succeeded`,
  `failed`, and `cancelled`. `waiting` marks a run that is blocked on an external
  limit (provider rate-limit, queue backpressure) rather than actively consuming
  compute, so it reads separately from `running`. A conditional claim provides
  one winner when nodes race. The
  winner renews a finite lease every 30 seconds; if it crashes, the control plane
  makes the item reclaimable after the two-minute lease expires.
- An **attempt** is represented explicitly on the run and starts at one. A run's
  evidence timeline (below) can record a `retry`/`fallback` event with a bounded
  reason and an incremented attempt number.

A one-off Run can be started directly with **New Run** in the app or
`bivy runs start "<instructions>"`; it does not require or save an Automation
definition. Instructions are encrypted for the selected Machine before upload.
Operators and other agents can probe lifecycle metadata with `bivy runs list`,
`bivy runs status <id>`, or block on a handoff with `bivy runs wait <id>`. These
surfaces expose bounded status/evidence/output references, not instructions or
transcripts.

Each run targets a new session. Routing intent carries the
node label, runtime, model, ephemeral preference, sandbox tier, and approval
mode (`never` / `risky` / `always` / `autonomous`, the same vocabulary as
`BIVY_APPROVAL_MODE` — see [security-model.md](security-model.md)). The claiming node applies
runtime, model, and sandbox when it creates the run's session, and applies
approval mode for the lifetime of that session; an unset value on the
definition falls back to the node's own configured default. Output is limited
to references such as session, branch, pull request, artifact, or a failure
summary. Account APIs expose definitions, trigger history, and run history
separately; the older work-item API reads from the same run records.

## Outcome finality, retry, and reclaim

Every accepted run reaches **exactly one** durable terminal outcome —
`succeeded`, `failed`, or `cancelled` — and that outcome is **immutable**. The
lifecycle state machine only allows a terminal state to be entered from a
non-terminal one, so no later or losing Machine can rewrite a finished run. The
client derives the finer customer outcome (`PR open`, `Checks failed`, `Needs
review`, …) from evidence; the durable terminal state underneath it never flips.

**Attempts.** `attempt` starts at 1. The first claim of a `pending` run keeps
attempt 1. A **reclaim** of an expired lease increments it. Every attempt belongs
to the **same customer-visible run** — a retry is not a second run.

**Leases and reclaim.** The winning Machine renews a finite lease (default two
minutes, `BIVY_WORK_LEASE_MS`) roughly every 30 seconds. If it stops renewing
(crash, network loss, teardown), the run becomes reclaimable once the lease
expires and another eligible node claims it as the next attempt. The Machine that
lost the lease is **fenced**: because ownership is checked on every node call and
terminal transitions are additionally scoped to the current claimant, a stale
Machine's heartbeat, `running`, `complete`, `fail`, `needs-attention`, and
evidence writes are all rejected (`409`) once it is no longer the claimant. It
therefore cannot complete, fail, or otherwise overwrite the new attempt.

**Cancellation precedence.** Cancellation is itself a terminal outcome that
clears the renewable lease. A completion or failure racing behind a cancellation
is a no-op — it never un-cancels the run — and, because it did not durably
transition anything, it records **no** lifecycle-result metric. Only real,
persisted transitions are counted, so a blocked completion cannot inflate the
`succeeded` outcome counter.

**Idempotent intake.** Duplicate trigger delivery (a redelivered webhook, a
repeated manual dispatch) collapses to a single run via the per-account
source/dedupe key: re-enqueuing the same key returns the existing run rather than
creating a second one. Hosted free-tier usage is likewise recorded once per run
key, so reconnects and reclaims never inflate the run count.

**Idempotent external effects.** A retry or reclaim of the same issue run must
not duplicate what a reader sees on GitHub:

- **Branches** for GitHub-issue and Linear runs are deterministic
  (`bivy/issue-<n>`, `bivy/linear-<slug>`), and a push of `branch:branch` is
  naturally idempotent, so re-running produces the same branch, not a second one.
- **Issue comments** — the pickup note and each outcome note (PR ready / no
  changes / pushed-without-PR) carry a hidden marker and are posted **at most
  once per `(issue, key)`**. The pickup comment is keyed per issue; outcome
  comments are keyed by their artifact (PR URL, branch) so a genuinely new
  artifact still comments while a reclaim on a fresh process does not repeat one.
- **Pull requests** are opened by the agent, then adopted by branch; a run whose
  issue branch already produced a merged PR is skipped rather than re-run.

Known limitation: Slack/schedule/generic-webhook repo runs still use a random
branch name per run, so their branch/PR effects are not yet idempotent across a
reclaim on a fresh process. That path is tracked separately.

**Metrics.** Outcomes are counted with fixed, low-cardinality labels only:
`bivy_run_lifecycle_results_total{outcome}` (succeeded / failed / needs_attention
/ cancelled) records one result per durable transition, and
`bivy_run_failure_stage_total{stage}` classifies where a failed or parked run
stopped short (`checks` / `timeout` / `agent` / `needs_review`), derived from the
run's own evidence. Neither carries a run, session, account, or user identifier.

## Observable lifecycle and outcome reports

A Run keeps one causal, append-only milestone timeline. The vocabulary covers
`trigger_received`, `trigger_matched`, `queued`, `routed`, `provisioning`,
`claimed`, `agent_started`, `checks_started`, `checks_completed`,
`result_delivery`, `notification`, `retry`, `cancel_requested`, and exactly one
`terminal` outcome. A stage is recorded only when the system observes it; old
rows may therefore have gaps rather than invented timestamps. Each milestone is
bounded, attempt-aware, and may carry only an allowlisted reason or evidence
reference. Repeated reports with the same milestone id are idempotent.

Active Run changes are pushed as content-free `run.updated` hints over the
existing relay connection to every connected client on the account. A hint
contains the Run id and revision, not instructions or evidence. The client then
fetches the canonical account-scoped record. Periodic and reconnect polling
remain as recovery when a hint is dropped or a client version does not support
it.

Operational state is explicit: **parked** means a nonterminal Run is waiting for
an operator or an external dependency; **dead-letter** means it terminated
without an automatic retry remaining. Both can be filtered independently from
the ordinary active/history feed. Attention severity and the canonical Run
projection determine the next valid operator action; clients do not manufacture
a retry, cancel, or review action from presentation state.

Every run also carries a small, structured **evidence** record — the piece a
PR alone can't show: what triggered the job, where it ran, which agent/model
and why, what checks passed, and why any retry or fallback happened. Fields are
allowlisted and bounded by `services/control-plane/src/run-evidence.ts` before
they ever reach storage:

- **`routingReason`** — a short, free-text explanation of why this node/
  runtime/model was chosen (queue label, manual override, node default,
  fallback after an error, ...).
- **`checks`** — declared validation commands and their `passed` / `failed` /
  `skipped` status plus exit code. The command text itself is never stored,
  only a name and, optionally, a hash of the command.
- **`events`** — an ordered, capped (100 entries) timeline. Every lifecycle
  transition (claimed, running, needs-attention, completed, cancelled) is
  stamped automatically by the control plane, so a run has a readable
  trigger→claim→attempt→outcome timeline even if the node never reports
  anything further. A node MAY layer richer events on top through
  `POST /node/work/:id/evidence` — routing changes, checkpoints, approvals,
  policy denials, retries/fallback (each with its own attempt number and
  reason), branch creation, and PR opened — plus `output` references
  (`checkpoint`/`commit` in addition to the existing session/branch/PR/
  artifact/failure fields).

For unattended issue work, the node also runs declared standard package scripts
(`test`, `lint`, and `typecheck` when present; configurable with
`BIVY_AUTOMATION_CHECKS`) after the agent turn. Each check has a bounded timeout.
Command text and output stay on the node; hosted evidence receives only its name,
SHA-256 command identity, status, duration, and exit code. Failed required checks fail the
run even if the agent claimed success or already opened a pull request.

The client derives one customer outcome from this evidence: `PR open`, `Changes
ready`, `Checks failed`, `Needs review`, `No changes`, `Agent failed`, `Timed
out`, or `Cancelled`. Process completion with no artifact/check/no-change evidence
becomes `Needs review`, never silent success.

The evidence endpoint requires the reporting node to be the run's current
claimant and rejects (400, not a silent drop) any field that looks like a
prompt, transcript, diff, file content, secret, token, or raw command/tool
output. The Runs UI renders this as per-Run details
timeline with a **Copy sanitized report** export — the same JSON object the
control plane stores, nothing more.

## Compatibility

Existing work-queue items continue to work unchanged: the older work-item
endpoints and fields read from the same run records, so repository and issue
context stays available to current nodes and the queue UI.

## Privacy and metering boundary

Interactive session prompts, transcripts, repository files, credentials, diffs,
and generated content stay on the node. GitHub and Linear issue text is not
retained past webhook routing: the claiming node fetches it directly from the
provider immediately before use. Slack and generic automation webhooks are the
explicit exception because those providers call the control plane directly:
Slack prompt text is stored as the run title, and a generic webhook's fixed
template plus event instruction is stored as the run body until the run is
deleted. Do not include secrets in either source. Output fields and sanitized
run evidence contain references and bounded status metadata, not generated
content.

Webhook receipt and queue browsing are not usage. Hosted free-tier usage is
recorded only when a claimed automation run enters `running`; self-hosted
deployments continue to bypass hosted entitlement enforcement.

## Workspace / repository

A run always starts the agent in a **prepared workspace**. The node clones or
updates the target GitHub repo *before* the session begins — the agent is not
responsible for choosing or cloning the project on the happy path.

| Trigger | Where the repo comes from |
|---|---|
| GitHub issue / mention | The event (`repository.full_name`) |
| Linear issue | Git link / `repo:owner/name` label / automation `repo` / node default |
| Slack `/bivy in owner/repo …` | The command |
| **Schedule** | **`definition.repo`** (set in the Automations UI) |
| Webhook automation | `definition.repo`, else optional `repo` on the event payload |

Schedule is the same kind of trigger as webhook or GitHub — it just needs an
explicit workspace because a cron tick does not name a repository. Connect the
GitHub App (or token) on the node so the clone can authenticate; picking the
repo on the automation is separate from connecting the source.

## Source automations (GitHub / Linear / CI)

Inbound intake is gated by **automation definitions**:

| `trigger` | Event | Default template |
|---|---|---|
| `github` | Issue labeled / @mention | `issue-to-pr` |
| `linear` | Linear issue labeled | `issue-to-pr` |
| `github_ci` | `workflow_run` completed failure | `fix-ci` |

1. Connecting a GitHub App **seeds** "Work issues into PRs" (enabled) and
   "Fix failed CI" (**paused** until you enable it). Linear seeds its issue
   automation the same way.
2. Inbound webhooks **match** enabled source automations by label filter and
   optional repo allowlist (CI can also filter by workflow name via `labels`).
   First match wins (oldest first).
3. **Pause** the automation → events enqueue nothing (`reason: no_automation`).
4. Mentions skip the label filter but still honour repo allowlists and enabled.
5. The Automations UI shows **live source status** (GitHub installs / node,
   Linear, Slack), a **filters editor** per source automation (labels, repo
   allowlist, default machine/agent/model), and **Open session** on recent runs.

New GitHub Apps request `workflow_run` + Actions/Checks read so CI failures can
reach the control plane. Existing apps need those events/permissions added in
GitHub settings (or re-create via the manifest flow).

Routing labels (`bivy/<node>`, `on <node>`) and the account default node still
apply after a match; the automation may also set `nodeLabel` / agent / model.

## Schedule semantics

Schedule definitions use either a one-time ISO timestamp or a standard
five-field cron expression with an explicit IANA timezone. Both are validated on
create and update. The stored `nextRunAt` is the occurrence identity: schedulers
insert a run with a unique `(account, definition, occurrence)` key and then
optimistically advance that exact timestamp. This makes restarts and concurrent
control-plane instances safe.

The catch-up policy is deliberately bounded: after downtime Bivy enqueues the
earliest missed occurrence once, then calculates the next occurrence from the
current time. It does not replay every missed interval. Disabled definitions are
excluded. One-time definitions disable themselves after enqueueing.

Cron follows IANA wall-clock rules. During spring-forward, a nonexistent local
time runs at the first corresponding valid time (for example 02:30 becomes
03:30). During fall-back, an ambiguous local time runs once at its first
instance.
