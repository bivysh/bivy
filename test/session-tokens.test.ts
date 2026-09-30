// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Session tokens: an agent's credential for its own session's routes only.
import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { authMiddleware } from "../src/auth.js";
import type { NodeIdentity } from "../src/identity.js";
import { createSessionTokenCodec, isSessionToken, sessionTokenAllows } from "../src/session/session-tokens.js";

test("a token names its session, and only this daemon's key accepts it", () => {
  const codec = createSessionTokenCodec();
  const token = codec.sign("s-1");
  assert.equal(codec.verify(token), "s-1");
  assert.equal(codec.verify(`${token.slice(0, -2)}xx`), undefined, "a tampered signature");
  assert.equal(codec.verify(token.replace(Buffer.from("s-1").toString("base64url"), Buffer.from("s-2").toString("base64url"))), undefined, "another session's id under this signature");
  assert.equal(createSessionTokenCodec().verify(token), undefined, "after a restart (new key)");
  assert.equal(codec.verify("some-device-token"), undefined);
});

test("a session token reaches its own session's routes and nothing else", () => {
  assert.ok(sessionTokenAllows("s-1", { method: "POST", path: "/api/session/s-1/notify" }));
  assert.ok(sessionTokenAllows("s-1", { method: "POST", path: "/api/session/s-1/ask/q/wait" }));
  assert.ok(sessionTokenAllows("s-1", { method: "POST", path: "/api/apps/present", body: { sessionId: "s-1" } }));
  assert.ok(sessionTokenAllows("s-1", { method: "GET", path: "/api/machines" }));
  assert.ok(!sessionTokenAllows("s-1", { method: "POST", path: "/api/session/s-2/notify" }), "another session's route");
  assert.ok(!sessionTokenAllows("s-1", { method: "POST", path: "/api/apps/present", body: { sessionId: "s-2" } }), "another session in the body");
  assert.ok(!sessionTokenAllows("s-1", { method: "POST", path: "/api/session/prompt", body: { sessionId: "s-1" } }), "driving the session is not an agent route");
  assert.ok(!sessionTokenAllows("s-1", { method: "GET", path: "/api/sessions" }));
});

test("the middleware scopes a token-carrying request even where loopback needs no token", () => {
  const codec = createSessionTokenCodec();
  const used: string[] = [];
  const middleware = authMiddleware({ verifyToken: () => null } as unknown as NodeIdentity, {
    verify: codec.verify, claims: isSessionToken, allows: sessionTokenAllows, used: (id, call) => used.push(`${id} ${call.method} ${call.path}`),
  });
  const call = (token: string, method: string, path: string, body: unknown = {}) => {
    let status = 200;
    let nexted = false;
    const req = { method, baseUrl: "/api", path: path.slice(4), body, headers: { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as Request;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    middleware(req, res, (() => { nexted = true; }) as NextFunction);
    return { status: nexted ? 200 : status, auth: (req as Request & { auth?: { sessionId?: string } }).auth };
  };
  const token = codec.sign("s-1");
  const allowed = call(token, "POST", "/api/session/s-1/notify");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.auth?.sessionId, "s-1");
  assert.deepEqual(used, ["s-1 POST /api/session/s-1/notify"]);
  assert.equal(call(token, "GET", "/api/sessions").status, 403);
  assert.equal(call("bst_bogus.sig", "POST", "/api/session/s-1/notify").status, 401);
});
