// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect } from "react";
import { useAppState, controller } from "../store/useStore.js";

// A non-blocking error toast pinned above the composer. It shows the FULL
// message — wrapped and capped to the viewport height (it scrolls if taller) —
// so the user can actually read it; a truncated "401 Unauthorized: Miss…" is
// useless. Longer messages linger longer before auto-dismissing; the × closes
// it immediately.

// Auto-dismiss after enough time to read it: a short line goes in ~6s, a long
// multi-line error gets proportionally longer, capped at 30s.
function dismissDelay(raw: string): number {
  return Math.min(30000, Math.max(6000, raw.trim().length * 45));
}

export function ErrorToast() {
  const { error } = useAppState();

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => controller.store.setError(""), dismissDelay(error));
    return () => clearTimeout(t);
  }, [error]);

  if (!error) return null;
  return (
    <div className="error-toast" role="alert">
      <span className="error-toast-icon" aria-hidden>
        !
      </span>
      <span className="error-toast-text">{error.trim()}</span>
      <button className="error-toast-close" onClick={() => controller.store.setError("")} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
