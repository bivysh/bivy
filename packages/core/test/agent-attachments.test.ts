// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Agent-sent (outbound) chat attachments: the live reducer path, the
// history-render path, and inline markdown images.
import { describe, expect, it } from "vitest";
import { SessionStore, renderHistory, toHtml } from "../src/index.js";

const HASH = "a".repeat(64);
const imageRef = { hash: HASH, name: "chart.png", mimeType: "image/png", size: 1234, kind: "image" as const };

describe("agent attachment — live reducer (placed where it was attached)", () => {
  const play = (events: unknown[]) => {
    const store = new SessionStore();
    for (const e of events) store.apply(e as never);
    return store;
  };

  it("lands at the point it was attached and stays there as the turn goes on", () => {
    const store = play([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "Taking a screenshot." } },
      { type: "attachment", id: "att1", ref: imageRef, caption: "cap" }, // agent attaches mid-turn…
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "Now fixing the layout." } }, // …then keeps working
      { type: "agent_end" },
    ]);
    const t = store.getState().activeSession.transcript;
    expect(t.map((e) => [e.text, e.attachments?.length ?? 0])).toEqual([["Taking a screenshot.", 0], ["cap", 1], ["Now fixing the layout.", 0]]);
    expect(t[1]!.attachments).toEqual([{ kind: "image", name: "chart.png", size: 1234, mimeType: "image/png", hash: HASH, description: "cap", createdAt: expect.any(Number) }]);
  });

  it("carries an explicit artifact:true marking through to the rendered chip", () => {
    const store = play([
      { type: "attachment", id: "att1", ref: imageRef, caption: "cap", artifact: true },
      { type: "agent_end" },
    ]);
    expect(store.getState().activeSession.transcript[0]!.attachments?.[0]?.artifact).toBe(true);
  });

  it("ignores malformed attachment events (no entry even after the turn ends)", () => {
    const store = play([
      { type: "attachment", id: "w" }, // no ref
      { type: "attachment", id: "x", ref: { hash: 123, kind: "image" } }, // non-string hash
      { type: "attachment", id: "y", ref: { hash: HASH, kind: "video" } }, // bad kind
      { type: "agent_end" },
    ]);
    expect(store.getState().activeSession.transcript).toHaveLength(0);
  });
});

describe("agent attachment — history render (placed where it was emitted)", () => {
  it("keeps an attachment where it was emitted, not on the turn's final reply", () => {
    const entries = renderHistory([
      { role: "user", content: "make a chart" },
      { role: "assistant", content: [{ type: "text", text: "Drawing it." }] },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: imageRef, caption: "cap" }] }, // mid-turn attach
      { role: "assistant", content: [{ type: "text", text: "Here's your chart." }] }, // final reply
    ]);
    expect(entries.map((e) => [e.text, e.attachments?.length ?? 0])).toEqual([["make a chart", 0], ["Drawing it.", 0], ["cap", 1], ["Here's your chart.", 0]]);
    expect(entries[2]!.attachments?.[0]).toMatchObject({ hash: HASH, description: "cap" });
  });

  it("carries an explicit artifact:true block field and the message's createdAt through history render", () => {
    const entries = renderHistory([
      { role: "assistant", createdAt: 1700000000000, content: [{ type: "bivy_attachment", ref: imageRef, caption: "cap", artifact: true }] },
    ]);
    expect(entries[0]!.attachments?.[0]).toMatchObject({ hash: HASH, artifact: true, createdAt: 1700000000000 });
  });
});

