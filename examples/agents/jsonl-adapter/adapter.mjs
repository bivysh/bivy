#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A complete Bivy agent adapter in the JSONL turn format (parser `bivy-protocol`).
 *
 * Bivy starts this program once per turn, writes the prompt to stdin, and reads
 * one JSON event per line from stdout. Replace `runTurn` with calls to the agent
 * or CLI you are wrapping; keep the events.
 *
 *   bivy agent add my-agent --transport process --parser bivy-protocol \
 *     --command /path/to/adapter.mjs --resume-args '["--resume","{id}"]'
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function readPrompt() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

async function runTurn(prompt, sessionId) {
  emit({ type: "message.reasoning", text: "Listing the workspace before answering." });

  emit({ type: "tool.call", toolCallId: "t1", name: "bash", input: { command: "ls" } });
  const output = execFileSync("ls", { cwd: process.cwd(), encoding: "utf8" });
  emit({ type: "tool.result", toolCallId: "t1", name: "bash", result: output });

  emit({ type: "message.delta", text: `Session ${sessionId}. You said: ${prompt}\n` });
  emit({ type: "message.delta", text: `The workspace has ${output.split("\n").filter(Boolean).length} entries.` });
  emit({ type: "usage", tokens: { input_tokens: prompt.length, output_tokens: 20 } });
}

const resumeAt = process.argv.indexOf("--resume");
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : randomUUID();

try {
  emit({ type: "session.started", sessionId });
  await runTurn(await readPrompt(), sessionId);
  emit({ type: "session.done" });
} catch (error) {
  emit({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
