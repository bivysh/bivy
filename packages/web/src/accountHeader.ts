// SPDX-License-Identifier: AGPL-3.0-only
// What the Settings account card shows under the email: the deployment's plan
// line, one usage meter, and — only when the allowance is nearly or fully used
// — its primary action (e.g. upgrade). Everything comes from the opaque
// deployment extension; Core names no tiers or limits itself.
import type { AccountExtensionView } from "@bivy/core";
import { accountPresentationMessage, clientConfiguration, showAccountExtension, type ClientConfiguration } from "./client-config.js";

/** Share of the allowance at which the card starts nudging. */
const NEAR_LIMIT = 0.8;

export type MeterState = "ok" | "near" | "reached";

export interface AccountHeader {
  summary?: string;
  meter?: { label: string; used: number; limit: number; state: MeterState };
  action?: { id: string; label: string };
}

export function accountHeader(extension: AccountExtensionView | undefined, config: ClientConfiguration = clientConfiguration): AccountHeader {
  if (!extension || config.accountExtension === "hidden") return {};
  // "facts" builds (store-distributed clients) drop anything an account message
  // rule flags, the same way the Account panel filters its facts.
  const allowed = (text: string) => config.accountExtension === "visible" || accountPresentationMessage(text, config) === text;
  const header: AccountHeader = {};
  const summary = extension.summary?.trim();
  if (summary && allowed(summary)) header.summary = summary;
  const m = extension.meter;
  if (m && typeof m.label === "string" && m.label.trim() && Number.isFinite(m.used) && Number.isFinite(m.limit) && m.limit > 0 && allowed(m.label)) {
    const used = Math.max(0, Math.min(m.used, m.limit));
    const state: MeterState = used >= m.limit ? "reached" : used / m.limit >= NEAR_LIMIT ? "near" : "ok";
    header.meter = { label: m.label.trim(), used, limit: m.limit, state };
    const primary = extension.actions?.find((a) => a.kind === "primary");
    if (state !== "ok" && primary && showAccountExtension(config)) header.action = { id: primary.id, label: primary.label };
  }
  return header;
}
