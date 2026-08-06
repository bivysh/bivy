// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pin the app shell to the *visual* viewport.
//
// iOS Safari does not shrink the layout viewport when the on-screen keyboard
// opens: `100dvh` still measures the whole screen. If the shell is in normal
// flow at that height, the browser is free to scroll it to reveal the focused
// composer — so the composer floats mid-screen or scrolls off the top, and the
// layout appears to drift. Instead we pin `.app` with `position: fixed` and size
// it to `window.visualViewport` (the region actually visible above the
// keyboard), offset by `offsetTop` for the rare case the visual viewport is
// itself scrolled. With nothing scrollable, the composer stays locked just above
// the keyboard and the shell never drifts. Desktop: offsetTop 0, height = the
// window, i.e. a normal full-screen app.

export function initViewport(): void {
  const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
  const root = document.documentElement;

  const apply = (): void => {
    const h = vv?.height ?? window.innerHeight;
    const top = vv?.offsetTop ?? 0;
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
    root.style.setProperty("--app-top", `${Math.round(top)}px`);
    // How much of the layout viewport the on-screen keyboard (plus any bottom
    // browser chrome) is covering: innerHeight is the full layout viewport,
    // `h + top` the region still visible above it. Published so overlays can
    // stop reserving space for UI the keyboard has pushed out of reach — e.g. a
    // picker sheet otherwise floats a whole composer's height above the
    // keyboard, stranding its list near the top with a dead gap below (see
    // .sheet-body). 0 when no keyboard is up.
    const keyboard = Math.max(0, Math.round((window.innerHeight || h) - h - top));
    root.style.setProperty("--keyboard-h", `${keyboard}px`);
  };

  apply();
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  } else {
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
  }
}
