// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { currentBivyVersion } from "../src/app-version.js";
import { recommendedBivyRange } from "../src/plugin-sdk/index.js";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
// Derive from the repo's own version so a release bump never breaks these tests.
const bivyRange = recommendedBivyRange(currentBivyVersion());
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function run(args: string[], env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(tsx, [path.join(root, "src", "plugin-cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("plugin CLI scaffolds a schema-linked, compatible manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-init-"));
  const target = path.join(dir, "sample-plugin");
  try {
    const initialized = run(["init", target, "--id", "sample-agent", "--name", "Sample Agent", "--adapter", "process", "--json"], { BIVY_DATA_DIR: dir });
    assert.equal(initialized.status, 0, initialized.stderr);
    const body = JSON.parse(initialized.stdout);
    assert.equal(body.plugin.id, "sample-agent");
    const manifest = fs.readFileSync(path.join(target, "bivy.plugin.yaml"), "utf8");
    assert.match(manifest, /yaml-language-server.*plugin-sdk\/schema\/bivy\.plugin\.schema\.json/);
    assert.match(manifest, new RegExp(`requires:\\n {2}bivy: "${escape(bivyRange)}"`));
    assert.match(manifest, /kind: process/);

    const validated = run(["validate", target, "--json"], { BIVY_DATA_DIR: dir });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).compatibility.compatible, true);

    const doctor = run(["doctor", target, "--json"], { BIVY_DATA_DIR: dir, PATH: process.env.PATH ?? "" });
    assert.equal(doctor.status, 1);
    assert.match(JSON.parse(doctor.stdout).errors.join("\n"), /sample-agent was not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin CLI doctor and test perform a real ACP handshake", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-conformance-"));
  const file = path.join(dir, "bivy.plugin.yaml");
  const fixture = path.join(root, "test", "fixtures", "acp-agent.mjs");
  fs.writeFileSync(file, `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: conformance-agent
  name: Conformance Agent
  version: 1.0.0
requires:
  bivy: "${bivyRange}"
contributes:
  agents:
    - id: conformance-agent
      name: Conformance Agent
      adapter:
        kind: acp
        command: node
        args: [${JSON.stringify(fixture)}]
`);
  const env = { BIVY_DATA_DIR: dir };
  try {
    const doctor = run(["doctor", file, "--json"], env);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).checks.some((check: { name: string; status: string }) => check.name === "executable" && check.status === "pass"), true);

    const tested = run(["test", file, "--json"], env);
    assert.equal(tested.status, 0, tested.stderr);
    const body = JSON.parse(tested.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.checks.some((check: { name: string; message: string }) => check.name === "conformance" && /ACP initialize/.test(check.message)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin CLI validates, installs, lists, and removes a manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-cli-"));
  const file = path.join(dir, "bivy.plugin.yaml");
  fs.writeFileSync(file, `
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: cli-fixture
  name: CLI Fixture
  version: 1.0.0
contributes:
  agents:
    - id: cli-fixture
      name: CLI Fixture
      adapter:
        kind: acp
        command: fixture-agent
        args: [acp]
`);
  const env = { BIVY_DATA_DIR: dir };
  try {
    const validated = run(["validate", file, "--json"], env);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).plugin.id, "cli-fixture");

    const installed = run(["install", file, "--json"], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).restartRequired, true);

    const listed = run(["list", "--json"], env);
    assert.equal(listed.status, 0, listed.stderr);
    const body = JSON.parse(listed.stdout);
    assert.equal(body.plugins[0].id, "cli-fixture");
    assert.equal(body.plugins[0].agents[0].adapter, "acp");

    const agents = spawnSync(process.execPath, [path.join(root, "bin", "bivy.mjs"), "agents", "--json"], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(agents.status, 0, agents.stderr);
    assert.equal(JSON.parse(agents.stdout).agents.some((agent: { id: string }) => agent.id === "cli-fixture"), true);

    const removed = run(["remove", "cli-fixture", "--json"], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).removed, "cli-fixture");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
