// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

/**
 * Sequenced live delivery (docs/session-reliability-plan.md, Phase 2). The node
 * stamps every `session.event` with a monotonic per-session `seq`; the store
 * reassembles the active session's stream in order, drops duplicates/replays,
 * detects a gap and asks the controller to `replay` it, and falls back to a full
 * history resync when the node's ring has evicted past the client's cursor.
 *
 * These drive the store through its public `apply()` reducer exactly as the
 * transport does, using completed assistant-text segments (message_start +
 * message_end) as the observable — each commits one transcript bubble — and
 * capture the requestReplay / requestFreshHistory callbacks the controller wires.
 */

const SID = "s1";
const EPOCH = "e1";
type Ev = Record<string, unknown>;

function focused(headSeq = 0, epoch = EPOCH) {
  const store = new SessionStore();
  const replays: Array<{ sessionId: string; afterSeq: number }> = [];
  let fresh = 0;
  store.requestReplay = (sessionId, afterSeq) => replays.push({ sessionId, afterSeq });
  store.requestFreshHistory = () => { fresh += 1; };
  // Focus SID via a full history sync (requestId → adopt as active), which also
  // baselines the reassembler.
  store.apply({ type: "session.history", sessionId: SID, requestId: "r0", mode: "full", count: 0, messages: [], historyHash: "h0", headSeq, streamEpoch: epoch } as never);
  return { store, replays, freshCalls: () => fresh };
}

/** A sequenced session.event envelope wrapping an inner runtime event. */
function evt(seq: number | undefined, inner: Ev, epoch = EPOCH): Ev {
  return { type: "session.event", sessionId: SID, ...(seq === undefined ? {} : { seq, epoch }), event: inner };
}
const msgStart = (seq?: number): Ev => evt(seq, { type: "message_start", message: { role: "assistant", content: "" } });
const msgEnd = (seq: number | undefined, text: string): Ev => evt(seq, { type: "message_end", message: { role: "assistant", content: text } });
/** A complete assistant segment "text" spanning two seqs (start, end). */
const seg = (startSeq: number, text: string): Ev[] => [msgStart(startSeq), msgEnd(startSeq + 1, text)];

/** Committed assistant-bubble texts, in order — the "what got applied" view. */
function texts(store: SessionStore): string[] {
  return store.getState().transcript.filter((e) => e.role === "assistant" && e.text).map((e) => e.text!);
}

describe("store sequenced live delivery (Phase 2)", () => {
  it("applies contiguous sequenced events in order", () => {
    const { store, replays } = focused(0);
    for (const e of [...seg(1, "A"), ...seg(3, "B")]) store.apply(e as never);
    expect(texts(store)).toEqual(["A", "B"]);
    expect(replays).toEqual([]);
  });

  it("detects a gap, holds the forward event, and asks to replay from the last seq held", () => {
    const { store, replays } = focused(0);
    for (const e of seg(1, "A")) store.apply(e as never); // seqs 1,2 → expected 3
    // Segment B (seqs 3,4) is lost on an uplink blip; segment C's start (seq 5)
    // arrives → gap. The held message_start commits no bubble yet.
    store.apply(msgStart(5) as never);
    expect(texts(store)).toEqual(["A"]);
    expect(replays).toEqual([{ sessionId: SID, afterSeq: 2 }]);

    // The node replays the missed segment B; applying it drains the held seq 5.
    store.apply({ type: "session.replay", sessionId: SID, mode: "replay", head: 5, epoch: EPOCH, events: seg(3, "B") } as never);
    // Now finish segment C, which the held message_start already opened.
    store.apply(msgEnd(6, "C") as never);
    expect(texts(store)).toEqual(["A", "B", "C"]);
  });

  it("drops duplicates and already-applied replays (no double render)", () => {
    const { store } = focused(0);
    for (const e of [...seg(1, "A"), ...seg(3, "B")]) store.apply(e as never);
    // A redundant replay of already-applied segments must not duplicate bubbles.
    store.apply({ type: "session.replay", sessionId: SID, mode: "replay", head: 4, epoch: EPOCH, events: [...seg(1, "A"), ...seg(3, "B")] } as never);
    store.apply(msgEnd(4, "B") as never); // stray duplicate of the last seq
    expect(texts(store)).toEqual(["A", "B"]);
  });

  it("baselines against history headSeq so pre-baseline seqs are dropped", () => {
    const { store, replays } = focused(10); // applied through seq 10 → expect 11
    // An old, superseded event (seq 5) is a duplicate relative to the baseline.
    store.apply(msgEnd(5, "stale") as never);
    // The next real segment (seqs 11,12) applies with no gap.
    for (const e of seg(11, "A")) store.apply(e as never);
    expect(texts(store)).toEqual(["A"]);
    expect(replays).toEqual([]);
  });

  it("falls back to a full history resync when the node reports reset", () => {
    const { store, freshCalls } = focused(0);
    store.apply({ type: "session.replay", sessionId: SID, mode: "reset", head: 999, epoch: EPOCH, events: [] } as never);
    expect(freshCalls()).toBe(1);
  });

  it("passes through unsequenced events from an older node unchanged", () => {
    const { store, replays } = focused(0);
    // No seq on the envelope → legacy path, applied directly with no gap logic.
    for (const e of [msgStart(undefined), msgEnd(undefined, "A")]) store.apply(e as never);
    expect(texts(store)).toEqual(["A"]);
    expect(replays).toEqual([]);
  });
});
