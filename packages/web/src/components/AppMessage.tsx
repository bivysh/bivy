// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { AppReference } from "@bivy/core";
import { AppsSheet } from "./AppsSheet.js";

/** Chat stores an app ID, never a bearer launch URL. Resolve access on click. */
export function AppMessage({ app }: { app: AppReference }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="artifact-row app-view-row app-message">
      <div className="artifact-main"><strong className="artifact-name">{app.name}</strong><span className="artifact-meta">Published app</span></div>
      <button className="btn" onClick={() => setOpen(true)} aria-label={`Open app: ${app.name}`}>Open app</button>
    </div>
    {open && <AppsSheet sessionId={app.sessionId} appId={app.appId} onClose={() => setOpen(false)} />}
  </>;
}
