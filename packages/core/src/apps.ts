// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Presentation is independent of runtime. Add new view kinds here and a
 * renderer/provider, not a new app category. Unknown kinds fail closed. */
export type AppViewSpec =
  | { kind: "web"; name: string; source: { kind: "static"; directory: string } | { kind: "service"; port: number; start?: AppCommandSpec } }
  | { kind: "terminal"; name: string; command: string; args?: string[] }
  /** A desktop GUI program, run on a private display streamed into the preview.
   * `restartOnChange`: restart it after an agent turn that changed files. */
  | { kind: "display"; name: string; command: string; args?: string[]; restartOnChange?: boolean }
  /** Backend views (what a backend change did, seen like a UI change is).
   *  The API as requests to run: `.http` files in `dir` (default .bivy/requests),
   *  against `base` (default: the app's web server). */
  | { kind: "requests"; name: string; base?: { url: string } | { view: string }; dir?: string }
  /** Saved queries in `dir` (default .bivy/queries), run through the project's
   *  own database client: the command gets each query on stdin and prints rows
   *  as JSON, CSV or TSV. */
  | { kind: "data"; name: string; command: string; args?: string[]; dir?: string }
  /** A server's output: a view Bivy runs (default: the app's), a file, or a command. */
  | { kind: "logs"; name: string; source?: { view: string } | { file: string } | { command: string; args?: string[] } };
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
      stats?: DisplayStats;
      /** The page last open in the preview, e.g. "/checkout". */
      lastPath?: string;
      /** Public share links that still work. */
      sharing?: AppViewSharing }
  | { id: string; kind: "terminal"; name: string; command: string; args: string[] }
  /** `detail`: where it reads from, in words ("127.0.0.1:3000", "sqlite3 -json dev.db"). */
  | { id: string; kind: "backend"; backend: BackendKind; name: string; detail: string };
export type BackendKind = "requests" | "data" | "logs";
export interface SessionApp {
  id: string;
  sessionId: string;
  name: string;
  views: AppView[];
  createdAt: number;
  /** When this app gets review cards in the chat (default "ready"). */
  reviewMode?: ReviewCardMode;
  /** The owner lets agents read this app's reviewer notes (`bivy app notes`). Off by default. */
  agentNotes?: boolean;
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
  /** "present": the agent said it's ready; "run": a run ended with a visual change; "asked": Show me;
   * "notes": a run ended with reviewer notes waiting and nothing else to show. */
  trigger: "present" | "run" | "asked" | "notes";
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
  /** Reviewer notes waiting on this view when the run ended. A count only:
   * the notes stay on the machine until the owner drafts them into a message. */
  notes?: number;
  /** What a run did to the app's backend views: one line each, the most
   *  important change first. A backend-only run's card has these instead of a picture. */
  evidence?: EvidenceRow[];
}
/** One line of backend evidence. `item` opens the view at that request or query. */
export interface EvidenceRow { viewId: string; view: string; backend: BackendKind; summary: string; detail?: string; tone: "ok" | "warn" | "danger" | "neutral"; item?: string }
const isEvidence = (row: unknown): row is EvidenceRow => {
  const r = row as Partial<EvidenceRow> | undefined;
  return !!r && typeof r.viewId === "string" && typeof r.view === "string" && ["requests", "data", "logs"].includes(r.backend as string)
    && typeof r.summary === "string" && r.summary.length <= 300 && (r.detail === undefined || (typeof r.detail === "string" && r.detail.length <= 300))
    && ["ok", "warn", "danger", "neutral"].includes(r.tone as string) && (r.item === undefined || typeof r.item === "string");
};
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
    && (review.trigger === "present" || review.trigger === "run" || review.trigger === "asked" || review.trigger === "notes") && typeof review.at === "number"
    && (review.shot === undefined || isShot(review.shot)) && (review.before === undefined || isShot(review.before))
    && (review.note === undefined || typeof review.note === "string")
    && (review.notes === undefined || (Number.isInteger(review.notes) && review.notes >= 0))
    && (review.evidence === undefined || (Array.isArray(review.evidence) && review.evidence.length <= 12 && review.evidence.every(isEvidence)));
}
/** A mark the user sent to the agent: their words, a picture of what they
 * marked, and where it was. Unlike the message that carried it, a pin has a
 * state — a later run can change what it points at, and saying so is the
 * difference between a comment and a piece of work. */
export interface AppPin {
  id: string; sessionId: string; appId: string; viewId: string;
  name: string; view: string; path: string;
  /** What the person wrote or said. Their words, shown as text. */
  words: string;
  /** Which note it was, when a message carried several. The picture wears the
   * same number, so a note and the thing it is about stay paired. */
  number?: number;
  at: number;
  /** The marked-up picture, as an end-to-end encrypted attachment. */
  shot?: ReviewShot;
  /** What the marks named, for finding them again in a later version. */
  selectors: string[];
  /** The marks' bounding box and the viewport they were made in, both in page
   * CSS pixels, so a later screenshot can be compared where it matters. */
  region: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  state: AppPinState;
  /** When the state last changed. */
  stateAt?: number;
}
/** "open": nothing has happened where it points. "changed": a later run changed
 * those pixels. "gone": what it named is no longer on the page. "done": the
 * person said so. Only evidence moves a pin off "open" — a run that changes
 * nothing there leaves it open, because it hasn't been answered. */
