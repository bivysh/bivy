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
  version: 1;
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

export function composerMetadataKey(sessionId?: string | null): string {
  return `${composerDraftKey(sessionId)}.metadata`;
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
    return [{ kind: candidate.kind, name: candidate.name.slice(0, 255), size: candidate.size, mimeType: candidate.mimeType.slice(0, 255) }];
  }).slice(0, 12);
}

/** Read both the long-standing plain-text key and versioned safe metadata. */
export function readComposerDraft(storage: DraftStorage, sessionId?: string | null): ComposerDraftSnapshot {
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
  return { version: 1, text, attachments };
}

/** Persist names/types/sizes only. File bytes and extracted text never enter localStorage. */
export function writeComposerDraft(
  storage: DraftStorage,
  sessionId: string | null | undefined,
  text: string,
  attachments: PromptAttachment[],
): void {
  const key = composerDraftKey(sessionId);
  const metadataKey = composerMetadataKey(sessionId);
  try {
    if (text) storage.setItem(key, text); else storage.removeItem(key);
    if (attachments.length) {
      const safe = attachments.slice(0, 12).map(({ kind, name, size, mimeType }) => ({ kind, name, size, mimeType }));
      storage.setItem(metadataKey, JSON.stringify({ version: 1, attachments: safe }));
    } else storage.removeItem(metadataKey);
  } catch { /* persistence is best-effort; composing must remain available */ }
}

export function clearComposerDraft(storage: DraftStorage, sessionId?: string | null): void {
  try { storage.removeItem(composerDraftKey(sessionId)); } catch {}
  try { storage.removeItem(composerMetadataKey(sessionId)); } catch {}
}
