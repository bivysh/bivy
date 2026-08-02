// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Agent-sent (outbound) chat attachments: the live reducer path, the
// history-render path, and inline markdown images.
import { describe, expect, it } from "vitest";
import { SessionStore, renderHistory, toHtml } from "../src/index.js";

const HASH = "a".repeat(64);
const imageRef = { hash: HASH, name: "chart.png", mimeType: "image/png", size: 1234, kind: "image" as const };

describe("agent attachment — live reducer (grouped onto the final bubble)", () => {
  const play = (events: unknown[]) => {
    const store = new SessionStore();
    for (const e of events) store.apply(e as never);
    return store;
  };

  it("is buffered until the turn ends (no standalone entry mid-turn)", () => {
    const store = play([{ type: "attachment", id: "att1", ref: imageRef, caption: "cap" }]);
    expect(store.getState().transcript).toHaveLength(0);
  });

  it("lands under the turn's final assistant bubble, even when attached before the reply", () => {
    const store = play([
      { type: "attachment", id: "att1", ref: imageRef, caption: "cap" }, // agent attaches mid-turn…
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_end", message: { role: "assistant", content: "Here it is." } }, // …then writes the reply
      { type: "agent_end" },
    ]);
    const t = store.getState().transcript;
    expect(t).toHaveLength(1);
    expect(t[0]!.role).toBe("assistant");
    expect(t[0]!.text).toBe("Here it is.");
    expect(t[0]!.attachments).toEqual([{ kind: "image", name: "chart.png", size: 1234, mimeType: "image/png", hash: HASH }]);
  });

  it("falls back to a standalone entry (keeping the caption) when the turn has no prose", () => {
    const store = play([
      { type: "attachment", id: "att1", ref: imageRef, caption: "just a file" },
      { type: "agent_end" },
    ]);
    const t = store.getState().transcript;
    expect(t).toHaveLength(1);
    expect(t[0]!.role).toBe("assistant");
    expect(t[0]!.text).toBe("just a file");
    expect(t[0]!.attachments?.[0]?.hash).toBe(HASH);
  });

  it("ignores malformed attachment events (no entry even after the turn ends)", () => {
    const store = play([
      { type: "attachment", id: "w" }, // no ref
      { type: "attachment", id: "x", ref: { hash: 123, kind: "image" } }, // non-string hash
      { type: "attachment", id: "y", ref: { hash: HASH, kind: "video" } }, // bad kind
      { type: "agent_end" },
    ]);
    expect(store.getState().transcript).toHaveLength(0);
  });
});

describe("agent attachment — history render (grouped onto the final bubble)", () => {
  it("groups an attachment emitted before the final message onto that message", () => {
    const entries = renderHistory([
      { role: "user", content: "make a chart" },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: imageRef, caption: "cap" }] }, // mid-turn attach
      { role: "assistant", content: [{ type: "text", text: "Here's your chart." }] }, // final reply
    ]);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[1]!.text).toBe("Here's your chart.");
    expect(entries[1]!.attachments?.map((a) => a.hash)).toEqual([HASH]);
  });

  it("groups an attachment mixed into the same message onto that message's prose", () => {
    const entries = renderHistory([
      { role: "assistant", content: [{ type: "text", text: "Done — see below." }, { type: "bivy_attachment", ref: imageRef }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Done — see below.");
    expect(entries[0]!.attachments?.map((a) => a.hash)).toEqual([HASH]);
  });

  it("keeps a lone attachment (no prose in its turn) as a standalone entry", () => {
    const entries = renderHistory([
      { role: "assistant", content: [{ type: "bivy_attachment", ref: imageRef, caption: "the chart" }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("the chart");
    expect(entries[0]!.attachments?.[0]?.hash).toBe(HASH);
  });

  it("does not group across turns", () => {
    const entries = renderHistory([
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: "q2" },
      { role: "assistant", content: [{ type: "bivy_attachment", ref: imageRef }] }, // turn 2 has no prose
    ]);
    expect(entries.map((e) => ({ role: e.role, text: e.text, att: e.attachments?.length ?? 0 }))).toEqual([
      { role: "user", text: "q1", att: 0 },
      { role: "assistant", text: "a1", att: 0 }, // untouched — different turn
      { role: "user", text: "q2", att: 0 },
      { role: "assistant", text: "", att: 1 }, // standalone (no prose to hang it on)
    ]);
  });
});

describe("markdown inline images", () => {
  it("renders ![alt](https://…) as a constrained <img>", () => {
    const html = toHtml("![a cat](https://ex.com/cat.png)");
    expect(html).toContain('<img class="md-image"');
    expect(html).toContain('src="https://ex.com/cat.png"');
    expect(html).toContain('alt="a cat"');
    expect(html).toContain('loading="lazy"');
  });

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
