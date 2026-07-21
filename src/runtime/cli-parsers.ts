// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — Phase 4: structured chat fidelity for CLI agents.
//
// Governance (Phases 1–3) already works for ANY agent because it wraps effects,
// not chat. This adds the *fidelity* layer: turn a CLI agent's structured stdout
// into the same normalized RuntimeEvents the PWA renders for Pi/Claude (streaming
// assistant text, tool cards, a proper transcript) instead of one opaque blob.
//
// A CliParser is a small, stateful, PURE mapper from stdout lines → events. It
// needs zero knowledge of the daemon. The two shipped here:
//
//   * bivyProtocol   — the UNIVERSAL path. Any agent that emits bivy-agent-
//                      protocol JSONL (natively or via a ~30-line shim) gets full
//                      fidelity. This is what makes "any agent" real: you never
//                      need a bespoke parser, just this one line format.
//   * claudeStreamJson — parses Claude Code CLI `--output-format stream-json`, as
//                      a worked example of adapting a native JSON mode. (Format
//                      per Anthropic's docs; validate against your CLI version.)
//
// Adding an agent = add a parser to CLI_PARSERS (data), never new daemon code.
// Unit-tested with fixtures in test/runtime-cli-parsers.test.ts.

import type { RuntimeEvent, RuntimeMessage, UsageSnapshot } from "./types.js";

export interface CliParser {
  /** Feed one complete stdout line; return normalized events to emit. */
  onLine(line: string): RuntimeEvent[];
  /** Called when the process exits; return any closing events (message_end/agent_end). */
  onClose(code: number | null, stderr: string): RuntimeEvent[];
  /** The conversation messages to persist for history (built at close). */
  messages(): RuntimeMessage[];
  /** Best-effort token/cost usage parsed from the agent's own output, or undefined. */
  usage?(): UsageSnapshot | undefined;
}

/**
 * Best-effort token usage from an agent's structured output. Coding CLIs report
 * tokens under many key spellings (OpenAI `prompt_tokens`, Anthropic/Codex
 * `input_tokens`, Gemini `promptTokenCount`, Goose `total_tokens`, …), so we scan
 * for all of them rather than hard-coding one shape. Returns undefined when the
 * object carries no recognizable counts, keeping usage honestly absent.
 */
export function extractTokenUsage(raw: unknown): UsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const input = num("input_tokens", "prompt_tokens", "promptTokenCount", "input", "prompt");
  const output = num("output_tokens", "completion_tokens", "candidatesTokenCount", "output", "completion");
  const cacheRead = num("cache_read_input_tokens", "cached_input_tokens", "cachedContentTokenCount", "cache_read");
  const cacheWrite = num("cache_creation_input_tokens", "cache_write");
  const total = num("total_tokens", "totalTokenCount", "total") ?? ((input ?? 0) + (output ?? 0) || undefined);
  const costUsd = num("cost_usd", "total_cost", "costUsd");
  if (input === undefined && output === undefined && total === undefined && costUsd === undefined) return undefined;
  const tokens: NonNullable<UsageSnapshot["tokens"]> = {};
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  if (total !== undefined) tokens.total = total;
  const snapshot: UsageSnapshot = {};
  if (Object.keys(tokens).length) snapshot.tokens = tokens;
  if (costUsd !== undefined) snapshot.costUsd = costUsd;
  return Object.keys(snapshot).length ? snapshot : undefined;
}

export type CliParserFactory = () => CliParser;

/** Shared assistant-turn accumulator: text + tool_use/tool_result blocks, and
 *  the "did we emit message_start yet" latch. Both parsers build on this so the
 *  persisted transcript shape matches the live-streaming shape (see protocol.ts). */
class TurnAccumulator {
  text = "";
  started = false;
  ended = false;
  reasoning = "";
  usageSnapshot: UsageSnapshot | undefined;
  readonly toolUses: Array<Record<string, unknown>> = [];
  readonly toolResults: Array<Record<string, unknown>> = [];
  private readonly out: RuntimeMessage[] = [];

  ensureStart(events: RuntimeEvent[]) {
    if (!this.started) {
      this.started = true;
      events.push({ type: "message_start", message: { role: "assistant", content: "" } });
    }
  }

