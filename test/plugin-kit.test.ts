// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// A kit carries one machine's plugins and theme to another: what is exported
// must install unchanged, and a kit may only point inside itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectedThemeId, selectTheme } from "../src/machine-theme.js";
import { installedContributions } from "../src/plugins/contributions.js";
import { applyKit, exportKit, KIT_FILE, readKit } from "../src/plugins/kit.js";
import { installPlugin } from "../src/plugins/store.js";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("an exported kit applies on another machine with the same plugins and theme", () => {
  const source = tmp("bivy-kit-src-");
  fs.writeFileSync(path.join(source, "bivy.plugin.yaml"), `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata: { id: dusk, name: Dusk, version: 1.0.0 }
contributes:
  themes:
    - { id: dusk, name: Dusk, mode: dark, colors: { background: "#101018", foreground: "#e0e0f0" } }
  widgets:
    - { id: note, name: Note, entry: note.html }
`);
  fs.writeFileSync(path.join(source, "note.html"), "<p>hi</p>");
  const machineA = tmp("bivy-kit-a-");
  installPlugin(source, { dataDir: machineA });
  selectTheme(machineA, installedContributions("themes", machineA).items[0]!.item);

  const kitDir = path.join(tmp("bivy-kit-out-"), "my-kit");
  const kit = exportKit(kitDir, machineA, { id: "my-kit", name: "My kit" });
  assert.deepEqual(kit.plugins, ["plugins/dusk"]);
  assert.equal(kit.theme, "dusk");
  assert.ok(fs.existsSync(path.join(kitDir, "plugins/dusk/bivy.plugin.yaml")));
  assert.throws(() => exportKit(kitDir, machineA, { id: "my-kit", name: "Again" }), /already exists/);

  const machineB = tmp("bivy-kit-b-");
  const applied = applyKit(kitDir, machineB);
  assert.deepEqual(applied.installed, ["dusk"]);
  assert.equal(installedContributions("widgets", machineB).items[0]?.item.id, "note");
  assert.equal(selectedThemeId(machineB), null, "applying installs; the CLI sets the theme it names");
});

test("a kit that points outside itself is refused", () => {
  const dir = tmp("bivy-kit-bad-");
  fs.writeFileSync(path.join(dir, KIT_FILE), "apiVersion: bivy.sh/v1alpha1\nkind: Kit\nmetadata: { id: bad, name: Bad }\nplugins: [../elsewhere, /etc]\n");
  assert.throws(() => readKit(dir), /must be a folder inside the kit/);
});
