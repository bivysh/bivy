# Rulesets — policy-driven run orchestration

When a run fails — a rate limit, exhausted quota, a full context window, an
offline node, a network blip — Bivy no longer treats every failure as a dead
end. A **ruleset** is user-authored policy that decides what happens next: retry,
reroute through a fallback route, or park the run for a human.

This page covers the condition taxonomy Bivy classifies failures into, the
ruleset schema you author, the built-in default, and where rulesets apply today.

## The seam: one matcher, context-specific effectors

The load-bearing idea is a single split:

```
src/policy/               ← SHARED, pure, testable
  conditions.ts             classify(rawError) → RuntimeCondition (+ retryAfter/resetsAt)
  ruleset.ts                schema (typebox) + validator + DEFAULT_RULESET + findRule (the matcher)
  run-policy.ts             (condition, context, attempt, chain-cursor) → RunDecision

src/control-plane-tasks.ts  ← QUEUE EFFECTOR: carries a decision out on an AutomationRun
(src/session/… )            ← SESSION EFFECTOR (future): carries a decision out on a live session
```

The **matcher and decision layer are pure** — no I/O, no clock beyond an
injectable RNG for jitter — so the whole policy is unit-tested in isolation. The
two execution contexts differ *only* in the **effector** that applies the
decision. That's how one rule language serves both the interactive session and
the unattended queue without forking.

**Action applicability is a capability gate, not a second language.** A rule
that names an action a context can't perform is simply inert there (`appliesTo`
gates it, and an effector that doesn't implement an action ignores it).

## Condition taxonomy

Rules match **stable condition codes**, never raw provider error strings. Raw
failures are classified exactly once (`src/policy/conditions.ts`):

| Condition | Example raw failure | Default handling |
|---|---|---|
| `rate_limited` | `429`, `overloaded`, `retry-after: 30` | retry with backoff (honors `retry-after`) |
| `credits_exhausted` | `credit balance too low`, `402`, `session limit reached` | park (needs attention) |
| `context_overflow` | `maximum context length`, `prompt is too long` | park |
| `auth_failed` | `401 Unauthorized`, `invalid x-api-key` | park |
| `node_offline` | `ECONNREFUSED`, `host unreachable` | retry with backoff |
| `transport_error` | `socket hang up`, `ETIMEDOUT`, `fetch failed`, `502` | retry with backoff |
| `task_failed` | `tests failed`, `made no changes` | none (not an infra retry) |
| `unknown` | anything unclassified | none — deliberately left for a human |

Classification also recovers metadata where the provider supplied it: a
`retryAfterMs` (from a `retry-after` header or a "try again in N minutes"
phrase) and a `resetsAt` ISO timestamp. A provider-supplied wait always wins over
computed backoff. In particular, a **Retry** rule matching `credits_exhausted`
waits until `resetsAt` before resuming, rather than consuming its remaining
attempts before the session/usage window reopens. If the reset has already
passed, it retries immediately; without recovery metadata, the rule uses its
configured backoff as usual.

## The ruleset schema

Validated with `typebox` into a versioned in-memory shape — Bivy never executes
arbitrary YAML expressions. (YAML is the intended import/export surface; the
internal representation is this JSON shape.)

```jsonc
{
  "version": 1,
  "name": "default",
  "appliesTo": ["queue", "session"],
  "rules": [
    {
      "when": ["credits_exhausted", "rate_limited"],
      "action": "reroute",                 // "retry" | "reroute" | "park"
      "chain": [                            // ordered fallback candidates (reroute only)
        { "account": "work-secondary" },   // same model, other account
        { "model": "claude-sonnet" },      // cheaper model, same provider
        { "runtimeId": "codex", "model": "gpt-5" }  // cross-provider last resort
      ],
      "onExhausted": "park",               // chain drained → "park" | "give_up"
      "maxAttempts": 3,
      "backoff": { "baseMs": 2000, "factor": 2, "capMs": 60000, "jitter": 0.3 }
    }
  ]
}
```

