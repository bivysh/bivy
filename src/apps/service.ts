// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppManifest, AppOffer, AppReview, OpenAppViewResult, ReviewCardMode, SessionApp, SessionAppOffersResult, SessionAppsResult, ShareAppViewResult } from "./types.js";
import { randomBytes } from "node:crypto";
import { REVIEW_MODES, shouldReview, visualChange } from "./review.js";
import { AppRegistry, type RegisteredView } from "./registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanListeners } from "./listeners.js";
import { takeShots, type Shot, type ShotRequest } from "./screenshot.js";
import { approximate, composite, readStrokes, type PageSignals } from "./annotate.js";
import { captureFrame, encodePng } from "./rfb.js";
import { pngSize } from "./review.js";

export interface AppPreviewProvider {
  readonly available?: boolean;
  open(id: string, returnTo?: string): string;
  openDirect?(id: string): string;
  address?(id: string): string | undefined;
  share(id: string): ShareAppViewResult;
  revoke(id: string): void;
}

export interface AppTerminalProvider {
  start(input: { command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> }): Promise<string>;
  has(termId: string): boolean;
  close(termId: string): void;
}

/** Private displays for desktop views (see display.ts). */
export interface AppDisplayProvider {
  unavailable(): string | undefined;
  ensure(id: string, name: string, scale?: number): Promise<{ socket: string; env: Record<string, string>; wm: { count: number } }>;
  stop(id: string): void;
}
/** Where review cards go: the server stores screenshots as encrypted
 * attachments, logs the card and broadcasts it. `publish` returns the card
 * with its screenshots' hashes; `expire` drops an older card's images,
 * except any hash in `keep`. */
export interface ReviewSink {
  publish(review: AppReview, images: { shot?: Buffer; before?: Buffer }): AppReview;
  expire(review: AppReview, keep: ReadonlySet<string>): void;
}
const NO_REVIEWS: ReviewSink = { publish: (review) => review, expire: () => {} };
/** One agent run (a prompt until the agent stops) in a session. */
interface Run {
  /** Each view's revision when the run started. */
  start: Map<string, number>;
  /** The page before the run, per view: what a visual change is measured against. */
  baseline: Map<string, Buffer>;
  /** Review card per app in this run, updated in place. */
  reviews: Map<string, string>;
  muted: boolean;
  ended: boolean;
}
const NO_DISPLAYS: AppDisplayProvider = { unavailable: () => "Desktop app views aren't available on this machine.", ensure: () => Promise.reject(new Error("Desktop app views aren't available on this machine.")), stop: () => {} };
/** How long a screenshot waits for a desktop app's first window. */
const WINDOW_WAIT_MS = 15_000;

/** Composes view providers; registry never spawns processes and the gateway
 * never knows about terminals. New providers can extend open/remove here. */
/** A managed server that keeps exiting is left down after this many restarts
 * in RESTART_WINDOW; opening the view again tries afresh. */
const MAX_RESTARTS = 5;
/** Compare keeps this many shots per view, taken after servers settle. */
const COMPARE_KEEP = 4;
const COMPARE_SETTLE_MS = 1_500;
const RESTART_WINDOW = 10 * 60_000;

