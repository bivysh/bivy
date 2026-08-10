// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import { SeqReassembler } from "../src/seq-reassembler.js";

describe("SeqReassembler", () => {
  it("applies in-order events and advances", () => {
    const r = new SeqReassembler();
    expect(r.accept(1, "a").ready).toEqual(["a"]);
    expect(r.accept(2, "b").ready).toEqual(["b"]);
    expect(r.accept(3, "c").ready).toEqual(["c"]);
    expect(r.expected).toBe(4);
  });

  it("drops duplicates and already-applied replays", () => {
    const r = new SeqReassembler();
    r.accept(1, "a");
    r.accept(2, "b");
    expect(r.accept(2, "b-again").ready).toEqual([]);
    expect(r.accept(1, "a-again").ready).toEqual([]);
    expect(r.expected).toBe(3);
  });

  it("holds a forward event on a gap and reports where to replay from", () => {
    const r = new SeqReassembler();
    r.accept(1, "a"); // next = 2
    const gap = r.accept(4, "d"); // missing 2,3
    expect(gap.ready).toEqual([]);
    expect(gap.gapFrom).toBe(1); // replay after seq 1
    expect(r.heldCount).toBe(1);
    // The replay fills the hole; the held event then drains in order.
    expect(r.accept(2, "b").ready).toEqual(["b"]);
    const fill = r.accept(3, "c"); // 3 arrives → drains 3 then held 4
    expect(fill.ready).toEqual(["c", "d"]);
    expect(r.heldCount).toBe(0);
    expect(r.expected).toBe(5);
  });

  it("baseline sets the expected seq forward-only after a history sync", () => {
    const r = new SeqReassembler();
    r.baseline(10); // applied through seq 10 → expect 11 next
    expect(r.accept(11, "k").ready).toEqual(["k"]);
    // A live event that raced ahead already advanced us; a later, lower baseline
    // must NOT rewind (which would re-apply and duplicate).
    r.baseline(5);
    expect(r.expected).toBe(12);
    // An event at/under the baseline is a dup and is dropped.
    expect(r.accept(9, "old").ready).toEqual([]);
  });

  it("baseline drops now-stale held events below the new expected seq", () => {
    const r = new SeqReassembler();
    r.accept(1, "a");
    r.accept(5, "e"); // held
    expect(r.heldCount).toBe(1);
    r.baseline(6); // history covers through 6 → held 5 is stale
    expect(r.heldCount).toBe(0);
    expect(r.accept(7, "g").ready).toEqual(["g"]);
  });

  it("signals overflow when too many events pile up behind a gap", () => {
    const r = new SeqReassembler({ maxHeld: 3 });
    r.accept(1, "a"); // next = 2
    expect(r.accept(10, "x").overflow).toBeUndefined();
    expect(r.accept(11, "x").overflow).toBeUndefined();
    expect(r.accept(12, "x").overflow).toBeUndefined();
    expect(r.accept(13, "x").overflow).toBe(true);
  });

  it("passes through unsequenced events from an older node", () => {
    const r = new SeqReassembler();
    expect(r.accept(undefined, "legacy").ready).toEqual(["legacy"]);
    expect(r.accept("nope", "legacy2").ready).toEqual(["legacy2"]);
    expect(r.expected).toBe(0); // stays uninitialised; never blocks legacy streams
  });

  it("adopts the first seq it sees when uninitialised", () => {
    const r = new SeqReassembler();
    expect(r.accept(42, "first").ready).toEqual(["first"]);
    expect(r.expected).toBe(43);
  });

  it("reset abandons all state for a new stream epoch", () => {
    const r = new SeqReassembler();
    r.accept(5, "a");
    r.accept(9, "held");
    r.reset();
    expect(r.expected).toBe(0);
    expect(r.heldCount).toBe(0);
    expect(r.accept(1, "fresh").ready).toEqual(["fresh"]);
  });
});
