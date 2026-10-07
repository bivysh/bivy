// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { SHARE_DURATIONS, type AppManifest, type AppOffer, type AppPin, type AppPinState, type AppReview, type OpenAppViewResult, type ReviewCardMode, type ReviewerNote, type SessionApp, type SessionAppOffersResult, type SessionAppsResult, type ShareAppViewResult, type ShareOptions, type EvidenceRow, type BackendKind } from "./types.js";
import { randomBytes } from "node:crypto";
import { PIN_CHANGE, REVIEW_MODES, regionChange, shouldReview, visualChange } from "./review.js";
import { AppRegistry, type RegisteredView } from "./registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanListeners, scanMachineListeners } from "./listeners.js";
import { takeShots, type Shot, type ShotRequest } from "./screenshot.js";
import { approximate, composite, crop, noteAnchor, readNotes, readStrokes, readElementScrolls, type ElementScroll, type MarkNote, type PageSignals, type Stroke } from "./annotate.js";
import { captureFrame, encodePng, sendInput } from "./rfb.js";
import { inputEvents, readAction } from "./input.js";
import { pressMenu, readMenuPath, readMenus, type AppMenu } from "./menu.js";
import { pngSize } from "./review.js";
import { Backend } from "./backend/index.js";
import { SCENARIO_DIR, loadScenarios, planScenario, scenariosFor, summarize, type ScenarioKind, type ScenarioPlan, type ScenarioStep, type ScenarioSummary } from "./scenarios.js";
import { startScenarioProxy } from "./scenario-proxy.js";

const scenarioKind = (entry: RegisteredView): ScenarioKind => entry.target.kind === "display" ? "desktop" : "web";
/** A desktop step in words, for the message when one fails. */
const stepWords = (step: ScenarioStep): string => "click" in step ? `click ${Array.isArray(step.click) ? step.click.join(",") : step.click}` : "type" in step ? `type "${step.type.slice(0, 40)}"` : "press" in step ? `press ${step.press}` : "menu" in step ? `menu ${step.menu}` : "wait" in step ? `wait ${step.wait}` : "step";

export interface AppPreviewProvider {
  readonly available?: boolean;
  open(id: string, returnTo?: string): string;
  openDirect?(id: string): string;
  address?(id: string): string | undefined;
  share(id: string, options?: { ttl?: number; controls?: boolean }): ShareAppViewResult;
  sharing?(id: string): { links: number; expiresAt: number } | undefined;
  unshare?(id: string): void;
  revoke(id: string): void;
}

export interface AppTerminalProvider {
  start(input: { command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> }): Promise<string>;
  has(termId: string): boolean;
  close(termId: string): void;
  /** Follows a terminal's output as it arrives (a server's logs). Optional: without it, logs views stay empty. */
  tap?(termId: string, onData: (data: string) => void): (() => void) | undefined;
}

