// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — structured chat fidelity for CLI agents.
//
// Governance already works for ANY agent because it wraps effects,
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
import { mapToolCall, mapToolResult, type ToolCallMapContext } from "./tool-call-map.js";
import { traceToolPayload } from "./tool-trace.js";

export interface CliParser {
  /** Feed one complete stdout line; return normalized events to emit. */
  onLine(line: string): RuntimeEvent[];
  /** Called when the process exits; return any closing events (message_end/agent_end). */
  onClose(code: number | null, stderr: string): RuntimeEvent[];
  /** The conversation messages to persist for history (built at close). */
  messages(): RuntimeMessage[];
  /** Best-effort token/cost usage parsed from the agent's own output, or undefined. */
  usage?(): UsageSnapshot | undefined;
  /** Native conversation reference learned from structured output. A fresh
   * process session uses this to continue the same upstream conversation on its
   * next turn and to persist an honest resume token. */
  sessionRef?(): string | undefined;
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
  const input = num("input_tokens", "prompt_tokens", "promptTokenCount", "inputTokens", "input", "prompt");
  const output = num("output_tokens", "completion_tokens", "candidatesTokenCount", "outputTokens", "output", "completion");
  const cacheRead = num("cache_read_input_tokens", "cached_input_tokens", "cachedContentTokenCount", "cachedInputTokens", "cache_read");
  const cacheWrite = num("cache_creation_input_tokens", "cache_write_input_tokens", "cacheWriteInputTokens", "cache_write");
  const total = num("total_tokens", "totalTokenCount", "totalTokens", "total") ?? ((input ?? 0) + (output ?? 0) || undefined);
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
  readonly toolResults: Array<Record<string, unknown>> = [];
  // Ordered content blocks (text + tool_use, interleaved exactly as they
  // streamed) for the assistant turn. A prior version tracked `text` and tool
  // uses separately and always emitted the whole turn's text ahead of every
  // tool call on finish() — collapsing a turn like "Let me check." → tool →
  // "Now editing." → tool into one merged text block followed by both tools.
  // That read as interim messages "disappearing"/bundling at the end once
  // history reconciled against it. `textFlushed` is the prefix of `text`
  // already sealed into `content` as its own block.
  private readonly content: Array<Record<string, unknown>> = [];
  private textFlushed = "";
  // A tool call interrupts the assistant's prose/reasoning: the text that
  // resumes after it is a NEW message segment, not a continuation of the last
  // token. Without a separator the two run together ("…what it does.The next…",
  // "…shell commandI have…") — exactly the seam the governed ProtocolRuntime
  // guards with its `assistantItemBoundary` \n\n insertion. Mirror that here so
  // every CliParser agent (Grok, Goose, Gemini, the generic streams) gets the
  // same clean paragraph break instead of a concatenated blob. Tracked per
  // stream because text and reasoning accumulate into separate buffers.
  private pendingTextBoundary = false;
  private pendingReasoningBoundary = false;
  private readonly out: RuntimeMessage[] = [];
  private readonly details = new Map<string, ReturnType<typeof mapToolCall>>();
  // Not every CLI includes a stable id on both halves of a tool exchange.
  // Keep a small FIFO of open calls so the universal parser can still pair an
  // anonymous result with its call instead of creating a second, forever-running
  // card in the transcript.
  private readonly openToolIds: string[] = [];
  private anonymousToolId = 0;

  private flushPendingText() {
    const pending = this.text.slice(this.textFlushed.length);
    this.textFlushed = this.text;
    if (pending) this.content.push({ type: "text", text: pending });
  }

