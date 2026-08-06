// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Wire protocol + framing codec for the remote agent runtime (Stage 1 of
 * docs/agent-node-decoupling.md).
 *
 * The node daemon drives an agent that lives in a SEPARATE process — the "agent
 * service" — over a duplex byte stream (a Unix socket or a loopback TCP socket)
 * instead of spawning it as its own `child_process`. This module is the small,
 * versioned contract between the two:
 *
 *   daemon (RemoteRuntimeSession)  ⇄  agent service (real runtime + child)
 *
 * It is deliberately dependency-free (only `node:buffer` types, erased at
 * compile) so it unit-tests without a socket, mirroring the injectable style of
 * `services/relay/src/backpressure.ts` and `src/session-event-coalescer.ts`.
 *
 * Framing: every message is a UTF-8 JSON object prefixed by a 4-byte big-endian
 * unsigned length. This is a raw-stream framing, distinct from the relay's WS
 * chunker (`src/relay-chunk.ts`), which frames already-sealed payloads for the
 * 256 KiB WebSocket message cap. The two do not overlap: this link is the
 * daemon↔service hop, the relay chunker is the daemon↔client hop.
 *
 * The payloads that cross this link (prompts, runtime events, transcripts) are
 * the same opaque conversation content the daemon already handles; nothing here
 * changes the daemon→client E2E wire contract, which server.ts still seals as
 * today. When this link later rides shared infrastructure it MUST be sealed with
 * the E2E utilities (`src/wire-format.ts`); the framing below is transport-level.
 */

import type {
  AgentCommand,
  ModelInfo,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  ToolCallDecision,
  ToolResult,
  ToolSpec,
  TuiLaunchSpec,
  UsageSnapshot,
} from "./types.js";

/**
 * Protocol version. Bump on any breaking change to the message shapes below.
 * The handshake (`start`) carries it so a daemon and service that disagree fail
 * loudly at connect time instead of misparsing frames mid-session.
 */
export const RPC_PROTOCOL_VERSION = 1;

/** 4-byte big-endian length prefix; guards against a hostile/buggy peer. */
export const FRAME_HEADER_BYTES = 4;
/** Hard cap on a single decoded frame. Generous — a big diff/file read fits. */
export const MAX_RPC_FRAME_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// State mirror
// ---------------------------------------------------------------------------

/**
 * The subset of a `RuntimeSession`'s state that the daemon reads SYNCHRONOUSLY
 * (getMessages/getName/getCurrentModel/isStreaming/sessionFile/activePid/…) and
 * therefore cannot round-trip on demand. The service mirrors it to the daemon:
 * a full snapshot in the `start` reply, then partial deltas riding each event
 * (and standalone `state` frames). Fields absent from a partial delta are left
 * unchanged on the daemon's local mirror.
 *
 * Timing invariant (see docs/agent-node-decoupling.md "Failure semantics" and
 * src/runtime/process.ts): `messages`, `sessionFile` and streaming flags must be
 * current BY THE TIME `agent_end` is delivered, because the daemon's agent_end
 * handler reads them for usage refresh, worktree diff and PR detection. The
 * service therefore attaches the mutated fields to the SAME `event` frame that
 * carries `agent_end`, so the daemon applies them before re-emitting the event.
 */
export interface PartialSnapshot {
  isStreaming?: boolean;
  sessionFile?: string | null;
  name?: string | null;
  currentModel?: ModelInfo | null;
  activePid?: number | null;
  thinkingLevel?: string | null;
  /** Present only when the transcript changed (message-boundary events). */
  messages?: RuntimeMessage[];
}

