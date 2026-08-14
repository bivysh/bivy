// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unit spec for the pure credential record model + selection (src/credentials/records.ts).
// No vault, no I/O — selection is a pure function over records + presets.

import assert from "node:assert/strict";

import {
  credKey,
  parseCredKey,
  normalizeLabel,
  normalizeProvider,
  agentNativeLabel,
  defaultSyncFor,
  resolveCredential,
  missingPresetLabels,
  DEFAULT_LABEL,
  type CredentialRecord,
  type CredentialOrigin,
} from "../src/credentials/records.js";

function rec(provider: string, label: string, origin: CredentialOrigin = "bivy"): CredentialRecord {
  return {
    provider: normalizeProvider(provider),
    label: normalizeLabel(label),
    origin,
    sync: defaultSyncFor(origin),
    source: { kind: "stored", cred: { type: "api_key", key: `${provider}-${label}` } },
  };
}

// --- keys & normalization ---------------------------------------------------
assert.equal(credKey(" Anthropic ", "Work"), "anthropic:work", "credKey normalizes both parts");
assert.equal(credKey("openai", ""), "openai:default", "empty label collapses to default");
assert.equal(credKey("openai", undefined), "openai:default", "missing label collapses to default");
assert.deepEqual(parseCredKey("anthropic:work"), { provider: "anthropic", label: "work" });
assert.equal(parseCredKey("nope"), undefined, "a key without ':' is malformed");
assert.equal(parseCredKey(":work"), undefined, "an empty provider is malformed");
assert.equal(normalizeLabel(undefined), DEFAULT_LABEL);

// --- agent-native reserved labels (never 'default') -------------------------
assert.equal(agentNativeLabel("claude-code"), "claude-code");
assert.equal(agentNativeLabel("openai-codex", "acct_123"), "openai-codex-acct-123");
assert.notEqual(agentNativeLabel("claude-code"), DEFAULT_LABEL, "ingest never lands on default");

// --- sync defaults ----------------------------------------------------------
assert.equal(defaultSyncFor("bivy"), "account", "bivy-first logins sync (opt-out)");
assert.equal(defaultSyncFor("agent-native"), "node", "agent-native logins stay node-local");

// --- zero-config: a single default-labelled key is picked invisibly ---------
{
  const s = resolveCredential("anthropic", [rec("anthropic", "default")]);
  assert.equal(s?.record.label, "default");
  assert.equal(s?.reason, "default label");
}

// --- a single non-default credential is still unambiguous -------------------
{
  const s = resolveCredential("anthropic", [rec("anthropic", "work")]);
  assert.equal(s?.record.label, "work");
  assert.equal(s?.reason, "only credential");
}

// --- explicit per-session label overrides everything ------------------------
{
  const recs = [rec("anthropic", "work"), rec("anthropic", "personal")];
  const s = resolveCredential("anthropic", recs, undefined, { preferLabel: "personal" });
  assert.equal(s?.record.label, "personal");
  assert.equal(s?.reason, "explicit label");
  // an explicit label that doesn't exist does not silently fall back
  assert.equal(resolveCredential("anthropic", recs, undefined, { preferLabel: "nope" }), undefined);
}

// --- active preset mapping, and per-session preset override -----------------
{
  const recs = [rec("anthropic", "work"), rec("anthropic", "personal")];
  const presets = {
    active: "project:acme",
    presets: { "project:acme": { anthropic: "work" }, other: { anthropic: "personal" } },
  };
  assert.equal(resolveCredential("anthropic", recs, presets)?.record.label, "work");
  assert.equal(resolveCredential("anthropic", recs, presets)?.reason, "preset:project:acme");
  // per-session request wins over config's `active`
  const s = resolveCredential("anthropic", recs, presets, { preset: "other" });
  assert.equal(s?.record.label, "personal");
  assert.equal(s?.reason, "preset:other");
}

// --- the conventional "default" preset is the fallback ----------------------
{
  const recs = [rec("anthropic", "work"), rec("anthropic", "personal")];
  const presets = { presets: { default: { anthropic: "personal" } } };
  const s = resolveCredential("anthropic", recs, presets);
  assert.equal(s?.record.label, "personal");
  assert.equal(s?.reason, "default preset");
}

// --- ambiguity never guesses ------------------------------------------------
{
  const recs = [rec("anthropic", "work"), rec("anthropic", "personal")];
  assert.equal(resolveCredential("anthropic", recs), undefined, "two accounts, no guidance → undefined");
}

// --- a dangling preset refuses to downgrade AND is reported -----------------
{
  const recs = [rec("anthropic", "personal")];
  const presets = { active: "x", presets: { x: { anthropic: "work" } } };
  assert.equal(resolveCredential("anthropic", recs, presets), undefined, "no silent downgrade to another key");
  assert.deepEqual(missingPresetLabels(recs, presets), [{ preset: "x", provider: "anthropic", label: "work" }]);
}

// --- unknown provider -------------------------------------------------------
assert.equal(resolveCredential("mistral", [rec("anthropic", "default")]), undefined);

// --- agent-native record coexists with a bivy key, additively ---------------
{
  const recs = [rec("anthropic", "work", "bivy"), rec("anthropic", agentNativeLabel("claude-code"), "agent-native")];
  assert.equal(recs.length, 2, "ingest is additive — no clobber of the bivy key");
  const s = resolveCredential("anthropic", recs, undefined, { preferLabel: "claude-code" });
  assert.equal(s?.record.origin, "agent-native");
  assert.equal(s?.record.sync, "node", "ingested credential stays node-local by default");
}

console.log("credentials-records: all tests passed");
