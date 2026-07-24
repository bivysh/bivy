# Session replication (warm standby)

> Status: **implemented, behind the `sessionSync` toggle (off by default).** All
> layers are built and unit-tested in-process; the live node↔node path (an owner
> daemon streaming to a standby over a real relay) is exercised by the multi-node
> validation plan at the end, not by CI (it needs a relay + control plane + two
> nodes). When `sessionSync` is off the whole system is inert and the daemon
> behaves exactly as before.

## Transport decision: the owner node as a headless client of its standby

Bivy has no node↔node link and deliberately bridges nodes *through a connected
client* (that is what the existing `session.fork.export/import` move-a-session
feature does). Continuous warm replication can't depend on a browser being open,
so the **owner daemon itself acts as a relay client of its standby** — the exact
mechanism `bivy run --node <account-node>` uses for a CLI to reach a node. Data
stays strictly node-to-node and E2E-encrypted; the control plane only coordinates
metadata (ownership, epoch, node liveness) and never sees transcripts or files.

This required one new control-plane primitive (an enrolled node minting a
client-scoped grant for a sibling it co-owns) and a node-side port of the browser
relay client.

Bivy pins a session to the node that owns its workspace and credentials. That's
correct for privacy, but it means a node going offline strands its live sessions.
**Session replication** keeps a *warm standby* copy of a session on another of your
nodes so, if the owner goes offline, you can pick the session up elsewhere —
**manually**, from the React app or the CLI — without fetching anything from the
(possibly dead) owner.

This is deliberately **not** automatic failover. A human promotes the standby. Warm
replication is what makes that promotion *possible even when the owner is dead*,
which an on-demand transfer can't be.

## Why warm (not on-demand)

The obvious alternative — assemble a bundle from the owner when you want to move —
can't survive the case we actually care about: the owner is already offline, so
there's nothing to pull from. The standby therefore has to *already* hold the
state. Continuously.

## The unlock: both halves of a session are already append-only logs

| State half | On-disk form today | Replication primitive |
|---|---|---|
| **Transcript** | `EventLog` — append-only JSONL (`src/session/event-log.ts`), coalesced/throttled flushes, base stored as bounded reset/extend deltas | Ship appended `LogRecord`s using the **count+hash cursor** from `src/history-sync.ts`. Self-heals on a gap (append vs. full). |
| **Workspace** | Git **checkpoint chain** — the Universal Agent Harness commits a checkpoint per turn (`src/harness/checkpoint.ts`) | Ship the checkpoint commit sha; the standby fetches objects. Git's own negotiation is idempotent + self-healing. |

So replication is "tail two logs and ship their deltas" — no new persistence model.

## Consistency: replicate at the turn/checkpoint boundary

Every replication **frame** carries a consistent pair: the transcript tail **and**
the git checkpoint that closed the *same* turn. The standby applies **both or
neither**. So every recovery point is a consistent `(transcript, workspace)` state,
and the recovery contract is simple:

> On promotion you resume from the **last completed turn**. A crash mid-turn loses
> at most the in-flight turn — the standby re-runs the last prompt.

The runtime resumes via the replicated `runtimeSessionRef` (Claude Code, Codex, Pi);
runtimes without native resume (Aider, Crush) restart on the checkpointed worktree
with history intact.

## The frame

See `src/session/replication.ts` (`ReplFrame`). Conceptually:

```
ReplFrame {
  sessionId
  epoch                      // ownership fence (compare-and-set on promotion)
  runtimeSessionRef?         // opaque resume token, replicated in the envelope
  checkpointCommit?          // the turn's git checkpoint sha
  mode, baseCount, records,  // transcript delta — history-sync shape over LogRecord[]
  count, historyHash         // cursor the standby stores + echoes back
}
```

- **Owner** calls `buildReplFrame(...)` with the cursor the standby last advertised.
  Returns `null` when the standby is already current (skip empty sends); otherwise an
  `append` (matching prefix) or a `full` (diverged / first send).
- **Standby** calls `applyReplFrame(state, frame, deps)`. It never advances past a
  gap (returns `resync` so the owner re-sends), fetches the checkpoint **before**
  persisting the transcript (both-or-neither), and mutates state only after every
  injected effect succeeds (clean retry on failure).

## Ownership & fencing (the split-brain guard)

The control plane's `session_index` gains an `ownerEpoch` (and a `standbyNodeId`).
Promotion is a **compare-and-set** epoch bump. `applyReplFrame` enforces the fence:

- `frame.epoch < state.epoch` → **stale**: a write from an owner that was already
  superseded by a promotion. Rejected; replica untouched.
- `frame.epoch ≥ state.epoch` → honored; applying adopts the (possibly higher) epoch,
  so a promoted owner's first frame transfers ownership cleanly.

This is the same "definitively-gone vs transient" discipline `src/runtime/adoption.ts`
already encodes, reused as a write-guard. When a stale owner comes back online it sees
the higher epoch and defers (demotes to standby, or discards its divergent tail).

## Transport & the hard constraint

The replication stream is **owner node → standby node, E2E-encrypted, over the relay
as opaque frames** (`src/relay-chunk.ts`, `src/wire-format.ts`). Transcript, git
objects, and `runtimeSessionRef` must **never** transit the control plane in plaintext
(`CORE.md`, `CLOUD.md`). The control plane coordinates *metadata only*: `standbyNodeId`,
`ownerEpoch`, and node liveness (`POST /node/heartbeat`, `online` / `lastSeenAt`).

