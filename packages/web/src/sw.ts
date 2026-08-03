// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/// <reference lib="webworker" />
//
// Bivy's custom service worker (vite-plugin-pwa `injectManifest` source).
//
// Why this file exists: the previous `generateSW` strategy produced a
// precache-only Workbox worker with no `push`/`notificationclick` handlers, so
// even though the client subscribed and the control plane sent Web Push
// messages, the browser had nothing to display. The push-delivery half used to
// live in the deleted legacy `public/service-worker.js`; this restores it while
// keeping the app-shell precaching Workbox already gave us.

import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// --- App shell precache (same behavior as the old generateSW build) ---------
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback to the precached index.html, except for routes the
// control plane owns and must reach the network:
//  - /api, /ws: API + WebSocket.
//  - /auth: full-page sign-in navigations (OAuth start/callback, magic-link
//    consume) that must reach the server so it can 302 to GitHub / redirect
//    back with the session. Mirrors the old `navigateFallbackDenylist`.
//  - /janitor: a separately-built product surface served through the control
//    plane. Returning Bivy's cached index here would leave /janitor in the URL
//    while rendering the ordinary Bivy start screen.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api/, /^\/ws/, /^\/auth/, /^\/janitor(?:\/|$)/],
  }),
);

// `registerType: 'prompt'` — never activate a waiting worker mid-session. The
// page posts SKIP_WAITING when the user opts into the "Update ready" prompt.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// --- Web Push: display incoming notifications -------------------------------
// Payload shape sent by the control plane (`sendPushToAccount`):
//   { title, body, kind, nodeId, sessionId, url }
interface PushPayload {
  title?: string;
  body?: string;
  kind?: string;
  sessionId?: string;
  url?: string;
}

function readPushPayload(data: PushMessageData | null): PushPayload {
  if (!data) return {};
  try {
    return data.json() as PushPayload;
  } catch {
    return { body: data.text() || "" };
  }
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event.data);
  const title = payload.title || "Bivy";
  const options: NotificationOptions = {
    body: payload.body || "Open Bivy to continue.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Collapse repeat notifications for the same session/kind instead of stacking.
    tag: payload.sessionId || payload.kind || "bivy",
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const target = new URL(data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientsList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(target);
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
