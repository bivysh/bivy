// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import http, { type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { previewShell } from "./preview-shell.js";
import { inspectorScript } from "./inspector.js";
import type { AppRegistry, RegisteredView } from "./registry.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
};

const COOKIE = "__Host-bivy-preview";
const OPEN_PATH = "/__bivy/open";
const REDEEM_PATH = "/__bivy/redeem";
const REVISION_PATH = "/__bivy/revision";
const INSPECTOR_PATH = "/__bivy/inspector.js";
/** Larger HTML documents pass through without the inspector. */
const MAX_INJECT_BYTES = 5 * 1024 * 1024;

/** Put the inspector first in <head>, so it sees errors from the app's own scripts. */
function withInspector(html: Buffer): Buffer {
  const text = html.toString("utf8");
  const tag = `<script src="${INSPECTOR_PATH}"></script>`;
  const at = /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text);
  return Buffer.from(at ? text.slice(0, at.index + at[0].length) + tag + text.slice(at.index + at[0].length) : tag + text);
}

/** Let the inspector through an app's CSP by exact URL; other sources are unchanged. */
function allowInspector(policy: string, url: string): string {
  const directives = policy.split(";").map((d) => d.trim()).filter(Boolean);
  const find = (name: string) => directives.findIndex((d) => d.toLowerCase().split(/\s+/)[0] === name);
  const index = [find("script-src-elem"), find("script-src")].find((i) => i >= 0) ?? -1;
  const add = (directive: string) => directive.replace(/\s'none'/i, "") + " " + url;
  if (index >= 0) directives[index] = add(directives[index]);
  else {
    const fallback = find("default-src");
    if (fallback < 0) return policy;
    directives.push(add(directives[fallback].replace(/^default-src/i, "script-src")));
  }
  return directives.join("; ");
}
const HOUR = 60 * 60_000;
/** Marks gateway-generated "server not answering" responses, so recovery
 * polling can tell them apart from an app's own 502s. */
const UPSTREAM_DOWN = "x-bivy-upstream-down";

/** A top-level or framed page load. Browsers without Fetch Metadata still ask for HTML. */
function isPageLoad(req: IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  return req.method === "GET" && (dest ? ["document", "iframe"].includes(dest) : /text\/html/.test(req.headers.accept ?? ""));
}

/** Served on the app's origin in place of a blank frame. It reloads itself once
 * the server answers, and tells a framing shell so it can offer next steps. */
