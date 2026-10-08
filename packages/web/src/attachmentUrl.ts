// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Turning a stored attachment into something displayable, and the byte/size
// helpers around it.
//
// This sits below the components on purpose. AttachmentChip renders the
// fullscreen ImageGallery, and the gallery needs the same hook — with the hook
// living in either component, that is an import cycle. A leaf module with no
// component imports keeps it a tree.
import { useEffect, useMemo, useState } from "react";
import type { PromptAttachment } from "@bivy/core";

import { controller } from "./store/useStore.js";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function base64ToBlobUrl(base64: string, mimeType: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  } catch {
    return null; // malformed base64 — fall back to a non-clickable chip
  }
}

/**
 * Resolve an attachment to a displayable blob URL. Two sources of bytes: inline
 * `data`/`text` (present on the client that just sent it), or — for an attachment
 * rehydrated from history — a content `hash` whose bytes are fetched from the
 * node's durable attachment store on demand. The hash path is what makes
 * attachments re-findable after a reload or on another device (see AttachmentStore
 * / controller.fetchAttachment). Returns null while a hash-only attachment is
 * still fetching, or if the bytes are unavailable. Shared by AttachmentChip and
 * the fullscreen ImageGallery.
 */
export function useAttachmentUrl(attachment: PromptAttachment | null | undefined): string | null {
  // Synchronous URL for inline content — bytes we already hold in memory.
  const inlineUrl = useMemo(() => {
    if (!attachment || attachment.omitted) return null;
    if (attachment.data) return base64ToBlobUrl(attachment.data, attachment.mimeType);
    if (attachment.text !== undefined) {
      try {
        return URL.createObjectURL(new Blob([attachment.text], { type: attachment.mimeType || "text/plain" }));
      } catch {
        return null;
      }
    }
    return null;
  }, [attachment]);

  useEffect(() => {
    return () => {
      if (inlineUrl) URL.revokeObjectURL(inlineUrl);
    };
  }, [inlineUrl]);

  // Lazily fetch bytes for a hash-only attachment (rehydrated from history) and
  // turn them into a blob URL, revoking it on unmount / hash change.
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  useEffect(() => {
    setFetchedUrl(null);
    if (inlineUrl || !attachment || attachment.omitted || !attachment.hash) return;
    const mimeType = attachment.mimeType;
    let cancelled = false;
    let objectUrl: string | null = null;
    void controller.fetchAttachment(attachment.hash, attachment.createdAt).then((res) => {
      if (cancelled || !res) return;
      objectUrl = base64ToBlobUrl(res.data, res.mimeType || mimeType);
      if (objectUrl) setFetchedUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [inlineUrl, attachment]);

  return inlineUrl ?? fetchedUrl;
}

/**
 * The text of a stored attachment, for a component that has to read a file's
 * contents rather than link to it (a CSV rendered as a table).
 *
 * Separate from useAttachmentUrl because the need is different: a blob URL is
 * for the browser to load, this is for us to parse. Bounded, because the bytes
 * become a rendered table in the message — a file past the cap reports its size
 * instead of locking the tab up laying out a hundred thousand rows.
 */
export const MAX_COMPONENT_TEXT_BYTES = 512 * 1024;

export type AttachmentText =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "error"; reason: string };

export function useAttachmentText(attachment: PromptAttachment | null | undefined): AttachmentText {
  const [result, setResult] = useState<AttachmentText>({ state: "loading" });
  const hash = attachment?.hash;
  const size = attachment?.size ?? 0;
  useEffect(() => {
    setResult({ state: "loading" });
    if (!hash) return;
    if (size > MAX_COMPONENT_TEXT_BYTES) {
      setResult({ state: "error", reason: `This file is ${fmtBytes(size)} — too large to show here.` });
      return;
    }
    let cancelled = false;
    void controller.fetchAttachment(hash).then((res) => {
      if (cancelled) return;
      if (!res) {
        setResult({ state: "error", reason: "This file could not be read." });
        return;
      }
      try {
        // atob gives latin1 bytes; decode them as UTF-8 so a non-ASCII cell
        // ("Tromsø") survives the round trip.
        const binary = atob(res.data);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        setResult({ state: "ready", text: new TextDecoder().decode(bytes) });
      } catch {
        setResult({ state: "error", reason: "This file could not be read as text." });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hash, size]);
  return result;
}
