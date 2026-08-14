// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState, useSyncExternalStore } from "react";
import type { ConnectionStatus } from "@bivy/core";
import { describeAvailability, dismissInstall, getPwaLifecycleState, requestInstall, subscribePwaLifecycle } from "../pwaLifecycle.js";

export function PwaLifecycleNotice({ status, hasCachedTranscript }: { status: ConnectionStatus; hasCachedTranscript: boolean }) {
  const lifecycle = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleState);
  const [guidance, setGuidance] = useState(false);
  const availability = describeAvailability(status, hasCachedTranscript, lifecycle);
  const showStatus = availability.kind !== "live-control";
  const showInstall = lifecycle.installChoice !== null && !lifecycle.standalone;
  if (!showStatus && !showInstall) return null;

  return (
    <>
      {showStatus && (
        <aside className="pwa-lifecycle" aria-label="App availability">
          <div className="pwa-lifecycle-copy" data-availability={availability.kind}>
            <strong>{availability.label}</strong><span>{availability.detail}</span>
          </div>
        </aside>
      )}
      {showInstall && (
        <aside className="pwa-install" aria-label="Install Bivy">
          <button type="button" className="pwa-install-dismiss" onClick={dismissInstall} aria-label="Dismiss install suggestion" title="Don't show again">×</button>
          <div className="pwa-install-copy">
            <strong>Install Bivy</strong>
            <span>Open Bivy in a dedicated window and return to this device more reliably.</span>
          </div>
          <div className="pwa-install-actions">
            {lifecycle.installChoice === "native" ? (
              <button type="button" className="btn ghost" onClick={() => void requestInstall()}>Install</button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setGuidance((value) => !value)}>How to install</button>
            )}
          </div>
          {guidance && lifecycle.installChoice === "ios" && (
            <p role="status">In Safari, tap Share, then <strong>Add to Home Screen</strong>, then Add. Other iOS browsers cannot install Bivy directly.</p>
          )}
          {guidance && lifecycle.installChoice === "safari" && (
            <p role="status">On macOS Sonoma or later, choose <strong>File → Add to Dock</strong> in Safari 17 or later. Older macOS Safari versions cannot install Bivy as a web app.</p>
          )}
        </aside>
      )}
    </>
  );
}
