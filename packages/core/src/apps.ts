// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Presentation is independent of runtime. Add new view kinds here and a
 * renderer/provider, not a new app category. Unknown kinds fail closed. */
export type AppViewSpec =
  | { kind: "web"; name: string; source: { kind: "static"; directory: string } | { kind: "service"; port: number; start?: AppCommandSpec } }
  | { kind: "terminal"; name: string; command: string; args?: string[] };
/** A managed server: Bivy runs it on first open and restarts it if it exits. */
export interface AppCommandSpec { command: string; args?: string[] }
export interface AppManifest { version: 1; name: string; views: AppViewSpec[] }
export type AppView =
  | { id: string; kind: "web"; name: string; source: "static" | "service"; managed?: boolean;
      /** Stable address for a home screen; opens only on signed-in devices. */
      address?: string;
      /** Notes left by people viewing a shared link. Untrusted text. */
      notes?: ReviewerNote[] }
  | { id: string; kind: "terminal"; name: string; command: string; args: string[] };
export interface SessionApp {
  id: string;
  sessionId: string;
  name: string;
  views: AppView[];
  createdAt: number;
}
/** A note pinned to an element by someone viewing a shared link. */
export interface ReviewerNote { id: string; at: number; note: string; selector: string; text: string; path: string; viewport: { width: number; height: number } }
/** Durable chat reference; never persist launch tickets or preview URLs. */
export interface AppReference { appId: string; sessionId: string; name: string }
export const APP_PUBLICATION_BLOCK = "bivy_app";
export function isAppReference(value: unknown): value is AppReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<AppReference>;
  return typeof ref.appId === "string" && /^[a-f0-9]{32}$/.test(ref.appId) && typeof ref.sessionId === "string" && ref.sessionId.length > 0 && typeof ref.name === "string" && ref.name.length <= 100;
}
export interface SessionAppsResult { apps: SessionApp[]; previewAvailable: boolean }
export type OpenAppViewResult = { kind: "web"; url: string } | { kind: "terminal"; termId: string };
/** A loopback server running inside the session workspace, not yet published.
 * An offer grants nothing; adopting it publishes a service view. */
export interface AppOffer { port: number; pid: number; command: string }
export interface SessionAppOffersResult { offers: AppOffer[] }
/** A loopback server running inside the session workspace, not yet published.
 * An offer grants nothing; adopting it publishes a service view. */
export interface AppOffer { port: number; pid: number; command: string }
export interface SessionAppOffersResult { offers: AppOffer[] }
/** A reusable preview link; a bearer capability until `expiresAt` or revoke. */
export interface ShareAppViewResult { url: string; expiresAt: number }
