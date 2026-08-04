# Make Bivy Great — core-flows plan

A plan to make the fourteen core-flow asks genuinely great, grounded in how the
code actually works today (each claim below carries a `file:line` anchor from a
read of the current tree). It is deliberately phased: **Phase 1 (this PR)** ships
the self-contained UX wins; the later phases are scoped, sequenced, and de-risked
so they can land as focused follow-ups rather than one unreviewable mega-change.

Guiding principle throughout: *powerful, simple, intuitive, easy to maintain.*
Most of these asks turned out to be **fixes and completions of infrastructure
that already exists**, not greenfield features — so the right move is almost
always to extend the existing seam, not add a parallel one.

---

## Phase 1 — shipped in this PR (UX polish cluster)

### 1. Attention floats to the top of the session list; no separate inbox
`buildInboxItems` (`packages/core/src/inbox.ts`) already aggregates every
attention source, and sessions already carry `needsAction`/`status`
(`packages/core/src/store.ts`). The list just didn't use it — it sorted purely
by `updatedAt`. 

- New `attentionRank()` (`packages/web/src/sessionStatus.ts`) — needs-action (2)
  > unseen-finished (1) > calm (0); `updatedAt` is the within-rank tiebreak.
- `SessionList` sorts by that rank first, and every attention row now carries a
  "what needs you" hint (the specific run-evidence phrase when present, else the
  status label) so the list itself says why.
- The separate Inbox button + modal are removed. The `☰` burger wears a red dot
  (`.attn-dot`) when something needs the user that they haven't seen; opening the
  drawer marks the current set seen. `buildInboxItems` stays as the dot/title/OS-
  badge source. Non-session attention (provider auth, GitHub queue) is unchanged
  and still reachable via Settings.

### 2. Next queued message auto-sends when a turn ends
Auto-drain already existed for the active session (`controller.drainFollowups`,
fired by `onSessionSettled` on `agent_end`). Two real gaps closed:

- A turn that finishes **while the socket is down** reconciles `working` from
  history, not from a fresh `agent_end`, so the queue wedged. New
  `installFollowupAutoDrain()` drains on the `working` true→false *edge* of the
  active session, covering that path (harmless no-op double when agent_end
  already drained). Deliberately **not** on session-switch: `beginOpen` paints
  `working:false` optimistically, which would risk firing a queued message into
  a background session that's actually mid-turn.
- An enqueue that lands just after the turn settled now drains immediately
  (`sendPrompt`) instead of waiting for the next edge.

*Follow-up:* a session that is **already idle on open** with a pending queue has
no `working` edge to ride, so it drains only on the next turn. Draining it safely
requires waiting for history to confirm idle first — deferred to avoid the
mid-turn hazard above.

### 3. Slash-command UI legibility
A full autocomplete menu already exists (`Composer.tsx`) sourced per session from
`commandsBySession`, with keyboard nav and correct dispatch (protocol-mode →
`command.invoke`; prompt-mode → forwarded). The gap: agents that advertise **no**
commands (Codex, opencode) showed *silence*, reading as "no slash support." Added
an empty-state ("This agent has no slash commands" / "No matching command") so the
feature is legible for every agent.

*Follow-up (Phase 4):* Codex and opencode have no `getCommands()` adapter
(`src/runtime/codex-*.ts`, `opencode-preflight.ts`), unlike Claude
(`claude-code.ts:765`) and Pi (`pi.ts:279`). Implementing those populates their
menus for real.

### 4. Version-mismatch banner with a one-tap update
No node→client version signal existed. Added:

- Node broadcasts an authoritative `node.update` on every connect (`server.ts`):
  `latest` set = behind (banner shows), absent = up to date (banner clears — this
  is how it disappears after an update lands and the socket reconnects). A
  throttled npm check refreshes it.
- `AppState.nodeUpdate` / `nodeUpdating` + reducer (`store.ts`); a persistent
  banner in `App.tsx` with an **Update this node** button.
- The button runs `bivy update` on the node via `runBivyUpdate()` — the sanctioned
  CLI path, which itself waits for the in-flight turn, updates, and restarts. Wired
  for both transports: `RELAY_COMMANDS["node.update"]` (relay) and
  `POST /api/node/update` (direct). Degrades to a surfaced error + manual command
  when the CLI can't be located.

