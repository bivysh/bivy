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
  policy is intentionally outside the current model.

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

## Compatibility and migration

The existing `work_items` rows are the canonical run storage, evolved in place
rather than copied into a parallel queue. Startup migration backfills legacy
rows with a trigger identity, inferred trigger kind, attempt one, and a new
session target; legacy `done` rows become `succeeded`. Existing work-item
endpoints and fields remain adapters over these records, so repository and issue
context remains available to current nodes and the queue UI.

## Privacy and metering boundary

The control plane stores routing and source metadata. It must not receive agent
prompts beyond the existing inbound request text, transcripts, repository files,
credentials, or generated content. Output fields contain references, not their
contents.

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
