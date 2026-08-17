// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The Models-screen preset editor writes credentials.config.json
// — set the active preset and map a provider→label within a preset — while
// preserving other config keys (e.g. `ingest`). The read side is `getCredentialPresets`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getCredentialPresets,
  setActiveCredentialPreset,
  setCredentialPresetMapping,
  getCredentialIngestPolicy,
  setCredentialIngestPolicy,
} from "../src/credentials/api.js";
import { defaultPresetsPath } from "../src/credentials/presets.js";

function freshApp(): { credsDir: string; cfgPath: string } {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-presets-write-"));
  const credsDir = path.join(appDir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return { credsDir, cfgPath: defaultPresetsPath(credsDir) };
}

// --- writes preserve unrelated config keys (ingest) + normalize -------------
{
  const { credsDir, cfgPath } = freshApp();
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ ingest: { policy: "separate" } }));

    setCredentialPresetMapping(credsDir, "project:acme", "Anthropic", "Work");
    setActiveCredentialPreset(credsDir, "project:acme");

    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.deepEqual(raw.ingest, { policy: "separate" }, "an unrelated config key is preserved");
    assert.equal(raw.active, "project:acme");
    assert.equal(raw.presets["project:acme"].anthropic, "work", "provider + label normalized");

    const view = getCredentialPresets(credsDir);
    assert.equal(view.active, "project:acme");
    assert.equal(view.presets?.["project:acme"].anthropic, "work");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- clearing a mapping drops an emptied preset; clearing active removes it --
{
  const { credsDir, cfgPath } = freshApp();
  try {
    setCredentialPresetMapping(credsDir, "team", "openai", "work");
    setActiveCredentialPreset(credsDir, "team");
    assert.equal(getCredentialPresets(credsDir).presets?.team.openai, "work");

    setCredentialPresetMapping(credsDir, "team", "openai", ""); // clear the only mapping
    assert.equal(getCredentialPresets(credsDir).presets?.team, undefined, "an emptied preset is dropped");

    setActiveCredentialPreset(credsDir, ""); // clear active
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).active, undefined, "active cleared");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a missing/empty config is fine (getCredentialPresets → {}) -------------
{
  const { credsDir } = freshApp();
  try {
    assert.deepEqual(getCredentialPresets(credsDir), {}, "no config → empty presets");
    setActiveCredentialPreset(credsDir, "solo");
    assert.equal(getCredentialPresets(credsDir).active, "solo", "config created on first write");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- ingest policy get/set round-trips, preserving presets ------------------
{
  const { credsDir } = freshApp();
  try {
    assert.equal(getCredentialIngestPolicy(credsDir), "merge", "default is merge");
    setCredentialPresetMapping(credsDir, "team", "anthropic", "work");
    setCredentialIngestPolicy(credsDir, "separate");
    assert.equal(getCredentialIngestPolicy(credsDir), "separate");
    assert.equal(getCredentialPresets(credsDir).presets?.team.anthropic, "work", "setting ingest preserves presets");
    setCredentialIngestPolicy(credsDir, "merge");
    assert.equal(getCredentialIngestPolicy(credsDir), "merge");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

console.log("credential-presets-write: all tests passed");
