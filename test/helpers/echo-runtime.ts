// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A tiny deterministic runtime for tests: one prompt → a full echo turn. Shared
// across the remote-adapter / Stage 2 suites so they exercise the same fixture.

import { EventEmitter } from "node:events";
import type {
  AgentRuntime,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolInterceptor,
} from "../../src/runtime/types.js";

export const ECHO_CAPS: RuntimeCapabilities = { toolInterception: true, modelSelection: true, packages: false, resume: true, fork: false };

export class EchoSession implements RuntimeSession {
  readonly id: string;
  private readonly emitter = new EventEmitter();
  private streaming = false;
  private messages: RuntimeMessage[] = [];
  private _sessionFile?: string;
  private _name?: string;
  private _model?: ModelInfo;
  disposed = false;
  turns = 0;

  constructor(readonly cwd: string, id: string, private readonly interceptor?: ToolInterceptor) {
    this.id = id;
  }

  get sessionFile() {
    return this._sessionFile;
  }
  get isStreaming() {
    return this.streaming;
  }
  activePid() {
    return this.streaming ? 4242 : undefined;
  }
  getMessages() {
    return this.messages;
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  private emit(event: RuntimeEvent) {
    this.emitter.emit("event", event);
  }

  async prompt(text: string): Promise<void> {
    this.streaming = true;
    this.turns++;
    this.messages.push({ role: "user", content: text });
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
    let reply = text;
    if (this.interceptor) {
      const decision = (await this.interceptor({ sessionId: this.id, toolName: "Echo", input: { text } })) || {};
      if (decision.block) reply = `BLOCKED:${decision.reason ?? ""}`;
      else if (decision.handled) reply = String(decision.result ?? "");
      this.emit({ type: "tool_result", toolName: "Echo", blocked: Boolean(decision.block) });
    }
    this.emit({ type: "message_update", message: { role: "assistant", content: reply } });
    const message = { role: "assistant", content: reply };
    this.messages.push(message);
    this._sessionFile = `/echo/${this.id}.json`;
    this.streaming = false;
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end" });
    this.emit({ type: "agent_end", code: 0, signal: null });
  }

  async abort(): Promise<void> {
    this.streaming = false;
  }
  dispose(): void {
    this.disposed = true;
    this.emitter.removeAllListeners();
  }
  getModels(): ModelInfo[] {
    return [{ provider: "echo", id: "echo-mini", name: "Echo Mini" }];
  }
  getCurrentModel(): ModelInfo | undefined {
    return this._model;
  }
  async setModel(provider: string, id: string): Promise<void> {
    this._model = { provider, id, name: id };
  }
  getName(): string | undefined {
    return this._name;
  }
  setName(name: string): void {
    this._name = name;
  }
  async suggestName(): Promise<string | undefined> {
    return undefined;
  }
}

export class EchoRuntime implements AgentRuntime {
  readonly id = "echo";
  readonly displayName = "Echo";
  readonly capabilities = ECHO_CAPS;
  readonly sessions: EchoSession[] = [];
  private seq = 0;

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new EchoSession(options.workspace, `echo-${++this.seq}`, options.toolInterceptor);
    this.sessions.push(session);
    return { session, warning: "echo warning" };
  }
  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    return this.createSession(options);
  }
  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.map((s) => ({ id: s.id, cwd: s.cwd, name: s.getName(), messageCount: s.getMessages().length }));
  }
}
