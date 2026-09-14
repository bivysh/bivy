// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Reconcile external state on resume, even when React's state hasn't changed.
 * pageshow also covers restoring an existing page from the back/forward cache.
 */
export function onAppVisible(
  reconcile: () => void,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  view: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const onVisible = () => {
    if (page.visibilityState === "visible") reconcile();
  };
  page.addEventListener("visibilitychange", onVisible);
  view.addEventListener("pageshow", onVisible);
  view.addEventListener("focus", onVisible);
  return () => {
    page.removeEventListener("visibilitychange", onVisible);
    view.removeEventListener("pageshow", onVisible);
    view.removeEventListener("focus", onVisible);
  };
}
