// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { PromptAttachment } from "@bivy/core";

export interface PendingAttachmentMetadata {
  name: string;
  size: number;
  mimeType: string;
  kind: "image" | "file";
}

export interface ComposerDraftSnapshot {
  version: 2;
  text: string;
  attachments: PendingAttachmentMetadata[];
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function composerDraftKey(sessionId?: string | null): string {
  return `bivy.composer.${sessionId || "new"}`;
}

/** Legacy v1 metadata key, retained for one-way migration. */
export function composerMetadataKey(sessionId?: string | null): string {
  return `${composerDraftKey(sessionId)}.metadata`;
}

export function composerSnapshotKey(sessionId?: string | null): string {
  return `${composerDraftKey(sessionId)}.snapshot`;
}

function safeMetadata(value: unknown): PendingAttachmentMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<PendingAttachmentMetadata>;
    if (
      (candidate.kind !== "image" && candidate.kind !== "file") ||
      typeof candidate.name !== "string" || !candidate.name ||
      typeof candidate.size !== "number" || !Number.isFinite(candidate.size) || candidate.size < 0 ||
      typeof candidate.mimeType !== "string"
    ) return [];
    return [{
      kind: candidate.kind,
      name: candidate.name.slice(0, 255),
      size: candidate.size,
      mimeType: candidate.mimeType.slice(0, 255),
    }];
  }).slice(0, 12);
}

function emptySnapshot(text = ""): ComposerDraftSnapshot {
  return { version: 2, text, attachments: [] };
}

/** Read the atomic v2 snapshot, then fall back to the long-standing v1 keys. */
export function readComposerDraft(storage: DraftStorage, sessionId?: string | null): ComposerDraftSnapshot {
  try {
    const raw = storage.getItem(composerSnapshotKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: unknown; text?: unknown; attachments?: unknown };
      if (parsed.version === 2 && typeof parsed.text === "string") {
        return { version: 2, text: parsed.text, attachments: safeMetadata(parsed.attachments) };
      }
    }
  } catch { /* corrupt or unavailable snapshots fall through to legacy data */ }

  let text = "";
  let attachments: PendingAttachmentMetadata[] = [];
  try { text = storage.getItem(composerDraftKey(sessionId)) || ""; } catch { /* unavailable storage */ }
  try {
    const raw = storage.getItem(composerMetadataKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: unknown; attachments?: unknown };
      if (parsed.version === 1) attachments = safeMetadata(parsed.attachments);
    }
  } catch { /* corrupt or unavailable metadata fails closed */ }
  return { ...emptySnapshot(text), attachments };
}

/**
 * Persist one atomic text + byte-less metadata snapshot. File bytes and
 * extracted text never enter browser storage. The old plain-text key is only a
 * compatibility mirror; reads prefer the coherent snapshot if a reload lands
 * between writes.
 */
export function writeComposerDraft(
  storage: DraftStorage,
  sessionId: string | null | undefined,
  text: string,
  attachments: Array<PromptAttachment | PendingAttachmentMetadata>,
): void {
  const textKey = composerDraftKey(sessionId);
  const metadataKey = composerMetadataKey(sessionId);
  const snapshotKey = composerSnapshotKey(sessionId);
  const safe = safeMetadata(attachments);

  try {
    if (!text && safe.length === 0) storage.removeItem(snapshotKey);
    else storage.setItem(snapshotKey, JSON.stringify({ version: 2, text, attachments: safe }));
  } catch {
    // Do not update compatibility keys after an atomic snapshot failure: keeping
    // the previous coherent draft is safer than manufacturing a torn new one.
    return;
  }

  try {
    if (text) storage.setItem(textKey, text); else storage.removeItem(textKey);
    storage.removeItem(metadataKey);
  } catch { /* the v2 snapshot above is already complete */ }
}

export function clearComposerDraft(storage: DraftStorage, sessionId?: string | null): void {
  try { storage.removeItem(composerSnapshotKey(sessionId)); } catch {}
  try { storage.removeItem(composerDraftKey(sessionId)); } catch {}
  try { storage.removeItem(composerMetadataKey(sessionId)); } catch {}
}
