// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AppReview, ReviewCardMode, ReviewShot, SessionAppsResult } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { AppsSheet, REVIEW_MODE_LABELS, notesDraft } from "./AppsSheet.js";
import { seedSessionDraft } from "../shareTarget.js";
import { AppRow, appInitial } from "./AppRow.js";
import { Spinner } from "./Spinner.js";
import { AppAccess } from "./AppAccess.js";
import { MoreMenu } from "./MoreMenu.js";
import { noteAttachments } from "./reviewerNotes.js";

/** What made the card, as its one line of detail. */
const TRIGGER_LABELS: Record<AppReview["trigger"], string> = {
  present: "Ready to review",
  run: "Changed in this run",
  asked: "As it looks now",
  notes: "Reviewer notes",
};

/** A screenshot fetched by hash over the session's encrypted channel. */
function useShot(shot: ReviewShot | undefined): { url: string | null; state: "none" | "loading" | "ready" | "missing" } {
  const [result, setResult] = useState<{ hash?: string; url: string | null; missing: boolean }>({ url: null, missing: false });
  useEffect(() => {
    if (!shot) return;
    let live = true;
    let url: string | null = null;
    void controller.fetchAttachment(shot.hash).then((res) => {
      if (!live) return;
      if (res) {
        const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || "image/png" }));
      }
      setResult({ hash: shot.hash, url, missing: !res });
    }, () => { if (live) setResult({ hash: shot.hash, url: null, missing: true }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [shot?.hash]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shot) return { url: null, state: "none" };
  if (result.hash !== shot.hash) return { url: null, state: "loading" };
  return { url: result.url, state: result.missing ? "missing" : "ready" };
}

/**
 * The app at a moment worth judging: its screenshot at phone width, a
 * Before/Now switch when the run changed it, and one primary action. Updated
 * in place while the run goes on; a newer card for the view retires its
 * pictures ("no longer stored"). Screenshots are encrypted attachments.
 */
export function ReviewCard({ review }: { review: AppReview }) {
  const { connection, activeSession } = useAppState();
  // Mute applies to the run in progress.
  const working = activeSession.activeSessionId === review.sessionId && activeSession.working;
  const online = connection.status === "online";
  const card = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    if (card.current) observer.observe(card.current);
    return () => observer.disconnect();
  }, []);
  // Historical cards must not flood the encrypted channel on session load.
  const now = useShot(!visible || review.expired ? undefined : review.shot);
  const before = useShot(!visible || review.expired ? undefined : review.before);
  const [side, setSide] = useState<"before" | "now">("now");
  const [sheet, setSheet] = useState<false | "preview" | "apps">(false);
  const [mode, setMode] = useState<ReviewCardMode | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const hasBefore = before.state === "ready" && now.state === "ready";
  const shown = side === "before" && hasBefore ? before : now;

  // The mode lives with the app on the machine; read it when the menu opens.
  const loadMode = () => {
    if (mode) return;
    void controller.appCommand("apps.list", review.sessionId).then((event) => {
      const app = (event as unknown as SessionAppsResult).apps?.find((item) => item.id === review.appId);
      setMode(app?.reviewMode ?? "ready");
    }, () => {});
  };
  const run = async (label: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(true); setStatus("");
    try { await action(); if (done) setStatus(done); }
    catch (e) { setStatus(e instanceof Error ? e.message : `Could not ${label}.`); }
    finally { setBusy(false); }
  };
  const showMe = () => run("take a screenshot", () => controller.appCommand("apps.showMe", review.sessionId, { appId: review.appId }));
  const chooseMode = (next: ReviewCardMode) => run("change preview cards", async () => {
    await controller.appCommand("apps.reviewMode", review.sessionId, { appId: review.appId, mode: next });
    setMode(next);
  }, next === "off" ? `No more cards for ${review.name}. Show me still works.` : `Preview cards: ${REVIEW_MODE_LABELS[next].toLowerCase()}.`);
  // Turning screenshots on is the user's explicit choice here, never automatic.
  // The notes live on the machine; fetch the current ones and draft them. Nothing is sent.
  const draftNotes = () => run("read the notes", async () => {
    const event = await controller.appCommand("apps.list", review.sessionId);
    const view = (event as unknown as SessionAppsResult).apps?.find((item) => item.id === review.appId)?.views.find((item) => item.id === review.viewId);
    const notes = view?.kind === "web" ? view.notes ?? [] : [];
    if (!notes.length) { setStatus("These notes were cleared."); return; }
    const text = notesDraft(view!.name, notes);
    const attachments = await noteAttachments(notes);
    if (!controller.prefillComposer(text, attachments)) {
      if (attachments.length) throw new Error("Open this session’s chat before adding reviewer pictures.");
      seedSessionDraft(localStorage, review.sessionId, text);
    }
  }, "Added to your message. Nothing is sent until you send it.");
  const enableShots = () => run("turn on screenshots", async () => {
    await controller.setNodeSettings({ appScreenshots: true });
    await controller.appCommand("apps.showMe", review.sessionId, { appId: review.appId });
  });

  const label = `${review.name}${review.view && review.view !== review.name ? ` · ${review.view}` : ""}`;
  const meta = `${TRIGGER_LABELS[review.trigger]} · ${review.path}`;
  return <>
    <section ref={card} className="apps-card review-card" aria-label={`${review.name}: ${TRIGGER_LABELS[review.trigger].toLowerCase()}`}>
      <AppRow tile={appInitial(review.name)} name={label} meta={meta}
        action={<MoreMenu label={`Preview card options for ${review.name}`} onOpen={loadMode} items={[
          { label: "App options", onSelect: () => setSheet("apps") },
          { heading: "Preview cards" },
          ...(["ready", "every", "off"] as const).map((item) => ({ label: REVIEW_MODE_LABELS[item], checked: mode ? mode === item : undefined, disabled: busy || !online || !mode, onSelect: () => void chooseMode(item) })),
          ...(working ? [{ label: "Mute for this run", disabled: busy || !online, separated: true, onSelect: () => void run("mute", () => controller.appCommand("apps.mute", review.sessionId), "Muted until the agent’s next run.") }] : []),
          { label: "Show me now", disabled: busy || !online, separated: !working, onSelect: () => void showMe() },
        ]} />} />

      {review.trigger === "notes" ? null : review.screenshotsOff && !review.shot ? <div className="banner inline review-banner" data-tone="neutral" role="status">
        <span className="banner-text">Turn on agent screenshots to see the app here. Bivy takes them with Chrome on this machine.</span>
        <span className="banner-actions"><button className="btn" disabled={busy || !online} onClick={() => void enableShots()}>Turn on</button></span>
      </div> : <div className="review-stage">
        {review.expired || shown.state === "missing" || !review.shot
          ? <p className="review-gone">{review.expired || shown.state === "missing" ? "Screenshot no longer stored" : "No screenshot this time"}</p>
          : <button type="button" className="review-shot" style={review.shot ? { aspectRatio: `${review.shot.width} / ${review.shot.height}`, blockSize: "var(--review-shot-height)", maxInlineSize: "100%" } : undefined} onClick={() => setSheet("preview")} aria-label={`Open preview of ${review.name} at ${review.path}`}>
              {shown.url ? <img src={shown.url} alt={`${review.name} at ${review.path}, ${side === "before" && hasBefore ? "before this run" : "now"}`} width={review.shot?.width} height={review.shot?.height} />
                : <span className="review-loading"><Spinner size="sm" /><span className="sr-only">Loading screenshot…</span></span>}
            </button>}
        {review.before && !review.expired && <div className="segmented review-side" role="radiogroup" aria-label="Show the app">
          {(["before", "now"] as const).map((item) => <button key={item} type="button" role="radio" className="seg-btn" disabled={!hasBefore} aria-checked={side === item} onClick={() => setSide(item)}>
            {item === "before" ? "Before" : "Now"}</button>)}
        </div>}
      </div>}

      {review.note && <p className="review-note">{review.note}</p>}
      {review.notes ? <div className="banner inline review-banner" data-tone="neutral" role="group" aria-label={`Reviewer notes on ${label}`}>
        <span className="banner-text">{review.notes === 1 ? "1 note" : `${review.notes} notes`} from people with a shared link. They reach the agent only if you send them.</span>
        <span className="banner-actions">
          <button className="btn sm" disabled={busy || !online} onClick={() => void draftNotes()}>Add to message</button>
          <button className="btn sm ghost" disabled={!online} onClick={() => setSheet("apps")}>Open in Apps</button>
        </span>
      </div> : null}
      {status && <p className="review-status" role="status">{status}</p>}
      <div className="review-actions">
        <button className={`btn${review.trigger === "notes" ? "" : " primary"}`} disabled={!online} onClick={() => setSheet("preview")}>Open preview</button>
        <AppAccess sessionId={review.sessionId} appId={review.appId} viewId={review.viewId} name={review.view || review.name} disabled={!online} />
      </div>
    </section>
    {sheet && <AppsSheet sessionId={review.sessionId} appId={review.appId} openView={sheet === "preview" ? { viewId: review.viewId, path: review.path } : undefined} onClose={() => setSheet(false)} />}
  </>;
}
