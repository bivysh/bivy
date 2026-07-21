// Fixtures below are REAL event shapes captured from the installed CLIs
// (codex-cli 0.142, goose 1.41, gemini-cli 0.49) — see the parser docs.
import assert from "node:assert/strict";
import { codexJsonParser, gooseStreamJsonParser, geminiJsonParser } from "../src/runtime/cli-parsers.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function run(parser: ReturnType<typeof codexJsonParser>, lines: string[], code = 0, stderr = ""): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const l of lines) events.push(...parser.onLine(l));
  events.push(...parser.onClose(code, stderr));
  return events;
}
const types = (e: RuntimeEvent[]) => e.map((x) => x.type);
const lastText = (e: RuntimeEvent[]) => (e.filter((x) => x.type === "message_update").at(-1) as any)?.message?.content;

// ---- Codex `exec --json` (real thread/turn/item model) --------------------
check("codex: agent_message + command_execution build a transcript", () => {
  const p = codexJsonParser();
  const events = run(p, [
    `{"type":"thread.started","thread_id":"019f"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"i0","type":"command_execution","command":"ls","aggregated_output":"file.txt","exit_code":0}}`,
    `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"I listed the files."}}`,
    `{"type":"turn.completed"}`,
  ]);
  assert.ok(events.some((e) => e.type === "tool_call" && (e as any).toolName === "shell"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.equal(lastText(events), "I listed the files.");
  assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
  const msgs = p.messages();
  assert.ok((msgs[0] as any).content.some((b: any) => b.type === "tool_use" && b.name === "shell"));
});

check("codex: turn.failed surfaces an error and closes once", () => {
  const p = codexJsonParser();
  const events = run(p, [
    `{"type":"turn.started"}`,
    `{"type":"error","message":"Reconnecting... 1/5"}`,
    `{"type":"turn.failed","error":{"message":"401 Unauthorized"}}`,
  ]);
  assert.ok(events.some((e) => e.type === "session.error" && /401/.test((e as any).error)));
  assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
  // The transient top-level "error" must NOT become a session.error.
  assert.equal(events.filter((e) => e.type === "session.error").length, 1);
});

check("codex: mcp_tool_call becomes a tool card", () => {
  const p = codexJsonParser();
  const events = run(p, [
    `{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","tool":"read_file","arguments":{"path":"/x"},"result":"data"}}`,
    `{"type":"turn.completed"}`,
  ]);
  assert.ok(events.some((e) => e.type === "tool_call" && (e as any).toolName === "read_file"));
  assert.ok(events.some((e) => e.type === "tool_result"));
});

// ---- Goose `--output-format stream-json` (real message/complete) ----------
check("goose: assistant text messages accumulate, complete closes", () => {
  const p = gooseStreamJsonParser();
  const events = run(p, [
    `{"type":"message","message":{"id":null,"role":"assistant","content":[{"type":"text","text":"Hello from"}]}}`,
    `{"type":"message","message":{"id":null,"role":"assistant","content":[{"type":"text","text":" the model."}]}}`,
    `{"type":"complete","total_tokens":10}`,
  ]);
  assert.equal(lastText(events), "Hello from the model.");
  assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
  assert.deepEqual(p.messages(), [{ role: "assistant", content: "Hello from the model." }]);
});

check("goose: toolRequest/toolResponse become tool cards; user echoes ignored", () => {
  const p = gooseStreamJsonParser();
  const events = run(p, [
    `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"run echo"}]}}`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"toolRequest","id":"t1","toolCall":{"name":"developer__shell","arguments":{"command":"echo hi"}}}]}}`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"toolResponse","id":"t1","toolResult":"hi"}]}}`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}`,
    `{"type":"complete","total_tokens":5}`,
  ]);
  assert.ok(events.some((e) => e.type === "tool_call" && (e as any).toolName === "developer__shell"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.equal(lastText(events), "Done.");
  // The user echo must not appear in assistant text.
  assert.ok(!String(lastText(events)).includes("run echo"));
});

check("goose: ascii banner / non-JSON lines are ignored", () => {
  const p = gooseStreamJsonParser();
  const events = run(p, [
    `    __( O)>  ● new session`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`,
    `{"type":"complete","total_tokens":1}`,
  ]);
  assert.equal(lastText(events), "ok");
});

// ---- Gemini `-o json` (real final object) ---------------------------------
check("gemini: final {response} object becomes the assistant message", () => {
  const p = geminiJsonParser();
  // gemini pretty-prints the object across many lines.
  const events = run(p, [
    `{`,
    `  "session_id": "b4a5",`,
    `  "response": "Hi there!",`,
    `  "stats": { "turns": 1 }`,
    `}`,
  ]);
  assert.equal(lastText(events), "Hi there!");
  assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
  assert.deepEqual(p.messages(), [{ role: "assistant", content: "Hi there!" }]);
});

check("gemini: error object becomes a session.error", () => {
  const p = geminiJsonParser();
  const events = run(p, [
    `{ "session_id": "x", "error": { "type": "Error", "message": "Please set an Auth method", "code": 41 } }`,
  ], 41);
  assert.ok(events.some((e) => e.type === "session.error" && /Auth method/.test((e as any).error)));
});

if (failures > 0) {
  console.error(`\n${failures} native-parser test(s) failed`);
  process.exit(1);
}
console.log("\nall native-parser tests passed");