Validate untrusted input with `validateRuleset(value)` → `{ ok, ruleset?, errors }`
(never throws). The reroute resolver **skips any chain candidate that provably
lacks credentials** on the node (via an injected `hasCredential` predicate), so a
chain can list routes that only some nodes can serve.

### Authoring rulesets in the app

Rulesets are edited from **Settings → Rulesets** in the web app. Each node owns
its own registry (`<appDir>/rulesets.json`, non-secret config only — never synced
through the credential envelope, since policy is per-machine). The panel is a
structured editor over the schema above: pick the failure conditions a rule
matches, choose retry / reroute / park, set the attempt bound and backoff, and —
for reroute — order the fallback chain. The node validates every save with
`validateRuleset` before it is stored, so an invalid shape is rejected with a
readable error rather than silently persisted.

One ruleset may be marked **active**. That is the ruleset both effectors run
under — the work queue (`activeQueueRuleset` in `src/server.ts`) and interactive
sessions (`activeSessionRuleset`) — each read lazily on the next failure so a UI
edit takes effect without a restart. An active ruleset only steers a context it
`appliesTo`: an active session-only ruleset never touches the unattended queue,
and an active queue-only ruleset never steers a session. With no active ruleset,
each context falls back to `DEFAULT_RULESET` below.

### Repository-owned policy

A repository may define the queue ruleset in `.bivy/policy.yaml`. This is the
preferred surface when policy should be reviewed with the code it governs:

```bash
bivy config init --project
bivy config validate --project
```

