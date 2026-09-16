// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Share-target landing: `/share?title=…&text=…&url=…`.
//
// Two entry points open this URL (see the `share_target` manifest entry in
// packages/web/vite.config.ts):
//   1. Android/desktop Chromium — the installed PWA appears in the OS share
//      sheet and the browser navigates here with the shared payload as GET
//      params (the Web Share Target API).
//   2. The iOS "Send to Bivy" Shortcut — iOS never exposes web apps in its
//      share sheet, so Settings → Share to Bivy walks the user through a
//      one-time Shortcut that opens this same URL with the shared text.
//
// Both land in the same place: the shared text is folded into the new-session
// composer draft (the same localStorage draft the Composer already restores)
// and the URL is rewritten to `/sessions/new` before the app mounts, so the
// share params never linger in the address bar or a copied link.

import { readComposerDraft, writeComposerDraft, type DraftStorage } from "./composerDraft.js";

export const SHARE_PATH = "/share";

/** Compose one draft-ready block from the share params. Android fills any
 *  subset of title/text/url (and often repeats the link inside `text`), so
 *  blank parts drop out and a URL already present in the text isn't repeated. */
export function sharedDraftText(params: URLSearchParams): string {
  const title = (params.get("title") ?? "").trim();
  const text = (params.get("text") ?? "").trim();
  const url = (params.get("url") ?? "").trim();
  const parts = [title, text];
  if (url && !title.includes(url) && !text.includes(url)) parts.push(url);
  return parts.filter(Boolean).join("\n");
}

/** Fold shared text into whatever the user already had drafted. An existing
 *  draft is never overwritten — the share is appended — and sharing the exact
 *  same payload twice (a double-fired Shortcut, a re-opened share) is a no-op. */
export function mergeSharedText(existing: string, shared: string): string {
  if (!shared) return existing;
  if (!existing.trim()) return shared;
  if (existing.includes(shared)) return existing;
  return `${existing.trimEnd()}\n\n${shared}`;
}

/**
 * Handle a share-target landing. Returns the path to redirect to when
 * `pathname` is the share route (after seeding the draft), or null for every
 * other path. Pure over its inputs so the whole flow is testable without a DOM.
 */
export function applyShareTarget(pathname: string, search: string, storage: DraftStorage): string | null {
  if (pathname.replace(/\/+$/, "") !== SHARE_PATH) return null;
  const shared = sharedDraftText(new URLSearchParams(search));
  if (shared) {
    // null session id = the "new draft" key the Composer reads for /sessions/new.
    const draft = readComposerDraft(storage, null);
    writeComposerDraft(storage, null, mergeSharedText(draft.text, shared), draft.attachments);
  }
  return "/sessions/new";
}

/** Browser wiring. Must run before the app mounts (see main.tsx) so the
 *  Composer's one-shot draft read sees the seeded text and every later
 *  parseRoute() sees `/sessions/new` instead of `/share`. */
export function consumeShareTarget(): void {
  const redirect = applyShareTarget(location.pathname, location.search, localStorage);
  // Drop the share query entirely (routePath() preserves location.search, so it
  // must not survive) but keep the hash — sign-in links land with a #payload.
  if (redirect) history.replaceState(null, "", redirect + location.hash);
}
