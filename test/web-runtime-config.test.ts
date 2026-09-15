// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { webRuntimeConfigScript } from "../services/control-plane/src/web-runtime-config.js";
import { runtimeBoolean } from "../packages/web/src/runtime-config.js";

test("runtime script exposes only a boolean opt-in, with the server kill switch dominant", () => {
  for (const ui of [undefined, "", "0", "true", "1", "</script>"]) {
    for (const server of [undefined, "0", "1"]) {
      const context: Record<string, unknown> = {};
      const script = webRuntimeConfigScript({ VITE_EPHEMERAL_MACHINES_ENABLED: ui, EPHEMERAL_MACHINES_ENABLED: server, RELAY_SECRET: "must-not-leak" });
      runInNewContext(script, context);
      const config = context.__BIVY_RUNTIME_CONFIG__ as Record<string, unknown>;
      assert.deepEqual(Object.keys(config), ["ephemeralMachinesEnabled"]);
      assert.equal(config.ephemeralMachinesEnabled, ui === "1" && server !== "0");
      assert.ok(!script.includes("must-not-leak"));
    }
  }
});

test("runtime booleans override either build default, including explicit disable", () => {
  for (const fallback of [false, true]) {
    for (const value of [true, false, "1", "true", null, undefined, 1]) {
      assert.equal(runtimeBoolean("ephemeralMachinesEnabled", fallback, { ephemeralMachinesEnabled: value }), value === true);
    }
    for (const config of [undefined, null, {}]) {
      assert.equal(runtimeBoolean("ephemeralMachinesEnabled", fallback, config), fallback);
    }
  }
});

test("runtime script bypasses static assets and offline precaching under the existing CSP", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const server = read("../services/control-plane/src/index.ts");
  assert.match(server, /app.get\("\/runtime-config.js",[\s\S]*?noStorePwaShell\(res\);[\s\S]*?res.type\("application\/javascript"\).send\(webRuntimeConfigScript\(\)\)/);
  assert.ok(server.indexOf('app.get("/runtime-config.js"') < server.indexOf("express.static(reactAppDir"));
  assert.match(server, /Cache-Control", "no-store, max-age=0"/);
  assert.match(read("../packages/web/vite.config.ts"), /globIgnores: \["\*\*\/runtime-config.js"\]/);
  assert.match(read("../packages/web/index.html"), /<script src="\/runtime-config.js"><\/script>\s*<script type="module"/);
  assert.doesNotMatch(read("../.github/workflows/service-images.yml"), /tag_suffix|--build-arg "VITE_EPHEMERAL/);
});
