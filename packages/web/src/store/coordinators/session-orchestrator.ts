// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, PromptAttachment, ServerEvent } from "@bivy/core";

const FORK_IMPORT_TIMEOUT_MS = 11 * 60 * 1000;

export interface SessionForkOptions {
  destNodeId?: string;
  agentId?: string;
  sourceAgentId?: string;
  model?: { provider: string; id: string };
  retireSource?: boolean;
}

export interface SessionOrchestrationDependencies {
  send(command: Command): void;
  sendRequest(command: Command): void;
  createRequestId(): string;
  createClientMessageId(): string;
  currentNodeId(): string;
  isDirect(): boolean;
  sessionRuntime(sessionId: string): string | undefined;
  switchNode(nodeId: string): void;
  waitForOnline(timeoutMs?: number): Promise<void>;
  openSession(sessionId: string, path?: string): void;
  addUserMessage(text: string, clientMessageId: string): void;
  transcriptUrl(sessionId: string): string;
  refreshAccountSessions(): void;
}

export type SessionOrchestrationResult =
  | { type: "command-sent"; command: Command }
  | { type: "prompt-prepared"; requestId: string; clientMessageId: string; text: string; attachments?: PromptAttachment[] };

/** Owns multi-step session protocol workflows; browser navigation and state mutation are ports. */
export class SessionOrchestrator {
  private readonly pending = new Map<string, {
    resolve: (event: ServerEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly deps: SessionOrchestrationDependencies) {}

  send(command: Command): SessionOrchestrationResult {
    this.deps.send(command);
    return { type: "command-sent", command };
  }

  preparePrompt(text: string, attachments?: PromptAttachment[]): SessionOrchestrationResult {
    return {
      type: "prompt-prepared",
      requestId: this.deps.createRequestId(),
      clientMessageId: this.deps.createClientMessageId(),
      text,
      ...(attachments?.length ? { attachments } : {}),
    };
  }

  /** Consume a correlated fork/promote reply. Returns true when handled. */
  handleEvent(event: ServerEvent): boolean {
    const id = String(event.requestId || "");
    const waiting = id ? this.pending.get(id) : undefined;
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    const error = (event as { error?: unknown }).error;
    if (error) waiting.reject(new Error(String(error)));
    else waiting.resolve(event);
    return true;
  }

  async importNativeSession(runtimeId: string, ref: string, acceptDisclosure = false): Promise<ServerEvent> {
    return this.request({ kind: "session.import", runtimeId, ref, acceptDisclosure }, 60_000);
  }

  async promote(sessionId: string, standbyNodeId: string): Promise<{ epoch: number }> {
    if (standbyNodeId && standbyNodeId !== this.deps.currentNodeId()) {
      this.deps.switchNode(standbyNodeId);
      await this.deps.waitForOnline();
    }
    const reply = await this.request({ kind: "session.promote", sessionId }, 30_000);
    this.deps.refreshAccountSessions();
    return { epoch: Number((reply as { epoch?: unknown }).epoch ?? 0) };
  }

  async fork(sourceSessionId: string, opts: SessionForkOptions = {}): Promise<{
    sessionId: string;
    fidelity: string;
    missing: Array<{ label?: string; detail?: string }>;
  }> {
    const sourceNodeId = this.deps.currentNodeId();
    const destNodeId = opts.destNodeId ?? sourceNodeId;
    const crossNode = !this.deps.isDirect() && Boolean(destNodeId) && destNodeId !== sourceNodeId;
    const sourceAgentId = opts.sourceAgentId ?? this.deps.sessionRuntime(sourceSessionId);
    const targetAgentId = opts.agentId ?? sourceAgentId;
    const crossAgent = Boolean(targetAgentId && (!sourceAgentId || targetAgentId !== sourceAgentId));

    if (!crossNode && !crossAgent) {
      const done = await this.request(
        { kind: "session.fork.local", sessionId: sourceSessionId, ...(opts.model ? { model: opts.model } : {}) },
        FORK_IMPORT_TIMEOUT_MS,
      );
      const sessionId = String((done as { sessionId?: unknown }).sessionId || "");
      if (!sessionId) throw new Error("Local fork returned no session id");
      const result = this.forkResult(done, "full");
      this.deps.openSession(sessionId);
      if (opts.retireSource) this.deps.send({ kind: "session.delete", sessionId: sourceSessionId });
      return { sessionId, ...result };
    }

    const exported = await this.request({
      kind: "session.fork.export",
      sessionId: sourceSessionId,
      ...(targetAgentId ? { agent: targetAgentId } : {}),
      ...(crossNode ? { crossNode: true } : {}),
    }, 60_000);
    const bundle = (exported as { bundle?: unknown }).bundle;
    if (!bundle) throw new Error("Fork export returned no bundle");

    if (crossNode) {
      this.deps.switchNode(destNodeId!);
      await this.deps.waitForOnline();
    }
    const done = await this.request({
      kind: "session.fork.import",
      bundle,
      transcriptUrl: this.deps.transcriptUrl(sourceSessionId),
      sameNode: !crossNode,
      ...(targetAgentId ? { agent: targetAgentId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    }, FORK_IMPORT_TIMEOUT_MS);
    const sessionId = String((done as { sessionId?: unknown }).sessionId || "");
    if (!sessionId) throw new Error("Fork import returned no session id");
    const actualAgentId = String((done as { runtimeId?: unknown }).runtimeId || "");
    if (targetAgentId && actualAgentId && actualAgentId !== targetAgentId) {
      throw new Error(`Fork requested agent ${targetAgentId}, but the destination used ${actualAgentId}`);
    }
    this.deps.openSession(sessionId);
    const seedPrompt = (done as { seedPrompt?: unknown }).seedPrompt;
    if (typeof seedPrompt === "string" && seedPrompt.trim()) {
      const id = this.deps.createClientMessageId();
      this.deps.addUserMessage(seedPrompt, id);
      this.deps.send({ kind: "prompt", sessionId, text: seedPrompt, clientMessageId: id });
    }

    if (opts.retireSource) {
      if (crossNode) {
        try {
          this.deps.switchNode(sourceNodeId);
          await this.deps.waitForOnline();
          this.deps.send({ kind: "session.delete", sessionId: sourceSessionId });
        } finally {
          this.deps.switchNode(destNodeId!);
          await this.deps.waitForOnline().catch(() => {});
          this.deps.openSession(sessionId);
        }
      } else {
        this.deps.send({ kind: "session.delete", sessionId: sourceSessionId });
      }
    }
    return { sessionId, ...this.forkResult(done, "seeded") };
  }

  private forkResult(event: ServerEvent, fallback: string) {
    const missing = (event as { missing?: unknown }).missing;
    return {
      fidelity: String((event as { fidelity?: unknown }).fidelity || fallback),
      missing: Array.isArray(missing) ? missing as Array<{ label?: string; detail?: string }> : [],
    };
  }

  private request(command: Command, timeoutMs: number): Promise<ServerEvent> {
    const requestId = this.deps.createRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Fork request timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.deps.sendRequest({ ...command, requestId });
    });
  }
}
