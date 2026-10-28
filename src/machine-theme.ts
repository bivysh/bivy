// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The theme of the machine a node runs on, so the app can match it: one chosen
// in Bivy (`bivy theme set`, from a plugin), else the desktop's. Today the
// desktop is Omarchy: `omarchy-theme-set` stages the active theme's
// `colors.toml`, which this reads, resolves the way Omarchy does (legacy names
// and ANSI fallbacks) and sends to clients as `node.theme`. Another desktop is
// another row in THEME_SOURCES; a theme chosen in Bivy is written in the same
// format, so both take the same path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MachineTheme {
  /** Display name, e.g. "Tokyo Night". */
  name: string;
  mode: "light" | "dark";
  /** Resolved `#rrggbb` colors, keyed by Omarchy's semantic names. */
  colors: Record<MachineColor, string>;
}

export const MACHINE_COLORS = ["background", "foreground", "accent", "selection", "muted", "red", "green", "yellow", "blue", "magenta", "cyan", "orange"] as const;
export type MachineColor = (typeof MACHINE_COLORS)[number];

/** Where a desktop keeps its active palette. Checked in order; the first that exists wins. */
export const THEME_SOURCES = [
  // Omarchy 3.2+: the staged, generated copy of the active theme.
  { colors: ".local/state/omarchy/current/theme/colors.toml", name: ".local/state/omarchy/current/theme.name" },
  // Earlier Omarchy: a symlink to the active theme's directory.
  { colors: ".config/omarchy/current/theme/colors.toml", name: null },
];

// Omarchy's own resolution order (bin/omarchy-theme-color): each key's
// candidates, first defined wins. Legacy short names and ANSI colorN come last.
const FALLBACKS: Record<MachineColor, string[]> = {
  background: ["background", "bg", "color0"],
  foreground: ["foreground", "fg", "color7"],
  accent: ["accent", "blue", "color4"],
  selection: ["selection", "selection_background", "color8", "color0", "background", "bg"],
  muted: ["muted", "color8", "dark_foreground", "dark_fg", "foreground", "fg", "color7"],
  red: ["red", "color1"],
  green: ["green", "color2"],
  yellow: ["yellow", "color3"],
  blue: ["blue", "color4"],
  magenta: ["magenta", "purple", "color5"],
  cyan: ["cyan", "color6"],
  orange: ["orange", "yellow", "color3"],
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `key = "value"` pairs from a flat TOML palette; comments and tables ignored. */
export function parseFlatToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/.exec(line);
    if (match) out[match[1]!] = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  return out;
}

function expand(hex: string): string {
  const h = hex.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

function isLight(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) > 382;
}

/** A palette the app can use, or null when the file lacks a usable background and foreground. */
export function resolveMachineTheme(raw: Record<string, string>, name: string, lightModeFile = false): MachineTheme | null {
  const colors = {} as Record<MachineColor, string>;
  for (const key of MACHINE_COLORS) {
    const value = FALLBACKS[key].map((candidate) => raw[candidate]).find((v) => v && HEX.test(v));
    if (value) colors[key] = expand(value);
  }
  if (!colors.background || !colors.foreground) return null;
  // Anything still missing falls back to the ink, so the app never mixes in a stray default.
  for (const key of MACHINE_COLORS) colors[key] ??= colors.foreground;
  const declared = raw.mode ?? raw.theme_type;
  const mode = declared === "light" || declared === "dark" ? declared : lightModeFile || isLight(colors.background) ? "light" : "dark";
  return { name, mode, colors };
}

function titleCase(slug: string): string {
  return slug.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`);
}

/** Where a theme chosen in Bivy itself is kept (`bivy theme set`), inside the data dir. */
export const SELECTED_THEME_DIR = "theme";

/**
 * Choose a palette for this machine (`bivy theme set`): written in the same
 * format as the desktop's, so it takes the same path to the app. `null` clears
 * the choice and the desktop's theme (if any) shows again.
 */
export function selectTheme(dataDir: string, theme: { id: string; name: string; mode?: "light" | "dark"; colors: Record<string, string> } | null): void {
  const dir = path.join(dataDir, SELECTED_THEME_DIR);
  if (!theme) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const lines = Object.entries(theme.colors).filter(([key, value]) => /^[a-z]+$/.test(key) && HEX.test(value)).map(([key, value]) => `${key} = "${value}"`);
  if (theme.mode) lines.push(`mode = "${theme.mode}"`);
  fs.writeFileSync(path.join(dir, "colors.toml"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "theme.name"), `${theme.name}\n`);
  fs.writeFileSync(path.join(dir, "theme.id"), `${theme.id}\n`);
}

/** The id of the palette chosen with `bivy theme set`, if any. */
export function selectedThemeId(dataDir: string): string | null {
  try {
    return fs.readFileSync(path.join(dataDir, SELECTED_THEME_DIR, "theme.id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Every place a palette may be, as absolute paths, the theme chosen in Bivy first. */
function themeSources(home: string, selectedDir?: string): { colors: string; name: string | null }[] {
  const selected = selectedDir ? [{ colors: path.join(selectedDir, "colors.toml"), name: path.join(selectedDir, "theme.name") }] : [];
  return [...selected, ...THEME_SOURCES.map((source) => ({ colors: path.join(home, source.colors), name: source.name ? path.join(home, source.name) : null }))];
}

/**
 * The machine's active theme, or null when there is none: one chosen with
 * `bivy theme set` (a plugin's theme) wins over the desktop's.
 */
export function readMachineTheme(home = os.homedir(), selectedDir?: string): MachineTheme | null {
  for (const source of themeSources(home, selectedDir)) {
    const colorsPath = source.colors;
    let text: string;
    try {
      text = fs.readFileSync(colorsPath, "utf8");
    } catch {
      continue;
    }
    const dir = path.dirname(colorsPath);
    let slug = "";
    try {
      slug = source.name ? fs.readFileSync(source.name, "utf8").trim() : path.basename(fs.realpathSync(dir));
    } catch {
      /* unnamed theme */
    }
    return resolveMachineTheme(parseFlatToml(text), titleCase(slug || "machine"), fs.existsSync(path.join(dir, "light.mode")));
  }
  return null;
}

/**
 * Call `onChange` whenever the machine's theme changes (a theme switch
 * replaces the staged directory, so this polls the file's stat rather than
 * holding an inotify watch on a directory that goes away). Returns a stop function.
 */
export function watchMachineTheme(onChange: (theme: MachineTheme | null) => void, home = os.homedir(), intervalMs = 1500, selectedDir?: string): () => void {
  let last = JSON.stringify(readMachineTheme(home, selectedDir));
  const check = () => {
    const theme = readMachineTheme(home, selectedDir);
    const next = JSON.stringify(theme);
    if (next === last) return;
    last = next;
    onChange(theme);
  };
  const paths = themeSources(home, selectedDir).flatMap((source) => [source.colors, source.name]).filter((p): p is string => !!p);
  for (const p of paths) fs.watchFile(p, { interval: intervalMs, persistent: false }, check);
  return () => { for (const p of paths) fs.unwatchFile(p, check); };
}
