// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useState } from "react";
import type { PromptAttachment } from "@bivy/core";
import { useAttachmentUrl } from "../attachmentUrl.js";
import { ImageViewer } from "./ImageViewer.js";

/** Resolve gallery attachments lazily; the viewer owns gestures and focus. */
export function ImageGallery({ images, index, onClose }: {
  images: PromptAttachment[]; index: number; onClose: () => void;
}) {
  const [current, setCurrent] = useState(index);
  const count = images.length;
  useEffect(() => setCurrent(index), [index]);
  const go = useCallback(
    (delta: number) => setCurrent((c) => (count ? (c + delta + count) % count : 0)),
    [count],
  );
  const attachment = images[current];
  const url = useAttachmentUrl(attachment);
  return <ImageViewer key={`${current}:${url}`} src={url} name={attachment?.name ?? "Image"}
    current={current} count={count} onNavigate={go} onClose={onClose} />;
}
