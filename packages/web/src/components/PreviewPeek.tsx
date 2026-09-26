// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useRef, useState } from "react";
import { controller, useAppState } from "../store/useStore.js";
import { seedSessionDraft } from "../shareTarget.js";
import { Sheet } from "./Sheet.js";
import { Dictation, dictationEngine, NO_DICTATION } from "./Dictation.js";

const BLOCKED_KEY = "bivy.previewPeekBlocked";

/** True once this browser refused preview cookies inside Bivy; previews then
 *  open straight in a tab instead of failing in the drawer first. */
export function peekBlocked(): boolean {
  try { return localStorage.getItem(BLOCKED_KEY) === "1"; } catch { return false; }
}

/** An app preview in a drawer over the chat. The framed shell is a separate,
 *  trusted Bivy origin; its messages are drafts for this session's composer
 *  (never sent from here), a report that the browser blocks framed cookies,
 *  or a request to listen. Voice is captured here, never on the preview
 *  origin: audio goes to the node over the encrypted session channel (or
 *  stays in the browser's own dictation), and only the transcript goes back
 *  to the shell's draft box, where it stays editable. */
export function PreviewPeek({ url, name, sessionId, onClose, onOpenInTab }: {
  url: string; name: string; sessionId: string; onClose: () => void; onOpenInTab: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { settings: { sttConfig } } = useAppState();
  const engine = dictationEngine(sttConfig);
  // `stop` counts releases: bumping it finishes the recording like ✓.
  const [listening, setListening] = useState<{ stop: number } | null>(null);
  const origin = new URL(url).origin;

  const toShell = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "bivy", ...message }, origin);
  }, [origin]);
  // Tell the shell whether it may show its mic (again when that changes).
  useEffect(() => { toShell({ type: "voice", available: Boolean(engine) }); }, [engine, toShell]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown; text?: unknown; state?: unknown } | null;
      if (data?.source !== "bivy-preview") return;
      if (data.type === "draft" && typeof data.text === "string") {
        const text = data.text.slice(0, 8000);
        if (!controller.prefillComposer(text)) seedSessionDraft(localStorage, sessionId, text);
        onClose();
      } else if (data.type === "blocked") {
        try { localStorage.setItem(BLOCKED_KEY, "1"); } catch { /* storage unavailable */ }
        setBlocked(true);
      } else if (data.type === "hello") {
        toShell({ type: "voice", available: Boolean(engine) });
      } else if (data.type === "listen") {
        if (data.state === "start") {
          if (engine) setListening((current) => current ?? { stop: 0 });
          else toShell({ type: "transcript", error: NO_DICTATION });
        } else if (data.state === "stop") setListening((current) => current && { stop: current.stop + 1 });
        else if (data.state === "cancel") setListening(null);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [origin, sessionId, onClose, engine, toShell]);

  const done = () => { setListening(null); toShell({ type: "listening", on: false }); };
  return <Sheet title={name} ariaLabel={`Preview: ${name}`} onClose={onClose} size="large" autoFocusSearch={false}
    headExtra={<button className="btn sm ghost" onClick={onOpenInTab}>Open in tab ↗</button>}>
    {blocked
      ? <div className="changes-binary" role="status">This browser doesn’t allow app previews inside Bivy, so previews will open in a tab on this device. <button className="btn sm" onClick={onOpenInTab}>Open in tab ↗</button></div>
      : <div className="preview-peek-stage">
          {listening && engine && <div className="preview-voice">
            <Dictation engine={engine} stop={listening.stop}
              onResult={(text) => toShell({ type: "transcript", text: text.slice(0, 4000) })}
              onCancel={done} onError={(message) => toShell({ type: "transcript", error: message })} />
          </div>}
          <iframe ref={frame} className="preview-peek" src={url} title={name} referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
            // Delegated to Bivy's preview shell, which passes it only to desktop-app viewers.
            allow="clipboard-read; clipboard-write" onLoad={() => toShell({ type: "voice", available: Boolean(engine) })} />
        </div>}
  </Sheet>;
}
