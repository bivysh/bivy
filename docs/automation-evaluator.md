# The shared automation evaluator

`src/automation/` is the single, canonical, dependency-free implementation of
"which automation fires for this event, and is it actually safe to run" —
first-match rule evaluation, overlap/shadow detection, and a six-check
preflight checklist. It is the one place this logic exists; every caller
delegates to it instead of hand-rolling an equivalent-but-not-identical
version:

- **Config-as-code** (`src/automation-config.ts`'s `simulateAutomation`, used
  by `bivy automation test`) — see
  [automations-as-code.md](automations-as-code.md).
- **The control plane** (`services/control-plane/src/automation-match.ts`) —
  every live GitHub/Linear webhook route (`matchSourceAutomation`), the
  `POST /account/automations/simulate` endpoint
  (`evaluateAccountAutomation`), and the save-time gate on
  `POST`/`PUT /account/automations` (`gatherPreflightSignals` +
  `runPreflightChecks` + `gateFromChecks`).
- **The PWA** (`packages/web/src/components/AutomationsView.tsx`) — the
  Automations editors' "Test event" / "Check readiness" workflow, via the
  simulate endpoint (`simulateAutomation` in `packages/core/src/account.ts`).

Canonical source lives at the repository root (`src/automation/`), consumed
directly by the root CLI/daemon via a relative import. It's republished as
`@bivy/automation-core` (`packages/automation-core/`, mirroring the existing
`src/plugin-sdk` / `packages/plugin-sdk` split) for `services/control-plane`,
a separately npm-managed service that isn't a pnpm workspace member. The PWA
does **not** depend on this package — it only ever talks to the control
plane's simulate endpoint over HTTP, so the evaluator's actual rule logic
never needs to ship to the browser.

## First-match behavior

`matchFirst()` walks candidates in the exact order the caller provides (file
order for config-as-code; `configOrder`/`createdAt` order for the control
plane) and returns the **first enabled candidate whose repository scope and
event rules match** — never the "best" or "most specific" match. Every
candidate gets an explanation entry (`{ id, matched, reason }`) in evaluation
order, not just the winner, so a caller can show *why* each automation did or
didn't fire.

```ts
import { matchFirst } from "./src/automation/index.js";

const { matched, trail } = matchFirst(candidates, event);
// trail: [{ id: "a", matched: false, reason: "repository is not allowed" }, ...]
```

Only `github` and `linear` events go through `matchFirst` with real filter
ambiguity. `schedule`, `webhook`, and `manual` automations each own their own
intake (a cron occurrence, a signed URL, a direct trigger) — there's no
"first match wins" question for them, so reaching `matchFirst` with one of
those event kinds just reports a plain match.

## Overlapping and shadowed rules

Because the **first** enabled match wins, an earlier automation whose scope
is a strict superset of a later one makes the later one permanently
unreachable — silently, since intake never reports it. `findOverlaps()`
surfaces this:

- **`shadowed`** — every event the later automation would accept is already
  matched by the earlier one. The later automation can never fire.
- **`overlaps`** — the two automations' scopes intersect (some events match
  both), but neither fully dominates the other. Not necessarily a mistake,
  but worth knowing: the earlier one wins ties.

`findOverlaps` uses a structural "does A's resolved filter set cover B's"
heuristic (repo scope, then event/action/label/mention/conclusion/workflow
predicates) — not a general N-way SAT solver — which is sufficient for the
`on[]` rule shapes Bivy supports today. Only `github`/`linear` automations
are considered; `schedule`/`webhook`/`manual` have no first-match ambiguity
and are excluded, matching `matchFirst`'s scope.

## The preflight checklist

`runPreflightChecks()` takes a `PreflightSignals` object — every field
optional — and returns one `PreflightCheckResult` per check, always in this
order:

| Check | What it means |
| --- | --- |
| `source_connection` | Is a GitHub/Linear source connected? (Not applicable to schedule/webhook/manual.) |
| `repo_access` | Is the source known to be installed on the configured repositories? |
| `encrypted_key_ownership` | Have instructions been encrypted for a machine, and is that machine online? |
| `assigned_machine` | Is the assigned machine online, or is there a fallback / shared-queue machine that can pick up the work? |
| `agent_model_credentials` | Are the requested agent/model's credentials ready on the assigned machine? |
| `sandbox_policy` | Does the requested approval/sandbox combination pass policy — in particular, is `autonomous` + `danger-full-access` explicitly acknowledged? |

