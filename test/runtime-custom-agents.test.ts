import assert from "node:assert/strict";
import { listRuntimes, makeRuntime } from "../src/runtime/index.js";

const previous = process.env.BIVY_CUSTOM_AGENTS;

try {
  process.env.BIVY_CUSTOM_AGENTS = JSON.stringify([
    { id: "my-codex", label: "My Codex", extends: "codex", command: "node", args: ["--version"] },
    { id: "Bad id", extends: "codex", command: "node" },
    { id: "missing-base", extends: "not-real", command: "node" },
  ]);

  const custom = listRuntimes().find((runtime) => runtime.id === "my-codex");
  assert.ok(custom, "valid custom agent should appear in the runtime picker");
  assert.equal(custom.displayName, "My Codex");
  assert.equal(custom.supportTier, "experimental");
  assert.equal(custom.certification, "unverified");
  assert.equal(listRuntimes().some((runtime) => runtime.id === "missing-base"), false);

  const runtime = makeRuntime({ runtime: "my-codex", credsDir: "/tmp/bivy-custom-agent-test" });
  assert.equal(runtime.id, "my-codex");
  console.log("ok custom agents: picker registration, validation, and runtime construction");
} finally {
  if (previous === undefined) delete process.env.BIVY_CUSTOM_AGENTS;
  else process.env.BIVY_CUSTOM_AGENTS = previous;
}
