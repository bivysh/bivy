// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// An app preview framed INSIDE a message, where the agent put it
// (`::view{app=<id>}`), rather than as an Open card beside the prose.
//
// The security posture this has to keep: the chat stores an app ID and nothing
// else, and a bearer launch URL is minted only when someone is actually going
// to look at the app. `AppMessage` achieves that by waiting for a click. A
// frame has no click, so it waits for the frame to SCROLL INTO VIEW — the
// closest honest equivalent. Consequences worth stating:
//
//   - Scrolling back through old history does not mint URLs for apps that stay
//     off screen, and never mints one for a message nobody opens.
//   - Nothing is stored either way: the URL lives in this component's state for
//     as long as the frame is mounted, and the transcript keeps only the ID.
//   - Resolving happens once per mount. Re-reading the same message later
//     resolves again rather than reusing a stale URL.
//
// Until it resolves — and whenever it cannot — this renders the ordinary Open
// card, so the app is always reachable even when framing is impossible (a
// browser that blocks partitioned cookies, a view that is not a web view, a
// machine that is offline).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionApp } from "@bivy/core";

import { controller } from "../store/useStore.js";
import { requestAppsSheet } from "../appsSheetRequest.js";
import { peekBlocked } from "./PreviewPeek.js";
import { AppRow, appInitial } from "./AppRow.js";
import { Spinner } from "./Spinner.js";

type OpenResult = { kind: string; url?: string };

/** The resolved frame, or why there isn't one. */
type Frame =
  | { state: "waiting" }
  | { state: "resolving" }
  | { state: "ready"; url: string; name: string }
  | { state: "unframeable"; name: string; why: string };

export function InlineApp({ appId, caption, sessionId }: { appId: string; caption?: string; sessionId: string | null }) {
  const [frame, setFrame] = useState<Frame>({ state: "waiting" });
  const host = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const open = useCallback(() => requestAppsSheet({ sessionId: sessionId ?? "", appId }), [sessionId, appId]);

  const resolve = useCallback(async () => {
    if (!sessionId) return;
    setFrame({ state: "resolving" });
    try {
      const listed = (await controller.appCommand("apps.list", sessionId, {})) as unknown as { apps?: SessionApp[] };
      const app = listed.apps?.find((item) => item.id === appId);
      if (!app) {
        setFrame({ state: "unframeable", name: appId, why: "This app is not published on the machine any more." });
        return;
      }
      const view = app.views.find((item) => item.kind === "web");
      if (!view) {
        // A terminal or backend view has its own surface in the sheet; it is
        // not something to drop into the middle of a message.
        setFrame({ state: "unframeable", name: app.name, why: "Open this one to see it." });
        return;
      }
      const opened = (await controller.appCommand("apps.open", sessionId, {
        appId: app.id,
        viewId: view.id,
        returnTo: `${location.origin}/sessions/${encodeURIComponent(sessionId)}`,
      })) as unknown as OpenResult;
      // Same check AppsSheet applies: a machine must not hand back a URL on
      // this origin, or one carrying credentials.
      const url = opened.kind === "web" && opened.url ? new URL(opened.url) : null;
      if (!url || url.protocol !== "https:" || url.origin === location.origin || url.username || url.password) {
        setFrame({ state: "unframeable", name: app.name, why: "This app could not be shown here." });
        return;
      }
      setFrame({ state: "ready", url: url.href, name: app.name });
    } catch (error) {
      setFrame({ state: "unframeable", name: appId, why: error instanceof Error ? error.message : "This app could not be shown here." });
    }
  }, [sessionId, appId]);

  // Resolve on first intersection. A browser known to block framed preview
  // cookies never resolves at all: the frame would fail anyway, so minting a
  // URL for it would be exposure bought for nothing.
  useEffect(() => {
    const node = host.current;
    if (!node || started.current || !sessionId) return;
    if (peekBlocked()) {
      setFrame({ state: "unframeable", name: appId, why: "Previews do not frame in this browser." });
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      started.current = true;
      void resolve();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || started.current) return;
      started.current = true;
      observer.disconnect();
      void resolve();
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [resolve, sessionId, appId]);

  if (frame.state === "ready") {
    return (
      <figure className="inline-app">
        <iframe
          className="inline-app-frame"
          src={frame.url}
          title={frame.name}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
        />
        <figcaption className="card-sub">
          {caption ?? frame.name}
          <button type="button" className="btn sm ghost inline-app-open" onClick={open}>Open full screen</button>
        </figcaption>
      </figure>
    );
  }
  // Waiting, resolving, or not framable: the ordinary Open card, so the app is
  // reachable by hand in every one of those cases.
  return (
    <div className="apps-card inline-app-card" ref={host}>
      <AppRow
        tile={appInitial(frame.state === "waiting" || frame.state === "resolving" ? appId : frame.name)}
        name={frame.state === "waiting" || frame.state === "resolving" ? (caption ?? "App") : frame.name}
        meta={frame.state === "resolving" ? "Opening the preview…" : frame.state === "unframeable" ? frame.why : "App · opens over the chat"}
        action={
          frame.state === "resolving"
            ? <Spinner size="sm" />
            : <button className="btn sm primary" onClick={open} aria-label={`Open app: ${frame.state === "unframeable" ? frame.name : appId}`}>Open</button>
        }
      />
    </div>
  );
}
