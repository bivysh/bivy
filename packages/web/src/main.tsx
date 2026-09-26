// SPDX-License-Identifier: AGPL-3.0-only
import { initializePackagedClient } from "./packaged-client.js";
import { applyTheme } from "./theme.js";
import { consumeShareTarget } from "./shareTarget.js";
import { consumePreviewLanding } from "./previewLanding.js";
import "@bivy/ui/tokens.css";
import "./styles.css";

applyTheme();
const loading = document.createElement("div");
loading.className = "setup";
loading.setAttribute("role", "status");
loading.textContent = "Preparing Bivy…";
document.getElementById("root")?.replaceChildren(loading);
// No import of App/controller until native secrets have been hydrated. A broken
// bridge fails closed instead of falling back to insecure browser persistence.
void initializePackagedClient()
  .then(() => {
    // Pre-mount URL rewrites run before mount.js is imported: importing it
    // constructs the controller, which records the boot route from the URL.
    // A share landing (`/share?text=…`, or the app preview's
    // `/share?session=<id>` "Add to chat") stashes its payload and rewrites
    // the URL to the session it targets (or /sessions/new).
    consumeShareTarget();
    // A signed-out visit to an app preview's stable address returns here;
    // stash it before the router strips the session deep link.
    consumePreviewLanding();
    return import("./mount.js");
  })
  .catch(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const container = document.createElement("div");
    container.className = "setup";
    const card = document.createElement("div");
    card.className = "card setup-card";
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = "Bivy could not initialize safely. Please restart the app and try again.";
    const retry = document.createElement("button");
    retry.className = "btn";
    retry.textContent = "Retry";
    retry.onclick = () => location.reload();
    card.append(message, retry);
    container.append(card);
    root.replaceChildren(container);
  });
