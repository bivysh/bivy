// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { defineConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The app's own version, read from this package's package.json at build time and
// baked into the bundle as `__APP_VERSION__`. Surfaced in Settings so a user can
// tell which build their (offline-capable, precached) PWA is actually running.
const pkgVersion = ((): string => {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "package.json");
    return (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
})();

// Browser-chrome / splash colors, read from the design system at build time so
// the static `<meta name="theme-color">` tags in index.html and the PWA manifest
// can never drift from `--bg` in packages/ui/tokens.css (the single source of
// truth). These are the literal first pixels a cold-loading PWA paints — before
// any CSS or JS — so they have to be baked in, not read at runtime.
const bgTokens = ((): { light: string; dark: string } => {
  const tokensPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui/tokens.css");
  const css = fs.readFileSync(tokensPath, "utf8");
  const bgIn = (blockHeader: RegExp): string => {
    const start = css.search(blockHeader);
    if (start < 0) throw new Error(`tokens.css: block ${blockHeader} not found`);
    const body = css.slice(start, css.indexOf("}", start));
    const m = /--bg:\s*(#[0-9a-fA-F]{3,8})/.exec(body);
    if (!m) throw new Error(`tokens.css: --bg not found in ${blockHeader}`);
    return m[1]!.toLowerCase();
  };
  return { light: bgIn(/^:root\s*\{/m), dark: bgIn(/^:root\[data-theme="dark"\]\s*\{/m) };
})();

// Bivy's single web client. Both the node daemon and the control plane serve
// this build at the root; the legacy vanilla client it replaced has been
// removed, so there is no longer a `/next` migration base.
export default defineConfig({
  resolve: {
    alias: {
      "@bivy/core": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../core/src/index.ts"),
      // Design-system package: tokens.css / components.css are imported by
      // specifier (e.g. `@bivy/ui/tokens.css`) so the single source of truth is
      // referenced, never copied. Mirrors the tsconfig `paths` entry.
      "@bivy/ui": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui"),
    },
  },
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    // The moment this bundle was built, baked in so Settings can show when the
    // running (precached) PWA was last updated — a freshness signal for a
    // client that keeps working offline off an old cache.
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    {
      // Fill the media-scoped theme-color tags from the design tokens (see
      // `bgTokens`). index.html carries placeholders, never hex.
      name: "bivy-theme-color",
      transformIndexHtml: (html) =>
        html.replace(/%BIVY_BG_DARK%/g, bgTokens.dark).replace(/%BIVY_BG_LIGHT%/g, bgTokens.light),
    },
    VitePWA({
      // `prompt`: never auto-reload a running session. The app shows a small
      // "Update ready" prompt and reloads only when the user opts in (or on the
      // next cold start). This is the correct-by-construction replacement for the
      // legacy hand-versioned `bivy-v11/v12` cache dance.
      registerType: "prompt",
      // No inline registration script — keeps us compatible with a strict
      // script-src 'self' CSP. We register from bundled code in pwa.ts.
      injectRegister: null,
      // Own the service worker source (src/sw.ts) instead of letting Workbox
      // generate a precache-only worker. `generateSW` gave us no hook for the
      // `push`/`notificationclick` handlers Web Push needs, so notifications
      // never displayed. The app-shell precache + navigation fallback (incl. the
      // /api, /ws, /auth, /janitor denylist) are reproduced inside sw.ts.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      manifest: {
        id: "/",
        name: "Bivy",
        short_name: "Bivy",
        description: "Remote control for your Bivy coding agents",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // The Web App Manifest spec has no per-user-preference field for these —
        // they're static, so a light-theme user still gets a dark native splash
        // screen for an instant on cold launch (the in-app/browser-chrome color
        // *is* theme-aware; see the media-scoped <meta name="theme-color"> tags
        // in index.html and theme.ts's applyTheme — this is specifically about
        // the OS-level splash shown before any web content, including those
        // tags, has painted). Uses the dark `--bg` token (the app's
        // system→dark-leaning default) so the splash blends into the first
        // painted frame instead of flashing an unrelated neutral.
        background_color: bgTokens.dark,
        theme_color: bgTokens.dark,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/tent-logo.png", sizes: "1254x1254", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  build: {
    // Avoid Vite's inline module-preload polyfill script so the bundle stays
    // compatible with script-src 'self'.
    modulePreload: { polyfill: false },
    target: "es2022",
    // Do not publish source maps with the self-serve production bundle by default.
    // If we add private error tracking later, upload maps there instead of
    // serving them to every hosted/local app user.
    sourcemap: false,
  },
  server: {
    // `npm run dev:web` proxies API/WS to a locally running node daemon.
    proxy: {
      "/api": "http://localhost:4317",
      "/ws": { target: "ws://localhost:4317", ws: true },
    },
  },
});
