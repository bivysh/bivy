# Live-session reliability & surfacing plan

Bivy's core value is a **remotely visible, steerable agent session**. That surface
is "flaky today": output sometimes appears to stall, a message typed into a hung
session can vanish, and it is hard to tell *which* runtime or transport is at
fault. This document is the standing plan for making it solid.

The important starting point — established by a full read of the runtime, session,
and web layers — is that **the agent abstraction is already the right one and is
mature**. Bivy has a real `AgentRuntime` / `RuntimeSession` interface
(`src/runtime/types.ts`), a declarative `RuntimeCapabilities` contract with an
explicit fail-closed *honesty invariant* (`withExactCapabilitySurface`), a
data-driven agent registry (`CLI_AGENT_SPECS`), `ToolCallProvenance` that carries
the raw native tool call alongside a normalized projection, and a web UI that
already branches on **capabilities, not agent names**. So this plan is *not* an
abstraction rewrite. It is a set of targeted fixes at four delivery/state seams
where the interface promises events and status it cannot yet deliver reliably.

## The four root causes

1. **Live daemon→client event delivery is at-most-once with no replay.**
   `relay-client.ts` drops any event when the socket is not `OPEN` (no outbound
   queue, no sequence number); a lost chunk of a large frame
   (`relay-chunk.ts`) evicts the whole event silently. Recovery is pull-based
   transcript catch-up (`history-sync.ts` count+hash cursor), which only recovers
   what reached the durable `EventLog` — transient stream events
   (`message_update`, `tool_execution_update`) are lost across a reconnect.
   *This is the largest driver of "it looked stuck / output went missing".*

2. **Session status is derived on read, not an explicit state machine, and
   transport health is not part of it.** `sessionBusy = isWorking ||
   session.isStreaming` (`server.ts`), and `isStreaming` can be stuck-true, so
   "working" is sometimes a lie the watchdog cleans up later. A healthy-but-
   disconnected session and a wedged session present identically.

3. **`agent_end` is unreliable across runtimes** — the entire `turn-watchdog`
   exists to compensate (stall timer, wall-clock cap, PID-dead grace). Process
   exit and turn end are decoupled.

4. **The remote (out-of-process) path can't distinguish "agent exited" from
   "connection lost"** — `RemoteRuntimeSession.handleClose` synthesizes
   `agent_end{disconnected:true}` for both.

## Phasing

Phases are ordered so that each is independently shippable and the earlier,
lower-risk phases improve *observability* first — so the higher-risk transport
work is guided by data instead of guesswork.

### Phase 1 — Observability & surfacing (this PR) ✅

Additive, fully unit-tested, no behavior removed.

- **First-class delegation/subagent surfacing.** Adds a `delegation` kind to the
  normalized `ToolCallDetail` taxonomy so an agent's sub-task dispatch (Claude's
  `Task`, `dispatch_agent`, `spawn`, MCP subagent calls) renders as a labelled
  "Delegated" activity card instead of an opaque tool blob. This is the one
  genuinely-missing normalization concept identified in the surfacing review, and
  it is the representation the UI needs before parent/child linkage (Phase 4) can
  be layered on. Touches `src/runtime/types.ts`, `src/runtime/tool-call-map.ts`,
  `packages/core/src/tool-format.ts`, `packages/web/src/components/ToolGroup.tsx`.

- **Turn-recovery diagnostics.** The watchdog already knows *why* it recovered a
  turn (subprocess died / went silent / hit the wall-clock cap) but discards that
  signal into a log line. A pure `classifyStallTrigger()` names the trigger, and
  `recoverStuckTurn` now broadcasts a `session.diagnostic` event carrying
  `{runtimeId, trigger, idleMs, turnMs}`. That turns "which agent/transport is
  flaky?" from a guess into a per-runtime histogram — the prerequisite for
  targeting Phases 2–4.

### Phase 2 — Sequenced, replayable event delivery (largest reliability win)

Make live daemon→client delivery lossless.

- Add a monotonic **per-session `seq`** to every user-visible event and a node-side
  **bounded resend buffer** (ring, e.g. last N events / M seconds per session).
- On reconnect the client sends its `last-seq`; the node replays the tail. A
  client-detected `seq` gap triggers a targeted resend — which also makes
  chunked-frame loss self-healing (the gap is detected at the event layer, not by
  a stuck reassembly group).
- Generalize the event envelope: lift the provenance idea from tool calls up to
  every event → `{id, seq, ts (node-receive time), fidelity, source, payload,
  raw}`. `ts` simultaneously fixes the transcript time-anchoring fallback that
  clumps overlays for agents that emit no timestamps (`transcript-merge.ts`).
- **Requires live-relay + paired-node end-to-end validation** (see
  `packages/web/STATUS.md`: RelayTransport is not yet live-validated). Build the
  reconnect/replay integration harness first.

### Phase 3 — Explicit session state machine

Replace read-time `working|idle|failed` derivation with four explicit axes —
`transport` (clients reachable), `process` (alive/exited/none), `agent`
(idle/working/awaiting-input), `workspace` (clean/dirty/checkpointing) — and
derive the display status from them, sending all four to the client. The web UI
already renders these axes separately (node dot vs session dot vs working row);
today the node collapses the information before it arrives. Land the derivation as
a pure, unit-tested module first, wire it into the payload additively, then cut the
display status over to it.

### Phase 4 — Authoritative turn-end & remote exit/disconnect split

- Replace `agent_end{disconnected: boolean}` with
  `agent_end{reason: "completed"|"crashed"|"disconnected"|"timed_out"}`.
- Treat process-exit as a first-class turn terminator (extend the existing PID
  path); have the agent-service report the child's real exit across the detach gap
  so a connection blip is no longer reported as a finished turn.
- With authoritative turn-end + Phase 1 diagnostics, the watchdog timers can be
  shortened (faster hang recovery) instead of relied upon as the primary signal.
- Add first-class **parent/child linkage** on delegation activity now that the
  category (Phase 1) and the sequenced stream (Phase 2) exist.

### Backlog (smaller, known UI gaps)

- Verify the backpressure tail-case: a backed-up client can drop the final
  `message_update`; confirm the web client renders the final text from
  `message_end`.
- Composer plan/act mode slot; "always allow / remember" on non-critical approval
  cards; wire `controller.pauseSession/resumeSession` (exist, no UI callsite);
  agent-switch transcript hand-off instead of starting a fresh session.

## Testing philosophy

Every phase lands its core logic as a **pure, unit-tested module** first
(`tool-call-map`, `turn-watchdog`, the future `session-state` and event-sequencer),
then wires it in additively. Transport phases additionally need an integration
harness that exercises real reconnect/replay against a live relay + paired node.
