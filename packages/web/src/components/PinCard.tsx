// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AppPin, AppPinState } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { requestAppsSheet } from "../appsSheetRequest.js";
import { AppRow, appInitial } from "./AppRow.js";
import { Spinner } from "./Spinner.js";
import { Badge, type BadgeTone } from "./Badge.js";

/** What each state says, and how it reads. A new state is a new row. */
const STATES: Record<AppPinState, { label: string; tone?: BadgeTone; detail: string }> = {
  open: { label: "Open", detail: "Nothing has changed here yet." },
  changed: { label: "Changed", tone: "ok", detail: "A later run changed what you marked. Have a look." },
  gone: { label: "Element gone", tone: "warn", detail: "What you marked is no longer on the page." },
  done: { label: "Done", tone: "ok", detail: "You marked this done." },
};

/**
 * A pin: what someone marked in a preview, the words they sent with it, and
 * what became of it. The same feedback used to travel as a paragraph of
 * selectors and coordinates in a message, which said nothing afterwards; a pin
 * keeps its place in the chat and moves its state on evidence — the pixels it
 * marked changed, or what it named left the page.
 */
export function PinCard({ pin }: { pin: AppPin }) {
  const { connection } = useAppState();
  const online = connection.status === "online";
  const card = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Historical pins must not flood the encrypted channel on session load.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    if (card.current) observer.observe(card.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !pin.shot) return;
    let live = true;
    let made: string | null = null;
    void controller.fetchAttachment(pin.shot.hash).then((res) => {
      if (!live) return;
      if (!res) { setMissing(true); return; }
      const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
      made = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || "image/png" }));
      setUrl(made);
    }, () => { if (live) setMissing(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [visible, pin.shot?.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = STATES[pin.state];
  const setState = async (next: AppPinState) => {
    setBusy(true); setError("");
    try { await controller.appCommand("apps.pinState", pin.sessionId, { pinId: pin.id, state: next }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update this pin."); }
    finally { setBusy(false); }
  };
  const openPreview = () => requestAppsSheet({ sessionId: pin.sessionId, appId: pin.appId, openView: { viewId: pin.viewId, path: pin.path } });
  return <section ref={card} className="apps-card review-card pin-card" aria-label={`${pin.number ? `Note ${pin.number} p` : "P"}inned on ${pin.name}: ${state.label.toLowerCase()}`}>
    <AppRow tile={appInitial(pin.name)} name={`${pin.name}${pin.view && pin.view !== pin.name ? ` · ${pin.view}` : ""}`}
      meta={`${pin.number ? `Note ${pin.number} · ` : ""}Pinned · ${pin.path}`}
      action={<Badge tone={state.tone}>{state.label}</Badge>} />
    {pin.shot && !missing
      ? <div className="review-stage">
          <button type="button" className="review-shot" style={{ aspectRatio: `${pin.shot.width} / ${pin.shot.height}`, blockSize: "var(--review-shot-height)", maxInlineSize: "100%" }}
            onClick={openPreview} aria-label={`Open the preview of ${pin.name} at ${pin.path}`}>
            {url ? <img src={url} alt={`What you marked on ${pin.name} at ${pin.path}${pin.number ? `, note ${pin.number}` : ""}`} width={pin.shot.width} height={pin.shot.height} />
              : <span className="review-loading"><Spinner size="sm" /><span className="sr-only">Loading what you marked…</span></span>}
          </button>
        </div>
      : <p className="review-gone">{missing ? "Picture no longer stored" : "Marked without a picture"}</p>}
    {pin.words && <p className="review-note">{pin.words}</p>}
    <p className="review-status">{state.detail}</p>
    {error && <p className="review-status" role="alert">{error}</p>}
    <div className="review-actions">
      <button className="btn primary" disabled={!online} onClick={openPreview}>Open preview</button>
      {pin.state === "done"
        ? <button className="btn ghost" disabled={busy || !online} onClick={() => void setState("open")}>Reopen</button>
        : <button className="btn" disabled={busy || !online} onClick={() => void setState("done")}>Mark done</button>}
    </div>
  </section>;
}