  /**
   * Surface the agent's reasoning/thinking stream as a live intermediate block —
   * the same `{type:"thinking"}` content shape the daemon renders for Pi/Claude
   * (server.ts persistIntermediateFromEvent), so a CLI agent's chain-of-thought
   * shows in the same collapsible sidecar. Kept out of `text` (the answer) and out
   * of persisted history — it's display-only.
   */
  appendReasoning(text: string, events: RuntimeEvent[]) {
    if (!text) return;
    this.reasoning += text;
    events.push({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: this.reasoning }] } });
  }

  /** Merge a best-effort usage snapshot parsed from the agent's output. */
  addUsage(snapshot: UsageSnapshot | undefined) {
    if (snapshot) this.usageSnapshot = snapshot;
  }

  appendText(text: string, events: RuntimeEvent[]) {
    if (!text) return;
    this.ensureStart(events);
    this.text += text;
    events.push({ type: "message_update", message: { role: "assistant", content: this.text } });
  }

  addToolUse(id: string, name: string, input: unknown, events: RuntimeEvent[]) {
    this.toolUses.push({ type: "tool_use", id, name, input: input ?? {} });
    events.push({ type: "tool_call", toolName: name, input, toolCallId: id });
  }

  addToolResult(toolUseId: string, name: string, content: unknown, events: RuntimeEvent[]) {
    this.toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: content ?? "" });
    events.push({ type: "tool_result", toolName: name, result: { toolCallId: toolUseId, content } });
  }

  /** Finalize the turn: emit message_end/turn_end/agent_end and record history. */
  finish(events: RuntimeEvent[]) {
    if (this.ended) return;
    this.ended = true;
    const message = { role: "assistant", content: this.text };
    if (this.toolUses.length || this.toolResults.length) {
      const content: Array<Record<string, unknown>> = [];
      if (this.text) content.push({ type: "text", text: this.text });
      content.push(...this.toolUses);
      if (content.length) this.out.push({ role: "assistant", content });
      if (this.toolResults.length) this.out.push({ role: "user", content: this.toolResults });
    } else if (this.text) {
      this.out.push(message);
    }
    events.push({ type: "message_end", message });
    events.push({ type: "turn_end" });
    events.push({ type: "agent_end" });
  }

  history(): RuntimeMessage[] {
    return this.out;
  }
}

/** Parser for the bivy-agent-protocol JSONL event vocabulary (the universal path). */
export function bivyProtocolParser(): CliParser {
  const acc = new TurnAccumulator();
  return {
    onLine(line) {
      const events: RuntimeEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return events;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return events; // ignore non-JSON noise (banners etc.)
      }
      const type = String(msg.type ?? "");
      if (type === "message.delta") {
        acc.appendText(String(msg.text ?? ""), events);
      } else if (type === "session.status") {
        const status = String(msg.status ?? "");
        if (status === "working") events.push({ type: "turn_start" });
      } else if (type === "tool.call") {
        acc.addToolUse(String(msg.toolCallId ?? msg.id ?? ""), String(msg.name ?? "tool"), msg.input, events);
      } else if (type === "tool.result") {
        acc.addToolResult(String(msg.toolCallId ?? msg.tool_use_id ?? msg.id ?? ""), String(msg.name ?? "tool"), msg.result ?? msg.output ?? msg.content ?? msg.text, events);
      } else if (type === "session.done") {
        acc.finish(events);
      } else if (type === "session.error") {
        events.push({ type: "session.error", error: String(msg.error ?? "Agent error") });
        acc.finish(events);
      }
      return events;
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      if (!acc.ended) {
        if (code && code !== 0 && stderr.trim()) events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
        acc.finish(events);
      }
      return events;
    },
    messages: () => acc.history(),
  };
}

