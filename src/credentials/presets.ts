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
