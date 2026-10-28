// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// What plugins add besides agents: widgets, tools, themes, guides. An agent
// writes these for the user, so the manifest fails closed, install copies only
// the plugin's own files, a name two plugins claim is used by neither, and a
// tool runs out of process with checked input.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMachineTheme, selectTheme } from "../src/machine-theme.js";
import { parsePluginManifest } from "../src/plugin-sdk/index.js";
import { installedContributions, readPluginWidget } from "../src/plugins/contributions.js";
import { installPlugin } from "../src/plugins/store.js";
import { runPluginTool, widgetTool } from "../src/plugins/tools.js";

const manifest = (id: string, contributes: string) => `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: ${id}
  name: ${id}
  version: 1.0.0
contributes:
${contributes}`;

const EVERYTHING = `
  widgets:
    - id: standup
      name: Standup
      entry: widgets/standup.html
  tools:
    - name: echo_input
      description: Echo the input back.
      input:
        text: { type: string, required: true }
      command: node
      args: ["{plugin}/tools/echo.mjs"]
      widgets: true
  themes:
    - id: dusk
      name: Dusk
      mode: dark
      colors: { background: "#101018", foreground: "#e0e0f0", accent: "#88aaff" }
  guides:
    - topic: standups
      file: guides/standups.md
`;

function pluginDir(id: string, contributes = EVERYTHING): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-src-"));
  fs.writeFileSync(path.join(dir, "bivy.plugin.yaml"), manifest(id, contributes));
  fs.mkdirSync(path.join(dir, "widgets"));
  fs.writeFileSync(path.join(dir, "widgets", "standup.html"), "<button>Done</button>");
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, "tools", "echo.mjs"), `let s = ""; for await (const c of process.stdin) s += c; const i = JSON.parse(s); if (i.text === "fail") { console.error("asked to fail"); process.exit(2); } console.log(JSON.stringify({ echoed: i.text, cwd: process.cwd() }));`);
  fs.mkdirSync(path.join(dir, "guides"));
  fs.writeFileSync(path.join(dir, "guides", "standups.md"), "# Standups\n\nSummary: How.\n");
  return dir;
}

test("a plugin may contribute only widgets, tools, themes and guides; unsafe ones fail closed", () => {
  const ok = parsePluginManifest(manifest("standup", EVERYTHING));
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.deepEqual(ok.manifest!.contributes.agents, []);
  assert.equal(ok.manifest!.contributes.tools![0]!.widgets, true);

  const bad = parsePluginManifest(manifest("bad", `
  widgets:
    - { id: w, name: W, entry: ../outside.html }
    - { id: w2, name: W, entry: page.js }
  tools:
    - { name: Bad-Name, description: x, command: x }
    - { name: ok_tool, description: x, command: x, timeoutSeconds: 9999 }
  themes:
    - { id: t1, name: T, colors: { background: red, foreground: "#fff" } }
  guides:
    - { topic: g1, file: /etc/passwd.md }
`));
  assert.equal(bad.ok, false);
  const errors = bad.errors.join("\n");
  assert.match(errors, /widgets\[0\]\.entry must be a relative path/);
  assert.match(errors, /widgets\[1\]\.entry must end in \.html/);
  assert.match(errors, /tools\[0\]\.name must be lowercase/);
  assert.match(errors, /timeoutSeconds must be an integer from 1 to 300/);
  assert.match(errors, /colors\.background must be a #rgb or #rrggbb color/);
  assert.match(errors, /guides\[0\]\.file must be a relative path/);
  assert.match(parsePluginManifest(manifest("empty", "  agents: []")).errors.join(), /at least one agent, widget, tool, theme or guide/);
});

test("install copies the plugin's own files only, and refuses a manifest naming a missing one", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-data-"));
  const src = pluginDir("standup");
  fs.mkdirSync(path.join(src, ".git"));
  fs.writeFileSync(path.join(src, ".git", "config"), "secret");
  fs.symlinkSync("/etc/hostname", path.join(src, "host-link"));
  const installed = installPlugin(src, { dataDir: data });
  assert.ok(fs.existsSync(path.join(installed.path, "widgets", "standup.html")));
  assert.ok(!fs.existsSync(path.join(installed.path, ".git")), "dot-directories stay behind");
  assert.ok(!fs.existsSync(path.join(installed.path, "host-link")), "symlinks are not followed or copied");
  assert.equal(readPluginWidget("standup", data).html, "<button>Done</button>");

  const missing = pluginDir("broken");
  fs.rmSync(path.join(missing, "guides", "standups.md"));
  assert.throws(() => installPlugin(missing, { dataDir: data }), /names files that are not in the plugin directory: guides\/standups\.md/);
});

test("a widget, tool, theme or guide two plugins both claim is used by neither", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-data-"));
  installPlugin(pluginDir("first"), { dataDir: data });
  installPlugin(pluginDir("second"), { dataDir: data });
  const { items, errors } = installedContributions("widgets", data);
  assert.deepEqual(items, []);
  assert.match(errors.join("\n"), /widget standup is also provided by first; neither is used/);
});

test("a tool runs out of process: input checked, JSON parsed, failures and its workspace reported", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-data-"));
  installPlugin(pluginDir("standup"), { dataDir: data });
  const tool = installedContributions("tools", data).items[0]!;
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ws-")));
  const result = await runPluginTool(tool, { text: "hi" }, { cwd: workspace });
  assert.deepEqual(result.structuredContent, { echoed: "hi", cwd: workspace });
  await assert.rejects(runPluginTool(tool, {}, { cwd: workspace }), /needs "text"/);
  await assert.rejects(runPluginTool(tool, { text: 1 }, { cwd: workspace }), /"text" must be a string/);
  await assert.rejects(runPluginTool(tool, { text: "hi", extra: true }, { cwd: workspace }), /does not take "extra"/);
  await assert.rejects(runPluginTool(tool, { text: "fail" }, { cwd: workspace }), /failed \(exit 2\): asked to fail/);
});

test("a widget gets only the tools whose plugin offers them to widgets", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-data-"));
  installPlugin(pluginDir("standup"), { dataDir: data });
  installPlugin(pluginDir("private", `
  tools:
    - { name: agent_only, description: Not for widgets., command: node, args: ["{plugin}/tools/echo.mjs"] }
`), { dataDir: data });
  assert.equal(widgetTool("echo_input", data).item.name, "echo_input");
  assert.throws(() => widgetTool("agent_only", data), /for agents only/);
  assert.throws(() => widgetTool("nothing", data), /No plugin on this machine provides a tool called "nothing"/);
});

test("a chosen theme replaces the desktop's, and clearing it brings the desktop's back", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-home-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-data-"));
  const desktop = path.join(home, ".config/omarchy/current/theme");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "colors.toml"), 'background = "#ffffff"\nforeground = "#000000"\n');
  const selected = path.join(data, "theme");
  assert.equal(readMachineTheme(home, selected)?.mode, "light");
  const dusk = parsePluginManifest(manifest("standup", EVERYTHING)).manifest!.contributes.themes![0]!;
  selectTheme(data, dusk);
  const theme = readMachineTheme(home, selected)!;
  assert.equal(theme.name, "Dusk");
  assert.equal(theme.mode, "dark");
  assert.equal(theme.colors.accent, "#88aaff");
  selectTheme(data, null);
  assert.equal(readMachineTheme(home, selected)?.colors.background, "#ffffff");
});