/** Parser for Claude Code CLI `--output-format stream-json`. */
export function claudeStreamJsonParser(): CliParser {
  const acc = new TurnAccumulator();
  return {
    onLine(line) {
      const events: RuntimeEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return events;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return events;
      }
      const type = String(msg.type ?? "");
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown })?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
            if (b.type === "text") acc.appendText(String(b.text ?? ""), events);
            else if (b.type === "tool_use") acc.addToolUse(String(b.id ?? ""), String(b.name ?? "tool"), b.input, events);
          }
        }
      } else if (type === "user") {
        const content = (msg.message as { content?: unknown })?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; tool_use_id?: unknown; content?: unknown };
            if (b.type === "tool_result") acc.addToolResult(String(b.tool_use_id ?? ""), "tool", b.content, events);
          }
        }
      } else if (type === "result") {
        // Final line. If the assistant text never streamed (non-partial mode),
        // seed it from the result string so history isn't empty.
        if (!acc.text && typeof msg.result === "string") acc.appendText(msg.result, events);
        acc.finish(events);
      }
      return events;
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      if (!acc.ended) {
        if (code && code !== 0 && stderr.trim()) events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
        acc.finish(events);
      }
      return events;
    },
    messages: () => acc.history(),
  };
}

/**
 * Parser for Codex `codex exec --json`. Real event model (captured from
 * codex-cli 0.142): a thread with turns, each turn a stream of typed items.
 *   {"type":"thread.started","thread_id":…}
 *   {"type":"turn.started"} / {"type":"turn.completed"} / {"type":"turn.failed","error":{message}}
 *   {"type":"item.completed","item":{"id":…,"type":"agent_message"|"reasoning"|
 *        "command_execution"|"mcp_tool_call"|"file_change"|"error", …}}
 *   {"type":"error","message":…}   ← transient reconnect noise (non-fatal)
 */
export function codexJsonParser(): CliParser {
  const acc = new TurnAccumulator();
  const handleItem = (item: Record<string, unknown>, events: RuntimeEvent[]) => {
    const id = String(item.id ?? "");
    switch (String(item.type ?? "")) {
      case "agent_message":
        acc.appendText(String(item.text ?? ""), events);
        break;
      case "command_execution":
        acc.addToolUse(id, "shell", { command: item.command ?? "" }, events);
        if (item.aggregated_output != null || item.exit_code != null) {
          acc.addToolResult(id, "shell", item.aggregated_output ?? "", events);
        }
        break;
      case "mcp_tool_call":
        acc.addToolUse(id, String(item.tool ?? item.server ?? "mcp"), item.arguments ?? item.input, events);
        if (item.result != null) acc.addToolResult(id, String(item.tool ?? "mcp"), item.result, events);
        break;
      case "file_change":
        acc.addToolUse(id, "apply_patch", { changes: item.changes ?? item }, events);
        break;
      case "reasoning": {
        // Codex reasoning items carry either `text` or a `summary` (string or an
        // array of {text}) — surface whichever is present as a thinking stream.
        const text = typeof item.text === "string"
          ? item.text
          : Array.isArray(item.summary)
            ? item.summary.map((s) => (typeof s === "string" ? s : String((s as Record<string, unknown> | null)?.text ?? ""))).join("")
            : typeof item.summary === "string"
              ? item.summary
              : "";
        acc.appendReasoning(text, events);
        break;
      }
      case "error":
        events.push({ type: "session.error", error: String(item.message ?? "Codex error") });
        break;
      // "todo_list", "web_search" — omitted from the transcript.
    }
  };
  return {
    onLine(line) {
      const events: RuntimeEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") return events; // skip tracing/log noise
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return events;
      }
      switch (String(msg.type ?? "")) {
        case "turn.started":
          events.push({ type: "turn_start" });
          break;
        case "item.completed":
          if (msg.item && typeof msg.item === "object") handleItem(msg.item as Record<string, unknown>, events);
          break;
        case "token_count":
          // Codex streams running token counts as their own event.
          acc.addUsage(extractTokenUsage(msg.info ?? msg.usage));
          break;
        case "turn.completed":
          // `usage` (when present) rides the terminal turn.completed event.
          acc.addUsage(extractTokenUsage((msg as Record<string, unknown>).usage));
          acc.finish(events);
          break;
        case "turn.failed":
          events.push({ type: "session.error", error: String((msg.error as { message?: unknown })?.message ?? "Codex turn failed") });
          acc.finish(events);
          break;
        // top-level "error" = transient reconnect noise; ignore (turn.failed is fatal).
      }
      return events;
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      if (!acc.ended) {
        if (code && code !== 0 && stderr.trim()) events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
        acc.finish(events);
      }
      return events;
    },
    messages: () => acc.history(),
    usage: () => acc.usageSnapshot,
  };
}

