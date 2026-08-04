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

## Phase 2 — Forking reliability (self-contained; highest bug-value)

Forking throws "strange errors all the time." Root causes found in
`src/session/fork.ts`, `fork-dirty.ts`, `src/worktree.ts`, and `standUpFork`
(`server.ts`), none of which have integration coverage:

1. **Unavailable target agent throws before the friendly path.** `standUpFork`
   calls `getRuntime()` (`host.ts:74`) *before* the blocking-prereq check, so a
   fork to an agent not installed on the destination surfaces a raw string with
   an empty `missing[]` instead of the install checklist. → Move/guard `getRuntime`
   after prereq detection.
2. **Cross-node "adopt" branches off the wrong base and loses committed work.**
   `createWorktree({ base: undefined })` resolves to the destination's default
   branch and never consults `origin/<srcBranch>`; the fork also never pushes the
   source branch. → Push source before export (or `git worktree add … origin/<b>`),
   and prefer `origin/<branch>` when the local branch is absent.
3. **`applyDirtyPatch` is unguarded** (`server.ts`) and throws on any hunk
   mismatch (frequent, given #2). → wrap + `git apply --3way`, degrade to a warning.
4. **Client import timeout (180s) < server clone timeout (600s)** → the client
   errors while the server keeps working, orphaning a session. → raise the client
   timeout above the clone, or stream progress / provision async.
5. **Worktree path/branch collisions** `rmSync` a path that may belong to a live
   session; no per-repo lock around clone+worktree. → serialize per repo; unique
   suffix even in adopt mode; never delete a live session's tree.
6. **Sandbox tier isn't carried in `ForkRecord`** → a sandboxed source can fork
   into an unsandboxed session. → carry the tier.

Ship with integration tests for all three fork paths (local, cross-agent,
cross-node), including unpushed-branch, non-applying patch, and unavailable-agent.

## Phase 3 — Faster model list on agent switch (self-contained)

Switching agent spins up a **fresh networked Pi `ModelRuntime` + full agent
session just to answer `models.list`**, and only one scratch session is cached
(`sessionForModelQuery`, `server.ts`), so every switch re-spawns
(`pi.ts` `build()` with `allowModelNetwork:true`). Fixes, cheapest first:

1. Answer `models.list` immediately from the offline `listCatalog()` fast-path
   (`allowModelNetwork:false`, reads `models.json`), then refine with the live
   session's `getModels()` — stale-while-revalidate, the pattern `RepoPicker`
   already uses.
2. Client per-runtime model cache: stop clearing `state.models` on switch; paint
   the last-known list while refreshing.
3. Cache scratch sessions per runtime (`Map<runtimeId, SessionRecord>`), and
   prefetch installed runtimes on picker open.
4. Collapse the triple `getAvailable()` in `publicModelsList`.

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
