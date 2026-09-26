// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Destination picker for a share-sheet landing (see shareTarget.ts): what was
// shared can start a fresh session (the default) or continue an existing one.
// Sessions with an app preview show it — the same row as an app anywhere — so
// a screenshot can go where it's compared with the running app. Dismissing the
// sheet — backdrop, Escape, swipe — falls back to the default so nothing
// shared is dropped.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptAttachment, SessionApp, SessionSummary } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { AppRow, appInitial } from "./AppRow.js";
import { ChatBubbleIcon, PlusIcon } from "./UiIcons.js";

/** Rows shown before the list stops being scannable on a phone sheet. */
const MAX_RECENT = 8;

/** Newest-first sessions that can actually receive a draft right now —
 *  provisioning placeholders can't. Exported for tests. */
export function shareDestinations(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => !session.pendingLaunch)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_RECENT);
}

/** A session's app preview, as a share destination names it. */
export interface SharePreview { name: string; path?: string }

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

/** Each session's newest app with a web view, across machines. */
function useSessionPreviews(listApps?: () => Promise<{ items: SessionApp[] }>): Map<string, SharePreview> {
  const [previews, setPreviews] = useState(new Map<string, SharePreview>());
  useEffect(() => {
    let live = true;
    void listApps?.().then((listing) => {
      const found = new Map<string, SharePreview>();
      for (const app of [...listing.items].sort((a, b) => b.createdAt - a.createdAt)) {
        const view = app.views.find((item) => item.kind === "web" && item.lastPath) ?? app.views.find((item) => item.kind === "web");
        if (view && !found.has(app.sessionId)) found.set(app.sessionId, { name: app.name, path: view.kind === "web" ? view.lastPath : undefined });
      }
      if (live) setPreviews(found);
    }, () => {});
    return () => { live = false; };
  }, [listApps]);
  return previews;
}

function Thumb({ image }: { image: PromptAttachment }) {
  const url = useMemo(() => image.data ? `data:${image.mimeType};base64,${image.data}` : "", [image]);
  return url ? <img className="share-thumb" src={url} alt={image.name} /> : null;
}

export function ShareDestinationSheet({
  text,
  images = [],
  sessions,
  listApps,
  onDeliver,
}: {
  /** The shared text, already composed into draft-ready text. */
  text: string;
  /** Shared images, delivered as composer attachments. */
  images?: PromptAttachment[];
  sessions: readonly SessionSummary[];
  /** The account's apps (across machines), to show each session's preview. */
  listApps?: () => Promise<{ items: SessionApp[] }>;
  /** null = new session (also the dismiss fallback); otherwise the picked
   *  session, with its app preview when it has one. */
  onDeliver: (target: SessionSummary | null, preview?: SharePreview) => void;
}) {
  const recent = shareDestinations(sessions);
  const previews = useSessionPreviews(listApps);
  // Deliver exactly once. A pick delivers immediately (the parent then
  // unmounts the sheet); the Sheet's own onClose — which fires for EVERY
  // close, including the one a pick triggers — only delivers the fallback
  // when nothing was picked (backdrop / Escape / swipe dismissal).
  const delivered = useRef(false);
  const deliver = (target: SessionSummary | null) => {
    if (delivered.current) return;
    delivered.current = true;
    onDeliver(target, target ? previews.get(target.sessionId) : undefined);
  };
  const what = images.length ? (images.length === 1 ? "screenshot" : `${images.length} images`) : "text";
  return (
    <Sheet
      title={images.length ? `Send the ${what} to…` : "Send shared text to…"}
      ariaLabel={`Choose where to send the shared ${what}`}
      onClose={() => deliver(null)}
      autoFocusSearch={false}
    >
      <div className="share-sheet">
        {(images.length > 0 || text) && <figure className="share-shared">
          {images.length > 0 && <div className="share-thumbs">{images.map((image, i) => <Thumb key={i} image={image} />)}</div>}
          {text && <figcaption className="muted small">“{previewOf(text)}”</figcaption>}
        </figure>}
        <div className="share-dests" role="list" aria-label="Destinations">
          <button type="button" role="listitem" className="share-dest" onClick={() => deliver(null)}>
            <AppRow tile={<PlusIcon size={18} />} name="New session" meta="Start fresh with what you shared" />
          </button>
          {recent.map((session) => {
            const preview = previews.get(session.sessionId);
            const about = [session.agentName, session.branch].filter(Boolean).join(" · ");
            return <button key={session.sessionId} type="button" role="listitem" className="share-dest" onClick={() => deliver(session)}>
              <AppRow tile={preview ? appInitial(preview.name) : <ChatBubbleIcon size={18} />} name={session.name}
                meta={preview ? `${preview.name} preview${preview.path && preview.path !== "/" ? ` · ${preview.path}` : ""}` : about || undefined}
                detail={preview && about ? <span className="app-row-meta">{about}</span> : undefined} />
            </button>;
          })}
        </div>
      </div>
    </Sheet>
  );
}
