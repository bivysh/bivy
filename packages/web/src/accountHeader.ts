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
  meter?: { label: string; used: number; limit: number; state: MeterState; freesNote?: string };
  action?: { id: string; label: string };
}

export function accountHeader(extension: AccountExtensionView | undefined, config: ClientConfiguration = clientConfiguration, now = new Date()): AccountHeader {
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
    // When allowance comes back only matters once it is running out.
    const freesAt = m.freesAt ? new Date(m.freesAt) : null;
    if (state !== "ok" && freesAt && freesAt > now) header.meter.freesNote = `A slot frees up ${formatWhen(freesAt, now)}`;
    const primary = extension.actions?.find((a) => a.kind === "primary");
    if (state !== "ok" && primary && showAccountExtension(config)) header.action = { id: primary.id, label: primary.label };
  }
  return header;
}

const DAY = 24 * 60 * 60 * 1000;

/** "in 25 min", "today at 14:00", "tomorrow at 09:30", "Thu at 14:00", or
 *  "Tue 6 Oct at 14:00" once the weekday alone would be ambiguous. */
export function formatWhen(at: Date, now: Date, locale?: string): string {
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / DAY);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const day = at.toLocaleDateString(locale, days < 6 ? { weekday: "short" } : { weekday: "short", day: "numeric", month: "short" });
  return `${day} at ${time}`;
}