  constructor(
    private readonly toolContext: ToolCallMapContext,
    // Native CLI streams (Grok, Goose, Claude/Codex JSON, …) start a fresh
    // prose/reasoning segment after each tool call without re-emitting a
    // separator, so we infer the paragraph break. The bivy-agent-protocol path
    // instead carries continuation faithfully (a shim can emit an explicit
    // boundary when it wants one), so it opts out.
    private readonly inferSegmentBoundaries = true,
  ) {}

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
    if (this.pendingReasoningBoundary && this.reasoning) this.reasoning += "\n\n";
    this.pendingReasoningBoundary = false;
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
    if (this.pendingTextBoundary && this.text) {
      // Advance the sealed prefix over the display-only separator when the prior
      // segment was already flushed to a content block, so the next persisted
      // block holds `Second message`, not `\n\nSecond message` (matching
      // ProtocolRuntime). The cumulative `text` still carries the break for the
      // live stream and the final answer.
      const wasFullyFlushed = this.textFlushed === this.text;
      this.text += "\n\n";
      if (wasFullyFlushed) this.textFlushed = this.text;
    }
    this.pendingTextBoundary = false;
    this.text += text;
    events.push({ type: "message_update", message: { role: "assistant", content: this.text } });
  }

  addToolUse(id: string, name: string, input: unknown, events: RuntimeEvent[]) {
    const callId = id || `cli-tool-${++this.anonymousToolId}`;
    this.openToolIds.push(callId);
    traceToolPayload({ phase: "call", context: this.toolContext, name, callId, payload: input });
    // Attach a normalized ToolCallDetail (display-only) so the PWA renders this
    // call the same way it renders every other agent's equivalent call. Absent
    // when unrecognized — the block stays opaque and renders as before.
    const detail = mapToolCall(name, input, this.toolContext);
    if (detail) this.details.set(callId, detail);
    this.flushPendingText();
    // Prose/reasoning that resumes after this call is a fresh segment — arm the
    // boundary so the next appendText/appendReasoning inserts a separator.
    if (this.inferSegmentBoundaries) {
      this.pendingTextBoundary = true;
      this.pendingReasoningBoundary = true;
    }
    this.content.push({ type: "tool_use", id: callId, name, input: input ?? {}, ...(detail ? { detail } : {}) });
    events.push({ type: "tool_call", toolName: name, input, toolCallId: callId, ...(detail ? { detail } : {}) });
  }

  addToolResult(toolUseId: string, name: string, content: unknown, events: RuntimeEvent[], isError = false) {
    // Prefer the explicit id. Otherwise close the oldest open call, which is
    // the only generally safe correlation available from an id-less stream.
    const callId = toolUseId || this.openToolIds.shift() || `cli-tool-result-${++this.anonymousToolId}`;
    if (toolUseId) {
      const index = this.openToolIds.indexOf(toolUseId);
      if (index >= 0) this.openToolIds.splice(index, 1);
    }
    traceToolPayload({ phase: "result", context: this.toolContext, name, callId, payload: content });
    const prior = this.details.get(callId);
    const detail = prior ? { ...prior, result: mapToolResult(content, isError) } : undefined;
    if (detail) this.details.set(callId, detail);
    this.toolResults.push({ type: "tool_result", tool_use_id: callId, content: content ?? "", ...(detail ? { detail } : {}) });
    events.push({ type: "tool_result", toolName: name, result: { toolCallId: callId, content }, ...(detail ? { detail } : {}) });
  }

  /** Finalize the turn: emit message_end/turn_end/agent_end and record history. */
  finish(events: RuntimeEvent[]) {
    if (this.ended) return;
    this.ended = true;
    // Whether this turn ever used a tool — checked BEFORE flushing trailing
    // text, so a tool-free turn (content still empty at this point) keeps the
    // plain-text message shape it always had instead of gaining a pointless
    // single-text-block wrapper.
    const hadTools = this.content.length > 0 || this.toolResults.length > 0;
    const message = { role: "assistant", content: this.text };
    if (hadTools) {
      this.flushPendingText();
      if (this.content.length) this.out.push({ role: "assistant", content: this.content });
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
  // The universal protocol carries continuation faithfully: text after a tool is
  // appended verbatim (a shim emits an explicit break when it wants one), so it
  // opts out of inferred segment boundaries.
  const acc = new TurnAccumulator({ provider: "bivy-protocol", protocol: "protocol" }, false);
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
  const acc = new TurnAccumulator({ provider: "claude", protocol: "structured-pipe" });
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
 *   {"type":"item.started","item":{…}}   ← a shell/patch/MCP call begins (live card)
 *   {"type":"item.completed","item":{"id":…,"type":"agent_message"|"reasoning"|
 *        "command_execution"|"mcp_tool_call"|"file_change"|"error", "status":…, …}}
 *   {"type":"error","message":…}   ← transient reconnect noise (non-fatal)
 * A `file_change`/`command_execution` item carries a terminal `status`
 * (`completed`|`failed`); a `failed` one is surfaced as an errored tool result
 * rather than a silent success (mirrors the governed app-server shim).
 */
export function codexJsonParser(): CliParser {
  const acc = new TurnAccumulator({ provider: "codex", protocol: "structured-pipe" });
  let sessionRef: string | undefined;
  // Tool ids already surfaced as a running card, so `item.started` (live) and the
  // later `item.completed` (terminal) render one card per call, not two.
  const startedTools = new Set<string>();
  const ensureToolUse = (id: string, name: string, input: unknown, events: RuntimeEvent[]) => {
    if (id && startedTools.has(id)) return;
    if (id) startedTools.add(id);
    acc.addToolUse(id, name, input, events);
  };
  // A tool item begins. Codex emits `item.started` for shell/patch/MCP calls
  // before the matching `item.completed`, so surfacing it shows a long-running
  // command or patch as a live "running" card instead of nothing until it ends.
  const handleStarted = (item: Record<string, unknown>, events: RuntimeEvent[]) => {
    const id = String(item.id ?? "");
    switch (String(item.type ?? "")) {
      case "command_execution":
        ensureToolUse(id, "shell", { command: item.command ?? "" }, events);
        break;
      case "file_change":
        ensureToolUse(id, "apply_patch", { changes: item.changes ?? item }, events);
        break;
      case "mcp_tool_call":
        ensureToolUse(id, String(item.tool ?? item.server ?? "mcp"), item.arguments ?? item.input, events);
        break;
    }
  };
  const handleItem = (item: Record<string, unknown>, events: RuntimeEvent[]) => {
    const id = String(item.id ?? "");
    switch (String(item.type ?? "")) {
      case "agent_message":
        acc.appendText(String(item.text ?? ""), events);
        break;
      case "command_execution":
        ensureToolUse(id, "shell", { command: item.command ?? "" }, events);
        if (item.aggregated_output != null || item.exit_code != null || item.status != null) {
          acc.addToolResult(id, "shell", { content: item.aggregated_output ?? "", exitCode: item.exit_code }, events, Number(item.exit_code) !== 0 || item.status === "failed");
        }
        break;
      case "mcp_tool_call":
        ensureToolUse(id, String(item.tool ?? item.server ?? "mcp"), item.arguments ?? item.input, events);
        if (item.result != null || item.error != null || item.status != null) {
          acc.addToolResult(id, String(item.tool ?? "mcp"), item.result ?? item.error ?? item.status, events, item.error != null || item.status === "failed");
        }
        break;
      case "file_change": {
        ensureToolUse(id, "apply_patch", { changes: item.changes ?? item }, events);
        // `file_change` is terminal in `exec --json` (no separate result event),
        // so close the card with a result reflecting its status. Without this a
        // completed patch hangs as "running" and — worse — a FAILED patch renders
        // as a successful edit. Mirrors the app-server shim's handling.
        const status = String(item.status ?? "completed");
        acc.addToolResult(id, "apply_patch", status, events, status === "failed");
        break;
      }
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
        case "thread.started":
          if (typeof msg.thread_id === "string" && msg.thread_id.trim()) sessionRef = msg.thread_id.trim();
          break;
        case "turn.started":
          events.push({ type: "turn_start" });
          break;
        case "item.started":
          if (msg.item && typeof msg.item === "object") handleStarted(msg.item as Record<string, unknown>, events);
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
    sessionRef: () => sessionRef,
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
  const acc = new TurnAccumulator({ provider: "goose", protocol: "structured-pipe" });
  let sessionRef: string | undefined;
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
      const ref = msg.session_id ?? msg.sessionId;
      if (typeof ref === "string" && ref.trim()) sessionRef = ref.trim();
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
    sessionRef: () => sessionRef,
  };
}

/**
 * Parser for Gemini `gemini -o json`. Real shape (captured from gemini-cli 0.49):
 * ONE (pretty-printed) JSON object at the end — not a stream — of the form
 *   { "session_id": …, "response": "…assistant text…", "stats": {…}, "error"?: {message} }
 * We accumulate all stdout and parse it once at close.
 */
export function geminiJsonParser(): CliParser {
  const acc = new TurnAccumulator({ provider: "gemini", protocol: "structured-pipe" });
  let raw = "";
  let sessionRef: string | undefined;
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
      const ref = obj?.session_id ?? obj?.sessionId;
      if (typeof ref === "string" && ref.trim()) sessionRef = ref.trim();
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
    sessionRef: () => sessionRef,
  };
}

/**
 * Pull a plain-text chunk out of a heterogeneous streaming-JSON event, covering
 * the shapes the popular agent CLIs emit (Claude/ACP assistant blocks, OpenAI
 * chat deltas, and flat `{text|content|response|…}` fields). Returns "" when the
 * event carries no assistant text (a control frame), so the caller can ignore it.
 */
function textFromStreamEvent(msg: Record<string, unknown>): string {
  // ACP session/update notifications nest the update below JSON-RPC params.
  // Grok's streaming-json mode uses this standard shape, while other CLIs put
  // the same content directly on the event. Unwrap it before applying the
  // broad fallbacks below so ACP remains a generic capability, not an agent
  // specific parser.
  const nested = (msg.params as Record<string, unknown> | undefined)?.update
    ?? (msg.update as Record<string, unknown> | undefined);
  const source: Record<string, unknown> = nested && typeof nested === "object" ? nested as Record<string, unknown> : msg;
  const nestedContent = (source.content as { text?: unknown } | undefined);
  if (nestedContent && typeof nestedContent.text === "string") return nestedContent.text;

  // Claude / ACP assistant shape: { message: { content: [{type:"text",text}] } }.
  const mc = (source.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(mc)) {
    return mc.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
  }
  if (typeof mc === "string") return mc;
  // OpenAI-style delta: { delta: { content|text } } or { choices:[{delta:{content}}] }.
  const delta = msg.delta as { content?: unknown; text?: unknown } | undefined;
  if (delta) {
    if (typeof delta.text === "string") return delta.text;
    if (typeof delta.content === "string") return delta.content;
  }
  const choices = msg.choices as Array<{ delta?: { content?: unknown }; text?: unknown }> | undefined;
  if (Array.isArray(choices)) {
    return choices.map((c) => (typeof c?.delta?.content === "string" ? (c.delta!.content as string) : typeof c?.text === "string" ? (c.text as string) : "")).join("");
  }
  // Flat string fields, in priority order.
  for (const k of ["text", "content", "response", "message", "output", "chunk"]) {
    const v = msg[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/** Flatten an ACP `ContentBlock[]` (or a single block/string) to plain text.
 * ACP tool updates carry their human-readable output as content blocks —
 * `[{type:"content", content:{type:"text", text}}]` or `[{type:"text", text}]` —
 * which is the display-normalized form to prefer over a raw byte dump. Returns
 * undefined when there is no usable text (so callers fall back to rawOutput). */
function flattenAcpContent(value: unknown): string | undefined {
  const walk = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(walk).join("");
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") return o.text;
      if (o.content !== undefined) return walk(o.content);
    }
    return "";
  };
  const text = walk(value);
  return text.trim() ? text : undefined;
}

/** Extract a numeric exit code from a raw tool-output object, if present. */
function rawExitCode(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const exit = o.exit_code ?? o.exitCode ?? o.code;
  return typeof exit === "number" ? exit : undefined;
}

/** Extract an ACP-style tool update. Two transports converge here:
 *   1. A JSON-RPC `session/update` notification (`params.update`), the true ACP
 *      wire form used by Gemini/Qwen/Copilot etc.
 *   2. A TOP-LEVEL tool frame (`{type:"tool_call", toolCallId, toolName,
 *      rawInput}` / `{type:"tool_call_update", …, rawOutput}`) — the shape the
 *      Grok CLI's `--output-format streaming-json` emits without the JSON-RPC
 *      envelope. Both name the same fields, so one mapper renders both as the
 *      same tool cards (no per-agent branch). */
function acpToolUpdate(msg: Record<string, unknown>): {
  kind: "call" | "result";
  id: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  error?: boolean;
} | undefined {
  const params = msg.params as Record<string, unknown> | undefined;
  // Fall back to the message itself so a top-level tool frame (Grok) is read the
  // same way as a nested `session/update` (canonical ACP). A non-tool top-level
  // frame has no toolCallId and is rejected by the `id` guard below.
  const update = (params?.update ?? msg.update ?? msg) as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object") return undefined;
  const type = String(update.sessionUpdate ?? update.type ?? "").toLowerCase();
  const id = String(update.toolCallId ?? update.tool_call_id ?? update.id ?? "");
  if (!id) return undefined;
  if (type === "tool_call" || type === "tool_call_started" || type === "tool_call_start") {
    return { kind: "call", id, name: String(update.title ?? update.toolName ?? update.name ?? "tool"), input: update.rawInput ?? update.input ?? update.arguments };
  }
  if (type === "tool_call_update" || type === "tool_result" || type === "tool_call_completed") {
    const status = String(update.status ?? "").toLowerCase();
    const terminal = status === "completed" || status === "complete" || status === "success" || status === "done" || status === "failed" || status === "error";
    const hasStatus = update.status !== undefined && update.status !== null && String(update.status).trim() !== "";
    const raw = update.rawOutput ?? update.output ?? update.result;
    // A CLI that streams progress (Grok) tags every frame with a non-terminal
    // status and a partial payload — only a terminal status closes the card. A
    // CLI that sends a single result frame with no status closes as soon as a
    // payload lands. This prevents both a premature close and a duplicate card.
    if (type === "tool_call_update" && (hasStatus ? !terminal : raw === undefined)) return undefined;
    // Prefer the display-normalized ACP content text over a raw payload (Grok's
    // rawOutput.output is a byte array that would render as garbage). Preserve
    // the exit code from the raw payload when we take the content text instead.
    const contentText = flattenAcpContent(update.content);
    const exit = rawExitCode(raw);
    const output = contentText !== undefined
      ? (exit !== undefined ? { content: contentText, exit_code: exit } : contentText)
      : (raw ?? update.content);
    return { kind: "result", id, output, error: status === "failed" || status === "error" };
  }
  return undefined;
}

// Event `type` values that mean "the turn is finished" across the various CLIs.
const STREAM_TERMINALS = new Set(["result", "done", "complete", "completed", "turn.completed", "session.done", "session_end", "session/ended", "message_stop", "response.completed", "final", "end"]);

// Event `type` values whose chunk (in a `data` field) is assistant answer prose
// vs. reasoning/thinking. Used by the generic streaming parser to support CLIs
// (e.g. Grok) that key the content off `type` with the text under `data`.
const STREAM_TEXT_TYPES = new Set(["text", "assistant", "answer", "agent_message", "assistant_message", "output_text", "response_text"]);
const STREAM_REASONING_TYPES = new Set(["thought", "thinking", "reasoning"]);

/**
 * A TOLERANT line-delimited JSON parser for CLIs whose `--stream-json` /
 * `--format json` streaming vocabularies we haven't pinned exactly (Amp, Cursor,
 * …). It extracts assistant text and token usage from the common shapes, ignores
 * control frames it doesn't recognize, and — crucially — if a run produced NO
 * structured text (e.g. the flag was wrong and the CLI printed plain text, or the
 * schema is entirely unfamiliar), it surfaces the raw output at close so enabling
 * it can never LOSE the reply (worst case it degrades to the dumb-pipe view).
 */
export function genericStreamJsonParser(): CliParser {
  const acc = new TurnAccumulator({ provider: "generic", protocol: "structured-pipe" });
  let sawText = false;
  let rawBuffer = "";
  return {
    onLine(line) {
      const events: RuntimeEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return events;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        rawBuffer += `${line}\n`; // non-JSON banner/line — hold for the fallback
        return events;
      }
      acc.addUsage(extractTokenUsage(msg.usage ?? msg.stats ?? msg));
      const nestedUpdate = ((msg.params as Record<string, unknown> | undefined)?.update
        ?? (msg.update as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined;
      const type = String(msg.type ?? msg.method ?? nestedUpdate?.sessionUpdate ?? nestedUpdate?.type ?? "");
      // Typed error frame — `{type:"error", message}` (Grok's streaming-json and
      // other ACP-style CLIs), `session/error`, `turn.error`, … — as opposed to
      // the `{error:{message}}` envelope handled below. Recognize it as data
      // (a suffix match, no per-agent branch) so the message is surfaced as a
      // real turn error instead of leaking into the transcript as assistant
      // prose via the broad `message` text fallback in textFromStreamEvent.
      const lowerType = type.toLowerCase();
      const isErrorFrame = /(^|[._:/])error$/.test(lowerType);
      const tool = acpToolUpdate(msg);
      if (tool?.kind === "call") acc.addToolUse(tool.id, tool.name ?? "tool", tool.input, events);
      else if (tool?.kind === "result") acc.addToolResult(tool.id, tool.name ?? "tool", tool.output, events, tool.error);
      if (msg.error && !type.includes("delta")) {
        const m = (msg.error as { message?: unknown }).message ?? msg.error;
        events.push({ type: "session.error", error: String(m) });
      } else if (isErrorFrame) {
        const m = msg.message ?? (msg.error as unknown) ?? msg.detail ?? msg.reason;
        if (typeof m === "string" && m.trim()) events.push({ type: "session.error", error: m.trim() });
      }
      // Reasoning/thinking stream carried as a typed chunk keyed by `type` with
      // the content in a `data` field (Grok's streaming-json: {type:"thought",
      // data}). Surface it as the same display-only thinking sidecar every agent
      // uses, never as answer prose — a generic shape, not a per-agent branch.
      if (!isErrorFrame && STREAM_REASONING_TYPES.has(lowerType) && typeof msg.data === "string") {
        acc.appendReasoning(msg.data, events);
        return events;
      }
      // Assistant answer text. Most CLIs expose it via one of the fields
      // textFromStreamEvent covers; some (Grok) put it in `data` keyed by an
      // assistant-text `type`. Fall back to `data` only for those types so an
      // unrelated control frame's `data` never leaks into the transcript.
      let text = isErrorFrame ? "" : textFromStreamEvent(msg);
      if (!text && !isErrorFrame && typeof msg.data === "string" && STREAM_TEXT_TYPES.has(lowerType)) text = msg.data;
      if (text && !STREAM_TERMINALS.has(type)) {
        acc.appendText(text, events);
        sawText = true;
      }
      if (STREAM_TERMINALS.has(type)) {
        if (!sawText && text) {
          acc.appendText(text, events);
          sawText = true;
        }
        acc.finish(events);
      }
      return events;
    },
    onClose(code, stderr) {
      const events: RuntimeEvent[] = [];
      if (!acc.ended) {
        // Nothing structured came through: fall back to whatever the CLI printed so
        // the turn is never silently empty.
        if (!sawText && rawBuffer.trim()) acc.appendText(rawBuffer.trim(), events);
        else if (!sawText && code && code !== 0 && stderr.trim()) events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
        acc.finish(events);
      }
      return events;
    },
    messages: () => acc.history(),
    usage: () => acc.usageSnapshot,
  };
}

/**
 * A TOLERANT final-object JSON parser for CLIs that buffer their reply and print a
 * single JSON object at exit (`--format json`). It extracts the assistant text
 * from whichever of the common fields is present (`response`/`result`/`text`/
 * `content`/`message`/`output`) and token usage from anywhere, and falls back to
 * the raw output if the object isn't a shape it recognizes — same never-lose-the-
 * reply guarantee as the streaming parser.
 */
export function genericJsonParser(): CliParser {
  const acc = new TurnAccumulator({ provider: "generic", protocol: "structured-pipe" });
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
      const errMsg = obj && (obj.error as { message?: unknown } | undefined)?.message;
      if (errMsg) {
        events.push({ type: "session.error", error: String(errMsg) });
      } else if (obj) {
        let text = "";
        for (const k of ["response", "result", "text", "content", "output", "message"]) {
          const v = obj[k];
          if (typeof v === "string") { text = v; break; }
          if (Array.isArray(v)) { text = v.map((b) => (typeof b === "string" ? b : String((b as { text?: unknown })?.text ?? ""))).join(""); if (text) break; }
        }
        if (text) acc.appendText(text, events);
        else if (raw.trim()) acc.appendText(raw.trim(), events); // unfamiliar shape → raw
        acc.addUsage(extractTokenUsage(obj.usage ?? obj.stats ?? obj) ?? extractTokenUsage((obj.stats as Record<string, unknown> | undefined)?.tokens));
      } else if (code && code !== 0 && stderr.trim()) {
        events.push({ type: "session.error", error: stderr.trim().slice(-2000) });
      } else if (raw.trim()) {
        acc.appendText(raw.trim(), events);
      }
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
  // Tolerant, format-agnostic parsers for CLIs whose JSON vocabularies we haven't
  // pinned exactly yet (opt-in per agent via a spec parserId; see AGENT_PROFILES).
  "generic-stream-json": genericStreamJsonParser,
  "generic-json": genericJsonParser,
};

export function parserFactoryFor(id: string | undefined): CliParserFactory | undefined {
  if (!id) return undefined;
  return CLI_PARSERS[id];
}
