import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedToolPayload, mapToolCall } from "../src/runtime/tool-call-map.js";
import { codexJsonParser, claudeStreamJsonParser } from "../src/runtime/cli-parsers.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

function feed(parser: { onLine(line: string): RuntimeEvent[]; onClose(code: number | null, stderr: string): RuntimeEvent[] }, lines: string[]): RuntimeEvent[] {
  return [...lines.flatMap((line) => parser.onLine(line)), ...parser.onClose(0, "")];
}

function shape(detail: ReturnType<typeof mapToolCall>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const { meta: _meta, raw: _raw, result: _result, ...rest } = detail;
  return rest;
}

assert.deepEqual(shape(mapToolCall("Bash", { command: "ls -la" })), { kind: "shell", command: "ls -la" });
assert.deepEqual(shape(mapToolCall("read_file", { file_path: "a.ts" })), { kind: "read", path: "a.ts" });
assert.deepEqual(shape(mapToolCall("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })), { kind: "edit", path: "a.ts", oldText: "x", newText: "y" });
assert.deepEqual(shape(mapToolCall("grep", { pattern: "TODO", path: "src" })), { kind: "search", query: "TODO", path: "src" });
assert.equal(mapToolCall("unknown", { value: 1 }), undefined);
assert.equal((boundedToolPayload({ text: "x".repeat(5000) }) as { truncated?: boolean }).truncated, true);

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/tool-normalization-v1.json", import.meta.url), "utf8")) as Array<any>;
for (const fixture of fixtures) {
  const detail = mapToolCall(fixture.name, fixture.input, { provider: fixture.provider, protocol: fixture.protocol });
  assert.deepEqual(shape(detail), fixture.expected, `${fixture.provider}:${fixture.name} drifted`);
  assert.equal(detail?.meta.provider, fixture.provider);
}

const codexEvents = feed(codexJsonParser(), [
  JSON.stringify({ type: "item.completed", item: { id: "x", type: "command_execution", command: "false", aggregated_output: "failed", exit_code: 1 } }),
  JSON.stringify({ type: "turn.completed" }),
]);
const codexCall = codexEvents.find((event) => event.type === "tool_call") as any;
const codexResult = codexEvents.find((event) => event.type === "tool_result") as any;
assert.deepEqual(codexCall.detail.meta, { version: 1, provider: "codex", protocol: "structured-pipe", rawToolName: "shell" });
assert.deepEqual(codexResult.detail.result, { text: "failed", exitCode: 1, isError: true });

const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-tool-trace-"));
const traceFile = path.join(traceDir, "trace.jsonl");
process.env.BIVY_TOOL_TRACE_FILE = traceFile;
feed(codexJsonParser(), [JSON.stringify({ type: "item.completed", item: { id: "trace", type: "command_execution", command: "pwd" } }), JSON.stringify({ type: "turn.completed" })]);
delete process.env.BIVY_TOOL_TRACE_FILE;
assert.equal(JSON.parse(fs.readFileSync(traceFile, "utf8").trim()).context.provider, "codex");
assert.equal(fs.statSync(traceFile).mode & 0o777, 0o600);

const claudeEvents = feed(claudeStreamJsonParser(), [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }] } }),
  JSON.stringify({ type: "result", result: "done" }),
]);
const claudeCall = claudeEvents.find((event) => event.type === "tool_call") as any;
assert.equal(claudeCall.detail.meta.provider, "claude");
assert.deepEqual(shape(claudeCall.detail), { kind: "edit", path: "a.ts", oldText: "x", newText: "y" });

console.log("runtime-tool-call-map: all tests passed");
