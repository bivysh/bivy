// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import type { RegisteredView } from "./registry.js";
import { captureFrame, encodePng } from "./rfb.js";

export interface ShotRequest { widths: number[]; themes: ("light" | "dark")[]; path: string }
/** Desktop apps are shot as they are on screen: `theme` is "native" for them. */
export interface Shot { viewId: string; view: string; width: number; theme: "light" | "dark" | "native"; file: string }

/** Browsers tried in order; BIVY_CHROME overrides. Any Chromium works. */
const CANDIDATES = [
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BIVY_CHROME) return fs.existsSync(env.BIVY_CHROME) ? env.BIVY_CHROME : undefined;
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith("/")) { if (fs.existsSync(candidate)) return candidate; continue; }
    try { return execFileSync("which", [candidate], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { /* next */ }
  }
  // A Playwright install (common on dev machines) ships a headless shell.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    for (const bin of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome"]) {
      const file = path.join(cache, dir, bin);
      if (dir.startsWith("chromium") && fs.existsSync(file)) return file;
    }
  }
  return undefined;
}

/** Serves a static snapshot on loopback for the duration of a shot. */
async function serveSnapshot(files: Map<string, Buffer>): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (file.endsWith("/")) file += "index.html";
    const data = files.get(file) ?? (path.extname(file) ? undefined : files.get("/index.html"));
    if (!data) { res.writeHead(404); res.end(); return; }
    res.end(data);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.close(); server.closeAllConnections(); } };
}

/** Minimal CDP client over one browser-level WebSocket (flattened sessions). */
class Cdp {
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        const call = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) call?.reject(new Error(msg.error.message)); else call?.resolve(msg.result);
      } else for (const fn of this.listeners) fn(msg.method, msg.params, msg.sessionId);
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  once(method: string, sessionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const fn = (m: string, _p: unknown, s?: string) => { if (m === method && s === sessionId) finish(); };
      const finish = () => { clearTimeout(timer); this.listeners.delete(fn); resolve(); };
      const timer = setTimeout(finish, ms);
      this.listeners.add(fn);
    });
  }
}

/** Screenshots web views with one headless browser, one shot at a time, so
 * small machines cope. Service views are loaded straight from loopback;
 * static views from a throwaway loopback server. Desktop apps are read from
 * their display, at its current size, without a browser. Files are PNGs in `outDir`. */
export async function takeShots(views: RegisteredView[], request: ShotRequest, outDir: string, chrome = findChrome()): Promise<Shot[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  for (const entry of views) {
    if (entry.target.kind !== "display" || !entry.display) continue;
    const frame = await captureFrame(entry.display);
    const file = path.join(outDir, `${entry.view.id.slice(0, 8)}-${frame.width}-native.png`);
    fs.writeFileSync(file, encodePng(frame.width, frame.height, frame.rgb));
    shots.push({ viewId: entry.view.id, view: entry.view.name, width: frame.width, theme: "native", file });
  }
  views = views.filter((entry) => entry.target.kind === "service" || entry.target.kind === "static");
  if (!views.length) return shots;
  if (!chrome) throw new Error("No Chrome or Chromium found on this machine. Install one, or set BIVY_CHROME to its path.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-shot-"));
  const servers: { close: () => void }[] = [];
  let ws: WebSocket | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  const deadline = setTimeout(() => browser?.kill("SIGKILL"), 120_000);
  // Chromium's sandbox is unavailable as root and where AppArmor blocks user
  // namespaces (Ubuntu 23.10+). The pages are the session's own apps, already
  // running as this user, so retrying without it doesn't widen what they can do.
  const launch = (sandbox: boolean) => new Promise<string>((resolve, reject) => {
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", ...(sandbox ? [] : ["--no-sandbox"]), "about:blank"];
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    browser = child;
    let text = "";
    const timer = setTimeout(() => reject(new Error("The browser didn't start in time.")), 20_000);
    child.stderr!.on("data", (chunk) => { text += chunk; const m = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (m) { clearTimeout(timer); resolve(m[1]!); } });
    child.once("exit", () => { clearTimeout(timer); reject(Object.assign(new Error("The browser exited before it was ready."), { noSandbox: /No usable sandbox|--no-sandbox/i.test(text) })); });
  });
  try {
    const endpoint = await launch(process.getuid?.() !== 0).catch((error: Error & { noSandbox?: boolean }) => {
      if (error.noSandbox) return launch(false);
      throw error;
    });
    ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await once(ws, "open");
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    for (const entry of views) {
      let origin: string;
      if (entry.target.kind === "service") origin = `http://127.0.0.1:${entry.target.port}`;
      else if (entry.target.kind === "static") { const server = await serveSnapshot(entry.target.files); servers.push(server); origin = server.origin; }
      else continue;
      for (const width of request.widths) for (const theme of request.themes) {
        const mobile = width < 600;
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 800, deviceScaleFactor: mobile ? 2 : 1, mobile }, sessionId);
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
        const loaded = cdp.once("Page.loadEventFired", sessionId, 15_000);
        await cdp.send("Page.navigate", { url: origin + request.path }, sessionId);
        await loaded;
        await new Promise((r) => setTimeout(r, 400)); // let fonts and first effects settle
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        const file = path.join(outDir, `${entry.view.id.slice(0, 8)}-${width}-${theme}.png`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        shots.push({ viewId: entry.view.id, view: entry.view.name, width, theme, file });
      }
    }
    return shots;
  } finally {
    clearTimeout(deadline);
    ws?.terminate();
    for (const server of servers) server.close();
    // Wait for the browser to exit before removing its profile: a killed
    // Chrome can still be writing into it. Cleanup never fails a shot.
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, "exit").catch(() => {});
      browser.kill("SIGKILL");
      await exited;
    }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir; the OS reclaims it */ }
  }
}
