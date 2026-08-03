import assert from "node:assert/strict";
import { listRuntimes, RUNTIME_CATALOG } from "../src/runtime/index.js";

// The agent picker must offer exactly the most-used coding agents, all driven
// through Bivy's general paths (native runtimes, the Codex app-server shim, and
// the data-driven ProcessRuntime + CliParser path) — no bespoke per-agent code.
const EXPECTED_PICKER = [
  // First wave.
  "pi",
  "claude-code-sdk",
  "codex-approvals",
  "opencode",
  "gemini",
  "qwen",
  "goose",
  "aider",
  "cline",
  "crush",
  // Second wave — the next-most-used CLIs, same data-driven ProcessRuntime path.
  "cursor",
  "copilot",
  "grok",
  "amp",
  "auggie",
  "droid",
  "continue",
  "kilocode",
  "rovodev",
].sort();

const listed = listRuntimes().map((r) => r.id).sort();
assert.deepEqual(listed, EXPECTED_PICKER, `picker should list the supported agents, got: ${listed.join(", ")}`);
assert.equal(listed.length, EXPECTED_PICKER.length, `the picker should show ${EXPECTED_PICKER.length} agents`);

// Codebuff is defined (runnable via BIVY_RUNTIME=codebuff) but deliberately hidden
// from the picker: it has no verified non-TTY headless mode upstream yet, so a
// picker entry would hang on a pipe. It must be in the catalog but NOT the picker
// — the same honest treatment as hermes/openclaw.
assert.ok(RUNTIME_CATALOG.some((r) => r.id === "codebuff"), "codebuff must exist in the catalog");
assert.ok(!listed.includes("codebuff"), "codebuff must stay hidden from the picker (no verified headless mode)");
assert.ok(!listed.includes("hermes") && !listed.includes("openclaw"), "hermes/openclaw stay hidden");

// Every listed agent must carry a support tier and a description the UI renders.
for (const runtime of listRuntimes()) {
  assert.ok(runtime.supportTier, `${runtime.id} must declare a supportTier`);
  assert.ok(runtime.description && runtime.description.length > 0, `${runtime.id} must have a description`);
  assert.ok(runtime.capabilities, `${runtime.id} must declare capabilities`);
  assert.ok(runtime.protectionLevel, `${runtime.id} must declare its effective protection mechanism`);
  assert.ok(runtime.protectionLabel && runtime.protectionDetail, `${runtime.id} must explain its protection in customer language`);
}
assert.equal(listRuntimes().find((r) => r.id === "pi")!.protectionLevel, "tool-controls");
assert.equal(listRuntimes().find((r) => r.id === "claude-code-sdk")!.protectionLevel, "native-sandbox");
assert.equal(listRuntimes().find((r) => r.id === "gemini")!.protectionLevel, "native-sandbox");
assert.equal(listRuntimes().find((r) => r.id === "opencode")!.protectionLevel, "user-permissions");

// Honesty invariant (docs/agents-not-fully-supported.md): the CLI ProcessRuntime
// adapters govern at the effect level and stream stdout — they must NOT advertise
// per-tool approvals, or the PWA renders a control that silently no-ops.
const CLI_ADAPTERS = [
  "opencode", "gemini", "qwen", "goose", "aider", "cline", "crush",
  "cursor", "copilot", "grok", "amp", "auggie", "droid", "continue", "kilocode", "rovodev",
];
for (const id of CLI_ADAPTERS) {
  const info = listRuntimes().find((r) => r.id === id);
  assert.ok(info, `${id} should be in the picker`);
  const caps = info!.capabilities as Record<string, unknown>;
  assert.equal(caps.toolInterception, false, `${id} must not advertise toolInterception (effect-level governance only)`);
}

// resume is on only for the CLI agents with a genuine native "continue session
// <id>" flag (opencode -s, gemini/qwen -r|--resume, goose --resume --session-id,
// cline --id) — wired as a spec.resume template (see CLI_AGENT_SPECS in
// src/runtime/index.ts). Aider and Crush have no such upstream flag, so they stay
// off until one exists (see the per-agent comments there).
const RESUME_CAPABLE = ["opencode", "gemini", "qwen", "goose", "cline", "cursor", "amp", "kilocode", "rovodev"];
const RESUME_INCAPABLE = ["aider", "crush", "copilot", "grok", "auggie", "droid", "continue"];
for (const id of RESUME_CAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.resume, true, `${id} should advertise resume (it has a built-in resume template)`);
}
for (const id of RESUME_INCAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.resume, false, `${id} must not advertise resume it can't drive (no native continue-by-id flag)`);
}

// modelSelection is advertised only where the adapter can actually drive the
// agent's model (a launch flag + a selectable list) — and NOT where it can't, so
// the picker never renders a model dropdown that no-ops.
const MODEL_CAPABLE = ["gemini", "qwen", "aider", "opencode", "codex-approvals", "cursor", "copilot", "grok", "droid", "continue", "kilocode"];
const MODEL_INCAPABLE = ["goose", "cline", "crush", "amp", "auggie", "rovodev"];
for (const id of MODEL_CAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.modelSelection, true, `${id} should advertise modelSelection (it has a model flag + list)`);
}
for (const id of MODEL_INCAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.modelSelection, false, `${id} must not advertise a model picker it can't drive`);
}

// usageReporting is advertised only for the agents whose structured parser
// extracts token usage (gemini-json / goose-stream-json). The dumb-pipe streamers
// (opencode/aider/cline/crush) and OpenCode have no usage parser, so it stays off.
const USAGE_CAPABLE = ["gemini", "qwen", "goose"];
const USAGE_INCAPABLE = ["opencode", "aider", "cline", "crush", "cursor", "copilot", "grok", "amp", "auggie", "droid", "continue", "kilocode", "rovodev"];
for (const id of USAGE_CAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.usageReporting, true, `${id} should report usage (its JSON parser emits tokens)`);
}
for (const id of USAGE_INCAPABLE) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.ok(!caps.usageReporting, `${id} must not advertise usage it can't parse`);
}

