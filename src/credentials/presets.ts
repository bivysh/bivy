// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Credential selection presets (`credentials.config.json`), as config-as-code.
//
// A preset maps `provider → label` for a named context; `active` names the preset
// a session resolves against by default. Selection is manual — nothing here picks
// a credential; it only supplies the data `resolveCredential` (records.ts) reads.
//
// Validation is hand-rolled (no schema library) so this module stays pure and
// dependency-free — it imports only the record model — and a malformed config
// degrades to "no presets" (the implicit default) rather than breaking the
// credential path. See docs/credentials-service-plan.md §3.3 / §5.

import fs from "node:fs";
import path from "node:path";

import { normalizeProvider, normalizeLabel, type CredentialPresets } from "./records.js";

/** The conventional filename, a sibling of the credential vault dir. */
export const PRESETS_FILENAME = "credentials.config.json";

/** Default presets path for a given vault dir: `<dataDir>/credentials.config.json`. */
export function defaultPresetsPath(credsDir: string): string {
  return path.join(path.dirname(credsDir), PRESETS_FILENAME);
}

/**
 * Coerce arbitrary parsed JSON into a validated `CredentialPresets`. Pure and
 * total: any malformed shape yields `{}` (the implicit default), and every
 * provider/label is normalized so lookups match the record model. Preset names
 * are preserved verbatim (they are user-facing labels like "project:acme").
 */
export function parsePresets(raw: unknown): CredentialPresets {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: CredentialPresets = {};

  if (typeof obj.active === "string" && obj.active.trim()) out.active = obj.active.trim();

  const presetsRaw = obj.presets;
  if (presetsRaw && typeof presetsRaw === "object" && !Array.isArray(presetsRaw)) {
    const presets: Record<string, Record<string, string>> = {};
    for (const [name, mapping] of Object.entries(presetsRaw as Record<string, unknown>)) {
      if (!name.trim() || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
      const clean: Record<string, string> = {};
      for (const [provider, label] of Object.entries(mapping as Record<string, unknown>)) {
        if (typeof label !== "string" || !label.trim()) continue;
        const id = normalizeProvider(provider);
        if (id) clean[id] = normalizeLabel(label);
      }
      if (Object.keys(clean).length) presets[name.trim()] = clean;
    }
    if (Object.keys(presets).length) out.presets = presets;
  }

  return out;
}

/**
 * Read and validate the presets file. Missing, unreadable, or malformed → `{}`
 * (the implicit default), never a throw — selection must survive a bad config.
 */
export function loadPresets(filePath: string): CredentialPresets {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  try {
    return parsePresets(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * What Bivy does with a login it captures from an agent's own CLI/TUI
 * (`credentials.config.json` → `ingest.policy`):
 *  - `merge` (default): fold it into the provider's `default` credential — the
 *    historical behavior; a native login updates the synced Bivy credential.
 *  - `separate`: keep it as a distinct, node-local credential under a reserved
 *    agent-derived label, selectable via a preset — so work/personal logins on
 *    the same provider stay apart and a native login never overwrites a Bivy key.
 */
export type IngestPolicy = "merge" | "separate";

/** Read `ingest.policy` from a parsed config; anything unrecognized → `merge`. */
export function parseIngestPolicy(raw: unknown): IngestPolicy {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const ingest = (raw as { ingest?: unknown }).ingest;
    if (ingest && typeof ingest === "object" && !Array.isArray(ingest)) {
      if ((ingest as { policy?: unknown }).policy === "separate") return "separate";
    }
  }
  return "merge";
}

/** Load the ingest policy from the config file; missing/malformed → `merge`. */
export function loadIngestPolicy(filePath: string): IngestPolicy {
  try {
    return parseIngestPolicy(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return "merge";
  }
}

// --- writes (the Models UI / CLI edits the same config file) ----------------

/** Read the raw config object, preserving unknown keys (e.g. `ingest`). */
function readRawConfig(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Atomically write the config (0600), creating the directory if needed. */
function writeRawConfig(filePath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Set the agent-native ingest policy (`merge`/`separate`). Preserves other keys. */
export function setIngestPolicy(filePath: string, policy: IngestPolicy): void {
  const config = readRawConfig(filePath);
  const ingest = (config.ingest && typeof config.ingest === "object" && !Array.isArray(config.ingest)
    ? (config.ingest as Record<string, unknown>)
    : {});
  ingest.policy = policy === "separate" ? "separate" : "merge";
  config.ingest = ingest;
  writeRawConfig(filePath, config);
}

/** Set (or clear, with an empty name) the active preset. Preserves other keys. */
export function setActivePreset(filePath: string, active: string | undefined): void {
  const config = readRawConfig(filePath);
  const name = String(active ?? "").trim();
  if (name) config.active = name;
  else delete config.active;
  writeRawConfig(filePath, config);
}

/**
 * Within `preset`, map `provider` to `label` (an empty label clears it). Creates
 * the preset if new; drops it when its last mapping is cleared. Preserves other keys.
 */
export function setPresetMapping(filePath: string, preset: string, provider: string, label: string | undefined): void {
  const name = String(preset ?? "").trim();
  const id = normalizeProvider(provider);
  if (!name || !id) return;
  const config = readRawConfig(filePath);
  const rawPresets = config.presets;
  const presets: Record<string, Record<string, string>> =
    rawPresets && typeof rawPresets === "object" && !Array.isArray(rawPresets)
      ? (rawPresets as Record<string, Record<string, string>>)
      : {};
  const mapping = { ...(presets[name] && typeof presets[name] === "object" ? presets[name] : {}) };
  if (label && String(label).trim()) mapping[id] = normalizeLabel(label);
  else delete mapping[id];
  if (Object.keys(mapping).length) presets[name] = mapping;
  else delete presets[name];
  config.presets = presets;
  writeRawConfig(filePath, config);
}