/**
 * Parser for Goose `goose run --output-format stream-json`. Real shape (captured
 * from goose 1.41): a stream of message envelopes then a completion.
 *   {"type":"message","message":{"role":"assistant","content":[
 *        {"type":"text","text":…} | {"type":"toolRequest",…} | {"type":"toolResponse",…}]}}
 *   {"type":"complete","total_tokens":…}
 */
export function gooseStreamJsonParser(): CliParser {
  const acc = new TurnAccumulator();
  return {
    onLine(line) {
      const events: RuntimeEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") return events; // skip the ascii banner
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return events;
      }
      const type = String(msg.type ?? "");
      if (type === "message") {
        const message = (msg.message ?? {}) as { role?: unknown; content?: unknown };
        // Only surface assistant content; user/tool echoes are already in the transcript.
        const content = Array.isArray(message.content) ? message.content : [];
        for (const raw of content) {
          const block = (raw ?? {}) as Record<string, unknown>;
          const bt = String(block.type ?? "");
          if (bt === "text") {
            if (message.role !== "user") acc.appendText(String(block.text ?? ""), events);
          } else if (bt === "toolRequest" || bt === "frontendToolRequest") {
            const call = (block.toolCall ?? block.tool_call ?? block) as Record<string, unknown>;
            acc.addToolUse(String(block.id ?? ""), String(call.name ?? block.name ?? "tool"), call.arguments ?? call.args ?? block.arguments, events);
          } else if (bt === "toolResponse") {
            const result = (block.toolResult ?? block.tool_result ?? block.result) as unknown;
            acc.addToolResult(String(block.id ?? ""), "tool", result, events);
          }
        }
      } else if (type === "complete") {
        // `complete` carries the turn's token totals (e.g. total_tokens).
        acc.addUsage(extractTokenUsage(msg));
        acc.finish(events);
      }
      return events;
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      if (!acc.ended) {
        if (code && code !== 0 && stderr.trim()) events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
        acc.finish(events);
      }
      return events;
    },
    messages: () => acc.history(),
    usage: () => acc.usageSnapshot,
  };
}

/**
 * Parser for Gemini `gemini -o json`. Real shape (captured from gemini-cli 0.49):
 * ONE (pretty-printed) JSON object at the end — not a stream — of the form
 *   { "session_id": …, "response": "…assistant text…", "stats": {…}, "error"?: {message} }
 * We accumulate all stdout and parse it once at close.
 */
export function geminiJsonParser(): CliParser {
  const acc = new TurnAccumulator();
  let raw = "";
  return {
    onLine(line) {
      raw += `${line}\n`;
      return [];
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      let obj: Record<string, unknown> | undefined;
      try {
        obj = JSON.parse(raw.trim());
      } catch {
        obj = undefined;
      }
      if (obj && (obj.error as { message?: unknown } | undefined)?.message) {
        events.push({ type: "session.error", error: String((obj.error as { message?: unknown }).message) });
      } else if (obj && typeof obj.response === "string") {
        acc.appendText(obj.response, events);
      } else if (code && code !== 0 && stderr.trim()) {
        events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
      } else if (raw.trim()) {
        // Not the expected JSON envelope — surface the text so nothing is lost.
        acc.appendText(raw.trim(), events);
      }
      // Token counts live under `stats` (shape varies by version — extract defensively).
      if (obj) acc.addUsage(extractTokenUsage(obj.stats) ?? extractTokenUsage((obj.stats as Record<string, unknown> | undefined)?.tokens));
      acc.finish(events);
      return events;
    },
    messages: () => acc.history(),
    usage: () => acc.usageSnapshot,
  };
}

/** Registry: parser id → factory. Adding an agent's fidelity = add a line here. */
export const CLI_PARSERS: Record<string, CliParserFactory> = {
  "bivy-protocol": bivyProtocolParser,
  "claude-stream-json": claudeStreamJsonParser,
  "codex-json": codexJsonParser,
  "goose-stream-json": gooseStreamJsonParser,
  "gemini-json": geminiJsonParser,
};

export function parserFactoryFor(id: string | undefined): CliParserFactory | undefined {
  if (!id) return undefined;
  return CLI_PARSERS[id];
}
