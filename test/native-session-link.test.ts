// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { nativeSessionLink } from "../packages/web/src/native-session-link.js";
const origin = "https://app.example";
assert.deepEqual(nativeSessionLink(`${origin}/sessions/abc-123?node=node_1`, origin), { path: "/sessions/abc-123", node: "node_1" });
assert.deepEqual(nativeSessionLink(`${origin}/runs/run_1`, origin), { path: "/runs/run_1", node: null });
for (const path of ["/auth/device/start", "/sessions/new", "/sessions/a/b", "/sessions/a?token=secret", "/sessions/a?node=a&node=b", "/sessions/a#secret", "/sessions/a?node=", "/sessions/a%2fb", "/runs/a?node=b"]) {
  assert.equal(nativeSessionLink(origin + path, origin), null, path);
}
for (const url of ["http://app.example/sessions/a", "https://evil.example/sessions/a", "https://app.example.evil/sessions/a", "https://user:pass@app.example/sessions/a", "javascript:alert(1)", "/sessions/a"]) {
  assert.equal(nativeSessionLink(url, origin), null, url);
}
console.log("native session links: accepted session/run hints; rejected unsafe origins, credentials and routing parameters");