The module does **no I/O of its own** — every signal is gathered by the
caller (the CLI reads local files and the vault; the control plane queries
its store) and passed in. A signal a caller can't observe in its own
environment is simply absent, which reports as `skipped` rather than being
silently treated as passing. This is why `bivy automation test` reports
`source_connection`/`repo_access`/`assigned_machine` as skipped when
run offline — there's no honest local signal for them — while the
control-plane simulate endpoint and the PWA's Test event workflow, which
query the account's real state, report the genuine value.

Each check has a severity (`ok` / `info` / `warn` / `block` / `skipped`) and
a `blocksSave` flag.

## The save gate

`gateFromChecks()` reduces a checklist to one decision:

```ts
interface PreflightGate {
  blocked: boolean;              // any check has blocksSave: true
  blockingChecks: PreflightCheckResult[];
  requiresAck: boolean;          // no blocking checks, but at least one warn/block
  warnChecks: PreflightCheckResult[];
}
```

- **`blocked`** — a hard failure. The save must not proceed. Today only two
  conditions set `blocksSave`: missing encrypted instructions when they're
  required, and `autonomous` + `danger-full-access` without an explicit
  acknowledgement (`allowDangerous` — config-as-code's
  `safety.allowDangerous`, the control plane's `allowDangerous` field, the
  PWA's "I understand the risk" checkbox).
- **`requiresAck`** — nothing blocks, but something isn't clean (an offline
  machine or an unconfirmed repo install). The caller must
  collect an explicit "I understand, save anyway" acknowledgement before
  proceeding.

Every save path enforces this the same way:

- `bivy automation test` exits `2` when the matched automation's checklist
  blocks.
- The control plane's `POST`/`PUT /account/automations` reject (`400`) a
  request whose gate is `blocked` — closing a real gap where the
  `autonomous` + `danger-full-access` hard-block was previously only
  enforced by config-as-code's YAML parser, never by the API the PWA and
  third-party clients actually save through.
- The PWA's Automations editors run the same evaluation silently right
  before every save (not just when the user clicks "Test event"): a block
  aborts before the request ever reaches the API, and `requiresAck` forces
  the acknowledgement checkbox first.

## Simulating a draft that was never saved

The control plane's `POST /account/automations/simulate` and
`evaluateAccountAutomation()` accept either an existing automation (by id,
optionally with a `draft` patch to preview an unsaved edit) or a brand-new
draft that has never been created. The draft is inserted into the account's
other automations at its real evaluation position — so a not-yet-saved
GitHub automation correctly sees itself shadowed by, or shadowing, an
existing one — and evaluated with the account's real signals. Nothing is
persisted and no run is created; the response includes a `subjectId` so the
caller can tell which row in the returned match trail and overlap findings
is the one it's testing, even when that id was only just generated for the
request.

## Known simplifications

- **No durable per-label routing table.** The control plane doesn't record
  which machine "serves" `bivy/<name>` versus the shared `bivy` queue — nodes
  decide that themselves by which labels they poll. `gatherPreflightSignals`
  therefore treats a `bivy/<name>` assignment as having no automatic
  fallback (an offline named machine genuinely has none today) and
  approximates the encrypted-instructions key holder as that same named
  machine.
- **`github_ci` doesn't require ciphertext.** Legacy `github_ci` rows run on
  a server-known plaintext default (`DEFAULT_FIX_CI_PROMPT`) when no
  ciphertext is set, so `encrypted_key_ownership` is the one check that
  doesn't apply to them.
- **Credential readiness from config-as-code is `info`, not verified.** The
  CLI can't cheaply resolve an agent id to a provider without spawning every
  installed runtime's catalog, so `bivy automation test` reports "can't be
  confirmed offline" rather than guessing. The control plane doesn't
  currently verify credentials either (no per-node credential index it can
  query without the node); this is a documented follow-up, not silently
  dropped.
- **Structural overlap detection, not general SAT.** `findOverlaps` is
  sufficient for the `on[]` rule shapes documented in
  [automations-as-code.md](automations-as-code.md), but doesn't attempt to
  prove coverage across arbitrarily combined predicates in general.
