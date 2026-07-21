// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect } from "react";
import { useAppState, controller } from "../store/useStore.js";

// Surfaces an opened pull request as a real, tappable link. The URL arrives
// asynchronously (session.pr_result), so auto-opening a tab from that event is
// detached from the user's tap and gets blocked by mobile popup blockers (iOS
// Safari especially) — the action then silently does nothing. A persistent toast
// with an <a target="_blank"> keeps the navigation inside a genuine gesture and
// works the same on every platform, including for a PR opened on a non-focused
// session from the sidebar menu.
export function PrToast() {
  const { prResult } = useAppState();

  useEffect(() => {
    if (!prResult) return;
    // Failures belong in the error toast; only a successful URL needs this one.
    if (!prResult.url) {
      if (prResult.error) controller.store.setError(prResult.error);
      controller.store.clearPrResult();
      return;
    }
    const t = setTimeout(() => controller.store.clearPrResult(), 15000);
    return () => clearTimeout(t);
  }, [prResult]);

  if (!prResult?.url) return null;
  return (
    <div className="update-toast" role="status">
      <span>Pull request ready</span>
      <a
        className="btn primary"
        href={prResult.url}
        target="_blank"
        rel="noopener"
        onClick={() => controller.store.clearPrResult()}
      >
        Open
      </a>
      <button className="sheet-close" onClick={() => controller.store.clearPrResult()} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