export type AppPinState = "open" | "changed" | "gone" | "done";
export const APP_PIN_STATES: readonly AppPinState[] = ["open", "changed", "gone", "done"];
export const APP_PIN_BLOCK = "bivy_app_pin";
export function isAppPin(value: unknown): value is AppPin {
  if (!value || typeof value !== "object") return false;
  const pin = value as Partial<AppPin>;
  const box = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && keys.every((k) => typeof (v as Record<string, unknown>)[k] === "number");
  return typeof pin.id === "string" && typeof pin.sessionId === "string" && typeof pin.appId === "string" && /^[a-f0-9]{32}$/.test(pin.appId)
    && typeof pin.viewId === "string" && typeof pin.name === "string" && typeof pin.view === "string" && typeof pin.path === "string"
    && typeof pin.words === "string" && typeof pin.at === "number"
    && (pin.number === undefined || (Number.isInteger(pin.number) && pin.number >= 1))
    && Array.isArray(pin.selectors) && pin.selectors.every((s) => typeof s === "string")
    && box(pin.region, ["x", "y", "width", "height"]) && box(pin.viewport, ["width", "height"])
    && APP_PIN_STATES.includes(pin.state as AppPinState)
    && (pin.shot === undefined || isShot(pin.shot));
}
/** Input→frame latency and bandwidth measured by a display view's viewer. */
export interface DisplayStats { at: number; latencyMs: { p50: number; p95: number }; kBps: number; viewport: { width: number; height: number; scale: number } }
/** Untrusted feedback on an element or marked area from a shared link. */
export interface ReviewerNote {
  id: string; at: number; note: string; selector: string; text: string;
  path: string; viewport: { width: number; height: number };
  context?: string;
  /** Retaken on the machine; may differ from the reviewer's browser. */
  shot?: ReviewShot;
}
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

/** Backend views, as the client shows them. Bodies, rows and log lines are the
 *  app's own output: shown as text, never run. */
export interface RequestAnswer { status: number; statusText: string; ms: number; at: number; headers: Record<string, string>; body: string; json?: boolean; truncated?: boolean; error?: string }
/** One change between two JSON answers (or two rows), by path. Absent sides are undefined. */
export interface ValueChange { path: string; before?: string; after?: string }
export interface RequestItem {
  id: string; file: string; name: string; method: string; url: string;
  /** Run on its own before and after each agent run: GET/HEAD to the app's server, or marked @auto. */
  auto: boolean;
  /** The host, when it isn't the app's own server. */
  external?: string;
  last?: RequestAnswer; before?: RequestAnswer;
}
export interface RequestsViewResult { base: string; requests: RequestItem[]; problems: { file: string; error: string }[] }
export interface RequestDetail { item: RequestItem; request: { method: string; url: string; headers: [string, string][]; body: string }; changes?: ValueChange[] }
export interface DataRowChange { key: string; row: Record<string, string>; fields?: ValueChange[] }
export interface DataQuery {
  id: string; file: string; title: string; key: string; columns: string[];
  /** The latest rows (up to 200 shown), and how many there are. */
  rows: Record<string, string>[]; count: number; at?: number; error?: string;
  /** Since the agent's run began, by key. Absent until there's a before. */
  changes?: { added: DataRowChange[]; changed: DataRowChange[]; removed: DataRowChange[] };
}
export interface DataViewResult { detail: string; queries: DataQuery[]; problems: { file: string; error: string }[] }
export interface LogLine { at: number; text: string; level: "error" | "warn" | "info" }
/** "Your last action": an agent run, a request run, a page or form in the preview. */
export interface LogMark { at: number; label: string }
export interface LogsViewResult { detail: string; lines: LogLine[]; marks: LogMark[]; running: boolean }
/** A loopback server running inside the session workspace, not yet published.
 * An offer grants nothing; adopting it publishes a service view. */
/** `project`: the folder the server runs in (its git root when it has one).
 * Only on machine-wide offers, made before any session exists. */
export interface AppOffer { port: number; pid: number; command: string; project?: string }
export interface SessionAppOffersResult { offers: AppOffer[] }
/** A reusable preview link; a bearer capability until `expiresAt` or revoke.
 * `controls`: people who open it get the reviewer tools (marking, notes). */
export interface ShareAppViewResult { url: string; expiresAt: number; controls: boolean }
/** How long a new share link works. Links live in the machine's memory, so a
 * restart ends them sooner. Adding a choice means adding a row. */
export const SHARE_DURATIONS = [
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "1d", label: "1 day", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
] as const;
export type ShareDuration = typeof SHARE_DURATIONS[number]["id"];
export const DEFAULT_SHARE_DURATION: ShareDuration = "1d";
export interface ShareOptions { duration?: ShareDuration; controls?: boolean }
/** Share links to a web view that still work: how many, and when the last one
 * lapses. Never the links themselves (agents can list apps). */
export interface AppViewSharing { links: number; expiresAt: number }
