// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// The web app a node serves on its direct listener: the chat widget frame must
// arrive sandboxed there too, since it runs agent-written pages.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { webAppRouter } from "../src/web-app.js";

test("the direct listener serves the widget frame with the sandbox directive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-web-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>app</title>");
  fs.copyFileSync(new URL("../packages/web/public/widget-frame.html", import.meta.url), path.join(dir, "widget-frame.html"));
  const app = express();
  app.use(webAppRouter([dir])!);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/widget-frame.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms");
    assert.match(await res.text(), /http-equiv="Content-Security-Policy" content="[^"]*connect-src 'none'/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