function upstreamDownPage(nonce: string, port: number, shellOrigin: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Waiting for the app server</title>
<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center}main{max-width:32rem}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;opacity:.75;line-height:1.5}</style>
<main><h1>Nothing is answering on port ${port}</h1><p role="status">The app server stopped or hasn’t started yet. This page reloads by itself when it’s back.</p></main>
<script nonce="${nonce}">const tell=state=>{if(parent!==window)parent.postMessage({type:'bivy:upstream',state,port:${port}},${JSON.stringify(shellOrigin)});};tell('down');
const poll=async()=>{try{const r=await fetch(location.href,{method:'HEAD',cache:'no-store'});if(!r.headers.has('${UPSTREAM_DOWN}')){tell('up');location.reload();return;}}catch{}setTimeout(poll,2000);};setTimeout(poll,2000);</script></html>`;
}
/** Copied links are reusable until revoked, capped so a forgotten one lapses. */
export const SHARE_TTL = 24 * HOUR;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Separate per-app origins are mandatory. TLS terminates at the deployment's
 * preview ingress. Delivery reaches only this gateway, never the node API. */
export function previewOriginTemplate(raw: string): string {
  const parsed = new URL(raw.replace("{app}", "a"));
  if (!/^https:\/\/\{app\}(?:-[a-f0-9]{24})?\.[a-z0-9.-]+\/?$/.test(raw) || raw.split("{app}").length !== 2 || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port) {
    throw new Error("BIVY_APPS_ORIGIN must be https://{app}.<dedicated-preview-domain> (no path or port).");
  }
  return raw.replace(/\/$/, "").toLowerCase();
}

function cleanHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const blocked = new Set([...HOP, ...(headers.connection ?? "").toLowerCase().split(",").map((s) => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key) && !key.startsWith("x-forwarded-") && key !== "forwarded"));
}
function upstreamHeaders(req: IncomingMessage, origin: string): OutgoingHttpHeaders {
  const headers = cleanHeaders(req.headers);
  // The preview credential is never disclosed to generated code/backends.
  headers.cookie = (req.headers.cookie ?? "").split(";").filter((part) => part.trim().split("=", 1)[0] !== COOKIE).join(";");
  headers.host = new URL(origin).host;
  headers["x-forwarded-host"] = headers.host;
  headers["x-forwarded-proto"] = "https";
  return headers;
}
function responseHeaders(headers: IncomingMessage["headers"], shellOrigin: string, inspector?: string): OutgoingHttpHeaders {
  const result = cleanHeaders(headers);
  if (headers["set-cookie"]) {
    result["set-cookie"] = headers["set-cookie"].filter((cookie) => cookie.split("=", 1)[0].trim() !== COOKIE)
      .map((cookie) => cookie.replace(/;\s*domain=[^;]*/ig, ""));
  }
  // Preview data must not become a shared proxy cache entry. Apps cannot frame
  // Bivy, retain an opener, or cache an offline service-worker copy of the gate.
  result["cache-control"] = "no-store";
  result["referrer-policy"] = "no-referrer";
  result["cross-origin-opener-policy"] = "same-origin";
  result["x-content-type-options"] = "nosniff";
  // The preview shell is the only allowed ancestor. Preserve the app's other
  // CSP directives, but replace framing restrictions with this narrower host.
  delete result["x-frame-options"];
  const csp = result["content-security-policy"];
  const policies = (Array.isArray(csp) ? csp : csp ? [String(csp)] : []).flatMap((policy) => policy.split(","))
    .map((policy) => policy.replace(/(^|;)\s*frame-ancestors[^;]*/gi, "$1"))
    .map((policy) => inspector ? allowInspector(policy, inspector) : policy);
  result["content-security-policy"] = [...policies, `frame-ancestors ${shellOrigin}; worker-src 'none'`].join(", ");
  return result;
}

export class AppGateway {
  readonly server: http.Server;
  private readonly template: string;
  private readonly tickets = new Map<string, { appId: string; expires: number; returnTo?: string; reusable?: boolean }>();
  private readonly styles = new Map([
    ["/__bivy/tokens.css", readFileSync(new URL("./tokens.css", import.meta.url))],
    ["/__bivy/styles.css", readFileSync(new URL("./styles.css", import.meta.url))],
  ]);
  private readonly sessions = new Map<string, { appId: string; expires: number }>();
  private readonly sockets = new Map<string, Set<Duplex>>();

  constructor(private readonly registry: AppRegistry, originTemplate: string, private readonly returnOrigins: () => readonly string[] = () => []) {
    this.template = previewOriginTemplate(originTemplate);
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end("Preview request failed."); }); });
    this.server.maxConnections = 256;
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 60_000;
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
  }

  origin(id: string): string { return this.template.replace("{app}", id); }
  shellOrigin(id: string): string { return this.template.replace("{app}", `view-${id}`); }
  open(id: string, returnTo?: string): string {
    const entry = this.requireWeb(id);
    if (returnTo) {
      const url = new URL(returnTo);
      const safeScheme = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
      if (!this.returnOrigins().includes(url.origin)) throw new Error("Return-to-chat origin is not configured on this machine. Set BIVY_APPS_RETURN_ORIGINS for an additional Bivy client origin.");
      if (!safeScheme || url.username || url.password || url.search || url.hash || url.pathname !== `/sessions/${encodeURIComponent(entry.app.sessionId)}`) throw new Error("Invalid return-to-chat URL.");
      returnTo = url.href;
    }
    // Fragment never reaches reverse-proxy access logs or the application.
    return `${this.shellOrigin(id)}${OPEN_PATH}#${this.grant({ appId: id, expires: Date.now() + 60_000, returnTo })}`;
  }
  /** A reusable link straight to the app origin (no shell frame), so it opens
   * in any browser and can be inspected. Valid until revoked or SHARE_TTL. */
  share(id: string): { url: string; expiresAt: number } {
    this.requireWeb(id);
    const expiresAt = Date.now() + SHARE_TTL;
    return { url: `${this.origin(id)}${OPEN_PATH}#${this.grant({ appId: id, expires: expiresAt, reusable: true })}`, expiresAt };
  }
  revoke(id: string): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, grant] of map) if (grant.appId === id) map.delete(key);
    for (const socket of this.sockets.get(id) ?? []) socket.destroy();
    this.sockets.delete(id);
  }
  close(): void {
    for (const id of this.sockets.keys()) this.revoke(id);
    this.tickets.clear(); this.sessions.clear();
    this.server.close();
    this.server.closeAllConnections();
  }
  private requireWeb(id: string): RegisteredView {
    const entry = this.registry.getView(id);
    if (entry?.view.kind !== "web") throw new Error("Web view not found.");
    return entry;
  }
  private grant(grant: { appId: string; expires: number; returnTo?: string; reusable?: boolean }): string {
    this.sweep();
    if (this.tickets.size >= 500 || this.sessions.size >= 500) throw new Error("Too many preview grants. Try again later.");
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, grant);
    return ticket;
  }
  private sweep(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, grant] of map) if (grant.expires <= Date.now()) map.delete(key);
  }
  private entry(req: IncomingMessage): RegisteredView | undefined {
    const host = req.headers.host ?? "";
    const id = /^([a-f0-9]{32})(?:[.-])/.exec(host)?.[1];
    if (!id || host !== new URL(this.origin(id)).host) return undefined;
    const entry = this.registry.getView(id);
    return entry?.view.kind === "web" ? entry : undefined;
  }
  private authorize(req: IncomingMessage, id: string): number | undefined {
    this.sweep();
    const token = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token && this.sessions.get(token);
    return session && session.appId === id ? session.expires : undefined;
  }
  private track(id: string, socket: Duplex, expires: number): void {
    let sockets = this.sockets.get(id);
    if (!sockets) { sockets = new Set(); this.sockets.set(id, sockets); }
    if (sockets.has(socket)) return;
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), Math.max(1, expires - Date.now()));
    timer.unref();
    socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); if (!sockets.size) this.sockets.delete(id); });
  }
  private async handleShell(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const origin = this.shellOrigin(id);
    const nonce = randomBytes(16).toString("hex");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src 'self' ${this.origin(id)}; frame-src ${this.origin(id)}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (req.method === "GET" && this.styles.has(req.url ?? "")) {
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.end(this.styles.get(req.url!)); return;
    }
    if (req.url === OPEN_PATH && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(previewShell(nonce)); return;
    }
    if (req.url === "/__bivy/launch" && req.method === "POST") {
      if (req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
      let ticket = "";
      for await (const chunk of req) { ticket += chunk.toString(); if (ticket.length > 128) { res.writeHead(413); res.end(); return; } }
      this.sweep();
      const grant = this.tickets.get(ticket);
      const entry = this.registry.getView(id);
      if (!grant || grant.appId !== id || !entry) { res.writeHead(401); res.end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: entry.app.name, origin: this.origin(id), returnTo: grant.returnTo })); return;
    }
    res.writeHead(404); res.end("Preview shell route not found.");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry = this.entry(req);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const shellId = /^view-([a-f0-9]{32})(?:[.-])/.exec(req.headers.host ?? "")?.[1];
    if (shellId && req.headers.host === new URL(this.shellOrigin(shellId)).host) { await this.handleShell(req, res, shellId); return; }
    if (!entry) { res.writeHead(404); res.end("App unavailable. Republish from your Bivy session."); return; }
    const id = entry.view.id;
    if (req.url === OPEN_PATH && req.method === "GET") {
      const nonce = randomBytes(16).toString("hex");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors ${this.shellOrigin(id)}; base-uri 'none'`);
      res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Open Bivy preview</title><p id="status" role="status">Opening preview…</p><script nonce="${nonce}">const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch('${REDEEM_PATH}',{method:'POST',headers:{'Content-Type':'text/plain'},body:ticket}).then(r=>{if(!r.ok)throw Error();location.replace('/');}).catch(()=>{document.getElementById('status').textContent='Preview link expired or cookies are blocked. Open a new link from Bivy.';});</script></html>`);
      return;
    }
    if (req.url === REDEEM_PATH && req.method === "POST") {
      if (req.headers.origin !== this.origin(id)) { res.writeHead(403); res.end(); return; }
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (body.length > 128) { res.writeHead(413); res.end(); return; } }
      this.sweep();
      const grant = this.tickets.get(body);
      if (!grant || grant.appId !== id || this.sessions.size >= 500) { res.writeHead(401); res.end(); return; }
      if (!grant.reusable) this.tickets.delete(body);
      // A browser session never outlives the link that created it.
      const expires = Math.min(Date.now() + HOUR, grant.expires);
      const token = randomBytes(32).toString("hex");
      this.sessions.set(token, { appId: id, expires });
      res.setHeader("Set-Cookie", `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((expires - Date.now()) / 1000))}`);
      res.writeHead(204); res.end(); return;
    }
    const expires = this.authorize(req, id);
    if (!expires) { res.writeHead(401); res.end("Preview access expired. Open a new preview link from Bivy."); return; }
    // Block cross-site mutations even if a client sends the preview cookie.
    if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers.origin !== this.origin(id)) { res.writeHead(403); res.end("Forbidden origin."); return; }
    if (req.headers["sec-fetch-dest"] === "serviceworker") { res.writeHead(403); res.end(); return; }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { res.writeHead(400); res.end(); return; }
    this.track(id, req.socket, expires);
    if (req.url.startsWith(`${REVISION_PATH}?`) && req.method === "GET") { this.revision(req, res, entry); return; }
    if (req.url === INSPECTOR_PATH && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(inspectorScript(this.shellOrigin(id))); return;
    }
    const inspect = isPageLoad(req);
    // Remember the framed page so a turn reload lands where the user was.
    if (req.method === "GET" && req.headers["sec-fetch-dest"] === "iframe" && req.url.length <= 2048) entry.lastPath = req.url;
    if (entry.target.kind === "static") {
      if (!["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
      let file: string;
      try { file = decodeURIComponent(req.url.split("?")[0]); } catch { res.writeHead(400); res.end(); return; }
      if (file.endsWith("/")) file += "index.html";
      let data = entry.target.files.get(file);
      let status = 200;
      // Client-side routes: an extensionless page load falls back like common
      // static hosts do — to 404.html (status 404) when present, else index.html.
      if (!data && !path.extname(file) && isPageLoad(req)) {
        const notFound = entry.target.files.get("/404.html");
        file = notFound ? "/404.html" : "/index.html";
        data = notFound ?? entry.target.files.get(file);
        if (notFound) status = 404;
      }
      if (!data) { res.writeHead(404); res.end("File not found."); return; }
      const headers = responseHeaders({}, this.shellOrigin(id));
      headers["content-type"] = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      if (inspect && path.extname(file).toLowerCase() === ".html" && data.length <= MAX_INJECT_BYTES) data = withInspector(data);
      res.writeHead(status, { ...headers, "content-length": data.length });
      res.end(req.method === "HEAD" ? undefined : data); return;
    }
    if (entry.target.kind !== "service") { res.writeHead(404); res.end(); return; }
    const port = entry.target.port;
    const forward = upstreamHeaders(req, this.origin(id));
    // Uncompressed HTML so the inspector can be added to page loads.
    if (inspect) forward["accept-encoding"] = "identity";
    const upstream = http.request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: forward }, (response) => {
      response.on("error", () => res.destroy());
      const html = inspect && /^text\/html/i.test(response.headers["content-type"] ?? "") && !response.headers["content-encoding"] && Number(response.headers["content-length"] ?? 0) <= MAX_INJECT_BYTES;
      if (!html) {
        res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers, this.shellOrigin(id)));
        response.pipe(res); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_INJECT_BYTES) { response.destroy(); res.destroy(); return; } chunks.push(chunk); });
      response.on("end", () => {
        const body = withInspector(Buffer.concat(chunks));
        const headers = responseHeaders(response.headers, this.shellOrigin(id), `${this.origin(id)}${INSPECTOR_PATH}`);
        delete headers["content-length"];
        res.writeHead(response.statusCode ?? 200, { ...headers, "content-length": body.length });
        res.end(body);
      });
    });
    upstream.setTimeout(60_000, () => upstream.destroy(new Error("Preview timed out")));
    upstream.on("error", () => {
      if (res.headersSent) { res.destroy(); return; }
      if (!isPageLoad(req)) { res.writeHead(502, { "content-type": "text/plain", [UPSTREAM_DOWN]: "1" }); res.end("App server unavailable. Start it on the registered port, then reload."); return; }
      const nonce = randomBytes(16).toString("hex");
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", [UPSTREAM_DOWN]: "1", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors ${this.shellOrigin(id)}; base-uri 'none'` });
      res.end(upstreamDownPage(nonce, port, this.shellOrigin(id)));
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }
  /** Long poll from the trusted shell (same-site, credentialed CORS): answers
   * when the view's revision differs from `after`, or after 25 seconds. */
  private revision(req: IncomingMessage, res: ServerResponse, entry: RegisteredView): void {
    const id = entry.view.id;
    const after = Number(new URL(req.url!, "http://gateway").searchParams.get("after"));
    let timer: NodeJS.Timeout | undefined;
    const onRevision = (viewId: string) => { if (viewId === id) send(); };
    const cleanup = () => { clearTimeout(timer); this.registry.off("revision", onRevision); };
    const send = () => {
      cleanup();
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": this.shellOrigin(id), "access-control-allow-credentials": "true", vary: "Origin" });
      res.end(JSON.stringify({ revision: entry.revision, path: entry.lastPath ?? "/" }));
    };
    if (entry.revision !== after) { send(); return; }
    this.registry.on("revision", onRevision);
    timer = setTimeout(send, 25_000);
    res.on("close", cleanup);
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const entry = this.entry(req);
    const expires = entry && this.authorize(req, entry.view.id);
    if (!entry || !expires || entry.target.kind !== "service" || req.headers.origin !== this.origin(entry.view.id) || req.headers.upgrade?.toLowerCase() !== "websocket" || !req.url?.startsWith("/") || req.url.startsWith("//")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    this.track(entry.view.id, socket, expires);
    const port = entry.target.port;
    const upstream = http.request({ hostname: "127.0.0.1", port, path: req.url, headers: { ...upstreamHeaders(req, this.origin(entry.view.id)), connection: "Upgrade", upgrade: "websocket" } });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      peer.setTimeout(0);
      this.track(entry.view.id, peer, expires);
      const headers = cleanHeaders(response.headers);
      delete headers["set-cookie"];
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries(headers).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on("response", (response) => { response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.end();
  }
}