describe("agent attachment — sticky across a lossy reconcile (append-only)", () => {
  const HASH2 = "c".repeat(64);
  const svg = { hash: HASH, name: "logo.svg", mimeType: "image/svg+xml", size: 4470, kind: "image" as const };
  const withOverlay = [
    { role: "user", content: "make a logo" },
    { role: "assistant", content: [{ type: "bivy_attachment", ref: svg, caption: "cap" }] },
    { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
  ];
  // The same turn as the runtime rebuilds it after a resume: raw messages, WITHOUT
  // the bivy-side outbound-attachment overlay.
  const withoutOverlay = [
    { role: "user", content: "make a logo" },
    { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
  ];
  const historyEvent = (messages: unknown[], count: number, hash: string, requestId?: string) => ({
    type: "session.history", requestId, sessionId: "s1", runtimeId: "claude", mode: "full", count, historyHash: hash, messages,
  });
  const attCount = (s: SessionStore) => s.getState().activeSession.transcript.reduce((n, e) => n + (e.attachments?.length ?? 0), 0);

  it("a later snapshot that omits the overlay does not erase the chip", () => {
    const s = new SessionStore();
    s.beginOpen("s1");
    s.apply(historyEvent(withOverlay, 3, "h3", "r1") as never); // open-paint: chip shows
    expect(attCount(s)).toBe(1);
    s.apply(historyEvent(withoutOverlay, 2, "hRaw") as never); // post-resume reconcile, lossy
    expect(attCount(s)).toBe(1); // sticky — chip survives
    const chip = s.getState().activeSession.transcript.find((e) => e.attachments?.length)?.attachments?.[0];
    expect(chip?.hash).toBe(HASH);
  });

  it("is never duplicated when the overlay comes back", () => {
    const s = new SessionStore();
    s.beginOpen("s1");
    s.apply(historyEvent(withOverlay, 3, "h3", "r1") as never);
    s.apply(historyEvent(withoutOverlay, 2, "hRaw") as never); // lossy
    s.apply(historyEvent(withOverlay, 3, "h3b") as never); // overlay returns
    expect(attCount(s)).toBe(1); // dedup by hash — not two copies
  });

  it("keeps distinct hashes; a lossy snapshot restores all of them", () => {
    const csv = { hash: HASH2, name: "data.csv", mimeType: "text/csv", size: 9, kind: "file" as const };
    const two = [
      { role: "user", content: "give me both" },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: svg }] },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: csv }] },
      { role: "assistant", content: [{ type: "text", text: "Both attached." }] },
    ];
    const s = new SessionStore();
    s.beginOpen("s1");
    s.apply(historyEvent(two, 4, "h4", "r1") as never);
    expect(attCount(s)).toBe(2);
    s.apply(historyEvent(withoutOverlay, 2, "hRaw") as never);
    const hashes = s.getState().activeSession.transcript.flatMap((e) => e.attachments?.map((a) => a.hash) ?? []);
    expect(new Set(hashes)).toEqual(new Set([HASH, HASH2]));
  });

  it("restores a dropped chip where it was, not onto a later reply", () => {
    const shown = [
      { role: "user", content: "make a logo" },
      { role: "assistant", content: [{ type: "text", text: "Drawing it." }] },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: svg, caption: "cap" }] },
    ];
    // Lossy, after the turn went on and a new one started.
    const grown = [
      { role: "user", content: "make a logo" },
      { role: "assistant", content: [{ type: "text", text: "Drawing it." }] },
      { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
      { role: "user", content: "now something else" },
      { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    ];
    const s = new SessionStore();
    s.beginOpen("s1");
    s.apply(historyEvent(shown, 3, "h3", "r1") as never);
    s.apply(historyEvent(grown, 5, "hRaw5") as never);
    const t = s.getState().activeSession.transcript;
    expect(t.map((e) => [e.text, e.attachments?.length ?? 0])).toEqual([
      ["make a logo", 0], ["Drawing it.", 0], ["cap", 1], ["Here it is.", 0], ["now something else", 0], ["Sure.", 0],
    ]);
  });

  it("a re-broadcast live attachment already in history is not duplicated", () => {
    const s = new SessionStore();
    s.beginOpen("s1");
    s.apply(historyEvent(withOverlay, 3, "h3", "r1") as never); // history already carries the chip
    // A resume/reconnect replays the live attachment event for the same bytes.
    s.apply({ type: "session.event", sessionId: "s1", event: { type: "attachment", id: "att1", ref: svg, caption: "cap" } } as never);
    s.apply({ type: "session.event", sessionId: "s1", event: { type: "agent_end" } } as never);
    expect(attCount(s)).toBe(1);
  });
});

describe("markdown inline images", () => {
  it("does NOT emit an <img> for non-https sources (http/js/data)", () => {
    expect(toHtml("![x](http://ex.com/a.png)")).not.toContain("<img");
    expect(toHtml("![x](javascript:alert(1))")).not.toContain("<img");
    expect(toHtml("![x](data:image/svg+xml,<svg onload=alert(1)>)")).not.toContain("<img");
  });

  it("still renders a normal https link (not an image) for [text](url)", () => {
    const html = toHtml("[docs](https://ex.com)");
    expect(html).toContain("<a ");
    expect(html).not.toContain("<img");
  });
});
