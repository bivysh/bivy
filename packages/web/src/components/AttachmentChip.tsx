// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The attachment chip and the fullscreen gallery its image chips open.
//
// Extracted from ChatView so the message-component registry can render the SAME
// chip for a `::view{src=report.pdf}` that the composer's paperclip and
// `bivy attach` already produce. One chip, one look, one download affordance —
// a second near-identical one is exactly what packages/web/AGENTS.md forbids.
import { useMemo, useState } from "react";
import type { PromptAttachment } from "@bivy/core";

import { ImageGallery } from "./ImageGallery.js";
import { fmtBytes, useAttachmentUrl } from "../attachmentUrl.js";

/**
 * A single attachment the user sent with this message, shown as a clickable
 * thumbnail (image) or file chip so they can re-open what they attached. When an
 * `onOpenImage` handler is supplied, a plain left-click on an image launches the
 * in-app gallery instead of opening the raw blob in a new tab; modifier/middle
 * clicks still fall through to the `<a>` so "open in new tab" keeps working.
 */
export function AttachmentChip({ attachment, onOpenImage }: { attachment: PromptAttachment; onOpenImage?: () => void }) {
  const url = useAttachmentUrl(attachment);

  return (
    <div className="msg-attachment">
      {attachment.kind === "image" && url && <a
        className="attach-preview"
        href={url}
        target="_blank"
        rel="noopener"
        title={attachment.name}
        onClick={
          onOpenImage
            ? (e) => {
                // Leave new-tab gestures (cmd/ctrl/shift/middle-click) untouched.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenImage();
              }
            : undefined
        }
      >
        <img src={url} alt={attachment.description || attachment.name} />
      </a>}
      <div className="attach-details">
        <div className="attach-copy">
          <div className="attach-name">{attachment.name}</div>
          <div className="attach-description">{attachment.description || `${attachment.mimeType || (attachment.kind === "image" ? "Image" : "File")} · ${fmtBytes(attachment.size)}`}</div>
        </div>
        {url ? (
          <a className="btn icon attach-download" href={url} download={attachment.name} aria-label={`Download ${attachment.name}`} title={`Download ${attachment.name}`}>
            <DownloadIcon />
          </a>
        ) : (
          <button className="btn icon attach-download" disabled aria-label={`Download ${attachment.name} unavailable`} title="Content unavailable or still loading">
            <DownloadIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function DownloadIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5" /></svg>;
}

/**
 * The row of attachment chips under a message, plus the fullscreen gallery its
 * image chips open. Owns the open/closed gallery state locally so paging stays
 * scoped to this message's images (the reader's chosen scope). Omitted images are
 * left out of the gallery set — they have no bytes to show.
 */
export function MessageAttachments({ attachments }: { attachments: PromptAttachment[] }) {
  const images = useMemo(() => attachments.filter((a) => a.kind === "image" && !a.omitted), [attachments]);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  return (
    <div className="msg-attachments">
      {attachments.map((a, i) => {
        const imageIndex = images.indexOf(a);
        return (
          <AttachmentChip
            key={`${a.name}-${i}`}
            attachment={a}
            onOpenImage={imageIndex >= 0 ? () => setGalleryIndex(imageIndex) : undefined}
          />
        );
      })}
      {galleryIndex !== null && (
        <ImageGallery images={images} index={galleryIndex} onClose={() => setGalleryIndex(null)} />
      )}
    </div>
  );
}
