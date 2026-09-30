// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Theme handling, matching the legacy tokens (bivy_theme in localStorage) so an
// existing install keeps its choice when it moves to the new client.

// "machine" follows the desktop theme of the machine the app is connected to
// (Omarchy), and is the default: with no machine theme it behaves as "system".
export type ThemeSetting = "machine" | "system" | "light" | "dark";
const KEY = "bivy_theme";
const MACHINE_KEY = "bivy_machine_theme";

export interface MachineTheme {
  name: string;
  mode: "light" | "dark";
  colors: Record<string, string>;
}

// The --machine-* inputs tokens.css derives the palette from.
const MACHINE_COLORS = ["background", "foreground", "accent", "selection", "muted", "red", "green", "yellow", "blue", "magenta", "cyan", "orange"];
const HEX = /^#[0-9a-f]{6}$/i;

/** A palette from the node, or null when it is missing or malformed in any way. */
function parseMachineTheme(value: unknown): MachineTheme | null {
  const theme = value as Partial<MachineTheme> | null;
  if (!theme || typeof theme !== "object" || (theme.mode !== "light" && theme.mode !== "dark")) return null;
  const colors: Record<string, string> = {};
  for (const key of MACHINE_COLORS) {
    const color = theme.colors?.[key];
    if (typeof color !== "string" || !HEX.test(color)) return null;
    colors[key] = color;
  }
  return { name: typeof theme.name === "string" ? theme.name.slice(0, 60) : "Machine", mode: theme.mode, colors };
}

// Last palette seen, kept so the next launch paints in it before the node answers.
let machine: MachineTheme | null = (() => {
  try { return parseMachineTheme(JSON.parse(localStorage.getItem(MACHINE_KEY) ?? "null")); } catch { return null; }
})();
const machineListeners = new Set<() => void>();

export function machineTheme(): MachineTheme | null {
  return machine;
}

/** Called with each `node.theme` event: the connected machine's palette, or null. */
export function setMachineTheme(value: unknown): void {
  const next = parseMachineTheme(value);
  if (JSON.stringify(next) === JSON.stringify(machine)) return;
  machine = next;
  try {
    if (next) localStorage.setItem(MACHINE_KEY, JSON.stringify(next));
    else localStorage.removeItem(MACHINE_KEY);
  } catch {
    /* ignore */
  }
  applyTheme();
  for (const listener of machineListeners) listener();
}

export function onMachineThemeChange(listener: () => void): () => void {
  machineListeners.add(listener);
  return () => machineListeners.delete(listener);
}
// Browser-chrome / status-bar color, read from the live `--bg` design token
// (packages/ui/tokens.css is the single source of truth) so the chrome always
// tracks the app background instead of showing a pure white/black band — and
// there is no hardcoded hex here to drift out of sync when the palette changes.
// Returns null when the token can't be read yet (styles not loaded); the caller
// then leaves the build-time `<meta>` values — also derived from `--bg` — alone.
function themeColor(): string | null {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) return bg;
  } catch {
    /* getComputedStyle can throw if called before styles load; fall through */
  }
  return null;
}

export function currentThemeSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "machine";
  } catch {
    return "machine";
  }
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedTheme(setting: ThemeSetting = currentThemeSetting()): "light" | "dark" {
  if (setting === "machine") return machine?.mode ?? (prefersDark() ? "dark" : "light");
  return setting === "system" ? (prefersDark() ? "dark" : "light") : setting;
}

export function applyTheme(setting: ThemeSetting = currentThemeSetting()): void {
  const root = document.documentElement;
  const palette = setting === "machine" ? machine : null;
  for (const key of MACHINE_COLORS) {
    if (palette) root.style.setProperty(`--machine-${key}`, palette.colors[key]!);
    else root.style.removeProperty(`--machine-${key}`);
  }
  if (palette) root.dataset.machineTheme = palette.name;
  else delete root.dataset.machineTheme;
  const mode = palette?.mode ?? setting;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode;
  else delete root.dataset.theme;
  // index.html declares two static `<meta name="theme-color" media="...">`
  // tags so the *system-default* browser-chrome color is already correct
  // before this ever runs. For an explicit override (setting !== "system")
  // the resolved color may disagree with the system preference, so push it
  // onto every theme-color tag — whichever one the browser's media query
  // currently has "active" will show that content either way, so this
  // doesn't need to know (or care) which one that is.
  const color = themeColor();
  if (!color) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.setAttribute("content", color));
}

export function setTheme(setting: ThemeSetting): void {
  try {
    if (setting === "machine") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    /* ignore */
  }
  applyTheme(setting);
}

export function cycleTheme(): ThemeSetting {
  const order: ThemeSetting[] = machine ? ["machine", "system", "light", "dark"] : ["system", "light", "dark"];
  const next = order[(order.indexOf(currentThemeSetting()) + 1) % order.length]!;
  setTheme(next);
  return next;
}
