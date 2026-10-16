import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRuntimes, makeRuntime } from "../src/runtime/index.js";

const previous = process.env.BIVY_DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-custom-agents-"));
const writeConfig = (agents: string) => fs.writeFileSync(path.join(dataDir, "config.yaml"), `version: 1\nagents:\n${agents}`);

try {
  process.env.BIVY_DATA_DIR = dataDir;
  writeConfig(`
  my-codex: { label: My Codex, extends: codex, command: node, args: [--version] }
  missing-base: { extends: not-real, command: node }
  prototype-base: { extends: constructor, command: node }
  pi: { label: Config must not win, extends: codex, command: node }
  claude: { label: Alias must not win, extends: codex, command: node }
`);

  const custom = listRuntimes().find((runtime) => runtime.id === "my-codex");
  assert.ok(custom, "valid custom agent should appear in the runtime picker");
  assert.equal(custom.displayName, "My Codex");
  assert.equal(custom.supportTier, "experimental");
  assert.equal(custom.certification, "unverified");
  assert.equal(custom.capabilities.sessionDiscovery, false, "custom commands do not inherit Codex host behavior");
  assert.deepEqual(custom.source, { kind: "config" });
  assert.equal(listRuntimes().some((runtime) => runtime.id === "missing-base"), false);
  assert.equal(listRuntimes().some((runtime) => runtime.id === "prototype-base"), false);
  const piSource = listRuntimes().find((runtime) => runtime.id === "pi")?.source;
  assert.equal(piSource?.kind, "package");
  assert.equal(piSource?.kind === "package" ? piSource.packageId : "", "bivy-agent-integrations");
  assert.equal(listRuntimes().some((runtime) => runtime.id === "claude"), false);

  const runtime = makeRuntime({ runtime: "my-codex", credsDir: "/tmp/bivy-custom-agent-test" });
  assert.equal(runtime.id, "my-codex");

  // An adapter entry saved while the node runs is in the picker on the next listing.
  writeConfig(`
  my-acp: { name: My ACP, adapter: { kind: acp, command: node, args: [agent.mjs] } }
`);
  const acp = listRuntimes().find((runtime) => runtime.id === "my-acp");
  assert.equal(acp?.displayName, "My ACP");
  assert.equal(acp?.executionMode, "protocol");
  assert.equal(acp?.capabilities.toolInterception, true);
  assert.equal(listRuntimes().some((runtime) => runtime.id === "my-codex"), false);
  console.log("ok custom agents: picker registration, validation, live config, and runtime construction");
} finally {
  if (previous === undefined) delete process.env.BIVY_DATA_DIR;
  else process.env.BIVY_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
