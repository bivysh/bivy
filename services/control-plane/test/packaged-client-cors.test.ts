// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { packagedClientCors } from "../src/packaged-client-cors.js";

for (const value of ["*", "null", "https://*.example", "http://example", "https://example/", "https://a:b@example", "capacitor://localhost/path"]) {
  test(`invalid packaged origin fails startup: ${value}`, () => {
    assert.throws(() => packagedClientCors(value));
  });
}

test("native CORS permits exact origin/preflight but retains route authorization", async () => {
  const app = express();
  app.use(packagedClientCors("capacitor://localhost,https://client.example"));
  app.post("/protected", (req, res) => {
    if (req.get("authorization") !== "Bearer test-only") return void res.status(401).json({ error: "Unauthorized" });
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/protected`;
  try {
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "capacitor://localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, Content-Type" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "capacitor://localhost");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    assert.match(preflight.headers.get("vary")!, /Origin/);
    for (const [method, header] of [["TRACE", "authorization"], ["POST", "x-arbitrary-header"]]) {
      const response = await fetch(url, { method: "OPTIONS", headers: { Origin: "capacitor://localhost", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": header } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    for (const origin of ["null", "capacitor://attacker", "https://client.example.attacker", "https://attacker.example"]) {
      const response = await fetch(url, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const unauthorized = await fetch(url, { method: "POST", headers: { Origin: "capacitor://localhost" } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "capacitor://localhost");
    const authorized = await fetch(url, { method: "POST", headers: { Origin: "capacitor://localhost", Authorization: "Bearer test-only" } });
    assert.equal(authorized.status, 200);
    const ordinary = await fetch(url, { method: "POST" });
    assert.equal(ordinary.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("unconfigured CORS leaves ordinary deployments unchanged", () => {
  let passed = false;
  packagedClientCors("")({} as never, {} as never, () => { passed = true; });
  assert.equal(passed, true);
});
