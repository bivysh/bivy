// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure, redacted domain model for the logical credential vault. Persistence and
// crypto replicas project into this shape; no secret value is retained here.

import type { CredentialRecordSummary } from "./protocol.js";

export type CredentialItemId = string;
export type CredentialItemKind = "api_key" | "oauth" | "reference";
export type CredentialItemOrigin = "browser" | "node";

export interface CredentialAvailability {
  account: boolean;
  device: boolean;
  /** Node ids known to hold the item. Sorted and unique. */
  nodes: readonly string[];
}

export interface CredentialItem {
  /** Stable logical identity derived from normalized provider + label. */
  id: CredentialItemId;
  provider: string;
  label: string;
  kind: CredentialItemKind;
  origins: readonly CredentialItemOrigin[];
  availability: CredentialAvailability;
  updatedAt?: number;
  expiresAt?: number;
  unattended?: boolean;
  testable?: boolean;
  lastVerifiedAt?: number;
  lastVerifiedOk?: boolean;
}

export const DEFAULT_CREDENTIAL_LABEL = "default";
export const normalizeCredentialProvider = (provider: string): string => String(provider ?? "").trim().toLowerCase();
export const normalizeCredentialLabel = (label?: string): string => String(label ?? "").trim().toLowerCase() || DEFAULT_CREDENTIAL_LABEL;

/** Stable across replica/storage moves; labels are identity until opaque ids ship. */
export function credentialItemId(provider: string, label?: string): CredentialItemId {
  const normalizedProvider = normalizeCredentialProvider(provider);
  if (!normalizedProvider) throw new Error("Credential provider is required");
  return `credential:v1:${encodeURIComponent(normalizedProvider)}:${encodeURIComponent(normalizeCredentialLabel(label))}`;
}

export type CredentialAvailabilityTarget = { scope: "account" } | { scope: "device" } | { scope: "node"; nodeId: string };
export function isCredentialAvailable(item: CredentialItem, target: CredentialAvailabilityTarget): boolean {
  if (target.scope === "account") return item.availability.account;
  if (target.scope === "device") return item.availability.device || item.availability.account;
  return item.availability.account || item.availability.nodes.includes(target.nodeId);
}

export interface CredentialAssignments {
  defaults: Readonly<Record<string, CredentialItemId>>;
  projects: Readonly<Record<string, Readonly<Record<string, CredentialItemId>>>>;
}
export const emptyCredentialAssignments = (): CredentialAssignments => ({ defaults: {}, projects: {} });

export function assignDefaultCredential(assignments: CredentialAssignments, provider: string, itemId?: CredentialItemId): CredentialAssignments {
  const key = normalizeCredentialProvider(provider);
  if (!key) throw new Error("Credential provider is required");
  const defaults = { ...assignments.defaults };
  if (itemId) defaults[key] = itemId; else delete defaults[key];
  return { defaults, projects: assignments.projects };
}

export function assignProjectCredential(assignments: CredentialAssignments, projectId: string, provider: string, itemId?: CredentialItemId): CredentialAssignments {
  const project = String(projectId ?? "").trim();
  const key = normalizeCredentialProvider(provider);
  if (!project) throw new Error("Project id is required");
  if (!key) throw new Error("Credential provider is required");
  const mapping = { ...(assignments.projects[project] ?? {}) };
  if (itemId) mapping[key] = itemId; else delete mapping[key];
  const projects = { ...assignments.projects };
  if (Object.keys(mapping).length) projects[project] = mapping; else delete projects[project];
  return { defaults: assignments.defaults, projects };
}

export type CredentialSelectionReason = "explicit" | "project" | "provider-default" | "default-label" | "only-available";
export type CredentialSelectionResult =
  | { status: "selected"; item: CredentialItem; reason: CredentialSelectionReason }
  | { status: "missing"; reason: "no-available-credential" | "assigned-credential-unavailable"; itemId?: CredentialItemId }
  | { status: "ambiguous"; reason: "multiple-available-credentials"; items: readonly CredentialItem[] };
export interface CredentialSelectionRequest {
  provider: string;
  target: CredentialAvailabilityTarget;
  assignments?: CredentialAssignments;
  projectId?: string;
  itemId?: CredentialItemId;
}

