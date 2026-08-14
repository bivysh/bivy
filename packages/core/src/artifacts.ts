// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The Session/Run Artifacts projection: a bounded index of the durable,
// content-addressed attachments a session's transcript already carries —
// screenshots, reports, benchmark results, build archives, anything an agent
// surfaced with `bivy attach` / `attach_to_chat`, plus the images a user
// uploaded and any remote markdown image the node resolved inline. Deliberately
// NOT a new wire command: every field here is already present on the
// TranscriptEntry[] the client renders (see store.ts / store-render.ts), so
// deriveArtifacts is a pure, synchronous fold over data the store already
// holds — no arbitrary filesystem indexing, no second blob store, no extra
// round trip to the node.
//
// Scope is implicitly one session: this never reaches across sessions, and it
// never touches the control plane — bytes and filenames stay on the node,
// exactly as they do for an ordinary chat attachment (see AttachmentStore /
// controller.fetchAttachment). A session's Run linkage (when it has one) is
// resolved separately, by the existing session↔Run evidence join (see
// runEvidence.ts in the web package) — this module has no notion of a Run.
//
// "Availability" (whether the bytes are still on the Machine, or the node is
// offline/pruned them) is deliberately NOT a field here: it can only be known
// by attempting controller.fetchAttachment(hash) at render time, exactly like
// an ordinary attachment chip does. Baking a stale boolean into this
// projection would be dishonest the moment the node's state changes under it.

import type { AttachmentRef, PromptAttachment } from "./protocol.js";
import type { TranscriptEntry } from "./store.js";

/** Where an artifact's bytes originated. */
export type ArtifactOrigin =
  | "agent" // an outbound `bivy attach` / `attach_to_chat` call
  | "user" // a composer upload
  | "inline"; // a remote markdown image the node fetched and resolved

export interface ArtifactEntry {
  /** Unique React/list key — the hash alone isn't guaranteed unique across
   *  distinct transcript entries (rare, but the same bytes can legitimately be
   *  attached twice with different captions), so this pairs it with the
   *  originating entry id. */
  id: string;
  /** SHA-256 content hash — the durable, re-findable address (see
   *  AttachmentStore on the node). */
  hash: string;
  /** Sanitized display filename (already confined/sanitized server-side). */
  name: string;
  mimeType: string;
  kind: "image" | "file";
  size: number;
  /** The agent's caption (an agent-attachment entry's text), when present. */
  caption?: string;
  /** Epoch ms this was produced, when known (see PromptAttachment.createdAt) —
   *  absent for a plain user upload, which has no durable timestamp today. */
  createdAt?: number;
  /** Explicitly marked as a named artifact via `--artifact` / `artifact: true`
   *  (see PromptAttachment.artifact). False for an ordinary attachment/inline
   *  image — still listed, just not badged. */
  artifact: boolean;
  origin: ArtifactOrigin;
  /** The TranscriptEntry this artifact renders under — the sheet's "jump to
   *  this turn" link targets this id. */
  entryId: string;
}

/** Hard cap on the projection, mirroring the node's own bounded-log caps
 *  (e.g. foldTool's 500) — a runaway/looping agent that spams attachments
 *  can't grow this into an unbounded list; the sheet always stays scrollable. */
export const MAX_ARTIFACTS = 500;

function fromAttachment(entry: TranscriptEntry, a: PromptAttachment): ArtifactEntry | null {
  if (!a.hash) return null; // not yet durably stored (in-flight send) — nothing to index yet
  return {
    id: `${entry.id}:${a.hash}`,
    hash: a.hash,
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    size: a.size,
    caption: entry.role === "assistant" && entry.text ? entry.text : undefined,
    createdAt: a.createdAt,
    artifact: Boolean(a.artifact),
    origin: entry.role === "assistant" ? "agent" : "user",
    entryId: entry.id,
  };
}

function fromInlineRef(entry: TranscriptEntry, ref: AttachmentRef): ArtifactEntry {
  return {
    id: `${entry.id}:${ref.hash}`,
    hash: ref.hash,
    name: ref.name,
    mimeType: ref.mimeType,
    kind: ref.kind,
    size: ref.size,
    artifact: false,
    origin: "inline",
    entryId: entry.id,
  };
}

/** A later duplicate of the same hash never demotes an earlier explicit
 *  "artifact" marking — a re-emitted/re-resolved reference should never make a
 *  deliberately-named artifact quietly lose its badge. */
function preferring(existing: ArtifactEntry | undefined, next: ArtifactEntry): ArtifactEntry {
  if (!existing) return next;
  return existing.artifact && !next.artifact ? { ...next, artifact: true } : next;
}

/**
 * Fold a session's transcript into the bounded, deduped Artifacts list. Dedupe
 * key is the content hash (identical bytes are one artifact no matter how many
 * times they were referenced); last-seen wins for display fields (name/caption/
 * createdAt), except an `artifact` flag is sticky once set. Sorted newest-first
 * — entries with no known `createdAt` (todays's plain user uploads) sort last,
 * never masquerading as "just now".
 */
export function deriveArtifacts(transcript: readonly TranscriptEntry[]): ArtifactEntry[] {
  const byHash = new Map<string, ArtifactEntry>();
  for (const entry of transcript) {
    for (const a of entry.attachments ?? []) {
      const next = fromAttachment(entry, a);
      if (next) byHash.set(next.hash, preferring(byHash.get(next.hash), next));
    }
    for (const ref of Object.values(entry.imageRefs ?? {})) {
      if (!ref?.hash || byHash.has(ref.hash)) continue; // an attachment chip already covers this hash with richer metadata
      byHash.set(ref.hash, fromInlineRef(entry, ref));
    }
  }
  const list = [...byHash.values()].sort((x, y) => (y.createdAt ?? -1) - (x.createdAt ?? -1));
  return list.slice(0, MAX_ARTIFACTS);
}
