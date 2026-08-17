// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The pure record model + selection for the standalone credential service.
//
// This module is the heart of multi-credential support and is deliberately
// I/O-FREE and dependency-free: it imports nothing at runtime (only a type-only
// reference to the existing StoredCredential shape, which type-stripping erases).
// Storage keys records by their NATURAL identity `provider:label` so the same
// logical credential created on two machines converges through the vault's
// existing freshest-wins merge instead of forking into duplicates. Selection is
// a pure function over records + presets that returns BOTH the chosen record and
// a human-readable reason — silent guesses are a footgun, so ambiguity returns
// undefined and the caller asks the user to choose.

import type { StoredCredential } from "./types.js";

/** Whether a credential is allowed to leave the node it was created on. */
export type SyncPolicy = "account" | "node";

/** Where a credential came from — used for display and to pick a sync default. */
export type CredentialOrigin = "bivy" | "agent-native";

/**
 * Where the secret actually lives.
 *  - `stored`    — a raw key / OAuth token set in the encrypted vault (today's model).
 *  - `reference` — a pointer (e.g. `op://…`) resolved LAZILY, per-node, via the
 *    existing secret vault. The materialized secret is never written into the
 *    credential vault. References are api-key-shaped only (a static pointer can't
 *    model a rotating OAuth token set).
 */
export type CredentialSource =
  | { kind: "stored"; cred: StoredCredential }
  | { kind: "reference"; ref: string; backend: "1password" | "env" | "command" };

/** One addressable credential. Its identity is `provider:label` (see `credKey`). */
export interface CredentialRecord {
  /** Normalized provider id, e.g. "anthropic". */
  provider: string;
  /** Normalized label, unique per provider, e.g. "work". */
  label: string;
  source: CredentialSource;
  sync: SyncPolicy;
  /** Provenance — display + default-picker only; behavior must never branch on it. */
  origin: CredentialOrigin;
  /** Explicit grant for control-plane-custodied unattended runners. Never implied by account sync. */
  unattended?: boolean;
  /** Store-owned mutation time (set by the vault, not by callers). */
  updatedAt?: number;
}

/** The label a single-credential (zero-config) user never has to think about. */
export const DEFAULT_LABEL = "default";

/** Normalize a provider id the way every path expects (trimmed, lowercased). */
export function normalizeProvider(provider: string): string {
  return String(provider ?? "").trim().toLowerCase();
}

/** Normalize a label; an empty label collapses to the default so callers can omit it. */
export function normalizeLabel(label: string | undefined): string {
  const trimmed = String(label ?? "").trim().toLowerCase();
  return trimmed || DEFAULT_LABEL;
}

/** The natural storage key for a credential: `provider:label`. */
export function credKey(provider: string, label: string | undefined): string {
  return `${normalizeProvider(provider)}:${normalizeLabel(label)}`;
}

/** Parse a `provider:label` key back into its parts (undefined if malformed). */
export function parseCredKey(key: string): { provider: string; label: string } | undefined {
  const raw = String(key ?? "");
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx >= raw.length - 1) return undefined;
  const provider = normalizeProvider(raw.slice(0, idx));
  const label = normalizeLabel(raw.slice(idx + 1));
  if (!provider) return undefined;
  return { provider, label };
}

/**
 * The reserved label an agent-native login is ingested under, so it can never
 * merge-clobber a Bivy-managed `provider:default` credential. Prefer the
 * account id when the native login carries one (distinguishes two accounts of
 * the same agent), otherwise the agent id.
 */
export function agentNativeLabel(agent: string, accountId?: string): string {
  const account = String(accountId ?? "").trim().toLowerCase();
  const base = normalizeProvider(agent) || "native";
  return account ? `${base}-${account.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` : base;
}

/** The default sync policy for a newly-created credential of a given origin. */
export function defaultSyncFor(origin: CredentialOrigin): SyncPolicy {
  // Bivy-first logins sync across the account by default (opt-out). Agent-native
  // logins stay on the node they were made on until explicitly promoted.
  return origin === "bivy" ? "account" : "node";
}

/**
 * The reference backend a pointer targets, inferred from its scheme:
 * `op://…` → 1Password, `env://NAME` → an environment variable, `cmd://…` → run a
 * command and use its stdout (the generic escape hatch for any password-manager
 * CLI — Bitwarden, LastPass, Proton Pass, pass, …). Anything else (a bare value,
 * a `secret://` local-vault ref, junk) returns undefined — a reference credential
 * must point at an external, per-node-resolvable secret.
 */
