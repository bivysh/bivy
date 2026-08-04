// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — network effect boundary (egress broker).
//
// Third pillar of "govern the substrate, not the agent". Almost every CLI agent
// (and the tools it spawns) honors the conventional HTTP_PROXY / HTTPS_PROXY /
// ALL_PROXY environment variables, so a single local proxy the daemon injects
// into the agent's env sees — and can allow/deny/log — all of its outbound
// network traffic, with zero agent-specific code.
//
// It handles both proxy modes:
//   * plain HTTP   → an ordinary forward proxy (absolute-URI requests),
//   * HTTPS/TLS    → the CONNECT method (we see host:port and tunnel bytes; TLS
//                    stays end-to-end so we log the destination, not content).
//
// Per the locked decision this ships as observe-and-log first (default allow),
// but the decider can deny by host now (e.g. block a data-exfil domain). Pure
// networking, unit-tested in test/harness-net-proxy.test.ts.

import http from "node:http";
import net from "node:net";

export interface NetDecision {
  allow: boolean;
  reason?: string;
}

/** Consulted before any outbound connection. `port` is the destination port. */
export type NetDecider = (host: string, port: number) => NetDecision | Promise<NetDecision>;

/** Allow every destination (the proxy's default — pure observe-and-log). */
export const allowAllDecider: NetDecider = () => ({ allow: true });

/**
 * Deny every destination. Used for a per-session egress proxy that enforces the
 * `read-only` sandbox tier's "no network" contract for agents whose own sandbox
 * doesn't (see egress.ts). Node-local traffic never reaches here — the proxy env's
 * NO_PROXY exempts localhost — so the agent can still reach the daemon's own MCP/API.
 */
export function denyAllDecider(reason = "read-only sandbox: outbound network is disabled"): NetDecider {
  return () => ({ allow: false, reason });
}

/**
 * Allow only hosts in `hosts` (exact, or a subdomain of a listed apex — "api.x.com"
 * matches an entry "x.com"), denying everything else. The building block for a
 * per-workflow egress allowlist that never touches the node-global decider. Host
 * matching is case-insensitive; an empty list denies all.
 */
export function allowlistDecider(hosts: string[], reason = "not on this session's egress allowlist"): NetDecider {
  const allow = new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  return (host: string) => {
    const h = host.trim().toLowerCase();
    for (const entry of allow) {
      if (h === entry || h.endsWith(`.${entry}`)) return { allow: true };
    }
    return { allow: false, reason };
  };
}

export type NetEvent =
  | { type: "http"; host: string; port: number; method: string; url: string; allowed: boolean; reason?: string }
  | { type: "connect"; host: string; port: number; allowed: boolean; reason?: string };

export interface EgressProxyOptions {
  /** Default allow-all when omitted (pure logging). */
  decide?: NetDecider;
  onEvent?: (event: NetEvent) => void;
}

/** Split "host:port" (CONNECT target) into parts, defaulting the port. */
export function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  // IPv6 literal like [::1]:443
  const m = /^\[([^\]]+)\]:?(\d+)?$/.exec(authority);
  if (m) return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
  const idx = authority.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(authority.slice(idx + 1))) {
    return { host: authority.slice(0, idx), port: Number(authority.slice(idx + 1)) };
  }
  return { host: authority, port: defaultPort };
}

/**
 * A running egress proxy. Construct via `EgressProxy.start()`; inject its
 * `env()` into an agent subprocess so all its traffic flows through it.
 */
export class EgressProxy {
  private constructor(
    private readonly server: http.Server,
    readonly port: number,
    readonly host: string,
  ) {}

  static start(options: EgressProxyOptions = {}, listenHost = "127.0.0.1"): Promise<EgressProxy> {
    const decide: NetDecider = options.decide ?? (() => ({ allow: true }));
    const onEvent = options.onEvent ?? (() => {});

    const server = http.createServer((clientReq, clientRes) => {
      // Plain-HTTP forward proxy: the request line carries an absolute URI.
      let target: URL;
      try {
        target = new URL(clientReq.url ?? "");
      } catch {
        clientRes.writeHead(400).end("Bad proxy request");
        return;
      }
      const port = target.port ? Number(target.port) : 80;
      void Promise.resolve(decide(target.hostname, port)).then((decision) => {
        onEvent({ type: "http", host: target.hostname, port, method: clientReq.method ?? "GET", url: target.href, allowed: decision.allow, reason: decision.reason });
        if (!decision.allow) {
          clientRes.writeHead(403).end(decision.reason || "Blocked by Bivy egress policy");
          return;
        }
        const proxyReq = http.request(
          { hostname: target.hostname, port, path: `${target.pathname}${target.search}`, method: clientReq.method, headers: clientReq.headers },
          (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(clientRes);
          },
        );
        proxyReq.on("error", () => clientRes.writeHead(502).end("Upstream error"));
        clientReq.pipe(proxyReq);
      });
    });

    // HTTPS via CONNECT: we see host:port and tunnel raw bytes (TLS end-to-end).
    server.on("connect", (req, clientSocket, head) => {
      const { host, port } = parseHostPort(req.url ?? "", 443);
      void Promise.resolve(decide(host, port)).then((decision) => {
        onEvent({ type: "connect", host, port, allowed: decision.allow, reason: decision.reason });
        if (!decision.allow) {
          clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        const upstream = net.connect(port, host, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
      });
    });

    return new Promise((resolve) => {
      server.listen(0, listenHost, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(new EgressProxy(server, port, listenHost));
      });
    });
  }

  /** Proxy env to merge into an agent subprocess so its traffic is governed. */
  env(): Record<string, string> {
    const url = `http://${this.host}:${this.port}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      ALL_PROXY: url,
      // Never route node-local traffic (the daemon's own API, MCP proxy) through here.
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    };
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
