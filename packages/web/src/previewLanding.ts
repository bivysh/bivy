// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Return trip for a preview's stable address (e.g. a home-screen icon). A
// signed-out visit is sent here by the node as
// `/sessions/:id?node=…#preview=<appId>.<viewId>.<path>`. The session deep link
// signs in and switches to the right machine as usual. Once that session is
// open, the client asks its node for a one-use direct link and goes back to the
// same page of the app. The fragment is untrusted input: it only names IDs and a
// same-origin path that the node checks again.

const KEY = "bivy.pendingPreview";
export type Pending = { sessionId: string; appId: string; viewId: string; path: string };

/** Pure over its inputs so the parsing is testable without a DOM. */
export function parsePreviewLanding(pathname: string, hash: string): Pending | null {
  const session = /^\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)?.[1];
  const match = /^#preview=([a-f0-9]{32})\.([a-f0-9]{32})\.(.{0,2048})$/.exec(hash);
  if (!session || session === "new" || !match) return null;
  let path = "/";
  try { path = decodeURIComponent(match[3]!); } catch { /* keep root */ }
  if (!path.startsWith("/") || path.startsWith("//")) path = "/";
  return { sessionId: session, appId: match[1]!, viewId: match[2]!, path };
}

/** Before mount: stash the request (it must survive an in-tab sign-in) and
 *  drop the fragment so it neither lingers nor re-fires. */
export function consumePreviewLanding(): void {
  const pending = parsePreviewLanding(location.pathname, location.hash);
  if (!pending) return;
  try { sessionStorage.setItem(KEY, JSON.stringify(pending)); } catch { /* storage unavailable */ }
  history.replaceState(history.state, "", location.pathname + location.search);
}

export function takePendingPreview(): Pending | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Pending | null; } catch { return null; }
}
export function clearPendingPreview(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
