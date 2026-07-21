// Tests the opt-in model-selection path on ProcessRuntime (the general, data-driven
// mechanism that gives CLI agents a working model picker): getModels() lists the
// configured models, setModel() records the choice, and the chosen id is spliced
// into the launch args at the configured position for every subsequent prompt.
// Driven by a STUB binary that records its argv — runs in CI with no real agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessRuntime } from "../src/runtime/process.js";
import { codexJsonParser } from "../src/runtime/cli-parsers.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-model-test-"));
const argsFile = path.join(tmp, "args.txt");

// A stub agent that records the exact argv it was launched with, then exits 0.
const stub = path.join(tmp, "stub-agent");
fs.writeFileSync(
  stub,
  ["#!/bin/sh", `[ -n "$STUB_ARGS_FILE" ] && printf '%s' "$*" > "$STUB_ARGS_FILE"`, "printf 'ok\\n'", ""].join("\n"),
  { mode: 0o755 },
);
fs.chmodSync(stub, 0o755);

const MODELS = [
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];

// Gemini-shaped: prompt flag `-p` is trailing, model flag prepends (insertAt 0).
function geminiLikeRuntime() {
  return new ProcessRuntime({
    id: "gemini",
    displayName: "Gemini (stub)",
    command: stub,
    promptMode: "argv",
    args: ["-p"],
    model: { models: MODELS, modelArgs: (id) => ["-m", id], insertAt: 0 },
    env: { STUB_ARGS_FILE: argsFile },
  });
}

// OpenCode-shaped: leading `run` subcommand, model flag inserts after it (insertAt 1).
function openCodeLikeRuntime() {
  return new ProcessRuntime({
    id: "opencode",
    displayName: "OpenCode (stub)",
    command: stub,
    promptMode: "argv",
    args: ["run"],
    model: { models: MODELS, modelArgs: (id) => ["--model", id], insertAt: 1 },
    env: { STUB_ARGS_FILE: argsFile },
  });
}

function runToEnd(session: { subscribe: (l: (e: RuntimeEvent) => void) => () => void; prompt: (t: string) => Promise<void> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = session.subscribe((e) => {
      if (e.type === "agent_end") { off(); resolve(); }
    });
    session.prompt("hello").catch((err) => { off(); reject(err); });
    setTimeout(() => { off(); reject(new Error("timed out waiting for agent_end")); }, 8000).unref();
  });
}

await check("runtime advertises modelSelection only when a model list is wired", () => {
  assert.equal(geminiLikeRuntime().capabilities.modelSelection, true);
  const plain = new ProcessRuntime({ id: "x", command: stub, promptMode: "argv" });
  assert.equal(plain.capabilities.modelSelection, false);
  // An empty list must not flip the capability on.
  const empty = new ProcessRuntime({ id: "y", command: stub, promptMode: "argv", model: { models: [], modelArgs: () => [] } });
  assert.equal(empty.capabilities.modelSelection, false);
});

