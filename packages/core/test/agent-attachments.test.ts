// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Agent-sent (outbound) chat attachments: the live reducer path, the
// history-render path, and inline markdown images.
import { describe, expect, it } from "vitest";
import { SessionStore, renderHistory, toHtml } from "../src/index.js";

const HASH = "a".repeat(64);
const imageRef = { hash: HASH, name: "chart.png", mimeType: "image/png", size: 1234, kind: "image" as const };

describe("agent attachment — live reducer", () => {
  it("an `attachment` event lands as an assistant entry with a rehydratable chip", () => {
    const store = new SessionStore();
    store.apply({ type: "attachment", id: "att1", ref: imageRef, caption: "Here's the chart" } as never);
    const t = store.getState().transcript;
    expect(t).toHaveLength(1);
    expect(t[0]!.role).toBe("assistant");
    expect(t[0]!.text).toBe("Here's the chart");
    expect(t[0]!.attachments).toEqual([{ kind: "image", name: "chart.png", size: 1234, mimeType: "image/png", hash: HASH }]);
  });

  it("seals in-flight prose before the attachment so a caption above it stays above it", () => {
    const store = new SessionStore();
    store.apply({ type: "message_start", message: { role: "assistant", content: "" } } as never);
    store.apply({ type: "message_end", message: { role: "assistant", content: "Rendering it now." } } as never);
    store.apply({ type: "attachment", id: "att1", ref: imageRef } as never);
    const roles = store.getState().transcript.map((e) => ({ role: e.role, text: e.text, hasAttach: !!e.attachments }));
    expect(roles).toEqual([
      { role: "assistant", text: "Rendering it now.", hasAttach: false },
      { role: "assistant", text: "", hasAttach: true },
    ]);
  });

  it("ignores a malformed attachment event (no ref / non-string hash / bad kind)", () => {
    const store = new SessionStore();
    store.apply({ type: "attachment", id: "w" } as never); // no ref
    store.apply({ type: "attachment", id: "x", ref: { hash: 123, kind: "image" } } as never); // non-string hash
    store.apply({ type: "attachment", id: "y", ref: { hash: HASH, kind: "video" } } as never); // bad kind
    expect(store.getState().transcript).toHaveLength(0);
  });
});

describe("agent attachment — history render", () => {
  it("renders a bivy_attachment block into an assistant entry with a chip", () => {
    const entries = renderHistory([
      { role: "assistant", content: [{ type: "bivy_attachment", ref: imageRef, caption: "the chart" }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.role).toBe("assistant");
    expect(entries[0]!.text).toBe("the chart");
    expect(entries[0]!.attachments?.[0]?.hash).toBe(HASH);
  });

  it("keeps prose above the attachment when a message mixes both", () => {
    const entries = renderHistory([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Done — see below." },
          { type: "bivy_attachment", ref: imageRef },
        ],
      },
    ]);
    expect(entries.map((e) => ({ text: e.text, hasAttach: !!e.attachments }))).toEqual([
      { text: "Done — see below.", hasAttach: false },
      { text: "", hasAttach: true },
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
