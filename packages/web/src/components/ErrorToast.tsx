// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { useAppState, controller } from "../store/useStore.js";
import { StatusIcon, Toast } from "./Toast.js";

// A non-blocking error toast pinned above the composer. Keep verbose command
// output collapsed initially so one failure cannot cover most of a phone screen;
// the full, scrollable diagnostic remains available on demand. Longer messages
// linger longer before auto-dismissing; the × closes it immediately.

// Auto-dismiss after enough time to read it: a short line goes in ~6s, a long
// multi-line error gets proportionally longer, capped at 30s.
function dismissDelay(raw: string): number {
  return Math.min(30000, Math.max(6000, raw.trim().length * 45));
}

export function ErrorToast() {
  const { presentation: { error } } = useAppState();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
    if (!error) return;
    const t = setTimeout(() => controller.store.setError(""), dismissDelay(error));
    return () => clearTimeout(t);
  }, [error]);

  if (!error) return null;
  const message = error.trim();
  const hasDetails = message.includes("\n") || message.length > 240;
  return (
    <Toast tone="danger" className={`error-toast${expanded ? " expanded" : ""}`} role="alert">
      <StatusIcon tone="danger">!</StatusIcon>
      <div className="error-toast-content">
        <span className="error-toast-text">{message}</span>
        {hasDetails && (
          <button className="error-toast-details" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            {expanded ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      <button className="error-toast-close" onClick={() => controller.store.setError("")} aria-label="Dismiss">
        ×
      </button>
    </Toast>
  );
}
