// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** What the Apps sheet opens at: a session's apps, one app, or straight into a view. */
export type AppsSheetRequest = { sessionId: string; appId?: string; openView?: { viewId: string; path?: string } };

type Listener = (request: AppsSheetRequest) => void;
const listeners = new Set<Listener>();

/** Transcript cards ask the app shell to open the Apps sheet instead of owning
 *  it. Their rows remount whenever history is re-rendered (after a turn,
 *  reconnect, resync), which would close a preview someone is looking at. */
export function requestAppsSheet(request: AppsSheetRequest): void {
  for (const listener of listeners) listener(request);
}

export function onAppsSheetRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