export class AppService {
  private terminalStarts = new Map<string, Promise<string>>();
  private servers = new Map<string, { termId?: string; pending?: Promise<string>; restarts: number[]; timer?: NodeJS.Timeout }>();
  private readonly scan: (workspace: string) => Promise<AppOffer[]>;
  private readonly serverWatchMs: number;
  private readonly screenshots: { enabled: () => boolean; take: typeof takeShots };
  private readonly displays: AppDisplayProvider;
  private shooting: Promise<unknown> = Promise.resolve();
  private readonly reviews: ReviewSink;
  private readonly settleMs: number;
  private runs = new Map<string, Run>();
  /** The latest card per view: a newer one expires its images. */
  private latest = new Map<string, AppReview>();
  /** Screenshots in progress, so a card, Compare and a baseline share one browser run. */
  private inflight = new Map<string, Promise<Buffer | undefined>>();
  constructor(readonly registry: AppRegistry, readonly gateway: AppPreviewProvider | undefined, private readonly terminals: AppTerminalProvider, options: {
    scan?: (workspace: string) => Promise<AppOffer[]>; serverWatchMs?: number;
    /** Agent screenshots are a node setting, off by default. */
    screenshots?: { enabled: () => boolean; take?: typeof takeShots };
    displays?: AppDisplayProvider;
    reviews?: ReviewSink;
    /** How long servers get to rebuild after a change before a screenshot. */
    settleMs?: number;
  } = {}) {
    this.scan = options.scan ?? scanListeners;
    this.serverWatchMs = options.serverWatchMs ?? 5_000;
    this.screenshots = { enabled: options.screenshots?.enabled ?? (() => false), take: options.screenshots?.take ?? takeShots };
    this.displays = options.displays ?? NO_DISPLAYS;
    this.reviews = options.reviews ?? NO_REVIEWS;
    this.settleMs = options.settleMs ?? COMPARE_SETTLE_MS;
  }

