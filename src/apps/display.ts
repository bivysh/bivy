// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { FitWindowManager, writeXauthority } from "./x11.js";
import { MacDisplayHost } from "./macos-display.js";

/** Environment for programs on a preview display. X11 for every toolkit, so an
 * app never escapes to the machine's own Wayland/X session. */
const APP_ENV: Record<string, string> = {
  WAYLAND_DISPLAY: "",
  GDK_BACKEND: "x11",
  QT_QPA_PLATFORM: "xcb",
  SDL_VIDEODRIVER: "x11",
  ELECTRON_OZONE_PLATFORM_HINT: "x11",
  NO_AT_BRIDGE: "1",
};
/** How each toolkit is told to draw at 2× for a high-density viewer (Chromium
 * and Electron read the Xft.dpi the window manager publishes). */
const SCALE_ENV: Record<number, Record<string, string>> = {
  1: {},
  2: { GDK_SCALE: "2", QT_SCALE_FACTOR: "2", J2D_UISCALE: "2" },
};
export const DISPLAY_SCALES = Object.keys(SCALE_ENV).map(Number);
/** TigerVNC's X server; BIVY_XVNC overrides. */
const XVNC = ["Xtigervnc", "Xvnc"];
const START_MS = 10_000;

export function findXvnc(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BIVY_XVNC) return fs.existsSync(env.BIVY_XVNC) ? env.BIVY_XVNC : undefined;
  for (const name of XVNC) {
    try { return execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim() || undefined; } catch { /* next */ }
  }
  return undefined;
}

export interface Display {
  /** Private VNC socket (mode 0600) the gateway streams from. */
  socket: string;
  /** DISPLAY, XAUTHORITY and toolkit hints for programs shown on it. */
  env: Record<string, string>;
  wm: FitWindowManager;
  /** Device pixels per CSS pixel the display was started for. */
  scale: number;
}

interface Running { dir: string; child?: ChildProcess; ready?: Promise<Display> }

/** One private X display per view, started on demand: an Xvnc server that
 * listens on no TCP port, an authority cookie only its programs get, and a
 * window manager that fits windows to whatever size the viewer asks for. */
export class DisplayHost {
  private displays = new Map<string, Running & { ready: Promise<Display> }>();
  constructor(private readonly options: { xvnc?: () => string | undefined; platform?: NodeJS.Platform; x11Dir?: string } = {}) {}

  /** Why desktop views can't run here, or undefined when they can. */
  unavailable(): string | undefined {
    if ((this.options.platform ?? process.platform) !== "linux") return "Desktop app views need a Linux or macOS machine.";
    if (!(this.options.xvnc ?? findXvnc)()) return "Desktop app views need TigerVNC's X server. Install it (Debian/Ubuntu: sudo apt install tigervnc-standalone-server), or set BIVY_XVNC to its path.";
    return undefined;
  }
  running(id: string): Promise<Display> | undefined { return this.displays.get(id)?.ready; }

  /** `scale` (1 or 2) is fixed when the display starts: programs pick it up once. */
  ensure(id: string, name: string, scale = 1): Promise<Display> {
    const existing = this.displays.get(id);
    if (existing) return existing.ready;
    const state: Running = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-")) };
    state.ready = this.start(state, name, SCALE_ENV[scale] ? scale : 1).then((display) => {
      // If the X server dies, forget it: the next open starts a fresh one.
      state.child!.once("exit", () => { if (this.displays.get(id) === state) this.stop(id); });
      return display;
    }, (error) => { this.stop(id); throw error; });
    this.displays.set(id, state as Running & { ready: Promise<Display> });
    return state.ready;
  }

  private async start(state: Running, name: string, scale: number): Promise<Display> {
    const reason = this.unavailable();
    if (reason) throw new Error(reason);
    const xvnc = (this.options.xvnc ?? findXvnc)()!;
    const x11Dir = this.options.x11Dir ?? "/tmp/.X11-unix";
    const authority = path.join(state.dir, "Xauthority");
    const socket = path.join(state.dir, "vnc.sock");
    const cookie = writeXauthority(authority);
    // Another X server may take a number between our check and its lock.
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = freeDisplay(x11Dir);
      const child = spawn(xvnc, [`:${number}`, "-auth", authority, "-rfbunixpath", socket, "-rfbunixmode", "0600", "-rfbport", "-1",
        "-SecurityTypes", "None", "-AlwaysShared=1", "-AcceptSetDesktopSize=1", "-SendPrimary=0", "-nolisten", "tcp", "-geometry", `${1280 * scale}x${800 * scale}`, "-depth", "24", "-dpi", String(96 * scale), "-desktop", name.slice(0, 60)],
      { stdio: "ignore" });
      state.child = child;
      const x = path.join(x11Dir, `X${number}`);
      const up = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + START_MS;
        const exited = () => resolve(false);
        child.once("exit", exited);
        child.once("error", exited);
        const poll = () => {
          if (child.exitCode !== null) return;
          if (fs.existsSync(socket) && fs.existsSync(x)) { child.off("exit", exited); resolve(true); return; }
          if (Date.now() > deadline) { child.kill("SIGKILL"); return; }
          setTimeout(poll, 50);
        };
        poll();
      });
      if (!up) continue;
      const wm = new FitWindowManager();
      await wm.start(x, cookie, 96 * scale);
      return { socket, wm, scale, env: { ...APP_ENV, ...SCALE_ENV[scale], DISPLAY: `:${number}`, XAUTHORITY: authority } };
    }
    throw new Error("Couldn't start a display for this app.");
  }

  stop(id: string): void {
    const state = this.displays.get(id);
    if (!state) return;
    this.displays.delete(id);
    void state.ready.then((display) => display.wm.stop(), () => {});
    state.child?.kill("SIGTERM");
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
  stopAll(): void { for (const id of [...this.displays.keys()]) this.stop(id); }
}

function freeDisplay(x11Dir: string): number {
  for (let n = 100; n < 1000; n++) {
    if (!fs.existsSync(path.join(x11Dir, `X${n}`)) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error("No free X display number.");
}

/** How each platform gives a desktop app a preview display: a private X
 * server on Linux, the app's own windows on a Mac. Both serve VNC on a
 * private socket, so everything downstream is shared. */
const HOSTS: Partial<Record<NodeJS.Platform, (dataDir: string) => DisplayHost | MacDisplayHost>> = {
  darwin: (dataDir) => new MacDisplayHost({ cacheDir: path.join(dataDir, "bin") }),
};
export function createDisplayHost(dataDir: string, platform: NodeJS.Platform = process.platform): DisplayHost | MacDisplayHost {
  return HOSTS[platform]?.(dataDir) ?? new DisplayHost({ platform });
}