The repository ruleset wins over the node-global active ruleset for unattended
runs in that repository. The same file can impose a sandbox ceiling, approval
floor, and required package-script checks. See
[config-as-code.md](config-as-code.md#repository-policy).

The app's Settings → Rulesets registry remains the node-wide fallback for repos
without project policy.

### The built-in default

`DEFAULT_RULESET` retries infra hiccups (transient transport, node-offline,
rate-limits) with backoff, and **parks** quota / auth / context failures for a
human — because Bivy can't presume a valid fallback model or account for an
arbitrary node. Genuine `task_failed` and `unknown` failures fall through to the
caller's existing failure path unchanged. Reroute + fallback chains are fully
supported but **opt-in**: author a rule with a `chain` to enable them.

## The work-queue effector

The queue poller (`src/control-plane-tasks.ts`) previously turned any thrown
error straight into `failed`. It now runs each item under the policy:

```
attempt → runItem → throws
  → classify → findRule → RunDecision:
      retry    → emit `retry` evidence, wait backoff, re-run           (attempt++)
      reroute  → emit `fallback` evidence, rewrite routing, re-run      (attempt++, cursor++)
      park     → emit `needs_attention` evidence → POST /needs-attention
      give_up  → POST /fail   (historical behavior; also the no-policy default)
```

**Reroute happens only at attempt boundaries** — the failed attempt is fully
unwound before the next begins — so there's no partial-work / idempotency hazard
(no "already committed, now switching model" case). Every decision is recorded as
a bounded, privacy-safe evidence event, so one run reads as a clear sequence of
attempts and fallbacks in the run-detail timeline.

Notable properties:

- **No storage migration.** `attempt` already existed (just never incremented);
  the evidence kinds `retry` / `fallback` / `needs_attention` already existed;
  `needs_attention` was a dormant status with no producer. The policy layer
  activates them; the `POST /node/work/:id/needs-attention` endpoint is the
  producer.
- **Back-compatible.** With no policy injected the poller behaves exactly as
  before (one attempt, any throw → `failed`).
- **Unattended-safe.** Queue runs act automatically within the ruleset's bounds
  (`maxAttempts`, backoff cap); on exhaustion they surface as `needs_attention`
  rather than silently failing.

## In-session model reroute

The session effector's first, fully in-place action: when a live turn ends in a
recoverable error, swap to a fallback **model** and retry the same prompt instead
of surfacing the error.

- **Seam**: the daemon's per-session `agent_end` handler already extracts a
  terminal turn error (`src/server.ts`). `SessionRerouteController.planReroute`
  (`src/policy/session-reroute.ts`) decides *synchronously* whether that error
  becomes a reroute, so the error toast is suppressed atomically; the model swap
  (`runtime.setModel`) + re-prompt run async.
- **Scope**: model swaps only — the one thing a session can change in place. A
  chain candidate that changes agent/account/node is skipped here (those are
  forks / promotions — see below). Reroute happens only at the turn boundary.
- **Opt-in**: set `BIVY_SESSION_MODEL_FALLBACK` to a comma-separated model list,
  e.g. `BIVY_SESSION_MODEL_FALLBACK=claude-sonnet,claude-haiku`. The daemon builds
  a session ruleset (`credits_exhausted`/`rate_limited` → reroute down the list,
  `onExhausted: give_up`) and wires it via `createRunPolicy({ context: "session" })`.
  Unset = inert, session behavior unchanged.
- **Bounded**: the per-turn reroute budget resets on each user prompt; when the
  chain drains the error surfaces as before.

## In-session resume after a usage/rate limit

A live turn that ends because a provider usage window is exhausted — a Claude
subscription "5-hour" or "weekly" cap, `you've hit your weekly limit · resets 12am
(UTC)` — is **waited out and re-sent** when the window resets, instead of leaving a
dead error bubble, whenever the active session ruleset says `retry` for that
condition.

- **Classification**: the qualifier in a windowed-limit message (`weekly`,
  `5-hour`, `7-day`) no longer defeats the classifier — these map to
  `credits_exhausted` (was silently `unknown`, so no rule ever matched). See
  `src/policy/conditions.ts`.
- **Reset time**: the resume fires at the provider's reset. `classifyFailure`
  resolves it, most-authoritative first: a structured `resetsAtHint` (the Claude
  usage snapshot's `resets_at`, essential for a multi-day window whose text only
  states a time-of-day), then an ISO stamp in the text, then a bare wall-clock
  (`resets 12am (UTC)`) via `parseResetClock`.
- **Seam**: `SessionRerouteController.planResume` decides synchronously (like
  `planReroute`); the daemon persists the due time (`metadata.resumeAt`) and arms
  a timer. `driveSessionResume` re-opens the session if needed and re-sends the
  turn's last prompt.
- **Durable**: the due time is persisted, so a daemon restart re-arms it
  (`sessionResumeSweep`, at boot and on a 60s interval). In-process timers are
  capped and the sweep re-arms long tails.
- **Bounded**: each resume charges the attempt budget (`noteResumeApplied`), so a
  limit that re-fires after the reset eventually exhausts (→ surfaces) instead of
  looping. A new user prompt supersedes a pending resume.
- **Runtime coverage**: Claude Code throws the limit inside the SDK query and
  emits its own `session.error` plus `agent_end.error`; the daemon now reads that
  `error` string (not just pi-ai's stop-reason shape) to drive recovery.

## Not yet supported

These are not available yet:

- **Session `suggest` mode** — asking before costly or lossy actions in
  interactive sessions, rather than acting automatically within the bounded
  budget.
- **`continue` action** — for `context_overflow`, forking into a fresh session
  that preserves run lineage and workspace, rather than parking.
- **Queue waiting state and claim leases** — releasing a node slot during a long
  `retry-after` instead of sleeping in-process, and reclaiming a dead node's
  claimed run. (Interactive sessions already resume durably — see the in-session
  resume section above — because their due time is persisted rather than held in
  a lease.)
- **Credential-aware queue reroute** — skipping un-credentialed fallback routes
  in the queue effector.
- **Node fallback** — warm-standby promotion, cross-node fork, and ephemeral
  routing with ownership fencing.
