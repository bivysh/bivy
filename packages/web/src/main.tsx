// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { applyTheme } from "./theme.js";
import { initPwa } from "./pwa.js";
import { initViewport } from "./viewport.js";
import { requestPersistentStorage } from "./storage.js";
import { controller } from "./store/useStore.js";
import "./styles.css";

// Apply the saved theme before first paint to avoid a flash.
applyTheme();
// Track the visual viewport so the shell stays pinned above the keyboard.
initViewport();
// Ask for durable storage so the device keypair + session token survive relaunch
// (iOS PWAs otherwise evict them, re-pairing as a new device each open).
void requestPersistentStorage();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

// Kick off the connection and register the service worker after mount.
controller.connect();
// Re-sync (reconnect + refresh sessions/history/models) when the tab returns to
// the foreground — mobile Safari can suspend the socket without a status cycle.
controller.installLifecycleHandlers();
initPwa();
