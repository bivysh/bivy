import assert from "node:assert/strict";
import { mapToolCall } from "../src/runtime/tool-call-map.js";
import { codexJsonParser, claudeStreamJsonParser } from "../src/runtime/cli-parsers.js";
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

function feed(parser: { onLine(l: string): RuntimeEvent[]; onClose(c: number | null, s: string): RuntimeEvent[] }, lines: string[]): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const l of lines) events.push(...parser.onLine(l));
  events.push(...parser.onClose(0, ""));
  return events;
}

async function main() {
  // ---- Direct mapper coverage across name/field spelling variants ----

  await check("shell: classifies bash/command_execution/run with {command|cmd|argv}", () => {
    assert.deepEqual(mapToolCall("Bash", { command: "ls -la" }), { kind: "shell", command: "ls -la" });
    assert.deepEqual(mapToolCall("command_execution", { command: "npm test" }), { kind: "shell", command: "npm test" });
    assert.deepEqual(mapToolCall("run", { cmd: "make" }), { kind: "shell", command: "make" });
    // argv array is joined
    assert.deepEqual(mapToolCall("shell", { command: ["git", "status"] }), { kind: "shell", command: "git status" });
    // cwd carried through when present
    assert.deepEqual(mapToolCall("bash", { command: "ls", cwd: "/tmp" }), { kind: "shell", command: "ls", cwd: "/tmp" });
  });

  await check("read: classifies Read/read_file with path|file_path", () => {
    assert.deepEqual(mapToolCall("Read", { file_path: "/a/b.ts" }), { kind: "read", path: "/a/b.ts" });
    assert.deepEqual(mapToolCall("read_file", { path: "x.md" }), { kind: "read", path: "x.md" });
  });

  await check("edit: classifies Edit/str_replace with old/new, and apply_patch changes-map", () => {
    assert.deepEqual(
      mapToolCall("Edit", { file_path: "a.ts", old_string: "foo", new_string: "bar" }),
      { kind: "edit", path: "a.ts", oldText: "foo", newText: "bar" },
    );
    assert.deepEqual(mapToolCall("str_replace", { path: "a.ts", old: "x", new: "y" }), { kind: "edit", path: "a.ts", oldText: "x", newText: "y" });
    // Codex file_change / apply_patch: derive path from the changes map's first key
    assert.deepEqual(mapToolCall("apply_patch", { changes: { "src/x.ts": {} } }), { kind: "edit", path: "src/x.ts" });
  });

  await check("write/search/fetch/plan buckets", () => {
    assert.deepEqual(mapToolCall("write_file", { file_path: "n.txt" }), { kind: "write", path: "n.txt" });
    assert.deepEqual(mapToolCall("grep", { pattern: "TODO", path: "src" }), { kind: "search", query: "TODO", path: "src" });
    assert.deepEqual(mapToolCall("web_fetch", { url: "https://x.dev" }), { kind: "fetch", url: "https://x.dev" });
    assert.deepEqual(mapToolCall("update_plan", { plan: "1. do it" }), { kind: "plan", text: "1. do it" });
  });

  await check("unrecognized tool or missing fields → undefined (opaque fallback)", () => {
    assert.equal(mapToolCall("some_bespoke_tool", { whatever: 1 }), undefined);
    assert.equal(mapToolCall("Bash", {}), undefined); // no command → no detail, stays opaque
    assert.equal(mapToolCall("Read", { note: "no path here" }), undefined);
  });

  await check("never throws on odd inputs", () => {
    assert.equal(mapToolCall("bash", null), undefined);
    assert.equal(mapToolCall("bash", "a string"), undefined);
    assert.equal(mapToolCall("", undefined), undefined);
  });

  // ---- End-to-end: detail rides the tool_call event through the real parsers ----

  await check("codexJson: command_execution emits a tool_call carrying shell detail", () => {
    const p = codexJsonParser();
    const events = feed(p, [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "1", type: "command_execution", command: "echo hi" } }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    const call = events.find((e) => e.type === "tool_call") as (RuntimeEvent & { detail?: unknown }) | undefined;
    assert.ok(call, "expected a tool_call event");
    assert.deepEqual(call!.detail, { kind: "shell", command: "echo hi" });
  });

  await check("claudeStreamJson: tool_use Edit emits a tool_call carrying edit detail", () => {
    const p = claudeStreamJsonParser();
    const events = feed(p, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }] } }),
      JSON.stringify({ type: "result", result: "done" }),
    ]);
    const call = events.find((e) => e.type === "tool_call") as (RuntimeEvent & { detail?: unknown }) | undefined;
    assert.ok(call, "expected a tool_call event");
    assert.deepEqual(call!.detail, { kind: "edit", path: "a.ts", oldText: "x", newText: "y" });
  });

  if (failures > 0) {
    console.error(`\n${failures} tool-call-map test(s) failed`);
    process.exit(1);
  }
  console.log("\nall tool-call-map tests passed");
}

void main();
