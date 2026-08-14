// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Theme handling, matching the legacy tokens (bivy_theme in localStorage) so an
// existing install keeps its choice when it moves to the new client.

export type ThemeSetting = "system" | "light" | "dark";
const KEY = "bivy_theme";
// Browser-chrome / status-bar color, read from the live `--bg` design token
// (packages/ui/tokens.css is the single source of truth) so the chrome always
// tracks the app background instead of showing a pure white/black band — and
// there is no hardcoded hex here to drift out of sync when the palette changes.
function themeColor(): string {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) return bg;
  } catch {
    /* getComputedStyle can throw if called before styles load; fall through */
  }
  return "#f5f3ee"; // paper-light --bg fallback; matches the static <meta> in index.html
}

export function currentThemeSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedTheme(setting: ThemeSetting = currentThemeSetting()): "light" | "dark" {
  return setting === "system" ? (prefersDark() ? "dark" : "light") : setting;
}

export function applyTheme(setting: ThemeSetting = currentThemeSetting()): void {
  const root = document.documentElement;
  if (setting === "light" || setting === "dark") root.dataset.theme = setting;
  else delete root.dataset.theme;
  // index.html declares two static `<meta name="theme-color" media="...">`
  // tags so the *system-default* browser-chrome color is already correct
  // before this ever runs. For an explicit override (setting !== "system")
  // the resolved color may disagree with the system preference, so push it
  // onto every theme-color tag — whichever one the browser's media query
  // currently has "active" will show that content either way, so this
  // doesn't need to know (or care) which one that is.
  const color = themeColor();
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.setAttribute("content", color));
}

export function setTheme(setting: ThemeSetting): void {
  try {
    if (setting === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    /* ignore */
  }
  applyTheme(setting);
}

export function cycleTheme(): ThemeSetting {
  const order: ThemeSetting[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(currentThemeSetting()) + 1) % order.length]!;
  setTheme(next);
  return next;
}
