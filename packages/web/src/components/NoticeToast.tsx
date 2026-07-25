// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect } from "react";
import { useAppState, controller } from "../store/useStore.js";

// A non-blocking success/confirmation toast, styled distinctly from the error
// toast (which is for failures). Used for moments like a completed upgrade, so
// the user gets an explicit acknowledgement instead of being dropped back on a
// silent app root. Auto-dismisses after a readable delay; the × closes it now.

function dismissDelay(raw: string): number {
  return Math.min(30000, Math.max(6000, raw.trim().length * 45));
}

export function NoticeToast() {
  const { notice } = useAppState();

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => controller.store.setNotice(""), dismissDelay(notice));
    return () => clearTimeout(t);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="notice-toast" role="status">
      <span className="notice-toast-icon" aria-hidden>
        ✓
      </span>
      <span className="notice-toast-text">{notice.trim()}</span>
      <button className="notice-toast-close" onClick={() => controller.store.setNotice("")} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
