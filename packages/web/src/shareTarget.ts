// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Share-target landing: `/share?title=…&text=…&url=…`.
//
// Entry points (see the `share_target` manifest entry in
// packages/web/vite.config.ts):
//   1. Android/desktop Chromium — the installed PWA appears in the OS share
//      sheet and POSTs the payload (text, links and images). The service
//      worker keeps it on the device (shareInbox.ts) and opens
//      `/share?shared=<id>`; images reach the chosen session's composer as
//      attachments once it's open.
//   2. The iOS "Send to Bivy" Shortcut — iOS never exposes web apps in its
//      share sheet, so Settings → Share to Bivy walks the user through a
//      one-time Shortcut that opens this same URL with the shared text.
//
// Both land in the same place: the shared text is stashed as a tab-scoped
// pending share and the URL is rewritten to `/sessions/new` before the app
// mounts, so the share params never linger in the address bar or a copied
// link. Once the shell renders, App shows a destination sheet
// (ShareDestinationSheet) — new session by default, or any recent session —
// and the choice lands in that session's composer draft.
//
// A `session=<id>` param names the destination up front (e.g. the app preview's
// "Ask agent to fix"): the text goes straight into that session's draft and the
// landing opens the session. Like every share, it only prefills — nothing is
// sent until the user sends it.

import { readComposerDraft, writeComposerDraft, type DraftStorage } from "./composerDraft.js";

export const SHARE_PATH = "/share";

/** Tab-scoped stash (sessionStorage) between the pre-mount landing and the
 *  post-mount destination sheet. Survives an in-tab sign-in reload; two tabs
 *  sharing at once never clobber each other. */
export const PENDING_SHARE_KEY = "bivy.pendingShare";
/** A share with images: the id of what the service worker kept (shareInbox.ts). */
export const PENDING_SHARE_FILES_KEY = "bivy.pendingShareFiles";

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
 * `pathname` is the share route (after stashing the payload for the
 * destination sheet), or null for every other path. Pure over its inputs so
 * the whole flow is testable without a DOM.
 */
export function applyShareTarget(pathname: string, search: string, pending: DraftStorage, drafts: DraftStorage): string | null {
  if (pathname.replace(/\/+$/, "") !== SHARE_PATH) return null;
  const params = new URLSearchParams(search);
  const shared = sharedDraftText(params);
  const files = params.get("shared") ?? "";
  if (/^[a-f0-9]{32}$/.test(files)) {
    // Images wait in the inbox; the destination sheet reads them after mount.
    try { pending.setItem(PENDING_SHARE_FILES_KEY, files); } catch { /* denied: the share is dropped */ }
    return "/sessions/new";
  }
  const session = params.get("session") ?? "";
  if (/^[A-Za-z0-9_-]{1,128}$/.test(session) && session !== "new") {
    if (shared) seedSessionDraft(drafts, session, shared);
    return `/sessions/${session}`;
  }
  if (shared) {
    // A share arriving before an earlier one was placed appends to it — both
    // payloads reach whichever destination the user finally picks.
    let existing = "";
    try { existing = pending.getItem(PENDING_SHARE_KEY) ?? ""; } catch { /* unavailable storage */ }
    try { pending.setItem(PENDING_SHARE_KEY, mergeSharedText(existing, shared)); } catch { /* quota/denied — the redirect still clears the URL */ }
  }
  return "/sessions/new";
}

/** The stashed share awaiting a destination, if any. Does not consume it —
 *  the sheet may not render yet (sign-in gate) and must survive until it does. */
export function peekPendingShare(storage: DraftStorage): string | null {
  try { return storage.getItem(PENDING_SHARE_KEY); } catch { return null; }
}

export function clearPendingShare(storage: DraftStorage): void {
  try { storage.removeItem(PENDING_SHARE_KEY); storage.removeItem(PENDING_SHARE_FILES_KEY); } catch { /* already gone */ }
}

export function peekPendingShareFiles(storage: DraftStorage): string | null {
  try { return storage.getItem(PENDING_SHARE_FILES_KEY); } catch { return null; }
}

/** The line a shared screenshot starts with when the destination has an app
 *  preview: which app and page to compare with. The user edits or replaces it. */
export function previewShareLine(images: number, app: { name: string; path?: string } | undefined): string {
  if (!images || !app) return "";
  const what = images === 1 ? "a screenshot — compare it" : `${images} screenshots — compare them`;
  return `Shared ${what} with the ${app.name} preview${app.path && app.path !== "/" ? ` (${app.path})` : ""}.`;
}

/** Fold shared text into a session's stored composer draft (null = the
 *  new-session draft). Written BEFORE navigating to the session, so the
 *  Composer's draft (re)load picks it up; existing text and attachment
 *  metadata are preserved. */
export function seedSessionDraft(drafts: DraftStorage, sessionId: string | null, text: string): void {
  const draft = readComposerDraft(drafts, sessionId);
  writeComposerDraft(drafts, sessionId, mergeSharedText(draft.text, text), draft.attachments);
}

/** Browser wiring. Must run before mount.js is imported (see main.tsx): that
 *  import constructs the controller, which records its boot route from the URL,
 *  so it and every later parseRoute() must see the redirect, not `/share`. */
export function consumeShareTarget(): void {
  const redirect = applyShareTarget(location.pathname, location.search, sessionStorage, localStorage);
  // Drop the share query entirely (routePath() preserves location.search, so it
  // must not survive) but keep the hash — sign-in links land with a #payload.
  if (redirect) history.replaceState(null, "", redirect + location.hash);
}