## Promotion (manual)

1. **Steady state** — owner A streams frames to standby B; the control plane holds
   `{ ownerNodeId: A, standbyNodeId: B, ownerEpoch }`.
2. **A goes offline** — heartbeat lapses; the control plane marks A `online:false`. The
   React app surfaces the session as *"Owner offline — continue on B?"* (B is known-warm).
3. **User promotes** (button, or `bivy resume <id> --from A`) — B does the epoch CAS,
   checks out the replicated checkpoint worktree, replays its event-log replica
   (`EventLog.deriveHistory`), and resumes the runtime. Instant; nothing pulled from A.
4. **Fencing** keeps a resurrected A from writing (see above).

Going automatic later is just replacing step 3's button with a lease-TTL timer — no
architectural change.

## Settings

Two per-node toggles (Settings → Nodes), off by default, on both the node and the
React app:

- **`sessionSync`** — warm-replicate the transcript to a standby node.
- **`worktreeSync`** — also replicate the git checkpoints (requires `sessionSync`;
  ignored for non-git workspaces).

Node: `NodeSettings` in `src/server.ts` + `packages/core/src/store.ts`, applied in
`applyNodeSettings`. React: toggles in `packages/web/src/components/Settings.tsx`.

## What's reused vs new

**Reused:** `EventLog` + `history-sync.ts` cursor (transcript delta + self-heal), git
checkpoint chain (workspace delta), `session-location.ts` seam (post-promotion routing),
`adoption.ts` classifier (fencing), control-plane heartbeat/`online` (liveness), relay
chunk/wire format, node-picker UI.

**New:** `ReplFrame` + `src/session/replication.ts` core (this PR); a per-session
replicator (owner) and applier (standby) around it; `standbyNodeId` + `ownerEpoch`
columns with compare-and-set; the promotion command/state-machine; the "continue on
standby" UI; the two settings toggles (this PR).

## Implementation map

| Concern | File |
|---|---|
| Pure decision core (`buildReplFrame`/`applyReplFrame`, fencing, resync) | `src/session/replication.ts` |
| Owner + standby orchestration (per-turn frame, cursor, both-or-neither) | `src/session/replicator.ts` |
| Git checkpoint bundle (full/thin/needFull, materialize) | `src/session/checkpoint-pack.ts` |
| Node-as-client relay transport to the standby | `src/session/sibling-client.ts` |
| Daemon integration (adapters, onTurnComplete / handleReplicaFrame / promote) | `src/session/replication-service.ts` |
| Daemon hooks (agent_end ship, `session.replica.frame` receive, `/api/session/promote`, `session.promote`) | `src/server.ts` |
| Ownership table + epoch CAS | `services/control-plane/src/{store,postgres-store}.ts` |
| Sibling-grant + standby/ownership/promote endpoints | `services/control-plane/src/index.ts` |
| Settings (`sessionSync`, `worktreeSync`, `syncStandbyNodeId`) | `packages/core/src/store.ts`, `src/server.ts`, `packages/web/src/components/Settings.tsx` |
| Promotion UI + CLI | `packages/web/src/components/SessionList.tsx`, `packages/web/src/store/controller.ts`, `bin/bivy.mjs` (`bivy promote <id>`) |

Unit-tested in-process: `test/replication.test.ts` (core, 9), `test/replicator.test.ts`
(orchestration round-trip, 4), `test/checkpoint-pack.test.ts` (real-git bundle, 4),
`services/control-plane/test/store-contract.ts` (ownership CAS). The frame crypto is
covered by the existing `relay-cli-crypto` tests.

## Live multi-node validation plan

The node↔node streaming can't run in CI. To validate end-to-end:

1. Bring up a control plane + relay (`services/*`) and enroll **two** nodes (A, B) on
   one account.
2. On A: Settings → Nodes → enable **Session sync** (+ Worktree sync), pick **B** as the
   standby. Start a session on A and run a few turns.
3. Confirm B receives frames: `appDir/replicas/<id>` holds the checkpoint commits and
   the replica transcript replays (`event-log/<id>.jsonl`); `GET /node/sessions/:id/ownership`
   shows owner A, standby B.
4. Kill A. On B, open the replicated session and choose **Continue here** (or
   `bivy promote <id>` on B). Expect the epoch to bump and the worktree to materialize
   from the last replicated turn.
5. Bring A back; confirm its late writes are fenced out (stale epoch).

## Remaining polish (follow-ups)

- **Resume-after-promote**: promotion runs the CAS + materializes the worktree; wiring the
  promoted session straight into a live runtime (vs. `bivy resume <id>` as a second step)
  is a small follow-up on `resolveOrResumeSession`.
- ~~**Reconnect/backoff** for the sibling client~~ — **done.** The standby connection is now a
  supervised `ReconnectingConnection` (`src/session/reconnect.ts`): exponential backoff + jitter
  on connect failure, prompt reconnect on a healthy connection's drop, and clean teardown when
  sync is disabled or the standby changes. Replication survives relay blips instead of pausing
  until the next turn. Unit-tested in `test/reconnect.test.ts`.
- *(Optional)* lease-TTL **auto-promotion**; finer **dirty-working-tree** sync.

## Out of scope (v1)

- No automatic promotion — a dead owner strands the session until a human promotes B.
- No live sub-turn replication — frames are built at checkpoint boundaries, so lost
  work is bounded by one turn, not one keystroke. A dirty-tree patch on each flush is a
  later knob.
