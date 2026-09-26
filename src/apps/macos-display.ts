// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";

/** The helper's source ships next to this module; it is compiled on this Mac on first use. */
const SOURCE = fileURLToPath(new URL("./macos-display.swift", import.meta.url));
const START_MS = 10_000;
const BUILD_MS = 5 * 60_000;
/** Darwin 22 is macOS 13, the first with everything the helper uses. */
const MIN_DARWIN = 22;
/** What each missing permission is called in System Settings. */
const PERMISSIONS = { screenRecording: "Screen Recording", accessibility: "Accessibility" } as const;
type Permissions = Record<keyof typeof PERMISSIONS, boolean>;

export interface MacDisplay {
  socket: string;
  /** Marks the app's processes, so the helper knows which windows are its. */
  env: Record<string, string>;
  /** The app starts through the helper, which stays its parent: signed apps
   * hide their environment, so their windows are traced to it instead. */
  launch: string[];
  /** The app's windows on screen, as the helper last reported. */
  wm: { count: number };
  scale: number;
}
interface Running { dir: string; child?: ChildProcess; ready: Promise<MacDisplay> }

/** Desktop views on macOS. There are no private displays on a Mac, so each
 * view gets a helper that serves its app's own windows as a VNC display on a
 * private socket (see macos-display.swift): the same contract as an Xvnc
 * display, so the viewer, relay, screenshots and input are shared. */
export class MacDisplayHost {
  private displays = new Map<string, Running>();
  private build?: Promise<string>;
  private checked?: { at: number; missing: string | undefined };
  private prompted = false;
  constructor(private readonly options: { cacheDir: string; platform?: NodeJS.Platform; release?: string; source?: string; swiftc?: () => boolean }) {}

  private compiled?: string;

  private get source(): string { return this.options.source ?? SOURCE; }
  private binary(): string {
    this.compiled ??= path.join(this.options.cacheDir, `macos-display-${createHash("sha256").update(fs.readFileSync(this.source)).digest("hex").slice(0, 16)}`);
    return this.compiled;
  }

  /** Why desktop views can't run here, or undefined when they can. */
  unavailable(): string | undefined {
    if ((this.options.platform ?? process.platform) !== "darwin") return "This display host runs on macOS only.";
    if (Number((this.options.release ?? os.release()).split(".")[0]) < MIN_DARWIN) return "Desktop app views need macOS 13 or later.";
    const binary = this.binary();
    if (fs.existsSync(binary)) return this.missing(binary);
    if (!(this.options.swiftc ?? hasSwiftc)()) return "Desktop app views on macOS need Apple's command line tools to build their helper. Install them with: xcode-select --install";
    void this.helper().catch(() => {}); // build ahead of the first open
    return undefined;
  }

  /** Permissions the helper lacks, as a message; checked at most every few seconds. */
  private missing(binary: string): string | undefined {
    if (this.checked && Date.now() - this.checked.at < 5_000) return this.checked.missing;
    let missing: string | undefined;
    try {
      const granted = JSON.parse(execFileSync(binary, ["check"], { encoding: "utf8", timeout: 5_000 })) as Permissions;
      const lacking = (Object.keys(PERMISSIONS) as (keyof Permissions)[]).filter((key) => !granted[key]).map((key) => PERMISSIONS[key]);
      if (lacking.length) {
        missing = `Desktop app views on macOS need ${lacking.join(" and ")} permission. In System Settings → Privacy & Security, allow ${lacking.join(" and ")} for the program that runs Bivy (your terminal app, or ${process.execPath} when Bivy runs in the background), then restart Bivy.`;
      }
    } catch { missing = "Couldn't run Bivy's macOS display helper."; }
    this.checked = { at: Date.now(), missing };
    return missing;
  }

  /** The compiled helper: built once per version of its source, then reused. */
  helper(): Promise<string> {
    const binary = this.binary();
    if (fs.existsSync(binary)) return Promise.resolve(binary);
    this.build ??= new Promise<string>((resolve, reject) => {
      fs.mkdirSync(this.options.cacheDir, { recursive: true, mode: 0o700 });
      const temp = `${binary}.${process.pid}.tmp`;
      execFile("xcrun", ["swiftc", "-O", "-swift-version", "5", this.source, "-o", temp], { timeout: BUILD_MS }, (error, _stdout, stderr) => {
        if (error) { fs.rmSync(temp, { force: true }); reject(new Error(`Couldn't build Bivy's macOS display helper: ${String(stderr).trim().split("\n").at(-1) ?? error.message}`)); return; }
        fs.renameSync(temp, binary);
        for (const old of fs.readdirSync(this.options.cacheDir)) if (old.startsWith("macos-display-") && path.join(this.options.cacheDir, old) !== binary) fs.rmSync(path.join(this.options.cacheDir, old), { force: true });
        resolve(binary);
      });
    }).finally(() => { this.build = undefined; });
    return this.build;
  }

  running(id: string): Promise<MacDisplay> | undefined { return this.displays.get(id)?.ready; }

  /** `scale` (1 or 2) is the pixel density frames are captured at. */
  ensure(id: string, _name: string, scale = 1): Promise<MacDisplay> {
    const existing = this.displays.get(id);
    if (existing) return existing.ready;
    const state = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-")) } as Running;
    state.ready = this.start(state, scale === 2 ? 2 : 1).then((display) => {
      state.child!.once("exit", () => { if (this.displays.get(id) === state) this.stop(id); });
      return display;
    }, (error) => { this.stop(id); throw error; });
    this.displays.set(id, state);
    return state.ready;
  }

  private async start(state: Running, scale: number): Promise<MacDisplay> {
    const reason = this.unavailable();
    if (reason) throw new Error(reason);
    const binary = await this.helper();
    const missing = this.missing(binary);
    if (missing) {
      // Once per run, let macOS ask: it lists the program in System Settings.
      if (!this.prompted) { this.prompted = true; execFile(binary, ["check", "--prompt"], () => {}); }
      throw new Error(missing);
    }
    const socket = path.join(state.dir, "vnc.sock");
    const token = randomBytes(16).toString("hex");
    const child = spawn(binary, ["serve", socket, token, String(scale)], { stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    const wm = { count: 0 };
    let errors = "";
    child.stderr!.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); console.warn(`[apps] macOS display: ${String(chunk).trim()}`); });
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, START_MS);
      child.once("exit", () => { clearTimeout(timer); resolve(false); });
      child.once("error", () => { clearTimeout(timer); resolve(false); });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (line === "ready") { clearTimeout(timer); resolve(true); }
        const windows = /^windows (\d+)$/.exec(line);
        if (windows) wm.count = Number(windows[1]);
      });
    });
    if (!up) throw new Error(`Couldn't start a display for this app.${errors ? ` ${errors.trim().split("\n").at(-1)}` : ""}`);
    return { socket, wm, scale, env: { BIVY_MAC_DISPLAY: token }, launch: [binary, "run", "--"] };
  }

  stop(id: string): void {
    const state = this.displays.get(id);
    if (!state) return;
    this.displays.delete(id);
    state.child?.kill("SIGTERM");
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
  stopAll(): void { for (const id of [...this.displays.keys()]) this.stop(id); }
}

let swiftc: boolean | undefined;
function hasSwiftc(): boolean {
  if (swiftc === undefined) {
    try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore", timeout: 10_000 }); swiftc = true; } catch { swiftc = false; }
  }
  return swiftc;
}