  /** A session's apps, or every app on this machine when no session is given. */
  list(sessionId?: string): SessionAppsResult {
    const available = Boolean(this.gateway) && this.gateway?.available !== false;
    const apps = this.registry.list(sessionId);
    for (const app of apps) for (const view of app.views) {
      if (view.kind !== "web") continue;
      if (available) view.address = this.gateway?.address?.(view.id);
      const entry = this.registry.getView(view.id);
      if (entry?.notes?.length) view.notes = structuredClone(entry.notes);
      if (entry?.stats) view.stats = structuredClone(entry.stats);
      if (entry?.lastPath) view.lastPath = entry.lastPath;
    }
    return { apps, previewAvailable: available };
  }
  publish(sessionId: string, workspace: string, manifest: AppManifest) {
    // Tell the agent now, not on first open, when this machine can't show it.
    const unavailable = manifest?.views?.some?.((view) => view?.kind === "display") && this.displays.unavailable();
    if (unavailable) throw new Error(unavailable);
    return this.registry.publish(sessionId, workspace, manifest);
  }
  /** An agent turn changed files in this session's workspace. With agent
   * screenshots on, Compare gets an "after" shot once servers have rebuilt. */
  turnChanged(sessionId: string): string[] {
    const bumped = this.registry.touch(sessionId);
    // Desktop apps that asked for it are restarted, so they run the new code.
    for (const id of bumped) {
      const entry = this.registry.getView(id);
      const server = this.servers.get(id);
      if (entry?.target.kind !== "display" || !server?.termId) continue;
      this.terminals.close(server.termId);
      server.termId = undefined;
      void this.ensureServer(entry).catch(() => {});
    }
    if (bumped.length && this.screenshots.enabled()) setTimeout(() => void this.capture(bumped), this.settleMs).unref?.();
    return bumped;
  }
  /** One phone-width shot per view of the page last viewed, kept for Compare. */
  async capture(viewIds: string[]): Promise<void> {
    for (const id of viewIds) {
      const entry = this.registry.getView(id);
      if (entry?.view.kind === "web") await this.shotOf(entry);
    }
  }
  /** A phone-width screenshot of a page at the view's current revision: one
   * already taken (Compare's after-turn shot), one in progress, or a new one.
   * Undefined when it fails; a card then goes without a picture. */
  private shotOf(entry: RegisteredView, page = entry.lastPath ?? "/"): Promise<Buffer | undefined> {
    const revision = entry.revision;
    const taken = [...entry.shots ?? []].reverse().find((shot) => shot.revision === revision && (shot.path ?? "/") === page);
    if (taken) return Promise.resolve(taken.png);
    const key = `${entry.view.id}:${revision}:${page}`;
    let pending = this.inflight.get(key);
    if (pending) return pending;
    pending = (async () => {
      await this.windowShown(entry).catch(() => {});
      const outDir = path.join(os.tmpdir(), "bivy-shots", "compare", entry.view.id);
      const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [390], themes: ["light"], path: page }, outDir));
      this.shooting = run;
      try {
        const [shot] = await run;
        if (!shot) return undefined;
        const png = fs.readFileSync(shot.file);
        fs.rmSync(outDir, { recursive: true, force: true });
        entry.shots = [...(entry.shots ?? []), { revision, at: Date.now(), png, path: page }].slice(-COMPARE_KEEP);
        return png;
      } catch { return undefined; /* a failed shot just leaves Compare without this turn */ }
      finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, pending);
    return pending;
  }

  /** Web views of a session whose app wants review cards on their own. */
  private reviewable(sessionId: string): RegisteredView[] {
    return this.registry.list(sessionId).filter((app) => REVIEW_MODES[this.registry.reviewMode(app.id)].minChange !== undefined)
      .flatMap((app) => app.views.filter((view) => view.kind === "web").map((view) => this.registry.getView(view.id)!)).filter(Boolean);
  }
  /** An agent run started. Remembers each view's revision, and the page as
   * it is now, so the end of the run can tell whether anything visibly
   * changed. A baseline is only taken when no screenshot of this revision
   * exists yet — after the first run, the last run's screenshot serves. */
  runStarted(sessionId: string): void {
    const views = this.reviewable(sessionId);
    const run: Run = { start: new Map(views.map((entry) => [entry.view.id, entry.revision])), baseline: new Map(), reviews: new Map(), muted: false, ended: false };
    this.runs.set(sessionId, run);
    if (!this.screenshots.enabled()) return;
    for (const entry of views) void this.shotOf(entry).then((png) => { if (png && entry.revision === run.start.get(entry.view.id)) run.baseline.set(entry.view.id, png); });
  }
  /** The run ended (done, or waiting for the user). Views whose revision
   * changed are screenshotted and compared with the page before the run; a
   * visible change makes (or updates) this run's card. Returns the run's
   * latest card, for the "session finished" notification. */
  async runEnded(sessionId: string): Promise<AppReview | undefined> {
    const run = this.runs.get(sessionId);
    if (!run || run.ended) return undefined;
    run.ended = true;
    let latest: AppReview | undefined;
    const changed = [...run.start].map(([id, revision]) => ({ entry: this.registry.getView(id), revision })).filter(({ entry, revision }) => entry && entry.revision !== revision);
    if (changed.length && this.screenshots.enabled() && !run.muted) await new Promise((r) => setTimeout(r, this.settleMs));
    for (const { entry } of changed) {
      if (!entry || !this.screenshots.enabled()) continue;
      const mode = this.registry.reviewMode(entry.app.id);
      if (run.muted || REVIEW_MODES[mode].minChange === undefined) continue;
      const before = run.baseline.get(entry.view.id);
      const after = await this.shotOf(entry);
      const change = before && after ? visualChange(before, after) : undefined;
      // A card the agent presented earlier in the run is refreshed if the page changed since.
      const current = this.latest.get(entry.view.id);
      const presented = current && run.reviews.get(entry.app.id) === current.id;
      if (!shouldReview({ trigger: "run", mode, muted: run.muted, revisionChanged: true, change }) && !(presented && after)) continue;
      latest = this.review(entry, run, { trigger: presented ? current.trigger : "run", note: presented ? current.note : undefined, path: entry.lastPath ?? "/", shot: after, before });
    }
    if (!latest) {
      const id = [...run.reviews.values()].at(-1);
      latest = [...this.latest.values()].find((review) => review.id === id);
    }
    return latest;
  }
  /** `bivy app present`, or Show me ("asked"): a card for one view now. */
  async present(sessionId: string, input: { target?: string; path?: string; note?: string; trigger?: "present" | "asked" }): Promise<{ review?: AppReview; message: string }> {
    const trigger = input.trigger ?? "present";
    const page = input.path;
    if (page !== undefined && (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//") || page.length > 2048)) throw new Error("Path must start with /.");
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : undefined;
    const entry = this.pickView(sessionId, input.target);
    const mode = this.registry.reviewMode(entry.app.id);
    const active = this.runs.get(sessionId);
    const run = active && !active.ended ? active : undefined;
    if (!shouldReview({ trigger, mode, muted: run?.muted ?? false, revisionChanged: true })) {
      return { message: run?.muted ? "The user muted preview cards for this run. They can still open the preview from the chat." : `Preview cards are off for ${entry.app.name}. The user can still open the preview from the chat.` };
    }
    // Presenting means the change is ready: pick up files written since the
    // turn began, so the picture (and any open preview) shows them.
    if (trigger === "present" && this.turnChanged(sessionId).includes(entry.view.id) && this.screenshots.enabled()) await new Promise((r) => setTimeout(r, this.settleMs));
    const enabled = this.screenshots.enabled();
    const path = page ?? entry.lastPath ?? "/";
    const shot = enabled ? await this.shotOf(entry, path) : undefined;
    const baseline = run?.baseline.get(entry.view.id);
    const before = baseline && shot && !baseline.equals(shot) && path === (entry.lastPath ?? "/") ? baseline : undefined;
    const review = this.review(entry, run, { trigger, note, path, shot, before, screenshotsOff: !enabled });
    return { review, message: enabled ? (shot ? "The user sees it in the chat." : "The user sees a card in the chat, but the screenshot failed.") : "The user sees a card in the chat. Screenshots are off on this machine, so it has no picture." };
  }
  /** No more cards for the rest of the session's current run. */
  mute(sessionId: string): { ok: true } {
    const run = this.runs.get(sessionId);
    if (run && !run.ended) run.muted = true;
    return { ok: true };
  }
  setReviewMode(sessionId: string, appId: string, mode: ReviewCardMode): { ok: true } {
    this.registry.setReviewMode(sessionId, appId, mode);
    return { ok: true };
  }
  /** A view by app or view ID or name; by default the one opened last, else the newest app's first. */
  private webViews(sessionId: string): RegisteredView[] {
    return this.registry.list(sessionId).flatMap((app) => app.views.filter((view) => view.kind === "web").map((view) => this.registry.getView(view.id)!)).filter(Boolean);
  }
  private pickView(sessionId: string, target?: string): RegisteredView {
    const views = this.webViews(sessionId);
    if (!views.length) throw new Error("This session has no web views to present. Publish one with bivy app publish, or preview a detected server.");
    if (target) {
      const wanted = target.trim().toLowerCase();
      const found = views.find((entry) => [entry.app.id, entry.view.id].includes(wanted))
        ?? views.find((entry) => entry.view.name.toLowerCase() === wanted) ?? views.find((entry) => entry.app.name.toLowerCase() === wanted);
      if (!found) throw new Error(`No web view called "${target}" in this session. Run bivy app list to see them.`);
      return found;
    }
    return views.reduce((best, entry) => (entry.openedAt ?? 0) > (best.openedAt ?? 0) || ((entry.openedAt ?? 0) === (best.openedAt ?? 0) && entry.app.createdAt > best.app.createdAt) ? entry : best);
  }
  /** Makes or updates a card, keeping each view's images to the latest card. */
  private review(entry: RegisteredView, run: Run | undefined, fields: Pick<AppReview, "trigger" | "path" | "note" | "screenshotsOff"> & { shot?: Buffer; before?: Buffer }): AppReview {
    const id = (run && run.reviews.get(entry.app.id)) ?? `review-${randomBytes(8).toString("hex")}`;
    const { shot, before, ...rest } = fields;
    const review = this.reviews.publish({
      id, sessionId: entry.app.sessionId, appId: entry.app.id, viewId: entry.view.id, name: entry.app.name, view: entry.view.name,
      at: Date.now(), ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== false)) as Pick<AppReview, "trigger" | "path">,
    }, { shot, before });
    const previous = this.latest.get(entry.view.id);
    if (previous && previous.id !== review.id) this.reviews.expire(previous, new Set([review.shot?.hash, review.before?.hash].filter((hash): hash is string => Boolean(hash))));
    this.latest.set(entry.view.id, review);
    run?.reviews.set(entry.app.id, review.id);
    return review;
  }
  /** Servers running in the workspace that this session doesn't preview yet. */
  async offers(sessionId: string, workspace: string): Promise<SessionAppOffersResult> {
    const claimed = this.registry.claimedPorts(sessionId);
    return { offers: (await this.scan(workspace)).filter((offer) => !claimed.has(offer.port)) };
  }
  /** Publish a detected server. Re-scanned so a client can't adopt an arbitrary port. */
  async adopt(sessionId: string, workspace: string, port: number): Promise<SessionApp> {
    const offer = (await this.offers(sessionId, workspace)).offers.find((item) => item.port === port);
    if (!offer) throw new Error(`Nothing in this session's workspace is listening on port ${port} any more.`);
    return this.registry.publish(sessionId, workspace, { version: 1, name: `${offer.command} · :${port}`.slice(0, 100), views: [{ kind: "web", name: `Port ${port}`, source: { kind: "service", port } }] });
  }
  /** `direct` opens the app origin itself (no shell): a signed-in device
   * returning to a view's stable address. */
  /** `scale`: the opening device's pixel density, used if this starts a display. */
  /** `page`: start on this page instead of the app's root (a review card's page). */
  async open(sessionId: string, appId: string, viewId: string, returnTo?: string, direct = false, scale?: number, page?: string): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    if (entry.target.kind === "display" && !entry.display) entry.displayScale = scale === 2 ? 2 : 1;
    if (entry.view.kind === "web") {
      if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
      if (direct && !this.gateway.openDirect) throw new Error("This machine can't open previews directly.");
      let url = direct ? this.gateway.openDirect!(viewId) : this.gateway.open(viewId, returnTo);
      if (page && page.startsWith("/") && !page.startsWith("//") && page.length <= 2048) url += `~${encodeURIComponent(page).replace(/~/g, "%7E")}`;
      // Don't wait for a managed server to boot: the preview shows it starting
      // and reloads itself once it answers.
      if (this.servers.get(viewId)) this.servers.get(viewId)!.restarts = [];
      void this.ensureServer(entry).catch(() => {});
      entry.openedAt = Date.now();
      // Compare needs a "before": take a baseline the first time it's opened.
      if (!entry.shots?.length && this.screenshots.enabled()) setTimeout(() => void this.capture([viewId]), this.settleMs).unref?.();
      return { kind: "web", url };
    }
    if (entry.target.kind !== "terminal") throw new Error("Unsupported app view provider.");
    let pending = this.terminalStarts.get(viewId);
    if (pending) {
      const existing = await pending;
      this.registry.requireView(sessionId, appId, viewId);
      if (this.terminals.has(existing)) return { kind: "terminal", termId: existing };
      if (this.terminalStarts.get(viewId) === pending) this.terminalStarts.delete(viewId);
      return this.open(sessionId, appId, viewId);
    }
    // Single flight: repeated taps/retries attach to the same running program.
    pending = this.terminals.start({ ...entry.target, name: `${entry.app.name} · ${entry.view.name}` });
    this.terminalStarts.set(viewId, pending);
    try {
      const termId = await pending;
      if (!this.registry.getView(viewId)) { this.terminals.close(termId); throw new Error("App was removed while starting."); }
      return { kind: "terminal", termId };
    } catch (error) {
      if (this.terminalStarts.get(viewId) === pending) this.terminalStarts.delete(viewId);
      throw error;
    }
  }
  /** Screenshots of a session's web views (one app, or all), for agents to
   * check their own UI. One browser at a time node-wide; PNGs in a temp dir. */
  async shot(sessionId: string, appId: string | undefined, input: Partial<ShotRequest>): Promise<{ shots: Shot[] }> {
    if (!this.screenshots.enabled()) throw new Error("Agent screenshots are off on this machine. Turn on “Let agents screenshot their app previews” in Bivy → Settings → this machine, or run: bivy config set sessions.appScreenshots true");
    const widths = input.widths ?? [390, 1280];
    const themes = input.themes ?? ["light"];
    const page = input.path ?? "/";
    if (!Array.isArray(widths) || !widths.length || widths.length > 4 || widths.some((w) => !Number.isInteger(w) || w < 240 || w > 2560)) throw new Error("Widths must be 1–4 whole numbers between 240 and 2560.");
    if (!Array.isArray(themes) || !themes.length || themes.some((t) => t !== "light" && t !== "dark")) throw new Error("Themes must be light and/or dark.");
    if (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//") || page.length > 2048) throw new Error("Path must start with /.");
    const apps = appId ? [this.registry.require(sessionId, appId)] : this.registry.list(sessionId);
    const views = apps.flatMap((app) => app.views).filter((view) => view.kind === "web").map((view) => this.registry.getView(view.id)!).filter(Boolean);
    if (!views.length) throw new Error("This session has no web views to screenshot. Publish one with bivy app publish, or preview a detected server.");
    await Promise.all(views.map((entry) => this.windowShown(entry)));
    const outDir = path.join(os.tmpdir(), "bivy-shots", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"), String(Date.now()));
    const run = this.shooting.catch(() => {}).then(() => this.screenshots.take(views, { widths, themes: [...new Set(themes)], path: page }, outDir));
    this.shooting = run;
    return { shots: await run };
  }
  /** Draw on the preview: the user's marks on a picture of what they saw.
   * The picture is the Compare screenshot they drew on, a desktop app's
   * current frame, or a web page retaken at their viewport, pixel ratio and
   * scroll — "approximate" when the page may hold state a fresh browser
   * doesn't. Returned to the client (over the session channel) as a PNG. */
  async annotate(sessionId: string, input: {
    appId: string; viewId: string; path?: string; viewport: { width: number; height: number };
    scroll?: { x: number; y: number }; dpr?: number; theme?: "light" | "dark"; strokes: unknown; compare?: number; signals?: PageSignals;
  }): Promise<{ image?: { data: string; mimeType: "image/png"; name: string; width: number; height: number }; approximate: boolean; screenshotsOff?: true }> {
    const entry = this.registry.requireView(sessionId, input.appId, input.viewId);
    if (entry.view.kind !== "web") throw new Error("Only previews can be drawn on.");
    const strokes = readStrokes(input.strokes);
    const whole = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
    // Compare's shot is drawn on at its on-screen size, which can be small.
    if (!whole(input.viewport?.width, 40, 4000) || !whole(input.viewport?.height, 40, 8000)) throw new Error("Invalid viewport.");
    const viewport = { width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) };
    const page = typeof input.path === "string" && input.path.startsWith("/") && !input.path.startsWith("//") && input.path.length <= 2048 ? input.path : entry.lastPath ?? "/";
    const scroll = { x: whole(input.scroll?.x, 0, 1e6) ? input.scroll!.x : 0, y: whole(input.scroll?.y, 0, 1e6) ? input.scroll!.y : 0 };
    const name = `${entry.app.name} ${page === "/" ? "" : page} marked.png`.replace(/[^\w .()-]+/g, "-").replace(/\s+/g, " ").trim();
    const finish = (base: Buffer, offset: { x: number; y: number }, approx: boolean) => {
      const png = composite(base, strokes, { scale: pngSize(base).width / viewport.width, offset });
      return { image: { data: png.toString("base64"), mimeType: "image/png" as const, name, ...pngSize(png) }, approximate: approx };
    };
    // Compare: the exact frame they drew on, in its own coordinates.
    if (input.compare !== undefined) {
      const shot = Number.isInteger(input.compare) ? entry.shots?.[input.compare] : undefined;
      if (!shot) throw new Error("That Compare screenshot is no longer kept. Open Compare again.");
      return finish(shot.png, { x: 0, y: 0 }, approximate("exact"));
    }
    if (!this.screenshots.enabled()) return { approximate: false, screenshotsOff: true };
    // A desktop app: its display's current frame is exactly what they saw.
    if (entry.target.kind === "display") {
      await this.windowShown(entry).catch(() => {});
      if (!entry.display) throw new Error("The app isn't running, so there's nothing to draw on.");
      const frame = await captureFrame(entry.display);
      return finish(encodePng(frame.width, frame.height, frame.rgb), { x: 0, y: 0 }, approximate("exact"));
    }
    const outDir = path.join(os.tmpdir(), "bivy-shots", "annotate", entry.view.id);
    const dpr = whole(input.dpr, 1, 3) ? Math.round(input.dpr! * 4) / 4 : 2;
    const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [viewport.width], themes: [input.theme === "dark" ? "dark" : "light"], path: page, height: viewport.height, scale: dpr, scroll }, outDir));
    this.shooting = run;
    const [shot] = await run;
    if (!shot) throw new Error("Couldn't take a picture of the page.");
    const base = fs.readFileSync(shot.file);
    fs.rmSync(outDir, { recursive: true, force: true });
    const landed = shot.scroll ?? scroll;
    const scrolledTo = Math.abs(landed.x - scroll.x) <= 2 && Math.abs(landed.y - scroll.y) <= 2;
    // Marks stay on the content they were drawn on, wherever the retake scrolled.
    return finish(base, landed, approximate("retake", input.signals, scrolledTo));
  }
  /** The managed server's output, as an attachable terminal (starts it if needed). */
  async logs(sessionId: string, appId: string, viewId: string): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    const termId = await this.ensureServer(entry);
    if (!termId) throw new Error("Only views with a start command have server logs.");
    return { kind: "terminal", termId };
  }
  /** A desktop app's display is up and showing a window (or gave up waiting),
   * so a screenshot shows the app rather than an empty screen. */
  private async windowShown(entry: RegisteredView): Promise<void> {
    if (entry.target.kind !== "display") return;
    await this.ensureServer(entry);
    const display = await this.displays.ensure(entry.view.id, entry.app.name, entry.displayScale);
    for (const until = Date.now() + WINDOW_WAIT_MS; !display.wm.count && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800)); // first paint
  }
  /** The program Bivy runs for a view: a service's start command, or a desktop
   * app on its display (started first). */
  private program(entry: RegisteredView): { command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> } | Promise<{ command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> }> {
    const target = entry.target;
    if (target.kind === "service" && target.start) return { ...target.start, name: `${entry.app.name} · ${entry.view.name} server` };
    if (target.kind !== "display") throw new Error("This view has no program.");
    return this.displays.ensure(entry.view.id, entry.app.name, entry.displayScale).then((display) => {
      entry.display = display.socket;
      return { command: target.command, args: target.args, workspace: target.workspace, env: display.env, name: `${entry.app.name} · ${entry.view.name}` };
    });
  }
  /** Services start synchronously; a desktop app waits for its display. */
  private startProgram(entry: RegisteredView): Promise<string> {
    const program = this.program(entry);
    return program instanceof Promise ? program.then((spec) => this.terminals.start(spec)) : this.terminals.start(program);
  }
  private ensureServer(entry: RegisteredView): Promise<string | undefined> {
    if (!(entry.target.kind === "service" && entry.target.start) && entry.target.kind !== "display") return Promise.resolve(undefined);
    const id = entry.view.id;
    let state = this.servers.get(id);
    if (!state) { state = { restarts: [] }; this.servers.set(id, state); }
    const server = state;
    if (server.termId && this.terminals.has(server.termId)) return Promise.resolve(server.termId);
    server.pending ??= this.startProgram(entry)
      .then((termId) => {
        if (!this.registry.getView(id)) { this.terminals.close(termId); throw new Error("App was removed while starting."); }
        server.termId = termId; return termId;
      })
      .finally(() => { server.pending = undefined; });
    // Watch for exits and restart, backing off a crash loop.
    server.timer ??= setInterval(() => {
      const current = this.registry.getView(id);
      if (!current) { this.stopServer(id); return; }
      if (server.pending || !server.termId || this.terminals.has(server.termId)) return;
      const now = Date.now();
      server.restarts = server.restarts.filter((at) => now - at < RESTART_WINDOW);
      if (server.restarts.length >= MAX_RESTARTS) return;
      server.restarts.push(now);
      server.termId = undefined;
      void this.ensureServer(current).catch(() => {});
    }, this.serverWatchMs);
    server.timer.unref?.();
    return server.pending;
  }
  private stopServer(id: string): void {
    this.displays.stop(id);
    const entry = this.registry.getView(id);
    if (entry) { entry.display = undefined; entry.displayScale = undefined; }
    const server = this.servers.get(id);
    if (!server) return;
    clearInterval(server.timer);
    if (server.termId) this.terminals.close(server.termId);
    void server.pending?.then((termId) => this.terminals.close(termId)).catch(() => {});
    this.servers.delete(id);
  }
  share(sessionId: string, appId: string, viewId: string): ShareAppViewResult {
    if (this.registry.requireView(sessionId, appId, viewId).view.kind !== "web") throw new Error("Only web views have preview links.");
    if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
    return this.gateway.share(viewId);
  }
  /** `bivy app share`: mints a share link for a web view picked by app and/or
   * view ID or name, like `present` (default: the one opened last). */
  shareView(sessionId: string, input: { app?: string; view?: string }): ShareAppViewResult & { appId: string; viewId: string; app: string; view: string } {
    let entry: RegisteredView;
    if (input.view) {
      const wantedApp = input.app?.trim().toLowerCase();
      const scope = this.webViews(sessionId).filter((candidate) => !wantedApp || candidate.app.id === wantedApp || candidate.app.name.toLowerCase() === wantedApp);
      if (wantedApp && !scope.length) throw new Error(`No app called "${input.app}" with web views in this session. Run bivy app list to see them.`);
      const wanted = input.view.trim().toLowerCase();
      const found = scope.find((candidate) => candidate.view.id === wanted) ?? scope.find((candidate) => candidate.view.name.toLowerCase() === wanted);
      if (!found) throw new Error(`No web view called "${input.view}"${input.app ? ` in "${input.app}"` : ""}. Run bivy app list to see them.`);
      entry = found;
    } else entry = this.pickView(sessionId, input.app);
    return { ...this.share(sessionId, entry.app.id, entry.view.id), appId: entry.app.id, viewId: entry.view.id, app: entry.app.name, view: entry.view.name };
  }
  clearNotes(sessionId: string, appId: string, viewId: string): { ok: true } {
    delete this.registry.requireView(sessionId, appId, viewId).notes;
    return { ok: true };
  }
  /** Ends every link, browser session and open connection for one view; the app stays. */
  revoke(sessionId: string, appId: string, viewId: string): { ok: true } {
    this.registry.requireView(sessionId, appId, viewId);
    this.gateway?.revoke(viewId);
    return { ok: true };
  }
  remove(sessionId: string, appId: string): void {
    const app = this.registry.require(sessionId, appId);
    this.registry.remove(sessionId, appId);
    for (const view of app.views) {
      this.gateway?.revoke(view.id);
      this.stopServer(view.id);
      const pending = this.terminalStarts.get(view.id);
      this.terminalStarts.delete(view.id);
      if (pending) void pending.then((id) => this.terminals.close(id)).catch(() => {});
    }
  }
}
