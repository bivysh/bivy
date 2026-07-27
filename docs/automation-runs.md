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
  are `pending`, `claimed`, `running`, `needs_attention`, `succeeded`, `failed`,
  and `cancelled`. A conditional `pending` to `claimed` update provides one
  winner when nodes race.
- An **attempt** is represented explicitly on the run and starts at one. Retry
  policy is intentionally outside the current model, but a run's evidence
  timeline (below) can already record a `retry`/`fallback` event with a
  bounded reason and an incremented attempt number the moment that policy
  lands, without a storage migration.

Runs initially target a new session. The schema also represents an existing
session target without enabling continuation yet. Routing intent carries the
node label, runtime, model, ephemeral preference, sandbox tier, and approval
mode (`never` / `risky` / `always` / `autonomous`, the same vocabulary as
`BIVY_APPROVAL_MODE` — see docs/security-model.md). The claiming node applies
runtime, model, and sandbox when it creates the run's session, and applies
approval mode for the lifetime of that session; an unset value on the
definition falls back to the node's own configured default. Output is limited
to references such as session, branch, pull request, artifact, or a failure
summary. Account APIs expose definitions, trigger history, and run history
separately; the legacy work-item API is a projection of the same run records.

## Run evidence and outcome reports

Every run also carries a small, structured **evidence** record — the piece a
PR alone can't show: what triggered the job, where it ran, which agent/model
and why, what checks passed, and why any retry or fallback happened. Three
fields, all allowlisted and bounded by
`services/control-plane/src/run-evidence.ts` before they ever reach storage:

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

The evidence endpoint requires the reporting node to be the run's current
claimant and rejects (400, not a silent drop) any field that looks like a
prompt, transcript, diff, file content, secret, token, or raw command/tool
output. The GitHub queue UI renders this as a per-run "Outcome reports"
timeline with a **Copy sanitized report** export — the same JSON object the
control plane stores, nothing more.

## Compatibility and migration

The existing `work_items` rows are the canonical run storage, evolved in place
rather than copied into a parallel queue. Startup migration backfills legacy
rows with a trigger identity, inferred trigger kind, attempt one, and a new
session target; legacy `done` rows become `succeeded`. Existing work-item
endpoints and fields remain adapters over these records, so repository and issue
context remains available to current nodes and the queue UI.

## Privacy and metering boundary

The control plane stores routing and source metadata, plus the sanitized
evidence above. It must not receive agent prompts, transcripts, repository
files, credentials, diffs, or generated content. GitHub issue/comment title
and body are not retained at all past webhook routing — the claiming node
fetches the live text directly from GitHub with its own token, immediately
before use. Output fields contain references, not their contents.

Webhook receipt and queue browsing are not usage. Hosted free-tier usage is
recorded only when a claimed automation run enters `running`; self-hosted
deployments continue to bypass hosted entitlement enforcement.

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
