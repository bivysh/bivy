// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The connected machine's access report (the node's src/access.ts): which
// setups reach it, what each gives, and the next step. The node owns the
// table; the app only reads and renders it.

export type AccessFeatureId = "devices" | "machines" | "push" | "sharing";
export type AccessSetupId = "local" | "tailscale" | "hosted" | "server";
/** 0 = no, 1 = on your tailnet only, 2 = from anywhere. */
export type Reach = 0 | 1 | 2;

export interface AccessReport {
  features: { id: AccessFeatureId; label: string }[];
  setups: { id: AccessSetupId; label: string; summary: string; command?: string; gives: Record<AccessFeatureId, Reach>; active: boolean }[];
  active: AccessSetupId[];
  reach: Record<AccessFeatureId, Reach>;
  next: { id: AccessSetupId; adds: AccessFeatureId[]; addsText: string }[];
  tailscaleUrl?: string;
  controlPlaneUrl?: string;
}

/** A machine on the tailnet running Bivy over Tailscale, at its own address. */
export interface TailnetMachine {
  name: string;
  url: string;
  nodeId?: string;
  os?: string;
  online: boolean;
  self: boolean;
}

/** "Tailscale + Bivy hosted", or the local setup's label. */
export function activeLabel(report: AccessReport): string {
  const on = report.setups.filter((s) => s.active && s.id !== "local");
  return on.length ? on.map((s) => s.label).join(" + ") : report.setups.find((s) => s.id === "local")?.label ?? "This machine only";
}

/** The setups that would give a feature, e.g. "Bivy hosted or your own server". */
export function providersOf(report: AccessReport, feature: AccessFeatureId): string {
  const labels = report.setups.filter((s) => s.gives[feature] === 2).map((s) => s.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)!.replace(/^Your/, "your")}` : labels[0] ?? "";
}
