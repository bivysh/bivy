// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppReference } from "@bivy/core";
import { requestAppsSheet } from "../appsSheetRequest.js";
import { AppRow, appInitial } from "./AppRow.js";

/** Chat stores an app ID, never a bearer launch URL. Resolve access on click. */
export function AppMessage({ app }: { app: AppReference }) {
  return <div className="apps-card app-message">
    <AppRow tile={appInitial(app.name)} name={app.name} meta="App · opens over the chat"
      action={<button className="btn sm primary" onClick={() => requestAppsSheet({ sessionId: app.sessionId, appId: app.appId })} aria-label={`Open app: ${app.name}`}>Open</button>} />
  </div>;
}
