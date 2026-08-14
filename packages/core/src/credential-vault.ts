// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure, redacted domain model for the logical credential vault. This module
// deliberately owns no persistence or crypto: browser and node records are
// projected into values which can safely be displayed, merged, and selected.

import type { CredentialRecordSummary } from "./protocol.js";

export type CredentialItemId = string;
export type CredentialItemKind = "api_key" | "oauth" | "reference";
export type CredentialItemOrigin = "browser" | "node";

/** Places at which a logical credential can currently be used. */
export interface CredentialAvailability {
  /** Available through the end-to-end account vault. */
  account: boolean;
  /** Available in this browser's device-local vault. */
  device: boolean;
  /** Node ids whose local vault contains the credential. Sorted and unique. */
  nodes: readonly string[];
}

/**
 * Secret-free metadata for one logical credential. There is intentionally no
 * key, token, OAuth payload, or reference value on this type.
 */
export interface CredentialItem {
  /** Deterministic identity derived from normalized provider + label. */
  id: CredentialItemId;
  provider: string;
  label: string;
  kind: CredentialItemKind;
  origins: readonly CredentialItemOrigin[];
  availability: CredentialAvailability;
  updatedAt?: number;
  expiresAt?: number;
  testable?: boolean;
  lastVerifiedAt?: number;
  lastVerifiedOk?: boolean;
}

export const DEFAULT_CREDENTIAL_LABEL = "default";

export function normalizeCredentialProvider(provider: string): string {
  return String(provider ?? "").trim().toLowerCase();
}

export function normalizeCredentialLabel(label?: string): string {
  return String(label ?? "").trim().toLowerCase() || DEFAULT_CREDENTIAL_LABEL;
}

/** Stable across storage moves and availability changes. */
export function credentialItemId(provider: string, label?: string): CredentialItemId {
  const normalizedProvider = normalizeCredentialProvider(provider);
  const normalizedLabel = normalizeCredentialLabel(label);
  if (!normalizedProvider) throw new Error("Credential provider is required");
  return `credential:v1:${encodeURIComponent(normalizedProvider)}:${encodeURIComponent(normalizedLabel)}`;
}

export type CredentialAvailabilityTarget =
  | { scope: "account" }
  | { scope: "device" }
  | { scope: "node"; nodeId: string };

/** Account credentials can be delivered to a paired device/node. */
export function isCredentialAvailable(item: CredentialItem, target: CredentialAvailabilityTarget): boolean {
  if (target.scope === "account") return item.availability.account;
  if (target.scope === "device") return item.availability.device || item.availability.account;
  return item.availability.account || item.availability.nodes.includes(target.nodeId);
}

/** Assignments refer to stable item ids, never mutable array positions. */
export interface CredentialAssignments {
  /** Provider id -> credential item id. */
  defaults: Readonly<Record<string, CredentialItemId>>;
  /** Project id -> provider id -> credential item id. */
  projects: Readonly<Record<string, Readonly<Record<string, CredentialItemId>>>>;
}

export function emptyCredentialAssignments(): CredentialAssignments {
  return { defaults: {}, projects: {} };
}

export function assignDefaultCredential(
  assignments: CredentialAssignments,
  provider: string,
  itemId: CredentialItemId | undefined,
): CredentialAssignments {
  const key = normalizeCredentialProvider(provider);
  if (!key) throw new Error("Credential provider is required");
  const defaults = { ...assignments.defaults };
  if (itemId) defaults[key] = itemId;
  else delete defaults[key];
  return { defaults, projects: assignments.projects };
}

export function assignProjectCredential(
  assignments: CredentialAssignments,
  projectId: string,
  provider: string,
  itemId: CredentialItemId | undefined,
): CredentialAssignments {
  const project = String(projectId ?? "").trim();
  const key = normalizeCredentialProvider(provider);
  if (!project) throw new Error("Project id is required");
  if (!key) throw new Error("Credential provider is required");
  const mapping = { ...(assignments.projects[project] ?? {}) };
  if (itemId) mapping[key] = itemId;
  else delete mapping[key];
  const projects = { ...assignments.projects };
  if (Object.keys(mapping).length) projects[project] = mapping;
  else delete projects[project];
  return { defaults: assignments.defaults, projects };
}

export type CredentialSelectionReason =
  | "explicit"
  | "project"
  | "provider-default"
  | "default-label"
  | "only-available";

export type CredentialSelectionResult =
  | { status: "selected"; item: CredentialItem; reason: CredentialSelectionReason }
  | { status: "missing"; reason: "no-available-credential" | "assigned-credential-unavailable"; itemId?: CredentialItemId }
  | { status: "ambiguous"; reason: "multiple-available-credentials"; items: readonly CredentialItem[] };

export interface CredentialSelectionRequest {
  provider: string;
  target: CredentialAvailabilityTarget;
  assignments?: CredentialAssignments;
  projectId?: string;
  /** One-off selection; has precedence over every persisted assignment. */
  itemId?: CredentialItemId;
}

