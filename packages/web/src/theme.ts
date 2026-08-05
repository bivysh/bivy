// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Theme handling, matching the legacy tokens (bivy_theme in localStorage) so an
// existing install keeps its choice when it moves to the new client.

export type ThemeSetting = "system" | "light" | "dark";
const KEY = "bivy_theme";
// Browser-chrome / status-bar color per theme. MUST match `--bg` in styles.css
// (and the static <meta name="theme-color"> tags in index.html) so the chrome
// blends into the app background instead of showing a pure white/black band.
const THEME_COLORS: Record<"light" | "dark", string> = { light: "#f5f3ee", dark: "#14171a" };

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
  const color = THEME_COLORS[resolvedTheme(setting)];
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
