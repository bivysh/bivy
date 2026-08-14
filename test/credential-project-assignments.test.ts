// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setProviderApiKeyLabeled } from "../src/credentials/api.js";
import { NodeCredentialResolver, projectIdsFromWorkspace } from "../src/credentials/resolver.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-project-creds-"));
const credsDir = path.join(root, "credentials");
await setProviderApiKeyLabeled(credsDir, "anthropic", "personal", "personal-key");
await setProviderApiKeyLabeled(credsDir, "anthropic", "work", "work-key");
fs.writeFileSync(path.join(root, "credentials.config.json"), JSON.stringify({
  presets: {
    default: { anthropic: "personal" },
    "project:acme/service": { anthropic: "work" },
  },
}));

const resolver = new NodeCredentialResolver(
  credsDir,
  { resolve: async () => undefined },
  { refresh: async () => undefined },
);

assert.deepEqual(projectIdsFromWorkspace("/srv/repos/acme__service/.bivy/worktrees/task"), [
  "/srv/repos/acme__service/.bivy/worktrees/task",
  "task",
  "acme/service",
]);
assert.equal((await resolver.getCredential("anthropic"))?.token, "personal-key", "account default applies without a project");
assert.equal(
  (await resolver.getCredential("anthropic", { workspace: "/srv/repos/acme__service/.bivy/worktrees/task" }))?.token,
  "work-key",
  "managed workspace resolves its owner/repo project assignment",
);
assert.equal(
  (await resolver.getCredential("anthropic", { project: "acme/service" }))?.token,
  "work-key",
  "an explicit project id resolves the same assignment",
);

fs.rmSync(root, { recursive: true, force: true });
console.log("credential-project-assignments: all tests passed");
