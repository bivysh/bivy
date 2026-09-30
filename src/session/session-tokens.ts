// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session tokens: a credential each agent session gets in its environment
 * ($BIVY_SESSION_TOKEN, via bivySessionEnv) that reaches only that session's
 * own routes. They let `bivy attach`, `notify`, `ask`, `app` and the MCP tools
 * work where the loopback bypass doesn't apply (multi-user hosts,
 * BIVY_REQUIRE_LOCAL_AUTH) and where the agent can't read the node's data dir to
 * mint a device token (sandboxed agents), without handing it the node.
 *
 * A token is `bst_<session id, base64url>.<HMAC-SHA256>` under a key that lives
 * only in the daemon's memory, so it needs no storage and stops working when
 * the daemon restarts (along with the agent processes that held it).
 */
const PREFIX = "bst_";

export interface SessionTokenCodec {
  sign(sessionId: string): string;
  /** The session a token speaks for, or undefined if it isn't one of ours. */
  verify(token: string | null | undefined): string | undefined;
}

export function isSessionToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith(PREFIX);
}

export function createSessionTokenCodec(key: Buffer = randomBytes(32)): SessionTokenCodec {
  const mac = (id: string) => createHmac("sha256", key).update(`bivy-session-token:${id}`).digest("base64url");
  return {
    sign(sessionId) {
      return `${PREFIX}${Buffer.from(sessionId).toString("base64url")}.${mac(sessionId)}`;
    },
    verify(token) {
      if (!isSessionToken(token)) return undefined;
      const [encoded, signature] = token!.slice(PREFIX.length).split(".");
      if (!encoded || !signature) return undefined;
      const sessionId = Buffer.from(encoded, "base64url").toString();
      const expected = Buffer.from(mac(sessionId));
      const given = Buffer.from(signature);
      return sessionId && given.length === expected.length && timingSafeEqual(given, expected) ? sessionId : undefined;
    },
  };
}

/**
 * What a session token may call: its own session's agent-facing routes, and
 * the read-only machine list `bivy delegate machines` needs. `session` says
 * where the request names its session (a path segment or body.sessionId); it
 * must be the token's own. Adding a route is adding a row.
 */
export const SESSION_TOKEN_ROUTES: readonly { method: "GET" | "POST"; path: RegExp; session: "path" | "body" | "none" }[] = [
  { method: "GET", path: /^\/api\/session\/([^/]+)\/context$/, session: "path" },
  { method: "POST", path: /^\/api\/session\/([^/]+)\/(attach|suggest|notify)$/, session: "path" },
  { method: "POST", path: /^\/api\/session\/([^/]+)\/ask$/, session: "path" },
  { method: "GET", path: /^\/api\/session\/([^/]+)\/ask\/[^/]+$/, session: "path" },
  { method: "POST", path: /^\/api\/session\/([^/]+)\/ask\/[^/]+\/wait$/, session: "path" },
  { method: "POST", path: /^\/api\/session\/([^/]+)\/delegated-runs$/, session: "path" },
  { method: "GET", path: /^\/api\/session\/([^/]+)\/delegated-runs\/[^/]+$/, session: "path" },
  { method: "POST", path: /^\/api\/session\/([^/]+)\/delegated-runs\/[^/]+\/wait$/, session: "path" },
  { method: "POST", path: /^\/api\/apps\/[a-zA-Z]+$/, session: "body" },
  { method: "POST", path: /^\/api\/session\/fork$/, session: "body" },
  { method: "GET", path: /^\/api\/machines$/, session: "none" },
];

/** Whether a request made with `sessionId`'s token is one it may make. */
export function sessionTokenAllows(sessionId: string, req: { method: string; path: string; body?: unknown }): boolean {
  for (const route of SESSION_TOKEN_ROUTES) {
    if (route.method !== req.method) continue;
    const match = route.path.exec(req.path);
    if (!match) continue;
    if (route.session === "none") return true;
    const named = route.session === "path"
      ? decodeURIComponent(match[1] ?? "")
      : (req.body as { sessionId?: unknown } | undefined)?.sessionId;
    return named === sessionId;
  }
  return false;
}
