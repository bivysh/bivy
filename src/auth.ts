// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";
import type { NodeIdentity } from "./identity.js";

/**
 * Bearer-token auth for the node API and WebSocket.
 *
 * Model:
 * - Remote callers (relay, paired devices) MUST present a valid device token.
 * - Loopback callers (the CLI and direct-mode web client on the same machine) may bypass auth when
 *   `allowLoopback` is true (default). Set BIVY_REQUIRE_LOCAL_AUTH=1 to force
 *   token auth even on loopback.
 */

export interface AuthContext {
  deviceId: string | null;
  loopback: boolean;
}

function loopbackAllowed() {
  return process.env.BIVY_REQUIRE_LOCAL_AUTH !== "1";
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export function extractToken(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}

/**
 * Pull a token from an HTTP request: Authorization header first, then the
 * `access_token` query param (used by WebSocket upgrades where headers are
 * awkward to set from browsers).
 */
export function tokenFromRequest(req: IncomingMessage): string | null {
  const header = extractToken(req.headers["authorization"] as string | undefined);
  if (header) return header;
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("access_token");
  } catch {
    return null;
  }
}

/** Resolve auth for any incoming request (HTTP or WS upgrade). */
export function resolveAuth(identity: NodeIdentity, req: IncomingMessage): AuthContext {
  const loopback = loopbackAllowed() && isLoopbackAddress(req.socket?.remoteAddress);
  const deviceId = identity.verifyToken(tokenFromRequest(req));
  return { deviceId, loopback };
}

export function isAuthorized(ctx: AuthContext): boolean {
  return ctx.deviceId !== null || ctx.loopback;
}

/**
 * Cross-origin / DNS-rebinding guard for the node's actionable surface (/api,
 * /ws). The daemon runs shell and edits files, and by default it authorizes any
 * loopback caller without a token — so without this guard, (a) any web page the
 * user visits could open a cross-origin WebSocket to ws://localhost:4317/ws and
 * drive the agent, and (b) DNS rebinding (attacker domain → 127.0.0.1) would
 * defeat the browser's same-origin protections entirely.
 *
 * Direct inbound connections to the node are only ever local/LAN: a direct-mode
 * web client (?local=1), a LAN device browsing the node directly, or CLI/native
 * clients (no Origin).
 * Remote phones reach the node through the relay, which the node dials
 * *outbound* — those never arrive here as inbound upgrades. So we allow only
 * local/private hostnames and reject a public Host (rebinding) or public Origin
 * (cross-site). Escape hatches: BIVY_ALLOWED_HOSTS (comma-separated extra
 * hostnames, e.g. a reverse-proxy domain) and BIVY_ALLOW_ANY_ORIGIN=1.
 */
function hostnameIsLocal(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/^::ffff:/, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".ts.net") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;                       // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale)
    return false;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local IPv6
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local IPv6
  return false;
}

/** Extract the hostname from a `Host`/`Origin`-style `host[:port]` value. */
function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1); // [::1]:4317 → [::1]
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1)) ? trimmed.slice(0, colon) : trimmed;
}

function allowedExtraHosts(): Set<string> {
  return new Set(
    (process.env.BIVY_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * True when a request may touch the actionable surface. Rejects a public Host
 * header (DNS rebinding) or a public browser Origin (cross-site). Requests with
 * no Origin (CLI/native/curl) are allowed through the Host check only.
 */
export function requestOriginAllowed(req: IncomingMessage): boolean {
  if (process.env.BIVY_ALLOW_ANY_ORIGIN === "1") return true;
  const extra = allowedExtraHosts();
  const ok = (hostname: string | null | undefined): boolean =>
    !!hostname && (hostnameIsLocal(hostname) || extra.has(hostname.toLowerCase()));

  const hostHeader = req.headers["host"];
  if (typeof hostHeader === "string") {
    const host = hostnameOf(hostHeader);
    if (host && !ok(host)) return false;
  }

  const originHeader = req.headers["origin"];
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin && origin !== "null") {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (!ok(originHost)) return false;
  }
  return true;
}

/** Express middleware enforcing auth on /api routes. */
export function authMiddleware(identity: NodeIdentity) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!requestOriginAllowed(req)) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }
    const ctx = resolveAuth(identity, req);
    if (!isAuthorized(ctx)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as Request & { auth: AuthContext }).auth = ctx;
    next();
  };
}
