// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest";
import { dedupeInboxItems, inboxItemId, isInboxAdvert, type InboxItem } from "../src/inbox.js";

function item(updatedAt: string, title = "old"): InboxItem {
  return {
    id: inboxItemId("session", "s1", "condition-1"),
    kind: "approval", severity: "warning", source: "session", state: "unresolved",
    sessionId: "s1", title, createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
  };
}

describe("global inbox normalization", () => {
  it("uses a deterministic identity for one unresolved condition", () => {
    expect(inboxItemId("session", "s1", "a1")).toBe("session:s1:a1");
  });

  it("deduplicates repeated adverts and keeps the newest projection", () => {
    const result = dedupeInboxItems([
      item("2026-01-01T00:00:01.000Z"),
      item("2026-01-01T00:00:02.000Z", "new"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("new");
  });

  it("accepts only the bounded content-free advert vocabulary", () => {
    expect(isInboxAdvert({ id: "a1", kind: "approval", severity: "warning", createdAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isInboxAdvert({ id: "a1", kind: "tool-body", severity: "warning", createdAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });
});