/** Private displays for desktop views (see display.ts). */
export interface AppDisplayProvider {
  unavailable(): string | undefined;
  /** `launch`: a command the program is started through, if the display needs one. */
  /** `control`: where to ask for the app's menus, if the display can. */
  ensure(id: string, name: string, scale?: number): Promise<{ socket: string; env: Record<string, string>; wm: { count: number }; launch?: string[]; control?: string }>;
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
/** Where pins go: the same treatment as a review card — the picture becomes an
 * encrypted attachment, the pin is logged and broadcast, and a state change is
 * re-published under the same id. */
export interface PinSink {
  publish(pin: AppPin, image?: Buffer): AppPin;
}
const NO_PINS: PinSink = { publish: (pin) => pin };
/** A pin's region is in the page CSS pixels of the viewport it was marked in.
 * Run screenshots are taken at this width, so a pin marked at a very different
 * one sat on a different layout: its region says nothing about these pixels,
 * and it stays open rather than being answered wrongly. */
const PIN_SHOT_WIDTH = 390;
const PIN_WIDTH_TOLERANCE = 0.1;
/** How long a drawn picture is kept for the pin that may follow it. */
const MARK_TTL_MS = 10 * 60_000;
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
  /** The backend views' "before", taken as the run starts. */
  backend?: Promise<void>;
}
const NO_DISPLAYS: AppDisplayProvider = { unavailable: () => "Desktop app views aren't available on this machine.", ensure: () => Promise.reject(new Error("Desktop app views aren't available on this machine.")), stop: () => {} };
/** How long a screenshot waits for a desktop app's first window. */
const WINDOW_WAIT_MS = 15_000;
/** How long an app gets to react to input before its picture is taken. */
const AFTER_INPUT_MS = 400;

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
  private readonly scanMachine: (root: string) => Promise<AppOffer[]>;
  private readonly serverWatchMs: number;
  private readonly screenshots: { enabled: () => boolean; take: typeof takeShots };
  private readonly displays: AppDisplayProvider;
  private shooting: Promise<unknown> = Promise.resolve();
  private readonly reviews: ReviewSink;
  private readonly pinSink: PinSink;
  /** Pins made in this node's lifetime, newest last, by view. */
  private pins: AppPin[] = [];
  /** The last picture drawn on a view, kept briefly for the pin that may
   *  follow it: the person is still typing their words when it is made. */
  private lastMark = new Map<string, { at: number; png: Buffer; path: string; viewport: AppPin["viewport"];
    notes: { n: number; words: string; selectors: string[]; region: AppPin["region"] }[] }>();
  private readonly settleMs: number;
  private runs = new Map<string, Run>();
  /** The latest card per view: a newer one expires its images. */
  private latest = new Map<string, AppReview>();
  /** Per view: the newest reviewer note a run-end card has already counted. */
  private handedOver = new Map<string, number>();
  /** Per desktop app in a scenario with an API: the proxy in front of it and the variable pointing there. */
  private proxies = new Map<string, { close(): void; env: Record<string, string> }>();
  /** Screenshots in progress, so a card, Compare and a baseline share one browser run. */
  private inflight = new Map<string, Promise<Buffer | undefined>>();
  /** Requests, data and logs views: what a backend change did. */
  readonly backend: Backend;
  constructor(readonly registry: AppRegistry, readonly gateway: AppPreviewProvider | undefined, private readonly terminals: AppTerminalProvider, options: {
    scan?: (workspace: string) => Promise<AppOffer[]>; scanMachine?: (root: string) => Promise<AppOffer[]>; serverWatchMs?: number;
    /** Agent screenshots are a node setting, off by default. */
    screenshots?: { enabled: () => boolean; take?: typeof takeShots };
    displays?: AppDisplayProvider;
    reviews?: ReviewSink;
    pins?: PinSink;
    /** How long servers get to rebuild after a change before a screenshot. */
    settleMs?: number;
  } = {}) {
    this.scan = options.scan ?? scanListeners;
    this.scanMachine = options.scanMachine ?? scanMachineListeners;
    this.serverWatchMs = options.serverWatchMs ?? 5_000;
    this.screenshots = { enabled: options.screenshots?.enabled ?? (() => false), take: options.screenshots?.take ?? takeShots };
    this.displays = options.displays ?? NO_DISPLAYS;
    this.reviews = options.reviews ?? NO_REVIEWS;
    this.pinSink = options.pins ?? NO_PINS;
    this.settleMs = options.settleMs ?? COMPARE_SETTLE_MS;
    this.backend = new Backend(registry, terminals);
    registry.desktopScenario = (viewId, scenario) => this.desktopScenario(viewId, scenario);
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
      const sharing = this.gateway?.sharing?.(view.id);
      if (sharing) view.sharing = sharing;
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
      // In a scenario, the new code starts in it again, steps and all.
      if (entry.scenario) { void this.desktopScenario(id, entry.scenario.id).catch(() => {}); continue; }
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

  private hasOpenPins(viewId: string): boolean {
    return this.pins.some((pin) => pin.viewId === viewId && pin.state === "open");
  }
  /** Web views a run watches: those whose app wants review cards, and those
   * carrying a pin still waiting for an answer. */
  private reviewable(sessionId: string): RegisteredView[] {
    return this.registry.list(sessionId)
      .flatMap((app) => app.views.filter((view) => view.kind === "web").map((view) => this.registry.getView(view.id)!)).filter(Boolean)
      .filter((entry) => REVIEW_MODES[this.registry.reviewMode(entry.app.id)].minChange !== undefined || this.hasOpenPins(entry.view.id));
  }
  /** An agent run started. Remembers each view's revision, and the page as
   * it is now, so the end of the run can tell whether anything visibly
   * changed. A baseline is only taken when no screenshot of this revision
   * exists yet — after the first run, the last run's screenshot serves. */
  runStarted(sessionId: string): Promise<void> {
    const views = this.reviewable(sessionId);
    const run: Run = { start: new Map(views.map((entry) => [entry.view.id, entry.revision])), baseline: new Map(), reviews: new Map(), muted: false, ended: false };
    this.runs.set(sessionId, run);
    if (this.backend.views(sessionId).length) run.backend = this.backend.baseline(sessionId).catch(() => {});
    // Settles when the backend's "before" is taken (tests wait on it; the server doesn't need to).
    const ready = run.backend ?? Promise.resolve();
    if (!this.screenshots.enabled()) return ready;
    for (const entry of views) void this.shotOf(entry).then((png) => { if (png && entry.revision === run.start.get(entry.view.id)) run.baseline.set(entry.view.id, png); });
    return ready;
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
    // Backend views run again; what changed is evidence, on the app's card.
    let evidence = new Map<string, { rows: EvidenceRow[]; changed: boolean }>();
    if (run.backend) { await run.backend; evidence = await this.backend.evidence(sessionId).catch(() => evidence); }
    const changed = [...run.start].map(([id, revision]) => ({ entry: this.registry.getView(id), revision })).filter(({ entry, revision }) => entry && entry.revision !== revision);
    if (changed.length && this.screenshots.enabled() && !run.muted) await new Promise((r) => setTimeout(r, this.settleMs));
    for (const { entry } of changed) {
      if (!entry || !this.screenshots.enabled()) continue;
      const mode = this.registry.reviewMode(entry.app.id);
      const cards = !run.muted && REVIEW_MODES[mode].minChange !== undefined;
      const before = run.baseline.get(entry.view.id);
      // Pins are answered from evidence even where cards are off or muted:
      // turning cards off means "stop showing me the app", not "forget what I
      // asked for".
      const after = cards || this.hasOpenPins(entry.view.id) ? await this.shotOf(entry) : undefined;
      await this.resolvePins(entry, before, after);
      if (!cards) continue;
      const change = before && after ? visualChange(before, after) : undefined;
      // A card the agent presented earlier in the run is refreshed if the page changed since.
      const current = this.latest.get(entry.view.id);
      const presented = current && run.reviews.get(entry.app.id) === current.id;
      if (!shouldReview({ trigger: "run", mode, muted: run.muted, revisionChanged: true, change }) && !(presented && after)) continue;
      latest = this.review(entry, run, { trigger: presented ? current.trigger : "run", note: presented ? current.note : undefined, try: presented ? current.try : undefined, path: entry.lastPath ?? "/", shot: after, before, evidence: evidence.get(entry.app.id)?.changed ? evidence.get(entry.app.id)!.rows : undefined });
    }
    // Reviewer notes that arrived since the last hand-over ride on the view's
    // card for this run, or get a card of their own. A count only: the notes
    // stay on the machine until the owner drafts them into a message.
    for (const entry of this.webViews(sessionId)) {
      const waiting = (entry.notes ?? []).filter((note) => note.at > (this.handedOver.get(entry.view.id) ?? 0));
      if (!waiting.length || run.muted || this.registry.reviewMode(entry.app.id) === "off") continue;
      this.handedOver.set(entry.view.id, Math.max(...waiting.map((note) => note.at)));
      const notes = entry.notes!.length;
      const current = this.latest.get(entry.view.id);
      if (current && run.reviews.get(entry.app.id) === current.id) {
        const card = this.reviews.publish({ ...current, notes, at: Date.now() }, {});
        this.latest.set(entry.view.id, card);
        if (!latest || latest.id === card.id) latest = card;
      } else {
        // Cards are one per app per run: another view's card keeps its own; these notes get a new one.
        const card = this.review(entry, run.reviews.has(entry.app.id) ? undefined : run, { trigger: "notes", path: entry.lastPath ?? "/", notes });
        // A visible change stays what "finished" talks about; notes fill in when there's nothing else.
        latest ??= card;
      }
    }
    // A backend-only change: the evidence is the card.
    for (const [appId, found] of evidence) {
      if (!found.changed || run.muted || run.reviews.has(appId) || this.registry.reviewMode(appId) === "off") continue;
      const entry = this.registry.getView(found.rows[0]!.viewId);
      if (entry) latest = this.review(entry, run, { trigger: "run", path: "/", evidence: found.rows });
    }
    if (!latest) {
      const id = [...run.reviews.values()].at(-1);
      latest = [...this.latest.values()].find((review) => review.id === id);
    }
    return latest;
  }
  /** `bivy app present`, or Show me ("asked"): a card for one view now. */
  async present(sessionId: string, input: { target?: string; path?: string; note?: string; trigger?: "present" | "asked"; try?: string[] }): Promise<{ review?: AppReview; message: string }> {
    const trigger = input.trigger ?? "present";
    const page = input.path;
    if (page !== undefined && (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//") || page.length > 2048)) throw new Error("Path must start with /.");
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : undefined;
    const entry = this.pickView(sessionId, input.target);
    const tries = input.try?.length ? this.tryScenarios(entry, input.try) : undefined;
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
    const review = this.review(entry, run, { trigger, note, path, shot, before, screenshotsOff: !enabled, ...(tries ? { try: tries } : {}) });
    return { review, message: enabled ? (shot ? "The user sees it in the chat." : "The user sees a card in the chat, but the screenshot failed.") : "The user sees a card in the chat. Screenshots are off on this machine, so it has no picture." };
  }
  /** `bivy app scenarios`: a view's scenarios as the preview shows them, and
   *  files that can't be opened, with what's wrong (picked like `present`). */
  scenarios(sessionId: string, target?: string): { app: string; view: string; dir: string; scenarios: ScenarioSummary[] } {
    const entry = this.pickView(sessionId, target);
    const { scenarios, problems } = loadScenarios(entry.workspace);
    const kind = scenarioKind(entry);
    return { app: entry.app.name, view: entry.view.name, dir: SCENARIO_DIR, scenarios: summarize(scenariosFor(scenarios, entry.app.name, entry.view.name, kind), problems, entry.app.createdAt, kind) };
  }
  /** Scenarios a review card offers to try, by ID, each one that can be opened. */
  private tryScenarios(entry: RegisteredView, ids: string[]): NonNullable<AppReview["try"]> {
    const { scenarios, problems } = loadScenarios(entry.workspace);
    const kind = scenarioKind(entry);
    const known = summarize(scenariosFor(scenarios, entry.app.name, entry.view.name, kind), problems, entry.app.createdAt, kind);
    const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase().replace(/\.json$/, "")).filter(Boolean))].slice(0, 6);
    return wanted.map((id) => {
      const found = known.find((item) => item.id === id);
      if (!found) throw new Error(`No scenario "${id}" for ${entry.view.name}. ${known.length ? `Its scenarios: ${known.map((item) => item.id).join(", ")}.` : `Write one in ${SCENARIO_DIR}/${id}.json.`}`);
      if (found.error) throw new Error(`Scenario "${id}" can't be opened: ${found.error}`);
      return { id: found.id, name: found.name };
    });
  }
  /** Puts a desktop app in a scenario ("" for none). It is one program for
   *  everyone watching, so the scenario is the app's: it restarts with the
   *  scenario's arguments and environment, its API (if the scenario has one)
   *  behind a proxy that applies the network rules, and then the steps run in
   *  its window the way an agent's input does. A step that fails leaves the app
   *  where it got to and says which step, rather than throwing. */
  async desktopScenario(viewId: string, id: string): Promise<{ plan: ScenarioPlan | null; error?: string }> {
    const entry = this.registry.getView(viewId);
    if (entry?.target.kind !== "display") throw new Error("Desktop scenarios are for desktop apps.");
    const plan = id ? planScenario(scenariosFor(loadScenarios(entry.workspace).scenarios, entry.app.name, entry.view.name, "desktop"), id, "desktop") : null;
    this.proxies.get(viewId)?.close();
    this.proxies.delete(viewId);
    if (plan?.api) {
      const proxy = await startScenarioProxy(plan.api.target, plan.network);
      this.proxies.set(viewId, { close: proxy.close, env: { [plan.api.env]: proxy.url } });
    }
    entry.scenario = plan ?? undefined;
    const server = this.servers.get(viewId);
    if (server?.termId) { this.terminals.close(server.termId); server.termId = undefined; }
    await this.windowShown(entry);
    if (!plan) return { plan: null };
    const steps = plan.stages.flatMap((stage) => stage.steps);
    for (const [index, step] of steps.entries()) {
      try { await this.desktopStep(entry, step); }
      catch (error) { return { plan, error: `Step ${index + 1} (${stepWords(step)}): ${(error as Error).message}` }; }
      await new Promise((r) => setTimeout(r, AFTER_INPUT_MS));
    }
    return { plan };
  }
  private async desktopStep(entry: RegisteredView, step: ScenarioStep): Promise<void> {
    if ("wait" in step) { if (typeof step.wait === "number") await new Promise((r) => setTimeout(r, step.wait as number)); return; }
    if ("menu" in step) {
      if (!entry.displayControl) throw new Error("This machine's desktop apps don't expose their menus (macOS only). Use a key combo instead.");
      await pressMenu(entry.displayControl, readMenuPath(step.menu));
      return;
    }
    if (!entry.display) throw new Error("The app isn't running. Check its Logs in the Apps sheet.");
    const action = "click" in step && Array.isArray(step.click) ? { kind: "click", x: step.click[0], y: step.click[1] }
      : "type" in step ? { kind: "type", text: step.type } : "press" in step ? { kind: "key", keys: step.press } : undefined;
    if (!action) throw new Error("That step is for web pages.");
    await sendInput(entry.display, inputEvents(readAction(action)));
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
  private pickView(sessionId: string, target?: string, desktop = false): RegisteredView {
    const views = this.webViews(sessionId).filter((entry) => !desktop || entry.target.kind === "display");
    const noun = desktop ? "desktop app" : "web view";
    if (!views.length) throw new Error(desktop ? "This session has no desktop apps. Publish one with bivy app run -- <command>." : "This session has no web views to present. Publish one with bivy app publish, or preview a detected server.");
    if (target) {
      const wanted = target.trim().toLowerCase();
      const found = views.find((entry) => [entry.app.id, entry.view.id].includes(wanted))
        ?? views.find((entry) => entry.view.name.toLowerCase() === wanted) ?? views.find((entry) => entry.app.name.toLowerCase() === wanted);
      if (!found) throw new Error(`No ${noun} called "${target}" in this session. Run bivy app list to see them.`);
      return found;
    }
    return views.reduce((best, entry) => (entry.openedAt ?? 0) > (best.openedAt ?? 0) || ((entry.openedAt ?? 0) === (best.openedAt ?? 0) && entry.app.createdAt > best.app.createdAt) ? entry : best);
  }
  /** Makes or updates a card, keeping each view's images to the latest card. */
  private review(entry: RegisteredView, run: Run | undefined, fields: Pick<AppReview, "trigger" | "path" | "note" | "screenshotsOff" | "notes" | "evidence" | "try"> & { shot?: Buffer; before?: Buffer }): AppReview {
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
  /** Servers running anywhere under `root`, with their projects: what a first
   *  session can start in and preview before it has a workspace of its own. */
  async machineOffers(root: string): Promise<SessionAppOffersResult> {
    return { offers: await this.scanMachine(root) };
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
  /** `scenario`: open it in that scenario (the shell enters it once the app has loaded). */
  async open(sessionId: string, appId: string, viewId: string, returnTo?: string, direct = false, scale?: number, page?: string, scenario?: string): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    if (entry.target.kind === "display" && !entry.display) entry.displayScale = scale === 2 ? 2 : 1;
    if (entry.view.kind === "web") {
      if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
      if (direct && !this.gateway.openDirect) throw new Error("This machine can't open previews directly.");
      let url = direct ? this.gateway.openDirect!(viewId) : this.gateway.open(viewId, returnTo);
      const start = page && page.startsWith("/") && !page.startsWith("//") && page.length <= 2048 ? page : undefined;
      const inScenario = !direct && scenario && /^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario) ? scenario : undefined;
      if (start || inScenario) url += `~${start ? encodeURIComponent(start).replace(/~/g, "%7E") : ""}`;
      if (inScenario) url += `~${inScenario}`;
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
  /** Computer use: an agent clicks, types, presses keys and scrolls in one of
   * its desktop apps, in the pixels of the app's screenshot, the way a viewer
   * would. Starts the app if needed. With screenshots on, returns the app as
   * it looks afterwards, so the agent sees what its action did. */
  async act(sessionId: string, target: string | undefined, input: unknown): Promise<{ width: number; height: number; shot?: Shot; message: string }> {
    const action = readAction(input);
    const entry = this.pickView(sessionId, target, true);
    if (!entry.display) await this.windowShown(entry);
    if (!entry.display) throw new Error("The app isn't running. Check its Logs in the Apps sheet.");
    const { width, height } = await sendInput(entry.display, inputEvents(action));
    if (!this.screenshots.enabled()) return { width, height, message: "Done. Agent screenshots are off on this machine, so there's no picture of the result: bivy config set sessions.appScreenshots true" };
    return { width, height, shot: await this.after(entry, sessionId), message: "Done. The shot is the app now." };
  }
  /** A desktop app's menu bar: listed, or one item chosen by its path of
   * titles ("File > Save"). Choosing returns the app afterwards, like `act`. */
  async menu(sessionId: string, target: string | undefined, path?: unknown): Promise<{ menus?: AppMenu[]; shot?: Shot; message?: string }> {
    const item = path === undefined ? undefined : readMenuPath(path);
    const entry = this.pickView(sessionId, target, true);
    if (!entry.display) await this.windowShown(entry);
    if (!entry.displayControl) throw new Error("This machine's desktop apps don't expose their menus (macOS only). Use keyboard shortcuts: bivy app key.");
    if (!item) return { menus: await readMenus(entry.displayControl) };
    await pressMenu(entry.displayControl, item);
    if (!this.screenshots.enabled()) return { message: "Chosen. Agent screenshots are off on this machine, so there's no picture of the result." };
    return { shot: await this.after(entry, sessionId), message: "Chosen. The shot is the app now." };
  }
  /** The app a moment after an action, as a screenshot. */
  private async after(entry: RegisteredView, sessionId: string): Promise<Shot | undefined> {
    await new Promise((r) => setTimeout(r, AFTER_INPUT_MS));
    const outDir = path.join(os.tmpdir(), "bivy-shots", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"), String(Date.now()));
    const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [], themes: [], path: "/" }, outDir));
    this.shooting = run;
    return (await run)[0];
  }
  /** Draw on the preview: the user's marks on a picture of what they saw.
   * The picture is the Compare screenshot they drew on, a desktop app's
   * current frame, or a web page retaken at their viewport, pixel ratio and
   * scroll — "approximate" when the page may hold state a fresh browser
   * doesn't. Returned to the client (over the session channel) as a PNG. */
  async annotate(sessionId: string, input: {
    appId: string; viewId: string; path?: string; viewport: { width: number; height: number };
    scroll?: { x: number; y: number }; elementScrolls?: ElementScroll[]; dpr?: number; theme?: "light" | "dark"; strokes: unknown; compare?: number; signals?: PageSignals;
    /** What the marks named, for a pin to find again later. Untrusted strings. */
    selectors?: unknown;
    /** One entry per note: its number, its words, and the strokes it owns. When
     * present it is the source of both the strokes and the numbers drawn. */
    notes?: unknown;
  }): Promise<{ image?: { data: string; mimeType: "image/png"; name: string; width: number; height: number }; approximate: boolean; screenshotsOff?: true }> {
    const entry = this.registry.requireView(sessionId, input.appId, input.viewId);
    if (entry.view.kind !== "web") throw new Error("Only previews can be drawn on.");
    // Several notes, each owning its strokes; one unnumbered mark is the same
    // thing with a single entry, so there is one path through here.
    const grouped = readNotes(input.notes);
    const strokes = grouped.length ? grouped.flatMap((note) => note.strokes) : readStrokes(input.strokes);
    const elementScrolls = readElementScrolls(input.elementScrolls);
    const whole = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
    // Compare's shot is drawn on at its on-screen size, which can be small.
    if (!whole(input.viewport?.width, 40, 4000) || !whole(input.viewport?.height, 40, 8000)) throw new Error("Invalid viewport.");
    const viewport = { width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) };
    const page = typeof input.path === "string" && input.path.startsWith("/") && !input.path.startsWith("//") && input.path.length <= 2048 ? input.path : entry.lastPath ?? "/";
    const scroll = { x: whole(input.scroll?.x, 0, 1e6) ? input.scroll!.x : 0, y: whole(input.scroll?.y, 0, 1e6) ? input.scroll!.y : 0 };
    const name = `${entry.app.name} ${page === "/" ? "" : page} marked.png`.replace(/[^\w .()-]+/g, "-").replace(/\s+/g, " ").trim();
    const box = (of: Stroke[]) => {
      const xs = of.flatMap((stroke) => stroke.points.map(([x]) => x));
      const ys = of.flatMap((stroke) => stroke.points.map(([, y]) => y));
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    const loose = (Array.isArray(input.selectors) ? input.selectors : []).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 300).slice(0, 8);
    // What each note covers, in the page pixels it was drawn in, so a later
    // screenshot can be compared exactly there (see resolvePins).
    const held = grouped.length
      ? grouped.map((note) => ({ n: note.n, words: note.words, selectors: note.selectors, region: box(note.strokes) }))
      : [{ n: 1, words: "", selectors: loose, region: box(strokes) }];
    const badges = grouped.length > 1 ? grouped.map((note) => ({ n: note.n, ...noteAnchor(note) })) : [];
    const finish = (base: Buffer, offset: { x: number; y: number }, approx: boolean) => {
      const png = composite(base, strokes, { scale: pngSize(base).width / viewport.width, offset }, badges);
      // Keep it for the pins that may follow: the person is still writing.
      this.lastMark.set(entry.view.id, { at: Date.now(), png, path: page, viewport, notes: held });
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
    const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [viewport.width], themes: [input.theme === "dark" ? "dark" : "light"], path: page, height: viewport.height, scale: dpr, scroll, ...(elementScrolls.length ? { elementScrolls } : {}) }, outDir));
    this.shooting = run;
    const [shot] = await run;
    if (!shot) throw new Error("Couldn't take a picture of the page.");
    const base = fs.readFileSync(shot.file);
    fs.rmSync(outDir, { recursive: true, force: true });
    const landed = shot.scroll ?? scroll;
    const scrolledTo = Math.abs(landed.x - scroll.x) <= 2 && Math.abs(landed.y - scroll.y) <= 2;
    // Marks stay on the content they were drawn on, wherever the retake scrolled.
    return finish(base, landed, approximate("retake", input.signals, scrolledTo && shot.elementScrollsRestored !== false));
  }
  /** A pin: the marks the person just sent, kept as a thing with a state
   * rather than a paragraph in a message. Made only when the message is
   * actually sent, so nothing appears in the chat that the person didn't send.
   * The picture is the one `annotate` already made for the message. */
  pin(sessionId: string, input: { appId: string; viewId: string; words?: string }): { pins: AppPin[] } {
    const entry = this.registry.requireView(sessionId, input.appId, input.viewId);
    const mark = this.lastMark.get(input.viewId);
    if (!mark || Date.now() - mark.at > MARK_TTL_MS) throw new Error("That mark is no longer held. Mark the preview again.");
    this.lastMark.delete(input.viewId);
    const scale = pngSize(mark.png).width / mark.viewport.width;
    const fallback = String(input.words ?? "").trim().slice(0, 2000);
    const made = mark.notes.map((note) => {
      // The card shows what that note marked, not the whole page it sat on.
      // The message keeps the full picture; this is the pin's own thumbnail.
      let picture = mark.png;
      try { picture = crop(mark.png, note.region, scale); } catch { /* the whole picture still tells the story */ }
      const pin = this.pinSink.publish({
        id: `pin-${randomBytes(8).toString("hex")}`, sessionId, appId: entry.app.id, viewId: entry.view.id,
        name: entry.app.name, view: entry.view.name, path: mark.path,
        words: note.words || fallback, at: Date.now(),
        ...(mark.notes.length > 1 ? { number: note.n } : {}),
        selectors: note.selectors, region: note.region, viewport: mark.viewport, state: "open",
      }, picture);
      this.pins = [...this.pins, pin].slice(-200);
      return pin;
    });
    return { pins: made };
  }
  /** The person's own verdict on a pin. Only they can say "done". */
  setPinState(sessionId: string, pinId: string, state: AppPinState): { pin: AppPin } {
    const current = this.pins.find((pin) => pin.id === pinId && pin.sessionId === sessionId);
    if (!current) throw new Error("That pin is no longer held on this machine.");
    return { pin: this.updatePin(current, state) };
  }
  private updatePin(pin: AppPin, state: AppPinState): AppPin {
    const next = this.pinSink.publish({ ...pin, state, stateAt: Date.now() });
    this.pins = this.pins.map((item) => (item.id === pin.id ? next : item));
    return next;
  }
  /** After a run, say what became of the pins on a view — from evidence only.
   * "gone" when what a pin named is no longer on the page; "changed" when the
   * pixels it marked differ from before the run. A run that changed nothing
   * there leaves the pin open: it has not been answered. */
  private async resolvePins(entry: RegisteredView, before: Buffer | undefined, after: Buffer | undefined): Promise<void> {
    const open = this.pins.filter((pin) => pin.viewId === entry.view.id && pin.state === "open");
    if (!open.length) return;
    const selectors = [...new Set(open.flatMap((pin) => pin.selectors))];
    let missing: string[] | undefined;
    if (selectors.length && this.screenshots.enabled()) {
      const outDir = path.join(os.tmpdir(), "bivy-shots", "pins", entry.view.id);
      try {
        const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [PIN_SHOT_WIDTH], themes: ["light"], path: entry.lastPath ?? "/", selectors }, outDir));
        this.shooting = run;
        missing = (await run)[0]?.missing;
      } catch { /* no answer is not an answer: the pins stay open */ }
      finally { fs.rmSync(outDir, { recursive: true, force: true }); }
    }
    for (const pin of open) {
      if (missing && pin.selectors.length && pin.selectors.every((selector) => missing!.includes(selector))) { this.updatePin(pin, "gone"); continue; }
      if (!before || !after || pin.path !== (entry.lastPath ?? "/")) continue;
      // A pin marked at a very different width sat on a different layout.
      if (Math.abs(pin.viewport.width - PIN_SHOT_WIDTH) > PIN_SHOT_WIDTH * PIN_WIDTH_TOLERANCE) continue;
      const change = regionChange(before, after, pin.region, pngSize(after).width / pin.viewport.width);
      if (change !== undefined && change > PIN_CHANGE) this.updatePin(pin, "changed");
    }
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
      entry.displayControl = display.control;
      // A scenario adds its arguments and environment; the display's own variables always win.
      const [command, ...args] = [...display.launch ?? [], target.command, ...target.args, ...entry.scenario?.args ?? []];
      const env = { ...entry.scenario?.env, ...this.proxies.get(entry.view.id)?.env, ...display.env };
      return { command: command!, args, workspace: target.workspace, env, name: `${entry.app.name} · ${entry.view.name}` };
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
        server.termId = termId;
        this.backend.attach(id, termId);
        return termId;
      })
      .finally(() => { server.pending = undefined; });
    // Watch for exits and restart, backing off a crash loop.
    server.timer ??= setInterval(() => {
      const current = this.registry.getView(id);
      if (!current) { this.stopServer(id); return; }
      if (server.pending || !server.termId || this.terminals.has(server.termId)) return;
      const now = Date.now();
      server.restarts = server.restarts.filter((at) => now - at < RESTART_WINDOW);
      // A crash loop stays down until the view is opened again, rather than
      // retrying every time the window rolls over.
      if (server.restarts.length >= MAX_RESTARTS) { clearInterval(server.timer); server.timer = undefined; return; }
      server.restarts.push(now);
      server.termId = undefined;
      void this.ensureServer(current).catch(() => {});
    }, this.serverWatchMs);
    server.timer.unref?.();
    return server.pending;
  }
  private stopServer(id: string): void {
    this.displays.stop(id);
    this.proxies.get(id)?.close();
    this.proxies.delete(id);
    const entry = this.registry.getView(id);
    if (entry) { entry.display = undefined; entry.displayControl = undefined; entry.displayScale = undefined; }
    const server = this.servers.get(id);
    if (!server) return;
    clearInterval(server.timer);
    if (server.termId) this.terminals.close(server.termId);
    void server.pending?.then((termId) => this.terminals.close(termId)).catch(() => {});
    this.servers.delete(id);
  }
  /** A backend view of a session, by exact IDs (the app) or by name (`bivy app requests`). */
  backendView(sessionId: string, kind: BackendKind, input: { appId?: string; viewId?: string; target?: string }) {
    if (input.appId && input.viewId) {
      const entry = this.registry.requireView(sessionId, input.appId, input.viewId);
      if (entry.target.kind !== kind) throw new Error(`That isn't a ${kind} view.`);
      return entry as Parameters<Backend["requests"]>[0];
    }
    return this.backend.pick(sessionId, kind, input.target);
  }
  share(sessionId: string, appId: string, viewId: string, options: ShareOptions = {}): ShareAppViewResult {
    if (this.registry.requireView(sessionId, appId, viewId).view.kind !== "web") throw new Error("Only web views have preview links.");
    if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
    const duration = options.duration === undefined ? undefined : SHARE_DURATIONS.find((row) => row.id === options.duration);
    if (options.duration !== undefined && !duration) throw new Error(`A share link lasts ${SHARE_DURATIONS.map((row) => row.id).join(", ")}.`);
    return this.gateway.share(viewId, { ...(duration ? { ttl: duration.ms } : {}), controls: options.controls !== false });
  }
  /** `bivy app share`: mints a share link for a web view picked by app and/or
   * view ID or name, like `present` (default: the one opened last). */
  shareView(sessionId: string, input: { app?: string; view?: string } & ShareOptions): ShareAppViewResult & { appId: string; viewId: string; app: string; view: string } {
    const entry = this.pickTarget(sessionId, input);
    return { ...this.share(sessionId, entry.app.id, entry.view.id, input), appId: entry.app.id, viewId: entry.view.id, app: entry.app.name, view: entry.view.name };
  }
  clearNotes(sessionId: string, appId: string, viewId: string): { ok: true } {
    this.registry.requireView(sessionId, appId, viewId);
    this.registry.clearNotes(viewId);
    return { ok: true };
  }
  /** The owner's choice (never the agent's): may agents read this app's notes? */
  setAgentNotes(sessionId: string, appId: string, enabled: boolean): { ok: true } {
    this.registry.setAgentNotes(sessionId, appId, enabled);
    return { ok: true };
  }
  /** `bivy app notes`: reviewer notes for an agent, only on apps whose owner
   * allowed it. Picked like `bivy app share`. Untrusted text, and labelled so. */
  notes(sessionId: string, input: { app?: string; view?: string; since?: number }): { app: string; view: string; appId: string; viewId: string; untrusted: true; notes: ReviewerNote[] } {
    const entry = this.pickTarget(sessionId, input);
    if (!this.registry.agentNotes(entry.app.id)) throw new Error(`Reviewer notes on ${entry.app.name} are private to its owner. They can allow agents to read them in Apps → ${entry.app.name} → ⋯ → Agents can read notes.`);
    const since = typeof input.since === "number" && Number.isFinite(input.since) ? input.since : 0;
    return { app: entry.app.name, view: entry.view.name, appId: entry.app.id, viewId: entry.view.id, untrusted: true, notes: structuredClone((entry.notes ?? []).filter((note) => note.at > since)) };
  }
  /** An app and/or view by ID or name (`bivy app share`, `bivy app notes`); by default the view opened last. */
  private pickTarget(sessionId: string, input: { app?: string; view?: string }): RegisteredView {
    if (!input.view) return this.pickView(sessionId, input.app);
    const wantedApp = input.app?.trim().toLowerCase();
    const scope = this.webViews(sessionId).filter((candidate) => !wantedApp || candidate.app.id === wantedApp || candidate.app.name.toLowerCase() === wantedApp);
    if (wantedApp && !scope.length) throw new Error(`No app called "${input.app}" with web views in this session. Run bivy app list to see them.`);
    const wanted = input.view.trim().toLowerCase();
    const found = scope.find((candidate) => candidate.view.id === wanted) ?? scope.find((candidate) => candidate.view.name.toLowerCase() === wanted);
    if (!found) throw new Error(`No web view called "${input.view}"${input.app ? ` in "${input.app}"` : ""}. Run bivy app list to see them.`);
    return found;
  }
  /** Ends a view's share links and what people opened with them; the owner's previews and the app stay. */
  unshare(sessionId: string, appId: string, viewId: string): { ok: true } {
    this.registry.requireView(sessionId, appId, viewId);
    this.gateway?.unshare?.(viewId);
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
    this.backend.forget(app.views.map((view) => view.id), app.id);
    for (const view of app.views) {
      this.gateway?.revoke(view.id);
      this.stopServer(view.id);
      const pending = this.terminalStarts.get(view.id);
      this.terminalStarts.delete(view.id);
      if (pending) void pending.then((id) => this.terminals.close(id)).catch(() => {});
    }
  }
}
