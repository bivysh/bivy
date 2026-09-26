// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { AppOffer, SessionAppOffersResult, SessionAppsResult } from "@bivy/core";
import { controller, useAppState } from "./store/useStore.js";

/** Servers usually start mid-turn, so re-scan while the agent works. */
const WORKING_POLL_MS = 10_000;

export interface SessionAppsSnapshot {
  /** Apps the node has published for this session (manifest or adopted);
   *  null until the node answers, or when it can't (offline, older node). */
  published: number | null;
  /** Servers running in the workspace that aren't previewed yet. */
  offers: AppOffer[];
}

const EMPTY: SessionAppsSnapshot = { published: null, offers: [] };

/** The node's live view of a session's apps, so a dev server any agent starts
 * surfaces on its own. Re-checked when the session or connection changes, a
 * turn starts or ends, the app returns to the foreground, the node reports
 * `apps.changed`, and every WORKING_POLL_MS while the agent works. */
export function useSessionApps(sessionId: string | undefined, working: boolean): SessionAppsSnapshot {
  const { connection } = useAppState();
  const online = connection.status === "online";
  // Keyed so a turn starting or ending keeps what's shown while it re-checks,
  // but another session or machine never shows this one's servers.
  const key = `${connection.currentNodeId ?? ""}:${sessionId ?? ""}`;
  const [snapshot, setSnapshot] = useState<SessionAppsSnapshot & { key: string }>({ key: "", ...EMPTY });

  useEffect(() => {
    if (!sessionId || !online) return;
    let live = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      // Older nodes don't know apps.offers; that is "none", not an error.
      const offers = controller.appCommand("apps.offers", sessionId).then((event) => (event as unknown as SessionAppOffersResult).offers ?? [], () => []);
      const published = controller.appCommand("apps.list", sessionId).then((event) => (event as unknown as SessionAppsResult).apps?.length ?? null, () => null);
      void Promise.all([published, offers]).then(([count, found]) => {
        if (live && current === generation) setSnapshot({ key, published: count, offers: found });
      });
    };
    load();
    const timer = working ? setInterval(load, WORKING_POLL_MS) : undefined;
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    const off = controller.onAppsChanged((changed) => { if (changed === sessionId) load(); });
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      off();
    };
  }, [key, sessionId, online, working]);

  return online && snapshot.key === key ? snapshot : EMPTY;
}
