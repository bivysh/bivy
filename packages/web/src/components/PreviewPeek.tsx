// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { controller } from "../store/useStore.js";
import { seedSessionDraft } from "../shareTarget.js";
import { Sheet } from "./Sheet.js";

const BLOCKED_KEY = "bivy.previewPeekBlocked";

/** True once this browser refused preview cookies inside Bivy; previews then
 *  open straight in a tab instead of failing in the drawer first. */
export function peekBlocked(): boolean {
  try { return localStorage.getItem(BLOCKED_KEY) === "1"; } catch { return false; }
}

/** An app preview in a drawer over the chat. The framed shell is a separate,
 *  trusted Bivy origin; its messages are drafts for this session's composer
 *  (never sent from here) or a report that the browser blocks framed cookies. */
export function PreviewPeek({ url, name, sessionId, onClose, onOpenInTab }: {
  url: string; name: string; sessionId: string; onClose: () => void; onOpenInTab: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [blocked, setBlocked] = useState(false);
  const origin = new URL(url).origin;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown; text?: unknown } | null;
      if (data?.source !== "bivy-preview") return;
      if (data.type === "draft" && typeof data.text === "string") {
        const text = data.text.slice(0, 8000);
        if (!controller.prefillComposer(text)) seedSessionDraft(localStorage, sessionId, text);
        onClose();
      } else if (data.type === "blocked") {
        try { localStorage.setItem(BLOCKED_KEY, "1"); } catch { /* storage unavailable */ }
        setBlocked(true);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [origin, sessionId, onClose]);

  return <Sheet title={name} ariaLabel={`Preview: ${name}`} onClose={onClose} size="large" autoFocusSearch={false}
    headExtra={<button className="btn sm ghost" onClick={onOpenInTab}>Open in tab ↗</button>}>
    {blocked
      ? <div className="changes-binary" role="status">This browser doesn’t allow app previews inside Bivy, so previews will open in a tab on this device. <button className="btn sm" onClick={onOpenInTab}>Open in tab ↗</button></div>
      : <iframe ref={frame} className="preview-peek" src={url} title={name} referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
          // Delegated to Bivy's preview shell, which passes it only to desktop-app viewers.
          allow="clipboard-read; clipboard-write" />}
  </Sheet>;
}
