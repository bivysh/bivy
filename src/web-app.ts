// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The web app, served by the node itself on its direct listener (Tailscale).
// Elsewhere the control plane serves it and the node stays a pure data plane;
// here there is no control plane, so the node hands out the same build and
// tells it, through /runtime-config.js, to talk to this node directly.
import fs from "node:fs";
import path from "node:path";
import express from "express";

/** Where a packaged install and a source checkout keep the built app and its icons. */
export function webAppDirs(packageRoot: string): string[] {
  return [
    path.join(packageRoot, "web"),
    path.join(packageRoot, "packages", "web", "dist"),
    path.join(packageRoot, "services", "control-plane", "public"),
  ].filter((dir) => fs.existsSync(dir));
}

/** Paths the node itself answers, never the app shell. */
const NODE_ROUTES = ["/api", "/ws", "/healthz", "/github"];

function noStore(res: express.Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

/** Serves the app shell, assets and a direct-mode runtime config; passes on anything else. */
export function webAppRouter(dirs: string[]): express.Router | null {
  const indexDir = dirs.find((dir) => fs.existsSync(path.join(dir, "index.html")));
  if (!indexDir) return null;
  // Read once: the shell is served from memory, with no file access per request.
  const indexHtml = fs.readFileSync(path.join(indexDir, "index.html"));
  const router = express.Router();
  router.get("/runtime-config.js", (_req, res) => {
    noStore(res);
    res.type("application/javascript").send(`globalThis.__BIVY_RUNTIME_CONFIG__ = ${JSON.stringify({ directNode: true })};\n`);
  });
  for (const dir of dirs) {
    router.use(express.static(dir, {
      index: false,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (name === "index.html" || name === "sw.js" || name.startsWith("workbox-")) noStore(res);
      },
    }));
  }
  // Client-side routes (`/sessions/…`, `/settings`, `/share`, …) load the shell;
  // the node's own routes pass through.
  router.get(/.*/, (req, res, next) => {
    if (NODE_ROUTES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)) || !req.accepts("html")) return next();
    noStore(res);
    res.type("html").send(indexHtml);
  });
  return router;
}
