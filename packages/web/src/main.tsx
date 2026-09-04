// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ProductsView } from "./components/ProductsView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { parseRoute } from "./router.js";
import { applyTheme } from "./theme.js";
import { initPwa } from "./pwa.js";
import { initViewport } from "./viewport.js";
import { requestPersistentStorage } from "./storage.js";
import { initializeInstallLifecycle } from "./pwaLifecycle.js";
import { controller } from "./store/useStore.js";
import "@bivy/ui/tokens.css";
import "./styles.css";
import "./ux-cleanup.css";
import "./pwa-lifecycle.css";

// Apply the saved theme before first paint to avoid a flash.
applyTheme();
// Track the visual viewport so the shell stays pinned above the keyboard.
initViewport();
// Ask for durable storage so the device keypair + session token survive relaunch
// (iOS PWAs otherwise evict them, re-pairing as a new device each open).
void requestPersistentStorage();
// Capture Chromium's one-shot install event before the first successful turn;
// the contextual install surface decides when it is appropriate to show it.
initializeInstallLifecycle();

const root = document.getElementById("root");
const route = parseRoute();
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        {route.kind === "products" ? <ProductsView /> : <App />}
      </ErrorBoundary>
    </StrictMode>,
  );
}

// The product table is a standalone destination and does not need an agent
// connection. Keep the session transport idle when it is opened directly.
if (route.kind !== "products") {
  controller.connect();
  // Re-sync (reconnect + refresh sessions/history/models) when the tab returns
  // to the foreground — mobile Safari can suspend the socket without a status
  // cycle.
  controller.installLifecycleHandlers();
}
initPwa();
