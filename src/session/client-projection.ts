// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash } from "node:crypto";
import type { AttachmentRef, AttachmentStore } from "./attachment-store.js";
import type { EventLog } from "./event-log.js";

/** A display-only projection. Never edit runtime messages or persisted bases:
 * the model still needs its native image blocks when a session resumes. */
export function createClientProjection(store: AttachmentStore, log: EventLog) {
  const refs = new Map<string, AttachmentRef>();
  return (sessionId: string, value: unknown): unknown => {
    let retained: Set<string> | undefined;
    let changed = false;
    function visit(value: unknown): unknown {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(visit);
      const block = value as Record<string, unknown>;
      const source = block.source as Record<string, unknown> | undefined;
      let data: unknown;
      let mime: unknown;
      if (block.type === "image") {
        data = block.data ?? (source?.type === "base64" ? source.data : undefined);
        mime = block.mimeType ?? source?.media_type;
      } else if (block.type === "image_url" || block.type === "input_image") {
        const url = typeof block.image_url === "string" ? block.image_url : (block.image_url as { url?: unknown })?.url;
        if (typeof url === "string") {
          const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(url);
          if (match) { mime = match[1]; data = match[2]; }
        }
      }
      if (typeof data === "string") {
        try {
          if (data.length > 36 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("Invalid image encoding");
          const mimeType = typeof mime === "string" && /^image\/[a-zA-Z0-9.+-]+$/.test(mime) ? mime : "image/png";
          const cacheKey = createHash("sha256").update(mimeType).update(data).digest("hex");
          let ref = refs.get(cacheKey);
          if (!ref || !store.getPath(ref.hash)) {
            ref = store.put(Buffer.from(data, "base64"), { name: `image.${mimeType.split("/")[1]}`, mimeType, kind: "image" });
            if (refs.size >= 1024) refs.delete(refs.keys().next().value!);
            refs.set(cacheKey, ref);
          }
          const url = `bivy-embedded:${ref.hash}`;
          retained ??= new Set(log.readInlineImages(sessionId).map(([url]) => url));
          if (!retained.has(url)) {
            log.appendInlineImage(sessionId, { url, ref });
            retained.add(url);
            changed = true;
          }
          return { type: "bivy_attachment", ref };
        } catch {
          // Failure is visible in the display, while original data remains in
          // the native transcript. Never fall back to sending the huge bytes.
          return { type: "text", text: "[Image unavailable: could not store this image for display. The original is retained on the machine.]" };
        }
      }
      // Only recognized image blocks are rewritten. Arbitrary strings and tool
      // arguments remain byte-for-byte intact, including large textual results.
      return Object.fromEntries(Object.entries(block).map(([key, child]) => [key, visit(child)]));
    }
    const projected = visit(value);
    if (changed) log.flush(sessionId);
    return projected;
  };
}
