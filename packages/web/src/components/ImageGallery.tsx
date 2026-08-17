// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptAttachment } from "@bivy/core";
import { useAttachmentUrl } from "./ChatView.js";
import { useModalEscape } from "../modalStack.js";
import { Spinner } from "./Spinner.js";

// Commit a swipe only when the motion is dominantly horizontal and travels far
// enough — same intent as useEdgeSwipe, kept local so it never fights vertical
// scrolling of the (usually taller-than-viewport) image.
const SWIPE_THRESHOLD = 48;

/**
 * Fullscreen, navigable image viewer for the images attached to one chat message.
 * Opens on the tapped image and lets the reader page through the rest — arrow
 * keys, on-screen prev/next, or a horizontal swipe — without closing and
 * reopening each one. Reuses the composer's `.image-viewer` overlay and the
 * shared modal-escape stack. Bytes for each image resolve lazily through the same
 * `useAttachmentUrl` path as the inline thumbnails.
 */
export function ImageGallery({
  images,
  index,
  onClose,
}: {
  images: PromptAttachment[];
  index: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(index);
  const count = images.length;

  // Re-seed if the caller opens a different image while mounted.
  useEffect(() => setCurrent(index), [index]);

  const go = useCallback(
    (delta: number) => setCurrent((c) => (count ? (c + delta + count) % count : 0)),
    [count],
  );

  useModalEscape(onClose);

  // Arrow-key navigation. Escape is owned by the modal-escape stack above.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  };

  const attachment = images[current];
  const url = useAttachmentUrl(attachment);

  return createPortal(
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${current + 1} of ${count}`}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {url ? (
        <img
          className="image-viewer-img"
          src={url}
          alt={attachment?.name ?? "Image"}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <Spinner size="lg" tone="inverse" />
      )}

      {count > 1 && (
        <>
          <button
            type="button"
            className="image-viewer-nav prev"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous image"
          >
            ‹
          </button>
          <button
            type="button"
            className="image-viewer-nav next"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next image"
          >
            ›
          </button>
          <div className="image-viewer-count" onClick={(e) => e.stopPropagation()}>
            {current + 1} / {count}
          </div>
        </>
      )}

      <button type="button" className="image-viewer-close" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>,
    document.body,
  );
}