await check("getModels lists the configured models; current is undefined until picked", async () => {
  const { session } = await geminiLikeRuntime().createSession({ workspace: tmp });
  assert.deepEqual(session.getModels().map((m) => m.id), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.equal(session.getCurrentModel(), undefined, "no model selected → agent's own default");
});

await check("no selection → the launch args are untouched (agent default)", async () => {
  const { session } = await geminiLikeRuntime().createSession({ workspace: tmp });
  await runToEnd(session);
  const launched = fs.readFileSync(argsFile, "utf8");
  assert.equal(launched, "-p hello", `expected no model flag, got: ${launched}`);
});

await check("setModel splices the model flag before a trailing prompt flag (insertAt 0)", async () => {
  const { session } = await geminiLikeRuntime().createSession({ workspace: tmp });
  await session.setModel("google", "gemini-2.5-flash");
  assert.equal(session.getCurrentModel()?.id, "gemini-2.5-flash", "current model round-trips");
  await runToEnd(session);
  const launched = fs.readFileSync(argsFile, "utf8");
  assert.equal(launched, "-m gemini-2.5-flash -p hello", `model flag should precede -p, got: ${launched}`);
});

await check("setModel inserts after a leading subcommand (insertAt 1)", async () => {
  const { session } = await openCodeLikeRuntime().createSession({ workspace: tmp });
  await session.setModel("google", "gemini-2.5-pro");
  await runToEnd(session);
  const launched = fs.readFileSync(argsFile, "utf8");
  assert.equal(launched, "run --model gemini-2.5-pro hello", `model flag should follow 'run', got: ${launched}`);
});

await check("clearing the model (empty id) falls back to the agent default", async () => {
  const { session } = await geminiLikeRuntime().createSession({ workspace: tmp });
  await session.setModel("google", "gemini-2.5-pro");
  await session.setModel("", "");
  assert.equal(session.getCurrentModel(), undefined, "empty id clears the selection");
  await runToEnd(session);
  assert.equal(fs.readFileSync(argsFile, "utf8"), "-p hello");
});

// --- Thinking / reasoning-effort injection --------------------------------
function thinkingRuntime() {
  return new ProcessRuntime({
    id: "codex",
    displayName: "Codex (stub)",
    command: stub,
    promptMode: "argv",
    args: ["exec", "-p"],
    // Model prepends (insertAt 0); thinking inserts after the `exec` subcommand.
    model: { models: MODELS, modelArgs: (id) => ["-m", id], insertAt: 0 },
    thinking: { levels: ["low", "high"], default: "low", thinkingArgs: (l) => ["-c", `model_reasoning_effort=${l}`], insertAt: 1 },
    env: { STUB_ARGS_FILE: argsFile },
  });
}

await check("supportsThinking + levels reflect the config", async () => {
  const { session } = await thinkingRuntime().createSession({ workspace: tmp });
  assert.equal(session.supportsThinking?.(), true);
  assert.deepEqual(session.getAvailableThinkingLevels?.(), ["low", "high"]);
  assert.equal(session.getThinkingLevel?.(), "low", "defaults to the configured level");
  const plain = (await new ProcessRuntime({ id: "x", command: stub, promptMode: "argv" }).createSession({ workspace: tmp })).session;
  assert.equal(plain.supportsThinking?.() ?? false, false);
});

await check("setThinkingLevel injects the effort flag after the subcommand", async () => {
  const { session } = await thinkingRuntime().createSession({ workspace: tmp });
  session.setThinkingLevel?.("high");
  await session.setModel("google", "gemini-2.5-pro");
  await runToEnd(session);
  // Model prepends; thinking inserts after `exec`; prompt trails.
  assert.equal(
    fs.readFileSync(argsFile, "utf8"),
    "-m gemini-2.5-pro exec -c model_reasoning_effort=high -p hello",
  );
});

await check("the displayed default is not force-injected (opt-in only)", async () => {
  const { session } = await thinkingRuntime().createSession({ workspace: tmp });
  // Fresh session shows the default level but must NOT pass a flag — the agent
  // runs on its own default until the user explicitly picks a level.
  assert.equal(session.getThinkingLevel?.(), "low");
  await runToEnd(session);
  assert.equal(fs.readFileSync(argsFile, "utf8"), "exec -p hello", "no effort flag injected by default");
});

await check("an unknown thinking level is ignored (keeps the default, no flag)", async () => {
  const { session } = await thinkingRuntime().createSession({ workspace: tmp });
  session.setThinkingLevel?.("bogus");
  assert.equal(session.getThinkingLevel?.(), "low", "bogus level ignored, default stands");
  await runToEnd(session);
  assert.equal(fs.readFileSync(argsFile, "utf8"), "exec -p hello", "no effort flag injected");
});

// --- Usage reporting (parser-extracted) -----------------------------------
// A codex-shaped stub that emits a token-bearing turn.completed.
const codexStub = path.join(tmp, "stub-codex-usage");
fs.writeFileSync(
  codexStub,
  [
    "#!/bin/sh",
    `printf '%s\\n' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"done"}}' '{"type":"turn.completed","usage":{"input_tokens":123,"output_tokens":45}}'`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
fs.chmodSync(codexStub, 0o755);

await check("getUsage returns the token snapshot parsed from the turn", async () => {
  const runtime = new ProcessRuntime({
    id: "codex",
    command: codexStub,
    promptMode: "argv",
    args: ["exec", "--json"],
    parserFactory: () => codexJsonParser(),
    usageReporting: true,
  });
  assert.equal(runtime.capabilities.usageReporting, true);
  const { session } = await runtime.createSession({ workspace: tmp });
  await runToEnd(session);
  const usage = await session.getUsage?.();
  assert.deepEqual(usage?.tokens, { input: 123, output: 45, total: 168 });
});

await check("usageReporting defaults off", () => {
  const plain = new ProcessRuntime({ id: "x", command: stub, promptMode: "argv" });
  assert.equal(plain.capabilities.usageReporting ?? false, false);
});

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failures > 0) {
  console.error(`\n${failures} process-model test(s) failed.`);
  process.exit(1);
}
console.log("\nAll process-model tests passed.");
