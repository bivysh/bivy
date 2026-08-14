// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { openOAuthLoginOnNode } from "../src/runtime/oauth/oauth-node-open.js";

let opened = "";
const opener = (url: string) => { opened = url; return true; };

assert.deepEqual(openOAuthLoginOnNode(undefined, opener), { opened: false, error: "Login is no longer waiting for authorization." });
assert.deepEqual(
  openOAuthLoginOnNode({ provider: "anthropic", status: "done", authUrl: "https://claude.ai/oauth/authorize" }, opener),
  { opened: false, error: "Login is no longer waiting for authorization." },
);
assert.equal(
  openOAuthLoginOnNode({ provider: "anthropic", status: "waiting", authUrl: "https://evil.example/steal" }, opener).opened,
  false,
  "a remote client cannot turn the command into an arbitrary URL opener",
);
assert.equal(opened, "");
const result = openOAuthLoginOnNode({
  provider: "anthropic",
  status: "waiting",
  authUrl: "https://claude.ai/oauth/authorize?client_id=test&state=opaque",
}, opener);
assert.deepEqual(result, { opened: true });
assert.match(opened, /^https:\/\/claude\.ai\/oauth\/authorize\?/);

assert.deepEqual(
  openOAuthLoginOnNode({ provider: "openai-codex", status: "waiting", authUrl: "https://auth.openai.com/oauth/authorize?state=x" }, () => false),
  { opened: false, error: "This machine cannot open a graphical browser." },
);

console.log("oauth-node-open: all tests passed");