/** The full mirror handed back when a session starts, opens, or is re-attached. */
export interface InitialSnapshot extends PartialSnapshot {
  sessionId: string;
  cwd: string;
  isStreaming: boolean;
  messages: RuntimeMessage[];
  /** Static-ish capability surface the daemon reports for this runtime. */
  capabilities: RuntimeCapabilities;
  supportsThinking: boolean;
  availableThinkingLevels: string[];
  commands: AgentCommand[];
  /** Non-fatal open note (e.g. requested model unavailable, fallback used). */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Method surfaces
// ---------------------------------------------------------------------------

/**
 * `RuntimeSession` methods that are genuinely async in the contract and so are
 * serviced by a request/response round-trip (as opposed to the synchronous
 * accessors, which read the mirror above).
 */
export type RpcMethod =
  | "prompt"
  | "abort"
  | "setModel"
  | "getModels"
  | "getAllModels"
  | "getUsage"
  | "suggestName"
  | "invokeCommand"
  | "interactiveTuiCommand";

/** Void, fire-and-forget mutations (the synchronous void setters + dispose). */
export type RpcNotify = "setName" | "setThinkingLevel" | "dispose";

/**
 * `AgentRuntime`-level (session-less) calls the daemon makes against the remote
 * runtime — session discovery and store cleanup. Issued on a short-lived
 * connection that carries no `start`. `readMessages` is intentionally absent:
 * it is synchronous in the contract and cannot round-trip, so the RemoteRuntime
 * leaves it undefined and the daemon falls back to a full open (exactly as
 * Claude Code does today).
 */
export type RuntimeRpcMethod = "listSessions" | "deleteSession";

/** How the service should bind the underlying real session on connect. */
export type StartOp = "create" | "open" | "attach";

export interface StartOptions {
  /** Workspace/cwd for create|open. */
  workspace?: string;
  /** Resume ref for `open` (a path for pi, a session id for Claude Code). */
  sessionFile?: string;
  /** Existing service-side session id for `attach` (reconnect after a drop). */
  sessionId?: string;
  /**
   * Whether the daemon supplied a tool interceptor. When true the service wires
   * the real session's interceptor to call back over this link (reverse RPC),
   * so the daemon's guardian/QuestionManager still adjudicates every tool —
   * AskUserQuestion included — exactly as in-process. Never ships the function.
   */
  hasToolInterceptor?: boolean;
  /**
   * Node-hosted tools (Bivy integrations / MCP) the daemon offers this session.
   * Only the serializable specs cross the link; when present the service builds a
   * proxy ToolProvider whose invoke() calls back to the daemon (reverse RPC via
   * `tool-invoke`), so the tools execute on the daemon where their credentials
   * live. Absent/empty = no extra tools. Runtime-agnostic: the service hands the
   * proxy to whatever runtime it hosts, exactly as the daemon would in-process.
   */
  toolSpecs?: ToolSpec[];
}

// ---------------------------------------------------------------------------
// Messages: daemon → service
// ---------------------------------------------------------------------------

export interface StartRequest {
  t: "start";
  id: number;
  protocol: number;
  runtime: string;
  sandbox?: string;
  op: StartOp;
  options: StartOptions;
}

export interface MethodRequest {
  t: "req";
  id: number;
  method: RpcMethod;
  args: unknown[];
}

export interface NotifyMessage {
  t: "notify";
  method: RpcNotify;
  args: unknown[];
}

/** A session-less runtime-level call (see RuntimeRpcMethod). */
export interface RuntimeRequest {
  t: "rt";
  id: number;
  protocol: number;
  runtime: string;
  sandbox?: string;
  method: RuntimeRpcMethod;
  args: unknown[];
}

/** Daemon's verdict for a service-issued `intercept` (the tool-approval reply). */
export interface InterceptResult {
  t: "intercept-res";
  id: number;
  decision: ToolCallDecision;
}

/** Daemon's result for a service-issued `tool-invoke` (a node-hosted tool ran). */
export interface ToolInvokeResult {
  t: "tool-invoke-res";
  id: number;
  result: ToolResult;
}

export type ClientMessage = StartRequest | RuntimeRequest | MethodRequest | NotifyMessage | InterceptResult | ToolInvokeResult;

// ---------------------------------------------------------------------------
// Messages: service → daemon
// ---------------------------------------------------------------------------

export interface StartedResponse {
  t: "started";
  id: number;
  snapshot: InitialSnapshot;
}

export type MethodResponse =
  | { t: "res"; id: number; ok: true; value: unknown; snapshot?: PartialSnapshot }
  | { t: "res"; id: number; ok: false; error: string };

/** A forwarded runtime event, with an optional state delta to apply first. */
export interface EventMessage {
  t: "event";
  event: RuntimeEvent;
  snapshot?: PartialSnapshot;
}

/** A standalone mirror update not tied to a runtime event. */
export interface StateMessage {
  t: "state";
  snapshot: PartialSnapshot;
}

/** Reverse RPC: the real session is asking the daemon to adjudicate a tool. */
export interface InterceptRequest {
  t: "intercept";
  id: number;
  ctx: { sessionId: string; toolName: string; input: unknown };
}

/**
 * Reverse RPC: the real session (on the service) is asking the daemon to EXECUTE
 * a node-hosted tool (one of the session's `toolSpecs`). The daemon runs it via
 * its ToolProvider — where the credentials live — and replies `tool-invoke-res`.
 */
export interface ToolInvokeRequest {
  t: "tool-invoke";
  id: number;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  params: unknown;
}

export type ServerMessage =
  | StartedResponse
  | MethodResponse
  | EventMessage
  | StateMessage
  | InterceptRequest
  | ToolInvokeRequest;

export type RpcMessage = ClientMessage | ServerMessage;

// Re-exported so consumers don't reach back into ./types for these shapes.
export type { RuntimeEvent, ToolCallDecision, ToolResult, ToolSpec, TuiLaunchSpec, UsageSnapshot, ModelInfo };

// ---------------------------------------------------------------------------
// Framing codec
// ---------------------------------------------------------------------------

/** Encode one message as a length-prefixed JSON frame. */
export function encodeFrame(message: RpcMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_RPC_FRAME_BYTES) {
    throw new Error(`RPC frame too large: ${json.length} > ${MAX_RPC_FRAME_BYTES}`);
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Streaming decoder: feed it socket chunks, get back complete messages. Buffers
 * partial frames across chunk boundaries. Throws on a frame that exceeds the cap
 * (a corrupt/hostile length prefix) so the caller can drop the connection rather
 * than allocate unbounded memory.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: RpcMessage[] = [];
    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_RPC_FRAME_BYTES) {
        throw new Error(`RPC frame too large: ${len} > ${MAX_RPC_FRAME_BYTES}`);
      }
      if (this.buf.length < FRAME_HEADER_BYTES + len) break;
      const body = this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len);
      out.push(JSON.parse(body.toString("utf8")) as RpcMessage);
      this.buf = this.buf.subarray(FRAME_HEADER_BYTES + len);
    }
    return out;
  }

  /** Bytes currently buffered awaiting a complete frame (test/introspection). */
  get pending(): number {
    return this.buf.length;
  }
}