/** explicit -> project -> provider default -> default label -> sole item */
export function selectCredentialItem(items: readonly CredentialItem[], request: CredentialSelectionRequest): CredentialSelectionResult {
  const provider = normalizeCredentialProvider(request.provider);
  const available = items.filter((item) => item.provider === provider && isCredentialAvailable(item, request.target)).slice().sort((a, b) => a.id.localeCompare(b.id));
  const assigned = request.itemId
    ?? (request.projectId ? request.assignments?.projects[request.projectId]?.[provider] : undefined)
    ?? request.assignments?.defaults[provider];
  const reason: CredentialSelectionReason = request.itemId ? "explicit" : request.projectId && request.assignments?.projects[request.projectId]?.[provider] ? "project" : "provider-default";
  if (assigned) {
    const item = available.find((candidate) => candidate.id === assigned);
    return item ? { status: "selected", item, reason } : { status: "missing", reason: "assigned-credential-unavailable", itemId: assigned };
  }
  const labelledDefault = available.find((item) => item.label === DEFAULT_CREDENTIAL_LABEL);
  if (labelledDefault) return { status: "selected", item: labelledDefault, reason: "default-label" };
  if (available.length === 1) return { status: "selected", item: available[0]!, reason: "only-available" };
  if (!available.length) return { status: "missing", reason: "no-available-credential" };
  return { status: "ambiguous", reason: "multiple-available-credentials", items: available };
}

const epoch = (value: string | number | null | undefined): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

export interface BrowserModelKeyMigrationEntry {
  provider: string;
  label?: string;
  key?: string;
  configured?: boolean;
  updatedAt?: string | number | null;
  scope?: "account" | "device";
}

/** Legacy/current browser metadata projection; key material is never returned. */
export function credentialItemFromBrowserModelKey(entry: BrowserModelKeyMigrationEntry): CredentialItem | undefined {
  const provider = normalizeCredentialProvider(entry.provider);
  if (!provider || (entry.configured !== true && !entry.key)) return undefined;
  const label = normalizeCredentialLabel(entry.label);
  const updatedAt = epoch(entry.updatedAt);
  return {
    id: credentialItemId(provider, label), provider, label, kind: "api_key", origins: ["browser"],
    availability: { account: entry.scope !== "device", device: true, nodes: [] },
    ...(updatedAt == null ? {} : { updatedAt }),
  };
}

/** Node summary projection; references remain redacted to kind-only metadata. */
export function credentialItemFromNodeSummary(summary: CredentialRecordSummary, nodeId: string): CredentialItem | undefined {
  const provider = normalizeCredentialProvider(summary.provider);
  const node = String(nodeId ?? "").trim();
  if (!provider || !node) return undefined;
  const label = normalizeCredentialLabel(summary.label);
  return {
    id: credentialItemId(provider, label), provider, label, kind: summary.kind, origins: ["node"],
    availability: { account: summary.sync === "account", device: false, nodes: [node] },
    ...(summary.expiresAt == null ? {} : { expiresAt: summary.expiresAt }),
    ...(summary.unattended ? { unattended: true } : {}),
    testable: summary.testable,
    ...(summary.lastVerifiedAt == null ? {} : { lastVerifiedAt: summary.lastVerifiedAt }),
    ...(summary.lastVerifiedOk == null ? {} : { lastVerifiedOk: summary.lastVerifiedOk }),
  };
}

export function mergeCredentialItems(...collections: readonly (readonly CredentialItem[])[]): CredentialItem[] {
  const merged = new Map<CredentialItemId, CredentialItem>();
  for (const collection of collections) for (const item of collection) {
    const previous = merged.get(item.id);
    merged.set(item.id, previous ? {
      ...previous, ...item,
      origins: [...new Set([...previous.origins, ...item.origins])].sort() as CredentialItemOrigin[],
      availability: {
        account: previous.availability.account || item.availability.account,
        device: previous.availability.device || item.availability.device,
        nodes: [...new Set([...previous.availability.nodes, ...item.availability.nodes])].sort(),
      },
    } : {
      ...item,
      origins: [...new Set(item.origins)].sort() as CredentialItemOrigin[],
      availability: { ...item.availability, nodes: [...new Set(item.availability.nodes)].sort() },
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const migrateBrowserModelKeys = (entries: readonly BrowserModelKeyMigrationEntry[]): CredentialItem[] =>
  mergeCredentialItems(entries.map(credentialItemFromBrowserModelKey).filter((item): item is CredentialItem => Boolean(item)));
export const migrateNodeCredentialSummaries = (summaries: readonly CredentialRecordSummary[], nodeId: string): CredentialItem[] =>
  mergeCredentialItems(summaries.map((summary) => credentialItemFromNodeSummary(summary, nodeId)).filter((item): item is CredentialItem => Boolean(item)));
