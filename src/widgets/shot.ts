// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// `bivy widget shot`: let the agent that wrote a widget see it before the user
// does. The widget is rendered in the frame the app uses (widget-frame.html, so
// the same runtime, sandbox and base styles), inside a small stand-in for the
// chat that answers the protocol the way the app's host does, with the app's
// design tokens. Screenshots come from the browser that shoots app previews,
// and every error the widget reports comes back with them.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { RegisteredView } from "../apps/registry.js";
import { takeShots, type Shot } from "../apps/screenshot.js";
import { checkWidgetScripts } from "./check.js";

export interface WidgetShotRequest {
  html: string;
  data?: Record<string, unknown>;
  state?: unknown;
  widths?: number[];
  themes?: ("light" | "dark")[];
  /** Answer the widget's `bivy.call`; without it, calls are refused. */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface WidgetShotResult {
  shots: Array<{ width: number; theme: string; file: string }>;
  /** What the widget reported (uncaught errors, failed calls), in order, de-duplicated. */
  errors: string[];
  /** The height the widget asked for, at the last width shot. */
  height?: number;
  /** Why there are no screenshots, when there is no browser to take them. */
  note?: string;
}

function readAsset(relative: string): string {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** The chat stand-in: tokens on the root, a reading column, the frame, and a
 *  host that answers like packages/web/src/widgets/host.ts. */
function harnessHtml(tokens: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${tokens}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-sans)}
main{max-width:720px;margin:0 auto;padding:var(--space-4)}
iframe{display:block;width:100%;height:120px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}
</style></head><body><main><iframe id="frame" sandbox="allow-scripts allow-forms" src="widget-frame.html" title="Widget"></iframe></main>
<script>
const loaded = fetch("__params").then((res) => res.json());
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = dark ? "dark" : "light";
const frame = document.getElementById("frame");
const post = (msg) => frame.contentWindow.postMessage(msg, "*");
const report = (text) => fetch("__report", { method: "POST", body: String(text) });
const NAMES = ${JSON.stringify(["--bg", "--surface", "--surface-2", "--surface-3", "--ink", "--muted", "--line", "--line-strong", "--accent", "--accent-hover", "--accent-soft", "--accent-contrast", "--focus-ring", "--ok", "--danger", "--danger-soft", "--unseen", "--merged", "--info", "--warn", "--warn-soft", "--font-sans", "--font-mono", "--font-serif", "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl", "--lh-sm", "--lh-base", "--lh-md", "--weight-normal", "--weight-medium", "--weight-semibold", "--weight-bold", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full", "--shadow-sm", "--shadow-md", "--shadow-lg"])};
const computed = getComputedStyle(document.documentElement);
const variables = Object.fromEntries(NAMES.map((n) => [n, computed.getPropertyValue(n).trim()]).filter(([, v]) => v));
let initialized = false;
addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data;
  if (!m || m.jsonrpc !== "2.0") return;
  const params = await loaded;
  if (m.method === "ui/notifications/sandbox-proxy-ready") return post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: params.html } });
  if (m.method === "ui/notifications/size-changed") { frame.style.height = Math.min(Math.max(40, m.params.height), 720) + "px"; fetch("__height", { method: "POST", body: String(m.params.height) }); return; }
  if (m.method === "notifications/message" && m.params && m.params.level === "error") return report(m.params.data);
  if (m.method === "ui/notifications/initialized") {
    if (initialized) return;
    initialized = true;
    post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: params.data } });
    post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify(params.data) }], structuredContent: params.data } });
    return;
  }
  if (m.id === undefined) return;
  const reply = (result) => post({ jsonrpc: "2.0", id: m.id, result });
  const refuse = (message) => post({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } });
  if (m.method === "ui/initialize") return reply({ protocolVersion: "2026-01-26", hostInfo: { name: "Bivy", version: "1" }, hostCapabilities: { openLinks: {}, logging: {}, serverTools: {}, experimental: { bivy: { state: true } } }, hostContext: { theme: dark ? "dark" : "light", displayMode: "inline", platform: innerWidth < 600 ? "mobile" : "web", styles: { variables }, bivy: { data: params.data, state: params.state } } });
  if (m.method === "tools/call") {
    const res = await fetch("__tool", { method: "POST", body: JSON.stringify(m.params) });
    const body = await res.json();
    if (!res.ok) { report("bivy.call(" + JSON.stringify(m.params.name) + ") failed: " + body.error); return refuse(body.error); }
    return reply(body.result);
  }
  // Sending, links, state and display modes do nothing in a screenshot.
  if (["ui/message", "ui/open-link", "bivy/state/set", "ui/update-model-context", "ping"].includes(m.method)) return reply({});
  if (m.method === "ui/request-display-mode") return reply({ mode: "inline" });
  post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Bivy does not support " + m.method } });
});
</script></body></html>`;
}

export async function shootWidget(request: WidgetShotRequest, outDir: string, take: typeof takeShots = takeShots): Promise<WidgetShotResult> {
  const frame = readAsset("./widget-frame.html");
  const tokens = readAsset("../apps/tokens.css");
  // Checked without a browser first, so a page whose script cannot parse is
  // caught on every machine.
  const errors: string[] = checkWidgetScripts(request.html);
  let height: number | undefined;
  const harness = harnessHtml(tokens);
  const params = JSON.stringify({ html: request.html, data: request.data ?? {}, state: request.state ?? {} });
  // Everything is served under an unguessable prefix: /__tool runs plugin tools
  // as this user, and loopback alone doesn't keep out other local users or a
  // web page probing ports while the shot runs.
  const base = `/${randomBytes(16).toString("hex")}/`;
  const server = http.createServer((req, res) => {
    const full = (req.url ?? "/").split("?")[0]!;
    if (!full.startsWith(base)) return void res.writeHead(404).end();
    const url = `/${full.slice(base.length)}`;
    const body: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { if (body.reduce((n, b) => n + b.length, 0) < 64 * 1024) body.push(chunk); });
    req.on("end", () => {
      const text = Buffer.concat(body).toString("utf8");
      if (url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(harness);
      if (url === "/__params") return res.writeHead(200, { "content-type": "application/json" }).end(params);
      if (url === "/widget-frame.html") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts allow-forms" }).end(frame);
      if (url === "/__report" && req.method === "POST") {
        if (!errors.includes(text) && errors.length < 20) errors.push(text);
        return res.writeHead(204).end();
      }
      if (url === "/__height" && req.method === "POST") {
        height = Number(text) || height;
        return res.writeHead(204).end();
      }
      if (url === "/__tool" && req.method === "POST") {
        const call = (() => { try { return JSON.parse(text) as { name?: string; arguments?: Record<string, unknown> }; } catch { return {}; } })();
        const run = request.callTool
          ? request.callTool(String(call.name ?? ""), call.arguments ?? {})
          : Promise.reject(new Error("Tools are not available here."));
        void run.then(
          (result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result })),
          (error: unknown) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    // A stand-in for a published view: the shooter only reads its id, name and target.
    const view = { view: { id: "widget00", name: "Widget" }, target: { kind: "service", port } } as unknown as RegisteredView;
    let shots: Shot[];
    try {
      shots = await take([view], { widths: request.widths ?? [390, 1024], themes: request.themes ?? ["light", "dark"], path: base, settleMs: 1500 }, outDir);
    } catch (error) {
      if (!/No Chrome or Chromium/.test((error as Error).message)) throw error;
      return { shots: [], errors, note: "No Chrome or Chromium on this machine, so there are no screenshots; its scripts were checked. Set BIVY_CHROME to a browser to see it." };
    }
    return { shots: shots.map(({ width, theme, file }) => ({ width, theme, file })), errors, ...(height ? { height } : {}) };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Where a session's widget shots go. */
export function widgetShotDir(sessionId: string): string {
  return path.join(os.tmpdir(), "bivy-shots", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"), `widget-${Date.now()}`);
}
