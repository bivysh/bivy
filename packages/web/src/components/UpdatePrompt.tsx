// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { onUpdateAvailable, reloadForUpdate } from "../pwa.js";

/**
 * World-class update UX: when a new version is precached, we show a small,
 * non-blocking prompt. We never reload mid-session — the user chooses. This
 * replaces the legacy hand-bumped cache version + surprise reloads.
 */
export function UpdatePrompt() {
  const [show, setShow] = useState(false);
  useEffect(() => onUpdateAvailable(setShow), []);
  if (!show) return null;
  return (
    <div className="update-toast" role="status">
      <span>A new version of Bivy is ready.</span>
      <button className="btn ghost" onClick={() => setShow(false)}>
        Later
      </button>
      <button className="btn primary" onClick={reloadForUpdate}>
        Reload
      </button>
    </div>
  );
}
