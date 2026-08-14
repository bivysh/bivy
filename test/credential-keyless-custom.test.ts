// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setProviderCredential } from "../src/credentials/api.js";
import { NodeCredentialResolver, buildAgentCredentialEnv } from "../src/credentials/resolver.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-keyless-custom-"));
try {
  await setProviderCredential(root, "local-lab", { env: { OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" } });
  const resolver = new NodeCredentialResolver(
    root,
    { resolve: async () => undefined },
    { refresh: async () => undefined },
  );

  const credential = await resolver.getCredential("local-lab");
  assert.equal(credential?.token, "local", "keyless endpoints receive a harmless compatibility token");
  assert.deepEqual(
    await buildAgentCredentialEnv(resolver, ["local-lab"], "local-lab"),
    {
      LOCAL_LAB_API_KEY: "local",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      OPENAI_API_KEY: "local",
    },
    "the active custom endpoint reaches non-Pi agents without requiring a real secret",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("credential-keyless-custom: all tests passed");