/**
 * Selection ladder: explicit item -> project assignment -> provider default ->
 * `default` label -> sole available item -> ambiguity. A dangling assignment is
 * an error and never silently falls through to a different account.
 */
export function selectCredentialItem(
  items: readonly CredentialItem[],
  request: CredentialSelectionRequest,
): CredentialSelectionResult {
  const provider = normalizeCredentialProvider(request.provider);
  const available = items
    .filter((item) => item.provider === provider && isCredentialAvailable(item, request.target))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const assigned = request.itemId
    ?? (request.projectId ? request.assignments?.projects[request.projectId]?.[provider] : undefined)
    ?? request.assignments?.defaults[provider];
  const assignedReason: CredentialSelectionReason = request.itemId
    ? "explicit"
    : request.projectId && request.assignments?.projects[request.projectId]?.[provider]
      ? "project"
      : "provider-default";

  if (assigned) {
    const item = available.find((candidate) => candidate.id === assigned);
    return item
      ? { status: "selected", item, reason: assignedReason }
      : { status: "missing", reason: "assigned-credential-unavailable", itemId: assigned };
  }

  const labelledDefault = available.find((item) => item.label === DEFAULT_CREDENTIAL_LABEL);
  if (labelledDefault) return { status: "selected", item: labelledDefault, reason: "default-label" };
  if (available.length === 1) return { status: "selected", item: available[0]!, reason: "only-available" };
  if (available.length === 0) return { status: "missing", reason: "no-available-credential" };
  return { status: "ambiguous", reason: "multiple-available-credentials", items: available };
}

/** Legacy browser shape. `key` is accepted only so callers can pass old entries directly; it is never returned. */
export interface BrowserModelKeyMigrationEntry {
  provider: string;
  key?: string;
  configured?: boolean;
  updatedAt?: string | number | null;
  scope?: "account" | "device";
}

function epoch(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Project one legacy browser model-key entry to redacted metadata. */
export function credentialItemFromBrowserModelKey(entry: BrowserModelKeyMigrationEntry): CredentialItem | undefined {
  const provider = normalizeCredentialProvider(entry.provider);
  if (!provider || (entry.configured !== true && !entry.key)) return undefined;
  const updatedAt = epoch(entry.updatedAt);
  return {
    id: credentialItemId(provider),
    provider,
    label: DEFAULT_CREDENTIAL_LABEL,
    kind: "api_key",
    origins: ["browser"],
    availability: {
      account: entry.scope !== "device",
      device: true,
      nodes: [],
    },
    ...(updatedAt == null ? {} : { updatedAt }),
  };
}

/** Project a node's `provider:label` summary to redacted metadata. */
export function credentialItemFromNodeSummary(
  summary: CredentialRecordSummary,
  nodeId: string,
): CredentialItem | undefined {
  const provider = normalizeCredentialProvider(summary.provider);
  const node = String(nodeId ?? "").trim();
  if (!provider || !node) return undefined;
  const label = normalizeCredentialLabel(summary.label);
  return {
    id: credentialItemId(provider, label),
    provider,
    label,
    kind: summary.kind,
    origins: ["node"],
    availability: { account: summary.sync === "account", device: false, nodes: [node] },
    ...(summary.expiresAt == null ? {} : { expiresAt: summary.expiresAt }),
    testable: summary.testable,
    ...(summary.lastVerifiedAt == null ? {} : { lastVerifiedAt: summary.lastVerifiedAt }),
    ...(summary.lastVerifiedOk == null ? {} : { lastVerifiedOk: summary.lastVerifiedOk }),
  };
}

/**
 * Merge projections by stable id. Later metadata wins while availability and
 * provenance are unioned. Input values and arrays are never mutated.
 */
export function mergeCredentialItems(...collections: readonly (readonly CredentialItem[])[]): CredentialItem[] {
  const merged = new Map<CredentialItemId, CredentialItem>();
  for (const collection of collections) {
    for (const item of collection) {
      const previous = merged.get(item.id);
      if (!previous) {
        merged.set(item.id, {
          ...item,
          origins: [...new Set(item.origins)].sort(),
          availability: { ...item.availability, nodes: [...new Set(item.availability.nodes)].sort() },
        });
        continue;
      }
      merged.set(item.id, {
        ...previous,
        ...item,
        origins: [...new Set([...previous.origins, ...item.origins])].sort(),
        availability: {
          account: previous.availability.account || item.availability.account,
          device: previous.availability.device || item.availability.device,
          nodes: [...new Set([...previous.availability.nodes, ...item.availability.nodes])].sort(),
        },
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function migrateBrowserModelKeys(entries: readonly BrowserModelKeyMigrationEntry[]): CredentialItem[] {
  return mergeCredentialItems(entries.map(credentialItemFromBrowserModelKey).filter((item): item is CredentialItem => !!item));
}

export function migrateNodeCredentialSummaries(
  summaries: readonly CredentialRecordSummary[],
  nodeId: string,
): CredentialItem[] {
  return mergeCredentialItems(summaries.map((summary) => credentialItemFromNodeSummary(summary, nodeId)).filter((item): item is CredentialItem => !!item));
}
