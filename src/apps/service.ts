// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppManifest, AppOffer, OpenAppViewResult, SessionApp, SessionAppOffersResult, SessionAppsResult, ShareAppViewResult } from "./types.js";
import { AppRegistry, type RegisteredView } from "./registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanListeners } from "./listeners.js";
import { takeShots, type Shot, type ShotRequest } from "./screenshot.js";

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
  ensure(id: string, name: string): Promise<{ socket: string; env: Record<string, string>; wm: { count: number } }>;
  stop(id: string): void;
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
  constructor(readonly registry: AppRegistry, readonly gateway: AppPreviewProvider | undefined, private readonly terminals: AppTerminalProvider, options: {
    scan?: (workspace: string) => Promise<AppOffer[]>; serverWatchMs?: number;
    /** Agent screenshots are a node setting, off by default. */
    screenshots?: { enabled: () => boolean; take?: typeof takeShots };
    displays?: AppDisplayProvider;
  } = {}) {
    this.scan = options.scan ?? scanListeners;
    this.serverWatchMs = options.serverWatchMs ?? 5_000;
    this.screenshots = { enabled: options.screenshots?.enabled ?? (() => false), take: options.screenshots?.take ?? takeShots };
    this.displays = options.displays ?? NO_DISPLAYS;
  }

  list(sessionId: string): SessionAppsResult {
    const available = Boolean(this.gateway) && this.gateway?.available !== false;
    const apps = this.registry.list(sessionId);
    for (const app of apps) for (const view of app.views) {
      if (view.kind !== "web") continue;
      if (available) view.address = this.gateway?.address?.(view.id);
      const notes = this.registry.getView(view.id)?.notes;
      if (notes?.length) view.notes = structuredClone(notes);
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
    if (bumped.length && this.screenshots.enabled()) setTimeout(() => void this.capture(bumped), COMPARE_SETTLE_MS).unref?.();
    return bumped;
  }
  /** One phone-width shot per view of the page last viewed, kept for Compare. */
  async capture(viewIds: string[]): Promise<void> {
    for (const id of viewIds) {
      const entry = this.registry.getView(id);
      if (!entry || entry.view.kind !== "web") continue;
      const outDir = path.join(os.tmpdir(), "bivy-shots", "compare", id);
      const run = this.shooting.catch(() => {}).then(() => this.screenshots.take([entry], { widths: [390], themes: ["light"], path: entry.lastPath ?? "/" }, outDir));
      this.shooting = run;
      try {
        const [shot] = await run;
        if (!shot) continue;
        const png = fs.readFileSync(shot.file);
        fs.rmSync(outDir, { recursive: true, force: true });
        entry.shots = [...(entry.shots ?? []), { revision: entry.revision, at: Date.now(), png }].slice(-COMPARE_KEEP);
      } catch { /* a failed shot just leaves Compare without this turn */ }
    }
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
  async open(sessionId: string, appId: string, viewId: string, returnTo?: string, direct = false): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    if (entry.view.kind === "web") {
      if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
      if (direct && !this.gateway.openDirect) throw new Error("This machine can't open previews directly.");
      const url = direct ? this.gateway.openDirect!(viewId) : this.gateway.open(viewId, returnTo);
      // Don't wait for a managed server to boot: the preview shows it starting
      // and reloads itself once it answers.
      if (this.servers.get(viewId)) this.servers.get(viewId)!.restarts = [];
      void this.ensureServer(entry).catch(() => {});
      // Compare needs a "before": take a baseline the first time it's opened.
      if (!entry.shots?.length && this.screenshots.enabled()) setTimeout(() => void this.capture([viewId]), COMPARE_SETTLE_MS).unref?.();
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
    const display = await this.displays.ensure(entry.view.id, entry.app.name);
    for (const until = Date.now() + WINDOW_WAIT_MS; !display.wm.count && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800)); // first paint
  }
  /** The program Bivy runs for a view: a service's start command, or a desktop
   * app on its display (started first). */
  private program(entry: RegisteredView): { command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> } | Promise<{ command: string; args: string[]; workspace: string; name: string; env?: Record<string, string> }> {
    const target = entry.target;
    if (target.kind === "service" && target.start) return { ...target.start, name: `${entry.app.name} · ${entry.view.name} server` };
    if (target.kind !== "display") throw new Error("This view has no program.");
    return this.displays.ensure(entry.view.id, entry.app.name).then((display) => {
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
