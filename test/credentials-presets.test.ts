// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unit spec for presets parsing/loading (src/credentials/presets.ts) and its
// composition with selection — the phase-3 live path. Pure: no vault.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePresets, loadPresets, defaultPresetsPath, PRESETS_FILENAME } from "../src/credentials/presets.js";
import { resolveCredential, type CredentialRecord } from "../src/credentials/records.js";

// --- parsePresets: valid config ---------------------------------------------
{
  const parsed = parsePresets({
    active: "  project:acme  ",
    presets: {
      default: { anthropic: "personal", OpenAI: "Personal" },
      "project:acme": { anthropic: "Work" },
    },
  });
  assert.equal(parsed.active, "project:acme", "active is trimmed");
  assert.equal(parsed.presets?.default.anthropic, "personal");
  assert.equal(parsed.presets?.default.openai, "personal", "provider + label normalized");
  assert.equal(parsed.presets?.["project:acme"].anthropic, "work");
}

// --- parsePresets: garbage / partial degrades to {} or drops bad entries ----
assert.deepEqual(parsePresets(null), {});
assert.deepEqual(parsePresets(42), {});
assert.deepEqual(parsePresets([1, 2]), {});
assert.deepEqual(parsePresets({ active: 5 }), {}, "non-string active dropped");
{
  const parsed = parsePresets({ presets: { x: { anthropic: "" }, y: { openai: "work" }, z: 3 } });
  assert.equal(parsed.presets?.x, undefined, "empty-label entry dropped, leaving preset empty");
  assert.equal(parsed.presets?.y.openai, "work");
  assert.equal(parsed.presets?.z, undefined, "non-object preset dropped");
}

// --- loadPresets: missing/malformed file → {} (never throws) ----------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-presets-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  const p = defaultPresetsPath(credsDir);
  assert.equal(p, path.join(dir, PRESETS_FILENAME), "config sits beside the vault dir");

  assert.deepEqual(loadPresets(p), {}, "missing file → {}");
  fs.writeFileSync(p, "{ not json");
  assert.deepEqual(loadPresets(p), {}, "malformed file → {}");
  fs.writeFileSync(p, JSON.stringify({ active: "team", presets: { team: { anthropic: "work" } } }));
  assert.equal(loadPresets(p).presets?.team.anthropic, "work");

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- composition: presets + resolveCredential = the live selection ----------
{
  const rec = (provider: string, label: string): CredentialRecord => ({
    provider,
    label,
    origin: "bivy",
    sync: "account",
    source: { kind: "stored", cred: { type: "api_key", key: `${provider}-${label}` } },
  });
  const records = [rec("anthropic", "work"), rec("anthropic", "personal")];

  // active preset picks the labeled account
  const presets = parsePresets({ active: "acme", presets: { acme: { anthropic: "work" } } });
  const sel = resolveCredential("anthropic", records, presets);
  assert.equal(sel?.record.label, "work");
  assert.equal(sel?.reason, "preset:acme");

  // zero-config invariant: one default credential, no presets → picked invisibly
  const single = resolveCredential("anthropic", [rec("anthropic", "default")], parsePresets(null));
  assert.equal(single?.record.label, "default");
  assert.equal(single?.reason, "default label");
}

console.log("credentials-presets: all tests passed");
