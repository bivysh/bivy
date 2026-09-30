// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The app matches an Omarchy machine's theme: the node resolves the staged
// colors.toml the way Omarchy does and notices a theme switch.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlatToml, readMachineTheme, resolveMachineTheme, watchMachineTheme } from "../src/machine-theme.js";

const TOKYO_NIGHT = `mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
foreground = "#a9b1d6"
red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
`;

// A theme from before Omarchy's semantic names: ANSI colors only, no mode.
const LEGACY_LIGHT = `accent = "#1e66f5"
background = "#EFF1F5" # comment
foreground = "#4c4f69"
color1 = "#d20f39"
color2 = "#40a02b"
color3 = "#df8e1d"
color4 = "#1e66f5"
color5 = "#ea76cb"
color6 = "#179299"
color8 = "#acb0be"
`;

async function run() {
  const semantic = resolveMachineTheme(parseFlatToml(TOKYO_NIGHT), "Tokyo Night");
  assert.equal(semantic?.mode, "dark");
  assert.equal(semantic?.colors.background, "#1a1b26");
  assert.equal(semantic?.colors.orange, "#eb927b");

  const legacy = resolveMachineTheme(parseFlatToml(LEGACY_LIGHT), "Latte");
  assert.equal(legacy?.mode, "light", "a light background makes a light theme when no mode is declared");
  assert.equal(legacy?.colors.background, "#eff1f5");
  assert.equal(legacy?.colors.red, "#d20f39", "ANSI color1 stands in for red");
  assert.equal(legacy?.colors.orange, "#df8e1d", "orange falls back to yellow, as in Omarchy");
  assert.equal(legacy?.colors.selection, "#acb0be", "selection falls back to color8");

  assert.equal(resolveMachineTheme({ foreground: "#ffffff", background: "url(x)" }, "Bad"), null, "a non-hex background is no palette");

  // Reads the staged theme, and notices a switch.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-omarchy-"));
  const current = path.join(home, ".local/state/omarchy/current");
  fs.mkdirSync(path.join(current, "theme"), { recursive: true });
  fs.writeFileSync(path.join(current, "theme/colors.toml"), TOKYO_NIGHT);
  fs.writeFileSync(path.join(current, "theme.name"), "tokyo-night\n");
  assert.equal(readMachineTheme(home)?.name, "Tokyo Night");
  assert.equal(readMachineTheme(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-no-omarchy-"))), null, "no Omarchy, no theme");

  // Resolves on the first change whose palette is the new one.
  const changed = new Promise<string | undefined>((resolve) => {
    const stop = watchMachineTheme((theme) => {
      if (theme?.mode !== "light") return;
      stop();
      resolve(theme.name);
    }, home, 20);
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.writeFileSync(path.join(current, "theme.name"), "catppuccin-latte\n");
  fs.writeFileSync(path.join(current, "theme/colors.toml"), LEGACY_LIGHT);
  assert.equal(await changed, "Catppuccin Latte");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("machine-theme: all tests passed");
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