export function inferReferenceBackend(ref: string): "1password" | "env" | "command" | undefined {
  const value = String(ref ?? "").trim();
  if (value.startsWith("op://")) return "1password";
  if (value.startsWith("env://")) return "env";
  if (value.startsWith("cmd://")) return "command";
  return undefined;
}

/**
 * Selection config, as stored in `credentials.config.json`. `presets` maps a
 * preset name to a `provider → label` choice; `active` names the current preset.
 * Both are optional — an absent config means "use the implicit default".
 */
export interface CredentialPresets {
  active?: string;
  presets?: Record<string, Record<string, string>>;
}

/** A per-session selection request layered on top of the config. */
export interface SelectionRequest {
  /** An explicit per-session preset name (overrides `presets.active`). */
  preset?: string;
  /** An explicit per-session label (overrides presets entirely). */
  preferLabel?: string;
}

/** The outcome of selection: the chosen record plus a human-readable reason. */
export interface Selection {
  record: CredentialRecord;
  reason: string;
}

function recordsForProvider(records: readonly CredentialRecord[], provider: string): CredentialRecord[] {
  const id = normalizeProvider(provider);
  return records.filter((r) => r.provider === id);
}

function findByLabel(pool: readonly CredentialRecord[], label: string | undefined): CredentialRecord | undefined {
  const wanted = normalizeLabel(label);
  return pool.find((r) => r.label === wanted);
}

/**
 * Choose the one credential a session should use for `provider`. Pure and
 * order-independent. Ladder (simplest intent first); returns the reason so the
 * choice is observable in the CLI and PWA:
 *  1. explicit `preferLabel`               → "explicit label"
 *  2. the active preset's mapping          → "preset:<name>"
 *  3. the "default" preset's mapping       → "default preset"
 *  4. a record labeled `default`, else the provider's ONLY record → "only credential" / "default label"
 *  5. otherwise undefined (ambiguous) — the caller must ask the user to choose,
 *     never silently pick one of several accounts.
 */
export function resolveCredential(
  provider: string,
  records: readonly CredentialRecord[],
  presets?: CredentialPresets,
  request?: SelectionRequest,
): Selection | undefined {
  const pool = recordsForProvider(records, provider);
  if (pool.length === 0) return undefined;

  // 1. explicit per-session label.
  if (request?.preferLabel) {
    const hit = findByLabel(pool, request.preferLabel);
    return hit ? { record: hit, reason: "explicit label" } : undefined;
  }

  const id = normalizeProvider(provider);

  // 2. active preset (per-session request wins over the config's `active`).
  const activeName = request?.preset ?? presets?.active;
  if (activeName && presets?.presets?.[activeName]) {
    const label = presets.presets[activeName][id];
    if (label) {
      const hit = findByLabel(pool, label);
      // A preset that names a label we don't hold is a dangling reference; don't
      // silently fall through to another account — surface it (missingPresetLabels).
      return hit ? { record: hit, reason: `preset:${activeName}` } : undefined;
    }
  }

  // 3. the conventional "default" preset.
  const defaultPreset = presets?.presets?.default;
  if (defaultPreset && defaultPreset[id]) {
    const hit = findByLabel(pool, defaultPreset[id]);
    if (hit) return { record: hit, reason: "default preset" };
  }

  // 4. a record explicitly labeled `default`, else the provider's only credential.
  const defaultLabelled = findByLabel(pool, DEFAULT_LABEL);
  if (defaultLabelled) return { record: defaultLabelled, reason: "default label" };
  if (pool.length === 1) return { record: pool[0], reason: "only credential" };

  // 5. multiple accounts, no guidance — ambiguous. The caller asks the user.
  return undefined;
}

/** A preset entry that points at a label no stored record provides. */
export interface DanglingPreset {
  preset: string;
  provider: string;
  label: string;
}

/**
 * Every `preset → provider → label` mapping that references a label not present
 * in `records`. Powers the `doctor` warning and the PWA badge so a dangling
 * preset is visible rather than a silent downgrade to another key.
 */
export function missingPresetLabels(
  records: readonly CredentialRecord[],
  presets?: CredentialPresets,
): DanglingPreset[] {
  const out: DanglingPreset[] = [];
  const have = new Set(records.map((r) => credKey(r.provider, r.label)));
  for (const [preset, mapping] of Object.entries(presets?.presets ?? {})) {
    for (const [provider, label] of Object.entries(mapping ?? {})) {
      if (!have.has(credKey(provider, label))) {
        out.push({ preset, provider: normalizeProvider(provider), label: normalizeLabel(label) });
      }
    }
  }
  return out;
}
