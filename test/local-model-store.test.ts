// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  listLocalProviderSummaries,
  loadLocalModels,
  toPiModelsConfig,
  upsertLocalProvider,
} from "../src/runtime/local-model-store.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-local-models-")); dirs.push(dir); return dir; }

describe("Machine-scoped local model registry", () => {
  it("retains Machine ownership through normalization and summaries", () => {
    const dir = tempDir();
    upsertLocalProvider(dir, "ollama-node-a", {
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      scope: "machine",
      machineId: "node-a",
      machineName: "Studio Mac",
      models: [{ id: "qwen" }],
    });
    const [sameMachine] = listLocalProviderSummaries(dir, () => false, "node-a");
    assert.equal(sameMachine.availableOnThisMachine, true);
    assert.equal(sameMachine.machineName, "Studio Mac");
    assert.equal(listLocalProviderSummaries(dir, () => false, "node-b")[0].availableOnThisMachine, false);
  });

  it("never projects another Machine's loopback provider into Pi", () => {
    const dir = tempDir();
    upsertLocalProvider(dir, "ollama-node-a", {
      baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", scope: "machine", machineId: "node-a", models: [{ id: "a" }],
    });
    upsertLocalProvider(dir, "remote", {
      baseUrl: "https://models.example/v1", api: "openai-completions", scope: "network", models: [{ id: "b" }],
    });
    const cfg = loadLocalModels(dir);
    assert.deepEqual(Object.keys(toPiModelsConfig(cfg, () => undefined, "node-b").providers), ["remote"]);
    assert.deepEqual(Object.keys(toPiModelsConfig(cfg, () => undefined, "node-a").providers).sort(), ["ollama-node-a", "remote"]);
  });
});
