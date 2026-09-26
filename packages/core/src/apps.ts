// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Presentation is independent of runtime. Add new view kinds here and a
 * renderer/provider, not a new app category. Unknown kinds fail closed. */
export type AppViewSpec =
  | { kind: "web"; name: string; source: { kind: "static"; directory: string } | { kind: "service"; port: number; start?: AppCommandSpec } }
  | { kind: "terminal"; name: string; command: string; args?: string[] }
  /** A desktop GUI program, run on a private display streamed into the preview.
   * `restartOnChange`: restart it after an agent turn that changed files. */
  | { kind: "display"; name: string; command: string; args?: string[]; restartOnChange?: boolean };
/** A managed server: Bivy runs it on first open and restarts it if it exits. */
export interface AppCommandSpec { command: string; args?: string[] }
export interface AppManifest { version: 1; name: string; views: AppViewSpec[] }
export type AppView =
  | { id: string; kind: "web"; name: string; source: "static" | "service" | "display"; managed?: boolean;
      /** Stable address for a home screen; opens only on signed-in devices. */
      address?: string;
      /** Notes left by people viewing a shared link. Untrusted text. */
      notes?: ReviewerNote[];
      /** How a desktop app's stream performed in the last viewer's browser. */
      stats?: DisplayStats }
  | { id: string; kind: "terminal"; name: string; command: string; args: string[] };
export interface SessionApp {
  id: string;
  sessionId: string;
  name: string;
  views: AppView[];
  createdAt: number;
  /** When this app gets review cards in the chat (default "ready"). */
  reviewMode?: ReviewCardMode;
}
/** Review cards: "ready" when the agent presents the app or a run ends with a
 * visible change; "every" also for small visual tweaks; "off" never on its own
 * (the user can still ask with Show me). */
export type ReviewCardMode = "ready" | "every" | "off";
export const REVIEW_CARD_MODES: readonly ReviewCardMode[] = ["ready", "every", "off"];
/** A phone-width screenshot, stored as an end-to-end encrypted attachment. */
export interface ReviewShot { hash: string; size: number; width: number; height: number }
/** The app at a moment worth judging. One card per app per run, updated in
 * place; screenshots are attachment hashes, never preview URLs or bytes. */
export interface AppReview {
  id: string; sessionId: string; appId: string; viewId: string;
  name: string; view: string; path: string;
  /** "present": the agent said it's ready; "run": a run ended with a visual change; "asked": Show me. */
  trigger: "present" | "run" | "asked";
  /** The agent's note from bivy app present. Agent text, shown as text. */
  note?: string;
  at: number;
  shot?: ReviewShot;
  /** The same page before this run's changes, when a baseline exists. */
  before?: ReviewShot;
  /** A newer card for this view replaced it; its images are no longer stored. */
  expired?: boolean;
  /** Agent screenshots are off on this machine, so the card has no image. */
  screenshotsOff?: boolean;
}
export const APP_REVIEW_BLOCK = "bivy_app_review";
const isShot = (value: unknown): value is ReviewShot => {
  const shot = value as Partial<ReviewShot> | undefined;
  return !!shot && typeof shot.hash === "string" && /^[0-9a-f]{64}$/.test(shot.hash) && [shot.size, shot.width, shot.height].every((n) => typeof n === "number" && n >= 0);
};
export function isAppReview(value: unknown): value is AppReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<AppReview>;
  return typeof review.id === "string" && typeof review.sessionId === "string" && typeof review.appId === "string" && /^[a-f0-9]{32}$/.test(review.appId)
    && typeof review.viewId === "string" && typeof review.name === "string" && typeof review.view === "string" && typeof review.path === "string"
    && (review.trigger === "present" || review.trigger === "run" || review.trigger === "asked") && typeof review.at === "number"
    && (review.shot === undefined || isShot(review.shot)) && (review.before === undefined || isShot(review.before))
    && (review.note === undefined || typeof review.note === "string");
}
/** Input→frame latency and bandwidth measured by a display view's viewer. */
export interface DisplayStats { at: number; latencyMs: { p50: number; p95: number }; kBps: number; viewport: { width: number; height: number; scale: number } }
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
/** A reusable preview link; a bearer capability until `expiresAt` or revoke. */
export interface ShareAppViewResult { url: string; expiresAt: number }
