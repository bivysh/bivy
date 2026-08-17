# Session replication (warm standby)

> Status: **implemented, behind the `sessionSync` toggle (off by default).** When
> `sessionSync` is off the whole system is inert and the daemon behaves exactly as
> before.

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
can't survive the case that matters: the owner is already offline, so there's
nothing to pull from. The standby therefore has to *already* hold the state.
Continuously.

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
objects, and `runtimeSessionRef` must **never** transit the control plane in plaintext.
The control plane coordinates *metadata only*: `standbyNodeId`,
`ownerEpoch`, and node liveness (`POST /node/heartbeat`, `online` / `lastSeenAt`).

## Promotion (manual)

1. **Steady state** — owner A streams frames to standby B; the control plane holds
   `{ ownerNodeId: A, standbyNodeId: B, ownerEpoch }`.
2. **A goes offline** — heartbeat lapses; the control plane marks A `online:false`. The
   React app surfaces the session as *"Owner offline — continue on B?"* (B is known-warm).
3. **User promotes** (button, or `bivy promote <id>` on B) — B does the epoch CAS,
   checks out the replicated checkpoint worktree, replays its event-log replica
   (`EventLog.deriveHistory`), and resumes the runtime. Instant; nothing pulled from A.
4. **Fencing** keeps a resurrected A from writing (see above).

## Settings

Two per-node toggles (Settings → Nodes), off by default, on both the node and the
React app:

- **`sessionSync`** — warm-replicate the transcript to a standby node.
- **`worktreeSync`** — also replicate the git checkpoints (requires `sessionSync`;
  ignored for non-git workspaces).

After promotion, the promoted session materializes its worktree and replays its
transcript; running `bivy resume <id>` on the promoted node reattaches it to a
live runtime. The standby connection reconnects automatically with exponential
backoff, so replication survives relay blips instead of pausing until the next
turn.

## Out of scope (v1)

- No automatic promotion — a dead owner strands the session until a human promotes B.
- No live sub-turn replication — frames are built at checkpoint boundaries, so lost
  work is bounded by one turn, not one keystroke. A dirty-tree patch on each flush is a
  later knob.
