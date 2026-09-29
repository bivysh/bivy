// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Offer push notifications at the moment they make sense: while the agent is
// working. That's when "it keeps going if you close this" is true and worth
// knowing. Offered once per device; hidden where push can't work (unsupported,
// blocked, already on, or no account to push through).

import { useEffect, useState } from "react";
import { controller } from "../store/useStore.js";

const DONE_KEY = "bivy:notify-offer";

export function NotifyOffer({ working, machineName, onOpenChange }: { working: boolean; machineName?: string; onOpenChange?: (open: boolean) => void }) {
  const [done, setDone] = useState(() => localStorage.getItem(DONE_KEY) === "done");
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check once a turn is running; once offered, stay until the user answers.
  useEffect(() => {
    // Pushes come through the account; a direct (local, no account) client has none.
    if (done || eligible || !working || controller.direct) return;
    let live = true;
    controller.pushStatus().then((status) => {
      if (live) setEligible(status.supported && !status.subscribed && status.permission !== "denied");
    }).catch(() => {});
    return () => { live = false; };
  }, [done, eligible, working]);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => setDone(true), 5000);
    return () => clearTimeout(t);
  }, [enabled]);

  const open = !done && eligible;
  useEffect(() => onOpenChange?.(open), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = () => {
    localStorage.setItem(DONE_KEY, "done");
    setDone(true);
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await controller.enablePush();
      localStorage.setItem(DONE_KEY, "done");
      setEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  if (enabled) return (
    <section className="card next-step" aria-label="Notifications">
      <p className="next-step-ok" role="status">✓ Notifications are on. You can close the app; Bivy will let you know.</p>
    </section>
  );
  return (
    <section className="card next-step" aria-labelledby="notify-offer-title">
      <div>
        <strong id="notify-offer-title">Get a notification when it's done?</strong>
        <p>The agent keeps working on {machineName || "your machine"} if you close this app. Bivy can tell you when it finishes or needs you.</p>
        {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      </div>
      <div className="next-step-actions">
        <button type="button" className="btn sm primary" disabled={busy} onClick={() => void enable()}>
          {busy ? "Turning on…" : "Turn on notifications"}
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={finish}>Not now</button>
      </div>
    </section>
  );
}
