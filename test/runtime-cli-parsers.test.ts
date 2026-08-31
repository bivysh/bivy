import assert from "node:assert/strict";
import { bivyProtocolParser, claudeStreamJsonParser, codexJsonParser, gooseStreamJsonParser, geminiJsonParser, genericStreamJsonParser, genericJsonParser, extractTokenUsage } from "../src/runtime/cli-parsers.js";
import { ProcessRuntime } from "../src/runtime/process.js";
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

function feed(parser: ReturnType<typeof bivyProtocolParser>, lines: string[]): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const l of lines) events.push(...parser.onLine(l));
  events.push(...parser.onClose(0, ""));
  return events;
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((e) => e.type);
}

async function main() {
  await check("bivyProtocol: streams text deltas into an accumulating message", () => {
    const p = bivyProtocolParser();
    const events = feed(p, [
      JSON.stringify({ type: "session.status", status: "working" }),
      JSON.stringify({ type: "message.delta", text: "Hello" }),
      JSON.stringify({ type: "message.delta", text: ", world" }),
      JSON.stringify({ type: "session.done" }),
    ]);
    const updates = events.filter((e) => e.type === "message_update");
    assert.equal((updates.at(-1) as any).message.content, "Hello, world");
    assert.deepEqual(types(events).filter((t) => t === "agent_end").length, 1, "exactly one agent_end");
    assert.deepEqual(p.messages(), [{ role: "assistant", content: "Hello, world" }]);
  });

  await check("bivyProtocol: tool call + result produce blocks and transcript", () => {
    const p = bivyProtocolParser();
    const events = feed(p, [
      JSON.stringify({ type: "message.delta", text: "Reading…" }),
      JSON.stringify({ type: "tool.call", toolCallId: "t1", name: "read_file", input: { path: "/x" } }),
      JSON.stringify({ type: "tool.result", toolCallId: "t1", name: "read_file", result: "contents" }),
      JSON.stringify({ type: "session.done" }),
    ]);
    assert.ok(events.some((e) => e.type === "tool_call" && (e as any).toolName === "read_file"));
    assert.ok(events.some((e) => e.type === "tool_result"));
    const msgs = p.messages();
    // assistant message with text + tool_use block, then a user message with tool_result
    assert.equal(msgs.length, 2);
    assert.equal((msgs[0] as any).role, "assistant");
    assert.ok((msgs[0] as any).content.some((b: any) => b.type === "tool_use" && b.name === "read_file"));
    assert.equal((msgs[1] as any).role, "user");
    assert.equal((msgs[1] as any).content[0].type, "tool_result");
  });

  await check("bivyProtocol: correlates tool results that omit ids", () => {
    const p = bivyProtocolParser();
    feed(p, [
      JSON.stringify({ type: "tool.call", name: "bash", input: { command: "pwd" } }),
      JSON.stringify({ type: "tool.result", name: "bash", result: "workspace" }),
      JSON.stringify({ type: "session.done" }),
    ]);
    const messages = p.messages();
    assert.equal(messages.length, 2);
    const call = (messages[0] as any).content[0];
    const result = (messages[1] as any).content[0];
    assert.equal(call.type, "tool_use");
    assert.ok(call.id);
    assert.equal(result.tool_use_id, call.id);
  });

  await check("bivyProtocol: close without session.done still finalizes once", () => {
    const p = bivyProtocolParser();
    const events = feed(p, [JSON.stringify({ type: "message.delta", text: "hi" })]);
    assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
    assert.equal(types(events).filter((t) => t === "message_end").length, 1);
  });

  await check("bivyProtocol: ignores non-JSON banner lines", () => {
    const p = bivyProtocolParser();
    const events = feed(p, ["Starting agent v1.2…", JSON.stringify({ type: "message.delta", text: "ok" }), JSON.stringify({ type: "session.done" })]);
    assert.equal((events.filter((e) => e.type === "message_update").at(-1) as any).message.content, "ok");
  });

  await check("claudeStreamJson: assistant text + tool_use, result closes", () => {
    const p = claudeStreamJsonParser();
    const events: RuntimeEvent[] = [];
    for (const l of [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "u1", name: "bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "file.txt" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "Done." }),
    ]) events.push(...p.onLine(l));
    events.push(...p.onClose(0, ""));
    assert.ok(events.some((e) => e.type === "tool_call" && (e as any).toolName === "bash"));
    assert.ok(events.some((e) => e.type === "tool_result"));
    assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
    assert.match((p.messages()[0] as any).content.find((b: any) => b.type === "text").text, /Let me check/);
  });

  await check("claudeStreamJson: result seeds text when nothing streamed", () => {
    const p = claudeStreamJsonParser();
    p.onLine(JSON.stringify({ type: "result", subtype: "success", result: "Final answer." }));
    p.onClose(0, "");
    assert.deepEqual(p.messages(), [{ role: "assistant", content: "Final answer." }]);
  });

  // Full ProcessRuntime structured-mode integration: spawn a node one-liner that
  // emits bivy-protocol JSONL; assert the runtime surfaces normalized events.
  await check("ProcessRuntime structured mode drives normalized events end-to-end", async () => {
    const emitter = `
      const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      say({ type: "session.status", status: "working" });
      say({ type: "message.delta", text: "Working on it" });
      say({ type: "tool.call", toolCallId: "t1", name: "bash", input: { command: "ls" } });
      say({ type: "tool.result", toolCallId: "t1", name: "bash", result: "ok" });
      say({ type: "message.delta", text: " — done" });
      say({ type: "session.done" });
    `;
    const runtime = new ProcessRuntime({
      command: process.execPath,
      args: ["-e", emitter],
      promptMode: "stdin",
      parserFactory: bivyProtocolParser,
    });
    const { session } = await runtime.createSession({ workspace: process.cwd() });
    const seen: RuntimeEvent[] = [];
    session.subscribe((e) => seen.push(e));
    await session.prompt("go");
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => (seen.some((e) => e.type === "agent_end") || Date.now() - start > 8000 ? resolve() : setTimeout(tick, 25));
      tick();
    });
    const finalText = (seen.filter((e) => e.type === "message_update").at(-1) as any)?.message?.content;
    assert.equal(finalText, "Working on it — done");
    assert.ok(seen.some((e) => e.type === "tool_call" && (e as any).toolName === "bash"), "tool_call surfaced");
    assert.equal(types(seen).filter((t) => t === "agent_end").length, 1, "exactly one agent_end");
    const msgs = session.getMessages();
    assert.ok(msgs.some((m: any) => m.role === "assistant"), "assistant message persisted");
    session.dispose();
  });

  // --- Usage extraction (best-effort, key-spelling agnostic) ----------------
  await check("extractTokenUsage reads the many token-key spellings", () => {
    assert.deepEqual(extractTokenUsage({ input_tokens: 3, output_tokens: 4 })?.tokens, { input: 3, output: 4, total: 7 });
    assert.deepEqual(extractTokenUsage({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 })?.tokens, { input: 5, output: 6, total: 11 });
    assert.equal(extractTokenUsage({ promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 })?.tokens?.total, 10);
    assert.deepEqual(extractTokenUsage({ inputTokens: 9, outputTokens: 3, totalTokens: 12 })?.tokens, { input: 9, output: 3, total: 12 });
    assert.equal(extractTokenUsage({ nothing: 1 }), undefined, "no recognizable counts → undefined");
    assert.equal(extractTokenUsage(null), undefined);
  });

  // --- Codex: reasoning stream + usage --------------------------------------
  await check("codexJsonParser surfaces reasoning as a thinking block and parses usage", () => {
    const p = codexJsonParser();
    const events: RuntimeEvent[] = [];
    for (const line of [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "let me think" } }),
      JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "the answer" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
    ]) events.push(...p.onLine(line));
    // Reasoning is a thinking-block message_update, kept out of the answer text.
    const thinking = events.find((e) => e.type === "message_update" && Array.isArray((e as any).message?.content) && (e as any).message.content[0]?.type === "thinking");
    assert.ok(thinking, "reasoning surfaced as a thinking block");
    assert.equal((thinking as any).message.content[0].thinking, "let me think");
    const answer = events.filter((e) => e.type === "message_update" && typeof (e as any).message?.content === "string").at(-1);
    assert.equal((answer as any).message.content, "the answer", "answer text is separate from reasoning");
    assert.deepEqual(p.usage?.()?.tokens, { input: 100, output: 20, total: 120 });
  });

  await check("gooseStreamJsonParser parses total tokens from `complete`", () => {
    const p = gooseStreamJsonParser();
    for (const line of [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "complete", total_tokens: 42 }),
    ]) p.onLine(line);
    assert.equal(p.usage?.()?.tokens?.total, 42);
  });

  await check("geminiJsonParser parses usage from stats", () => {
    const p = geminiJsonParser();
    p.onLine(JSON.stringify({ response: "hi", stats: { promptTokenCount: 9, candidatesTokenCount: 1, totalTokenCount: 10 } }));
    p.onClose(0, "");
    assert.equal(p.usage?.()?.tokens?.total, 10);
  });

  // Credential preflight: a preflight that reports a missing credential must
  // surface a clean session.error turn and NEVER spawn the subprocess (which
  // would otherwise die with an opaque upstream 401).
  await check("ProcessRuntime preflight blocks spawn and emits an actionable error", async () => {
    const runtime = new ProcessRuntime({
      command: process.execPath,
      args: ["-e", `process.stdout.write("SHOULD_NOT_RUN")`],
      promptMode: "stdin",
      preflight: () => "No credential. Sign in first.",
    });
    const { session } = await runtime.createSession({ workspace: process.cwd() });
    const seen: RuntimeEvent[] = [];
    session.subscribe((e) => seen.push(e));
    await session.prompt("go");
    assert.ok(
      seen.some((e) => e.type === "session.error" && (e as any).error === "No credential. Sign in first."),
      "preflight error surfaced as session.error",
    );
    assert.equal(types(seen).filter((t) => t === "agent_end").length, 1, "turn terminated with agent_end");
    const anyOutput = seen.filter((e) => e.type === "message_update").map((e) => (e as any).message?.content).join("");
    assert.ok(!anyOutput.includes("SHOULD_NOT_RUN"), "subprocess was never spawned");
    assert.equal(session.isStreaming, false, "streaming reset after preflight block");
    session.dispose();
  });

  // ---- generic tolerant parsers (opt-in fidelity for unpinned JSON CLIs) ------

  await check("genericStreamJson: extracts Claude/ACP-style assistant text", () => {
    const p = genericStreamJsonParser();
    const events = feed(p, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hel" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } }),
      JSON.stringify({ type: "result", usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    const last = events.filter((e) => e.type === "message_update").at(-1) as any;
    assert.equal(last.message.content, "Hello");
    assert.equal(types(events).filter((t) => t === "agent_end").length, 1);
    assert.equal(p.usage?.()?.tokens?.input, 3);
  });

  await check("genericStreamJson: extracts OpenAI-style delta chunks", () => {
    const p = genericStreamJsonParser();
    const events = feed(p, [
      JSON.stringify({ choices: [{ delta: { content: "foo " } }] }),
      JSON.stringify({ delta: { text: "bar" } }),
      JSON.stringify({ type: "done" }),
    ]);
    const last = events.filter((e) => e.type === "message_update").at(-1) as any;
    assert.equal(last.message.content, "foo bar");
  });

  await check("genericStreamJson: never loses output — non-JSON falls back to raw at close", () => {
    const p = genericStreamJsonParser();
    const events = feed(p, ["not json at all", "just plain text"]);
    const last = events.filter((e) => e.type === "message_update").at(-1) as any;
    assert.match(last.message.content, /just plain text/);
    assert.equal(types(events).filter((t) => t === "agent_end").length, 1, "still terminates");
  });

  await check("genericStreamJson: surfaces an error frame", () => {
    const p = genericStreamJsonParser();
    const events = feed(p, [JSON.stringify({ error: { message: "boom" } }), JSON.stringify({ type: "done" })]);
    assert.ok(events.some((e) => e.type === "session.error" && (e as any).error === "boom"));
  });

  await check("genericJson: extracts the reply from a final JSON object + usage", () => {
    const p = genericJsonParser();
    const events = feed(p, [JSON.stringify({ response: "the answer", usage: { total_tokens: 9 } })]);
    const last = events.filter((e) => e.type === "message_update").at(-1) as any;
    assert.equal(last.message.content, "the answer");
    assert.equal(p.messages()[0]?.content, "the answer");
    assert.equal(p.usage?.()?.tokens?.total, 9);
  });

  await check("genericJson: tolerates the `result` field and content arrays", () => {
    const a = genericJsonParser();
    feed(a, [JSON.stringify({ result: "R" })]);
    assert.equal(a.messages()[0]?.content, "R");
    const b = genericJsonParser();
    feed(b, [JSON.stringify({ content: [{ text: "x" }, { text: "y" }] })]);
    assert.equal(b.messages()[0]?.content, "xy");
  });

  await check("genericJson: unfamiliar shape falls back to raw (never empty)", () => {
    const p = genericJsonParser();
    const events = feed(p, [JSON.stringify({ weird: 123 })]);
    const last = events.filter((e) => e.type === "message_update").at(-1) as any;
    assert.match(last.message.content, /weird/);
  });

  if (failures > 0) {
    console.error(`\n${failures} cli-parser test(s) failed`);
    process.exit(1);
  }
  console.log("\nall cli-parser tests passed");
}

void main();
