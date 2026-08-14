// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { deriveArtifacts, MAX_ARTIFACTS, type ArtifactEntry } from "../src/artifacts.js";
import type { TranscriptEntry } from "../src/store.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function entry(overrides: Partial<TranscriptEntry> & { id: string }): TranscriptEntry {
  return { role: "assistant", text: "", ...overrides } as TranscriptEntry;
}

describe("deriveArtifacts — projection over a session's transcript", () => {
  it("indexes an agent-sent attachment, carrying caption/createdAt/kind/size/mime through", () => {
    const transcript = [
      entry({
        id: "e1",
        role: "assistant",
        text: "Here's the coverage report.",
        attachments: [{ kind: "file", name: "coverage.html", size: 4096, mimeType: "text/html", hash: HASH_A, createdAt: 1000, artifact: true }],
      }),
    ];
    const [a] = deriveArtifacts(transcript);
    expect(a).toMatchObject({
      hash: HASH_A,
      name: "coverage.html",
      mimeType: "text/html",
      kind: "file",
      size: 4096,
      caption: "Here's the coverage report.",
      createdAt: 1000,
      artifact: true,
      origin: "agent",
      entryId: "e1",
    });
  });

  it("indexes a user-uploaded attachment with no caption and origin \"user\"", () => {
    const transcript = [
      entry({ id: "e1", role: "user", text: "check this out", attachments: [{ kind: "image", name: "screenshot.png", size: 10, mimeType: "image/png", hash: HASH_A }] }),
    ];
    const [a] = deriveArtifacts(transcript);
    expect(a.origin).toBe("user");
    expect(a.caption).toBeUndefined();
  });

  it("skips an attachment with no hash yet (in-flight, not durably stored)", () => {
    const transcript = [entry({ id: "e1", role: "user", attachments: [{ kind: "image", name: "x.png", size: 1, mimeType: "image/png" }] })];
    expect(deriveArtifacts(transcript)).toHaveLength(0);
  });

  it("dedupes identical bytes referenced twice, keeping one entry", () => {
    const ref = { kind: "image" as const, name: "chart.png", size: 1, mimeType: "image/png", hash: HASH_A };
    const transcript = [
      entry({ id: "e1", role: "assistant", attachments: [ref] }),
      entry({ id: "e2", role: "assistant", attachments: [{ ...ref, name: "chart-copy.png" }] }),
    ];
    const result = deriveArtifacts(transcript);
    expect(result).toHaveLength(1);
    // Last occurrence's display fields win.
    expect(result[0]!.name).toBe("chart-copy.png");
    expect(result[0]!.entryId).toBe("e2");
  });

  it("a later un-marked duplicate never demotes an earlier explicit artifact marking", () => {
    const ref = { kind: "file" as const, name: "report.pdf", size: 1, mimeType: "application/pdf", hash: HASH_A };
    const transcript = [
      entry({ id: "e1", role: "assistant", attachments: [{ ...ref, artifact: true }] }),
      entry({ id: "e2", role: "assistant", attachments: [ref] }), // re-attached later, no flag
    ];
    expect(deriveArtifacts(transcript)[0]!.artifact).toBe(true);
  });

  it("indexes a resolved inline markdown image, with origin \"inline\"", () => {
    const transcript = [
      entry({
        id: "e1",
        role: "assistant",
        text: "![chart](https://ex.com/c.png)",
        imageRefs: { "https://ex.com/c.png": { hash: HASH_B, name: "c.png", mimeType: "image/png", size: 2, kind: "image" } },
      }),
    ];
    const [a] = deriveArtifacts(transcript);
    expect(a).toMatchObject({ hash: HASH_B, origin: "inline", artifact: false });
  });

  it("prefers an attachment chip over an inline-image ref for the same hash (richer metadata)", () => {
    const transcript = [
      entry({
        id: "e1",
        role: "assistant",
        text: "cap",
        attachments: [{ kind: "image", name: "real-name.png", size: 3, mimeType: "image/png", hash: HASH_A, artifact: true }],
        imageRefs: { "https://ex.com/x.png": { hash: HASH_A, name: "x.png", mimeType: "image/png", size: 3, kind: "image" } },
      }),
    ];
    const result = deriveArtifacts(transcript);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("real-name.png");
    expect(result[0]!.artifact).toBe(true);
  });

  it("sorts newest-first by createdAt, with unknown-time entries sorted last", () => {
    const transcript = [
      entry({ id: "e1", role: "assistant", attachments: [{ kind: "file", name: "old.txt", size: 1, mimeType: "text/plain", hash: HASH_A, createdAt: 100 }] }),
      entry({ id: "e2", role: "assistant", attachments: [{ kind: "file", name: "new.txt", size: 1, mimeType: "text/plain", hash: HASH_B, createdAt: 200 }] }),
      entry({ id: "e3", role: "user", attachments: [{ kind: "file", name: "no-time.txt", size: 1, mimeType: "text/plain", hash: HASH_C }] }),
    ];
    expect(deriveArtifacts(transcript).map((a) => a.name)).toEqual(["new.txt", "old.txt", "no-time.txt"]);
  });

  it("is bounded by MAX_ARTIFACTS even when the transcript has more distinct hashes", () => {
    const transcript: TranscriptEntry[] = [];
    for (let i = 0; i < MAX_ARTIFACTS + 25; i++) {
      const hash = i.toString(16).padStart(64, "0");
      transcript.push(entry({ id: `e${i}`, role: "assistant", attachments: [{ kind: "file", name: `f${i}.txt`, size: 1, mimeType: "text/plain", hash, createdAt: i }] }));
    }
    const result = deriveArtifacts(transcript);
    expect(result).toHaveLength(MAX_ARTIFACTS);
    // The cap keeps the NEWEST — highest createdAt survive, oldest are dropped.
    expect(result[0]!.name).toBe(`f${MAX_ARTIFACTS + 24}.txt`);
  });

  it("returns an empty list for a transcript with no attachments", () => {
    expect(deriveArtifacts([entry({ id: "e1", role: "assistant", text: "just talk" })])).toEqual([] satisfies ArtifactEntry[]);
  });
});
