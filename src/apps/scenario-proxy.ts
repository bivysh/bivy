// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import https from "node:https";
import { once } from "node:events";
import { matchRule, type NetworkRule } from "./scenarios.js";

/** Marks a response Bivy made up for a scenario, not the app's API. */
export const SIMULATED = "x-bivy-simulated";

/** A scenario's network rule met a request: wait if it says so, then answer
 *  for the API, drop the connection ("offline"), or let the request through
 *  late (a delay alone). Returns whether the request was answered here. The
 *  preview gateway (web pages) and the API proxy (desktop apps) share it. */
export async function simulate(req: IncomingMessage, res: ServerResponse, rule: NetworkRule, headers: OutgoingHttpHeaders = {}): Promise<boolean> {
  if (rule.delayMs) {
    const gone = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { res.off("close", closed); resolve(false); }, rule.delayMs);
      const closed = () => { clearTimeout(timer); resolve(true); };
      res.once("close", closed);
    });
    if (gone) return true;
  }
  if (rule.offline) { req.socket.destroy(); return true; }
  if (rule.status === undefined && rule.json === undefined && rule.body === undefined) return false;
  const json = rule.json !== undefined;
  const body = Buffer.from(json ? JSON.stringify(rule.json) : rule.body ?? "");
  res.writeHead(rule.status ?? 200, { ...headers, "content-type": json ? "application/json" : "text/plain; charset=utf-8", "content-length": body.length, [SIMULATED]: "1" });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** A desktop app calls its API directly, so a scenario's network rules can't
 *  be applied in the preview. This proxy sits between them instead: the app is
 *  started with its API address pointed here (loopback only), matching
 *  requests are answered by the rules, and the rest go on to `target`. */
export async function startScenarioProxy(target: string, rules: NetworkRule[]): Promise<{ url: string; close(): void }> {
  const base = new URL(target);
  const client = base.protocol === "https:" ? https : http;
  // The app is given the target's path too, so its requests already carry it.
  const prefix = base.pathname.replace(/\/$/, "");
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url?.startsWith("/") ? req.url : "/";
      const rule = matchRule(rules, req.method, url);
      if (rule && await simulate(req, res, rule)) return;
      const headers = { ...req.headers, host: base.host };
      const upstream = client.request({ protocol: base.protocol, hostname: base.hostname, port: base.port, path: url, method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("The API isn't answering."); });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}${prefix}`, close: () => { server.close(); server.closeAllConnections(); } };
}
