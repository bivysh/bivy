// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useRef, useState } from "react";
import { controller, useAppState } from "../store/useStore.js";
import { seedSessionDraft } from "../shareTarget.js";
import { Sheet } from "./Sheet.js";
import { Dictation, dictationEngine, NO_DICTATION } from "./Dictation.js";
import { Spinner } from "./Spinner.js";
import type { PromptAttachment } from "@bivy/core";

/** Marks drawn in the preview, as the shell hands them over (see apps.annotate). */
type Mark = { path?: string; viewport: { width: number; height: number }; scroll?: { x: number; y: number }; dpr?: number; theme?: string; strokes: unknown[]; compare?: number; signals?: Record<string, boolean> };
type Annotated = { image?: { data: string; mimeType: string; name: string }; approximate: boolean; screenshotsOff?: boolean };
const APPROXIMATE = "Picture: retaken on the machine, so it may not show this page’s state (a cart, a sign-in, an open menu). The marks and elements are exact.";

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
export function PreviewPeek({ url, name, sessionId, appId, viewId, onClose, onOpenInTab }: {
  url: string; name: string; sessionId: string; onClose: () => void; onOpenInTab: () => void;
  /** The view shown: Draw asks the machine for a picture of it. */
  appId?: string; viewId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { settings: { sttConfig } } = useAppState();
  const engine = dictationEngine(sttConfig);
  // `stop` counts releases: bumping it finishes the recording like ✓.
  const [listening, setListening] = useState<{ stop: number } | null>(null);
  const origin = new URL(url).origin;
  // Draw: the marked-up picture is being made, or needs the user's choice.
  const [marking, setMarking] = useState<null | { state: "working" } | { state: "off" | "failed"; text: string; mark: Mark; message?: string }>(null);

  const toShell = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "bivy", ...message }, origin);
  }, [origin]);
  const canDraw = Boolean(appId && viewId);
  const capabilities = useCallback(() => { toShell({ type: "voice", available: Boolean(engine) }); toShell({ type: "draw", available: canDraw }); }, [engine, canDraw, toShell]);
  // Tell the shell whether it may show its mic and Draw (again when that changes).
  useEffect(() => { capabilities(); }, [capabilities]);

  const deliver = useCallback((text: string, attachments: PromptAttachment[] = []) => {
    if (!controller.prefillComposer(text, attachments)) seedSessionDraft(localStorage, sessionId, text);
    setMarking(null);
    onClose();
  }, [sessionId, onClose]);
  /** The user's words and marks, plus a picture of what they marked: made on
   *  the machine and fetched over the session channel, never the preview's. */
  const addMarked = useCallback(async (text: string, mark: Mark) => {
    if (!appId || !viewId) return deliver(text);
    setMarking({ state: "working" });
    try {
      const result = await controller.appCommand("apps.annotate", sessionId, { appId, viewId, ...mark }) as unknown as Annotated;
      if (result.screenshotsOff || !result.image) { setMarking({ state: "off", text, mark }); return; }
      const image = result.image;
      const attachment: PromptAttachment = { kind: "image", mimeType: image.mimeType, data: image.data, size: Math.round((image.data.length * 3) / 4),
        name: result.approximate ? image.name.replace(/\.png$/, " (approximate).png") : image.name };
      deliver(result.approximate ? `${text}\n${APPROXIMATE}` : text, [attachment]);
    } catch (e) { setMarking({ state: "failed", text, mark, message: e instanceof Error ? e.message : "Couldn’t take the picture." }); }
  }, [appId, viewId, sessionId, deliver]);
  // Turning screenshots on is the user's explicit choice here, never automatic.
  const enableShots = async (text: string, mark: Mark) => {
    setMarking({ state: "working" });
    try { await controller.setNodeSettings({ appScreenshots: true }); await addMarked(text, mark); }
    catch (e) { setMarking({ state: "failed", text, mark, message: e instanceof Error ? e.message : "Couldn’t turn on screenshots." }); }
  };

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
        capabilities();
      } else if (data.type === "annotation" && typeof data.text === "string" && (data as { mark?: unknown }).mark) {
        void addMarked(data.text.slice(0, 8000), (data as unknown as { mark: Mark }).mark);
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
  }, [origin, sessionId, onClose, engine, toShell, capabilities, addMarked]);

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
            allow="clipboard-read; clipboard-write" onLoad={capabilities} />
          {marking && <div className="preview-marking" role={marking.state === "working" ? "status" : "alert"}>
            {marking.state === "working"
              ? <div className="banner inline" data-tone="neutral"><Spinner size="sm" /><span className="banner-text">Adding a picture of what you marked…</span></div>
              : <div className="banner inline" data-tone={marking.state === "off" ? "neutral" : "danger"}>
                  <span className="banner-text">{marking.state === "off"
                    ? "Screenshots are off on this machine, so there’s no picture. Your marks and the elements you marked still go with your words."
                    : `Couldn’t add the picture: ${marking.message}`}</span>
                  <span className="banner-actions">
                    {marking.state === "off"
                      ? <button className="btn primary" onClick={() => void enableShots(marking.text, marking.mark)}>Turn on and add picture</button>
                      : <button className="btn" onClick={() => void addMarked(marking.text, marking.mark)}>Try again</button>}
                    <button className="btn ghost" onClick={() => deliver(marking.text)}>Add without picture</button>
                  </span>
                </div>}
          </div>}
        </div>}
  </Sheet>;
}
