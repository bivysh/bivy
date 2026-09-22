// SPDX-License-Identifier: AGPL-3.0-only
import { initializePackagedClient } from "./packaged-client.js";
import { applyTheme } from "./theme.js";
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
  .then(() => import("./mount.js"))
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
