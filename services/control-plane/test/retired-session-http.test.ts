// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
const port = await new Promise<number>((resolve) => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1", () => { const address = listener.address() as net.AddressInfo; listener.close(() => resolve(address.port)); });
});
const child = spawnTestService(fileURLToPath(new URL("../", import.meta.url)), { PORT: String(port), BIND_HOST: "127.0.0.1", NODE_ENV: "test", RELAY_SECRET: "test-retired", DISABLE_DEV_LOGIN: "0" });
const base = `http://127.0.0.1:${port}`;
const call = (url: string, method = "GET", token?: string, body?: unknown) => fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await call("/healthz")).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready);
  const a = (await (await call("/auth/dev-login", "POST", undefined, { email: "retired-http@example.com" })).json()).token;
  const b = (await (await call("/auth/dev-login", "POST", undefined, { email: "other-http@example.com" })).json()).token;
  const path = "/session-correlation/session-retired";
  assert.equal((await call(path, "DELETE")).status, 401);
  assert.equal((await call(path, "PUT", a, { nodeId: "eph-retired", provider: "fly" })).status, 200);
  assert.equal((await call(path, "DELETE", b)).status, 204);
  assert.equal((await (await call("/session-correlation", "GET", a)).json()).correlations.length, 1);
  const enrollment = await (await call("/nodes/enroll", "POST", a, { nodeId: "eph-retired", name: "Tear" })).json();
  await call("/node/heartbeat", "POST", enrollment.enrollmentToken, {});
  assert.equal((await call(path, "DELETE", a)).status, 409, "live nodes must use live session deletion");
  // Unenroll as teardown does, then account-side deletion no longer needs the node.
  assert.equal((await call("/nodes/eph-retired", "DELETE", a)).status, 200);
  assert.equal((await call(path, "DELETE", a)).status, 204);
  assert.equal((await call(path, "DELETE", a)).status, 204);
  assert.equal((await (await call("/session-correlation", "GET", a)).json()).correlations.length, 0);
  assert.equal((await call(path, "PUT", a, { nodeId: "eph-retired", provider: "fly" })).status, 410);
  console.log("retired-session-http: authentication, isolation, live-node guard, deletion and resurrection guard passed");
} finally { await stopTestServices([child]); }
