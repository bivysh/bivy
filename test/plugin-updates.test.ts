// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Installed plugins know where they came from: outdated compares, update takes
// the change, and rollback undoes it. Nothing here updates on its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findContribution } from "../src/plugins/contributions.js";
import { childSource } from "../src/plugins/source.js";
import { installPlugin, listPluginSnapshots, rollbackPlugin } from "../src/plugins/store.js";
import { checkPluginUpdates, updatePlugin } from "../src/plugins/updates.js";

function writePlugin(dir: string, version: string, guide: string): void {
  fs.mkdirSync(path.join(dir, "guides"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bivy.plugin.yaml"), `apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata: { id: standup, name: Standup, version: ${version} }
contributes:
  guides:
    - { topic: standups, file: guides/standups.md }
`);
  fs.writeFileSync(path.join(dir, "guides", "standups.md"), `# Standups\n\nSummary: ${guide}\n`);
}

const guideText = (data: string) => {
  const found = findContribution("guides", "standups", data)!;
  return fs.readFileSync(path.join(found.dir, found.item.file), "utf8");
};

test("outdated sees a changed source, update takes it, rollback undoes it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-updates-"));
  const source = path.join(root, "standup");
  const data = path.join(root, "data");
  try {
    writePlugin(source, "1.0.0", "first");
    installPlugin(source, { dataDir: data, source });
    assert.deepEqual(checkPluginUpdates({ dataDir: data }).map((c) => c.status), ["current"]);

    writePlugin(source, "1.0.0", "edited");
    assert.deepEqual(checkPluginUpdates({ dataDir: data }).map((c) => c.status), ["changed"], "a file change without a new version");

    writePlugin(source, "1.1.0", "second");
    const [check] = checkPluginUpdates({ dataDir: data });
    assert.deepEqual([check!.status, check!.installed, check!.available], ["update", "1.0.0", "1.1.0"]);

    assert.deepEqual(updatePlugin("standup", { dataDir: data }), { id: "standup", from: "1.0.0", to: "1.1.0" });
    assert.match(guideText(data), /second/);
    assert.deepEqual(checkPluginUpdates({ dataDir: data }).map((c) => c.status), ["current"], "the update records the new state");

    assert.deepEqual(rollbackPlugin("standup", data), { from: "1.1.0", to: "1.0.0" });
    assert.match(guideText(data), /first/);
    assert.equal(checkPluginUpdates({ dataDir: data })[0]!.status, "update", "after a rollback the newer source shows again");

    for (let i = 0; i < 5; i += 1) installPlugin(source, { dataDir: data, source, force: true });
    assert.equal(listPluginSnapshots("standup", data).length, 3, "only the last three copies are kept");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin without a recorded source is reported, not guessed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-updates-"));
  try {
    writePlugin(path.join(root, "standup"), "1.0.0", "first");
    installPlugin(path.join(root, "standup"), { dataDir: path.join(root, "data") });
    assert.equal(checkPluginUpdates({ dataDir: path.join(root, "data") })[0]!.status, "no-source");
    assert.throws(() => updatePlugin("standup", { dataDir: path.join(root, "data") }), /doesn't know where standup came from/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin from a kit records its own source inside the kit", () => {
  assert.equal(childSource("github:team/setup#v2", "plugins/standup"), "github:team/setup/plugins/standup#v2");
  assert.equal(childSource("github:team/repo/kits/main", "plugins/standup"), "github:team/repo/kits/main/plugins/standup");
  assert.equal(childSource("https://gitlab.com/team/setup.git", "plugins/standup"), undefined, "a plain git URL cannot name a folder");
  assert.equal(childSource("/home/me/kit", "plugins/standup"), "/home/me/kit/plugins/standup");
});
