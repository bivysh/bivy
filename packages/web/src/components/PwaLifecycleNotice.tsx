// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState, useSyncExternalStore } from "react";
import type { ConnectionStatus } from "@bivy/core";
import { getPwaLifecycleState, requestInstall, subscribePwaLifecycle } from "../pwaLifecycle.js";

export function PwaLifecycleNotice({ status, hasCachedTranscript }: { status: ConnectionStatus; hasCachedTranscript: boolean }) {
  const lifecycle = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleState);
  const [guidance, setGuidance] = useState(false);
  const queued = lifecycle.locallyQueuedPrompts > 0;
  const reconnecting = status === "reconnecting" || status === "connecting" || status === "linking" || status === "pairing";

  let label = "Live control";
  let detail = "This Machine is connected. Prompts send now and transcript changes sync live.";
  if (queued) {
    label = "Prompt queued on this device";
    detail = "It has not reached the Machine yet. Keep Bivy open; it will send after this connection recovers.";
  } else if (reconnecting) {
    label = "Reconnecting Machine";
    detail = hasCachedTranscript
      ? "The transcript shown is the cached copy. You can keep drafting; live control returns after reconnect."
      : "The app shell is available, but live Machine control is still reconnecting.";
  } else if (status === "offline" && hasCachedTranscript) {
    label = "Cached transcript";
    detail = "This readable copy is stored on this device. It may be behind the Machine; prompts cannot send until reconnect.";
  } else if (status === "offline") {
    label = "Cached app shell";
    detail = "Bivy can open from this device's cache, but no transcript or Machine control is available yet.";
  }

  const showStatus = status !== "online" || queued;
  const showInstall = lifecycle.installChoice !== null && !lifecycle.standalone;
  if (!showStatus && !showInstall) return null;

  return (
    <aside className="pwa-lifecycle" aria-label="App availability">
      {showStatus && <div className="pwa-lifecycle-copy"><strong>{label}</strong><span>{detail}</span></div>}
      {showInstall && (
        <div className="pwa-install">
          <span>Install Bivy for a dedicated window and reliable return to this device.</span>
          {lifecycle.installChoice === "native" ? (
            <button type="button" className="btn ghost" onClick={() => void requestInstall()}>Install</button>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setGuidance((value) => !value)}>How to install</button>
          )}
          {guidance && lifecycle.installChoice === "ios" && (
            <p role="status">In Safari, tap Share, then <strong>Add to Home Screen</strong>, then Add. Other iOS browsers cannot install Bivy directly.</p>
          )}
          {guidance && lifecycle.installChoice === "safari" && (
            <p role="status">In Safari, choose <strong>File → Add to Dock</strong>. On older Safari versions, use Add to Home Screen from the Share menu.</p>
          )}
        </div>
      )}
    </aside>
  );
}
