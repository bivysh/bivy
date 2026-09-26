// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pre-warm the dev server's dependency cache once, before any worker starts.
//
// Workers share one Vite cacheDir (see fixtures.ts). Without this step the first
// few specs would race to pre-bundle the app's dependencies into that directory
// at the same time, which is both wasted work and a real source of flake. Doing
// one cold boot here means every worker afterwards starts against a complete
// cache and only has to transform app source.
//
// Loading the real entry HTML is what actually populates the cache: Vite
// discovers dependencies by crawling from the entry, so merely listening would
// warm nothing.
import { startWebServer } from "./fixtures.js";

export default async function globalSetup() {
  const { server, origin } = await startWebServer();
  try {
    const response = await fetch(origin + "/");
    await response.text();
    // Vite's dependency scan is kicked off by the first request and finishes
    // asynchronously; wait for it so the cache on disk is complete.
    await server.waitForRequestsIdle?.();
  } finally {
    await server.close();
  }
}
