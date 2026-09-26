// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { SessionPresence } from "@bivy/core";
import { controller, useAppState } from "./store/useStore.js";

/** The node's live presence for a session: fetched when the session opens or
 *  the app returns to the foreground, then kept current by `session.presence`. */
export function useSessionPresence(sessionId: string | undefined): SessionPresence | undefined {
  const { connection } = useAppState();
  const online = connection.status === "online";
  const [presence, setPresence] = useState<SessionPresence>();

  useEffect(() => {
    setPresence(undefined);
    if (!sessionId || !online) return;
    let live = true;
    // Older nodes don't know presence; that's "nobody else", not an error.
    const load = () => controller.getPresence(sessionId).then((p) => { if (live) setPresence(p); }, () => {});
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    const off = controller.onPresence((p) => { if (live && p.sessionId === sessionId) setPresence(p); });
    return () => {
      live = false;
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, online, connection.currentNodeId]);

  return presence;
}
