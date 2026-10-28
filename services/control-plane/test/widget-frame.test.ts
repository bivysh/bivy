// SPDX-License-Identifier: MIT
// The chat widget frame runs agent-written HTML, so its own response must put
// it in an opaque origin with no network, whoever frames or opens it — and must
// replace, not add to, the app's headers that would stop the app framing it.
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import fs from "node:fs";
import { serveWidgetFrame } from "../src/widget-frame.js";

const frame = fs.readFileSync(new URL("../../../packages/web/public/widget-frame.html", import.meta.url));

test("the real widget frame is served sandboxed without same-origin, offline, and frameable by the app", async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.get("/widget-frame.html", serveWidgetFrame(frame));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/widget-frame.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const policy = res.headers.get("content-security-policy") ?? "";
    const directives = Object.fromEntries(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    assert.ok(directives.sandbox?.includes("allow-scripts"));
    assert.ok(!directives.sandbox?.includes("allow-same-origin"), "an opaque origin, whoever opens it");
    assert.deepEqual(directives["connect-src"], ["'none'"]);
    assert.deepEqual(directives["form-action"], ["'none'"]);
    assert.equal(directives["frame-ancestors"], undefined);
    assert.equal(res.headers.get("x-frame-options"), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a frame page without its own policy is refused at boot", () => {
  assert.throws(() => serveWidgetFrame(Buffer.from("<!doctype html><title>frame</title>")), /must carry its Content-Security-Policy/);
});