> Verified by typecheck, lint, and the unit suites. The node-side `runBivyUpdate`
> spawn (restart-and-update) has **not** been exercised against a live node in
> this environment — it mirrors how `bin/bivy.mjs` already self-spawns the
> detached update, and fails safe, but should get a live smoke test.

### 5. General terminal removed from the session ⋯ menu
Dropped the `onOpenTerminal` prop + menu item from `SessionMenu`; "Continue in
terminal" (the runtime TUI handoff) stays. The standalone sidebar terminal is a
separate entry point and is untouched.

---

## Phase 2 — Forking reliability (self-contained; highest bug-value) — SHIPPED

Forking threw "strange errors all the time." Root causes were in
`src/session/fork.ts`, `fork-dirty.ts`, `src/repo-workspace.ts`, `src/worktree.ts`,
and `standUpFork` (`server.ts`). All six are fixed, with integration coverage
added (`test/fork-standup.test.ts`, plus new cases in `test/fork-dirty.test.ts`
and `test/fork-transport.test.ts`):

1. **Unavailable target agent threw before the friendly path.** `standUpFork`
   resolved the runtime with `getRuntime()` (→ `RuntimeHost.get` → `resolveRuntimeId`,
   which *throws* for a known-but-not-installed agent) *before* the blocking-prereq
   check, surfacing a raw string with an empty `missing[]` instead of the install
   checklist. → **Fixed:** prereq detection now reads availability + display name
   from the runtime *registry* (`listRuntimes()`, which never throws); `getRuntime`
   is resolved only after the blocking check passes. An unknown id is treated as
   unavailable so it, too, degrades to the checklist.
2. **Cross-node "adopt" branched off the wrong base and lost committed work.**
   Adopt mode passed `base: undefined` → the destination's default branch, never
   consulting `origin/<srcBranch>`, and nothing pushed the source branch.
   → **Fixed:** new `resolveAdoptBaseRef()` fetches and prefers the pushed
   `origin/<branch>` (falling back to the default when absent), and the export
   handler best-effort pushes the source branch on a *cross-node* fork
   (`pushForkSourceBranch`, gated on the new `crossNode` export flag) so committed
   work travels via origin.