// An operator can override/clear the model list via BIVY_<ID>_MODELS — clearing it
// to [] turns modelSelection back off (honest), proving the list is data-driven.
process.env.BIVY_GEMINI_MODELS = "[]";
assert.equal(
  (listRuntimes().find((r) => r.id === "gemini")!.capabilities as Record<string, unknown>).modelSelection,
  false,
  "an empty BIVY_<ID>_MODELS override should drop modelSelection to off",
);
delete process.env.BIVY_GEMINI_MODELS;
assert.equal(
  (listRuntimes().find((r) => r.id === "gemini")!.capabilities as Record<string, unknown>).modelSelection,
  true,
  "clearing the override should restore modelSelection",
);

// streamingBehaviors must survive into the session-less runtimes.list catalog:
// the composer reads steer support from there (AppController.supportsSteering),
// so if the catalog constant drifts from the live runtime instance the client
// never learns steering is available and force-queues every mid-turn message.
// Guards against the two catalog constants (CLAUDE_CAPABILITIES / PI_CAPABILITIES
// in src/runtime/index.ts) silently dropping what the runtimes actually advertise.
const claudeCaps = listRuntimes().find((r) => r.id === "claude-code-sdk")!.capabilities as Record<string, unknown>;
assert.deepEqual(claudeCaps.streamingBehaviors, ["steer"], "claude-code-sdk must advertise steer in the catalog");
const piCaps = listRuntimes().find((r) => r.id === "pi")!.capabilities as Record<string, unknown>;
assert.deepEqual(piCaps.streamingBehaviors, ["steer", "followUp"], "pi must advertise steer + followUp in the catalog");

// Newly promoted agents are present with their display names.
const byId = Object.fromEntries(RUNTIME_CATALOG.map((r) => [r.id, r]));
assert.equal(byId.qwen.displayName, "Qwen Code");
assert.equal(byId.cline.displayName, "Cline");
assert.equal(byId.crush.displayName, "Crush");
assert.equal(byId.cursor.displayName, "Cursor");
assert.equal(byId.copilot.displayName, "GitHub Copilot");
assert.equal(byId.grok.displayName, "Grok");
assert.equal(byId.amp.displayName, "Amp");
assert.equal(byId.auggie.displayName, "Auggie");
assert.equal(byId.droid.displayName, "Droid");
assert.equal(byId.continue.displayName, "Continue");
assert.equal(byId.kilocode.displayName, "Kilo Code");
assert.equal(byId.rovodev.displayName, "Rovo Dev");
assert.equal(byId.codebuff.displayName, "Codebuff");

// The generic resume primitive is honest AND real: setting a per-agent resume
// template via env flips the advertised capability on (proving the O(1),
// data-driven resume path is wired, not hard-coded to Codex or to the built-in
// specs). Crush has no built-in template, so on/off here is unambiguous.
process.env.BIVY_CRUSH_RESUME_TEMPLATE = JSON.stringify(["run", "--resume", "{id}"]);
const crushResumable = listRuntimes().find((r) => r.id === "crush");
assert.equal(
  (crushResumable!.capabilities as Record<string, unknown>).resume,
  true,
  "a BIVY_<ID>_RESUME_TEMPLATE override should make the agent advertise resume",
);
delete process.env.BIVY_CRUSH_RESUME_TEMPLATE;
assert.equal(
  (listRuntimes().find((r) => r.id === "crush")!.capabilities as Record<string, unknown>).resume,
  false,
  "clearing the override should return resume to off",
);

// A session pinned to a hidden runtime (e.g. BIVY_RUNTIME=hermes) stays visible so
// the picker isn't empty for that session.
const withHidden = listRuntimes("hermes").map((r) => r.id);
assert.ok(withHidden.includes("hermes"), "the current runtime stays visible even when hidden from the picker");
assert.equal(withHidden.length, EXPECTED_PICKER.length + 1, "current hidden runtime adds exactly one to the visible set");

// A session pinned to the hidden codebuff runtime also stays visible.
const withCodebuff = listRuntimes("codebuff").map((r) => r.id);
assert.ok(withCodebuff.includes("codebuff"), "a codebuff-pinned session keeps codebuff visible in its picker");

// #1 — MCP-proxy approval gating. CLI agents advertise `mcpToolApprovals` only when
// the proxy shim is enabled (BIVY_MCP_PROXY): with it on, their MCP tool calls are
// gated by the same Approve/Deny flow as native interception; toolInterception
// itself stays false (the gate covers MCP tools, not built-in shell/edits).
const priorMcpProxy = process.env.BIVY_MCP_PROXY;
delete process.env.BIVY_MCP_PROXY;
for (const id of ["opencode", "cursor", "gemini"]) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.ok(!caps.mcpToolApprovals, `${id} must not advertise MCP approvals when the proxy is off`);
}
process.env.BIVY_MCP_PROXY = "1";
for (const id of ["opencode", "cursor", "gemini"]) {
  const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
  assert.equal(caps.mcpToolApprovals, true, `${id} should advertise MCP approvals when the proxy is on`);
  assert.equal(caps.toolInterception, false, `${id} still must NOT claim full toolInterception (MCP-scoped only)`);
}
if (priorMcpProxy === undefined) delete process.env.BIVY_MCP_PROXY;
else process.env.BIVY_MCP_PROXY = priorMcpProxy;

console.log("runtime-catalog: all tests passed");
