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
| `credits_exhausted` | `credit balance too low`, `402`, `quota exceeded` | park (needs attention) |
| `context_overflow` | `maximum context length`, `prompt is too long` | park |
| `auth_failed` | `401 Unauthorized`, `invalid x-api-key` | park |
| `node_offline` | `ECONNREFUSED`, `host unreachable` | retry with backoff |
| `transport_error` | `socket hang up`, `ETIMEDOUT`, `fetch failed`, `502` | retry with backoff |
| `task_failed` | `tests failed`, `made no changes` | none (not an infra retry) |
| `unknown` | anything unclassified | none — deliberately left for a human |

Classification also recovers metadata where the provider supplied it: a
`retryAfterMs` (from a `retry-after` header or a "try again in N minutes"
phrase) and a `resetsAt` ISO timestamp. A provider-supplied wait always wins over
computed backoff.

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

### The built-in default

`DEFAULT_RULESET` retries infra hiccups (transient transport, node-offline,
rate-limits) with backoff, and **parks** quota / auth / context failures for a
human — because Bivy can't presume a valid fallback model or account for an
arbitrary node. Genuine `task_failed` and `unknown` failures fall through to the
caller's existing failure path unchanged. Reroute + fallback chains are fully
supported but **opt-in**: author a rule with a `chain` to enable them.

## Milestone 1 — the work-queue effector (shipped)

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
  `needs_attention` was a dormant status with no producer. This slice activates
  them. The new `POST /node/work/:id/needs-attention` endpoint is the producer.
- **Back-compatible.** With no policy injected the poller behaves exactly as
  before (one attempt, any throw → `failed`).
- **Unattended-safe.** Queue runs act automatically within the ruleset's bounds
  (`maxAttempts`, backoff cap); on exhaustion they surface as `needs_attention`
  rather than silently failing.

## Milestone 2 — in-session model reroute (shipped)

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

## Not yet supported

These are not available yet:

- **Session `suggest` mode** — asking before costly or lossy actions in
  interactive sessions, rather than acting automatically within the bounded
  budget.
- **`continue` action** — for `context_overflow`, forking into a fresh session
  that preserves run lineage and workspace, rather than parking.
- **Waiting state and claim leases** — releasing a node slot during a long
  `retry-after` instead of sleeping, and reclaiming a dead node's claimed run.
- **Credential-aware queue reroute** — skipping un-credentialed fallback routes
  in the queue effector.
- **Node fallback** — warm-standby promotion, cross-node fork, and ephemeral
  routing with ownership fencing.