3. **`applyDirtyPatch` was unguarded** and threw on any hunk mismatch (frequent,
   given #2), taking the whole fork down. → **Fixed:** it now returns a result
   (never throws), retries with `git apply --3way` (reading the exit status via
   `spawnSync` to tell "landed with conflict markers" from "nothing applied"),
   and the destination surfaces a `session.notice` when WIP didn't apply cleanly.
4. **Client import timeout (180s) < server clone timeout (600s)** orphaned a
   session while the server kept cloning. → **Fixed:** client fork import/local
   timeouts raised to `FORK_IMPORT_TIMEOUT_MS` (660s > the 600s clone cap).
5. **Worktree path/branch collisions.** `createWorktree`'s adopt-path `rmSync`
   could clear a live session's tree, and nothing serialized clone+worktree work
   per repo. → **Fixed:** a per-repo async mutex (`withRepoLock`) serializes the
   worktree ops, and adopt now uses a unique worktree *directory* id (keeping the
   branch name), so a fork never reuses/deletes another session's tree.
6. **Sandbox tier wasn't carried in `ForkRecord`** → a sandboxed source could
   fork into an unsandboxed session. → **Fixed:** `ForkRecord.sandbox` is captured
   on export and threaded into both `getRuntime()` launch flags and
   `createSession({ sandbox })` on the destination.

## Phase 3 — Faster model list on agent switch (self-contained) — SHIPPED

Switching agent spun up a **fresh networked Pi `ModelRuntime` + full agent
session just to answer `models.list`**, and only one scratch session was cached
(`sessionForModelQuery`, `server.ts`), so every switch re-spawned
(`pi.ts` `build()` with `allowModelNetwork:true`). Fixed via a stale-while-
revalidate design that keeps the **real** `getModels()` path authoritative (so
no offline model-resolution reimplementation to drift out of sync):

1. **Per-runtime scratch cache (server).** `modelQueryScratch` /
   `…Pending` became `Map<runtimeId, …>` and `sessionForModelQuery(runtimeId?)`
   reuses/creates one warm scratch **per runtime**, passing the id through to
   `createSession`. Switching Claude → Codex → Claude no longer evicts+re-spawns
   the single slot; the switch-back answers from the still-live session.
2. **Per-runtime model cache (client).** `SessionStore.modelsByRuntime` remembers
   each runtime's last list; `setSelectedAgentLocal` repaints the target runtime's
   cached models **instantly** on switch-back instead of blanking to a loading
   state (first-ever switch to an agent still blanks, as before). The node's fresh
   `models.list` still overwrites — stale-while-revalidate.
3. **Prefetch on picker open.** A new fire-and-forget `models.prefetch`
   command / `POST /api/models/prefetch` warms every installed runtime's scratch
   **serially** (not a concurrent burst — gentle on small nodes) when the agent
   picker opens (`AgentPicker`), so the first user-visible switch is usually warm.
4. **Runtime-hinted draft queries.** `models.list` (WS + `/api/models`) accepts an
   optional `runtimeId`; the composer sends the agent it's previewing on a draft,
   so the node answers for that runtime even if its default hasn't flipped yet.

Verified: node + web + core typecheck, lint (0 errors), 411 core tests
(+3: per-runtime repaint, runtime-hint forwarding, prefetch routing), 172 unit
suites, web build. *Deviation from the original sketch:* the offline
`listCatalog()` fast-path (item 1 of the old plan) was **not** used to synthesize
the draft list — deriving "connected" providers offline from the vault diverges
from the live `getModels()` path for env-/OAuth-/subscription-based creds (would
mislabel a connected provider as "connect me"). The warm-scratch cache + prefetch
reaches the same "instant switch" outcome without that correctness risk.
*Caveat:* the per-runtime warm-up and prefetch were exercised via the client/
transport tests and the reasoning above, not a live multi-agent node.

## Phase 4 — Top-tier agents + slash completeness (Claude, Codex, Pi, opencode)

- Codex/opencode `getCommands()` adapters (see Phase-1 item 3 follow-up).
- Audit each adapter's model list, streaming/steer behaviours, and TUI handoff on
  mobile against the `runtime/types.ts` capability surface; close gaps so the four
  headline agents are first-class in the mobile app.

---

## Phase 5 — Integrations as normal chat (GitHub, Linear, Slack)

A queued work item already becomes a **fully interactive `SessionRecord`**
(`server.ts` `runWorkItem`/`createSession`), so the user can keep chatting to it
in-app. The gap: **only GitHub** routes a later channel reply back into the same
session (`findIssueSession` → `runIssueFollowUp`). Linear and Slack run one turn
and stop (`server.ts`), so a follow-up in the originating channel starts fresh.

→ Add a `findSession(source)` analog for `queue:linear:issue` and `queue:slack`
(the control plane already supports `targetKind:"existing_session"` — it's just
GitHub-gated), so "keep interacting as a normal chat" works from the channel too,
not only from the app.

## Phase 6 — Workflow sandbox without colliding with the agent's own sandbox

Today a "workflow" **is** an ordinary session and already gets the per-session
sandbox tier via `WorkItem.sandbox → createSession(opts.sandbox)`
(`src/harness/sandbox.ts`). There is no second sandbox. If a distinct
workflow-level sandbox is added, the collision surfaces to design around are all
**node-global singletons**:

- The egress proxy is one daemon-wide instance + one `NetDecider`
  (`src/harness/egress.ts`, `net-proxy.ts`); its `HTTP(S)_PROXY`/`NO_PROXY` env is
  injected into every subprocess. A per-workflow policy needs a per-workflow proxy,
  not the singleton.
- `BIVY_SANDBOX` / `configuredTier` are process-global (`sandbox.ts`) — a workflow
  must set its tier only through the per-session `sandbox` override arg, never via
  env, or it clobbers every concurrent session.
- Worktrees share `<repoRoot>/.bivy/worktrees/<slug>` and MCP config rewrites
  share the home/workspace path — both need the same locking/adopt discipline and
  an isolated config path.

→ Isolate via the per-session override arg + a per-workflow proxy/decider; never
touch the process-global knobs.

## Phase 7 — Connect computer to remote app; key & provider OAuth sync

Grouped because both live in the enrollment/credential seam (`src/relay-setup.ts`,
`pairing-crypto.ts`, `runtime/oauth`, `runtime/credential-*.ts`,
`docs/credential-sync.md`). Scope a dedicated pass: audit the pairing/enroll happy
path and failure modes for the "connect computer" flow, and make provider key +
OAuth sync converge predictably across node ↔ device ↔ ephemeral runner. Land its
own plan doc before implementation — this is the largest surface and least
suited to fold into a polish PR.
