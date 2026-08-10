// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPluginCompatibility, parsePluginManifest, PLUGIN_MANIFEST_SCHEMA, recommendedBivyRange } from "../src/plugin-sdk/index.js";
import { installPlugin, installedAgentContributions, listInstalledPlugins, removePlugin } from "../src/plugins/store.js";

const valid = `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: review-bot
  name: Review Bot
  version: 1.2.3
  homepage: https://example.com/review-bot
contributes:
  agents:
    - id: review-bot
      name: Review Bot
      description: Reviews changes.
      authOwner: mixed
      adapter:
        kind: process
        command: review-bot
        args: [run]
        promptMode: argv
        structured:
          args: [run, --stream-json]
          parser: generic-stream-json
        resume:
          args: [run, --resume, "{id}"]
        model:
          flag: --model
          insertAt: 1
          choices:
            - id: fast
              name: Fast
              provider: review-bot
`;

test("plugin manifest validates and normalizes a process agent", () => {
  const result = parsePluginManifest(valid);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.manifest?.metadata.id, "review-bot");
  const agent = result.manifest?.contributes.agents[0];
  assert.equal(agent?.adapter.kind, "process");
  if (agent?.adapter.kind === "process") {
    assert.deepEqual(agent.adapter.resume?.args, ["run", "--resume", "{id}"]);
    assert.equal(agent.adapter.model?.choices[0]?.id, "fast");
  }
});

test("plugin manifest validates compatibility ranges and checks the running version", () => {
  const result = parsePluginManifest(valid.replace("contributes:", "requires:\n  bivy: \">=0.10.0 <0.11.0\"\ncontributes:"));
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(checkPluginCompatibility(result.manifest!, "0.10.1").compatible, true);
  assert.equal(checkPluginCompatibility(result.manifest!, "0.10.1-staging.42").compatible, true);
  assert.equal(recommendedBivyRange("0.10.1-staging.42"), ">=0.10.1 <0.11.0");
  const incompatible = checkPluginCompatibility(result.manifest!, "0.11.0");
  assert.equal(incompatible.compatible, false);
  assert.match(incompatible.message, /requires Bivy/);

  const malformed = parsePluginManifest(valid.replace("contributes:", "requires:\n  bivy: definitely-not-semver\ncontributes:"));
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join("\n"), /valid semantic-version range/);
});

test("packaged JSON Schema is generated from the SDK schema object", () => {
  const file = path.resolve(import.meta.dirname, "../packages/plugin-sdk/schema/bivy.plugin.schema.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), PLUGIN_MANIFEST_SCHEMA);
});

test("plugin manifest fails closed on unknown fields and unsafe shapes", () => {
  const result = parsePluginManifest(`
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: x
  name: X
  version: 1
  script: ./install.sh
contributes:
  agents:
    - id: x
      name: X
      magic: true
      adapter:
        kind: process
        command: x
        resume:
          args: [--resume]
        structured:
          args: [--json]
          parser: made-up-parser
`);
  assert.equal(result.ok, false);
  const errors = result.errors.join("\n");
  assert.match(errors, /metadata\.script is not supported/);
  assert.match(errors, /magic is not supported/);
  assert.match(errors, /must contain an \{id\}/);
  assert.match(errors, /structured\.parser must be one of/);
});

test("plugin store installs atomically, lists, replaces, and removes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-store-"));
  const source = path.join(dir, "bivy.plugin.yaml");
  fs.writeFileSync(source, valid);
  try {
    const installed = installPlugin(source, { dataDir: dir });
    assert.equal(installed.replaced, false);
    assert.equal(fs.statSync(path.join(installed.path, "manifest.json")).mode & 0o777, 0o600);
    assert.throws(() => installPlugin(source, { dataDir: dir }), /already installed/);
    assert.equal(installPlugin(source, { dataDir: dir, force: true }).replaced, true);

    const listed = listInstalledPlugins(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.manifest?.metadata.version, "1.2.3");
    assert.deepEqual(installedAgentContributions(dir).agents.map((item) => item.agent.id), ["review-bot"]);

    assert.equal(removePlugin("review-bot", dir), true);
    assert.equal(removePlugin("review-bot", dir), false);
    assert.deepEqual(listInstalledPlugins(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin store rejects incompatible installs and omits incompatible installed contributions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-compatibility-"));
  const source = path.join(dir, "bivy.plugin.yaml");
  fs.writeFileSync(source, valid.replace("contributes:", "requires:\n  bivy: \">=0.10.0 <0.11.0\"\ncontributes:"));
  try {
    assert.throws(() => installPlugin(source, { dataDir: dir, bivyVersion: "0.11.0" }), /requires Bivy/);
    installPlugin(source, { dataDir: dir, bivyVersion: "0.10.1" });
    assert.deepEqual(installedAgentContributions(dir).agents.map((item) => item.agent.id), ["review-bot"]);
    assert.equal(listInstalledPlugins(dir, "0.11.0")[0]?.errors.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installed plugin diagnostics report malformed manifests and duplicate agents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-errors-"));
  try {
    const sourceA = path.join(dir, "a.yaml");
    const sourceB = path.join(dir, "b.yaml");
    fs.writeFileSync(sourceA, valid.replace("id: review-bot\n  name", "id: plugin-a\n  name"));
    fs.writeFileSync(sourceB, valid.replace("id: review-bot\n  name", "id: plugin-b\n  name"));
    installPlugin(sourceA, { dataDir: dir });
    installPlugin(sourceB, { dataDir: dir });
    fs.mkdirSync(path.join(dir, "plugins", "broken"));
    fs.writeFileSync(path.join(dir, "plugins", "broken", "manifest.json"), "{not json");

    const contributions = installedAgentContributions(dir);
    assert.equal(contributions.agents.length, 1);
    assert.match(contributions.errors.join("\n"), /conflicts with plugin plugin-a/);
    assert.match(contributions.errors.join("\n"), /broken/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
