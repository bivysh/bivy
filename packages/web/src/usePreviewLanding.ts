// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { OpenAppViewResult } from "@bivy/core";
import { controller, useAppState } from "./store/useStore.js";
import { clearPendingPreview, takePendingPreview } from "./previewLanding.js";

/** Once the named session is open and online, go back to the app. Returns
 *  the status to show while that happens, or null. */
export function usePreviewLanding(): string | null {
  const { connection, activeSession } = useAppState();
  const [pending] = useState(takePendingPreview);
  const [status, setStatus] = useState<string | null>(pending ? "Opening your app preview…" : null);
  const ready = Boolean(pending) && connection.status === "online" && activeSession.activeSessionId === pending?.sessionId;
  useEffect(() => {
    if (!pending || !ready) return;
    clearPendingPreview();
    void controller.appCommand("apps.open", pending.sessionId, { appId: pending.appId, viewId: pending.viewId, direct: true })
      .then((event) => {
        const result = event as unknown as OpenAppViewResult;
        const url = result.kind === "web" ? new URL(result.url) : null;
        if (!url || url.protocol !== "https:" || url.origin === location.origin) throw new Error("Unexpected preview link.");
        location.replace(`${url.href}~${encodeURIComponent(pending.path)}`);
      })
      .catch((e: unknown) => setStatus(`Couldn’t reopen the preview: ${e instanceof Error ? e.message : "try again from Apps"}.`));
  }, [pending, ready]);
  return status;
}
