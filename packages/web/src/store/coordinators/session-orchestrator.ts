// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, EphemeralNodeConfig, PromptAttachment, ServerEvent } from "@bivy/core";

const FORK_IMPORT_TIMEOUT_MS = 11 * 60 * 1000;

export interface SessionForkOptions {
  destNodeId?: string;
  /** Provision this managed profile as the destination after source export. */
  managedConfigId?: string;
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
  launchManagedDestination(configId: string, runtimeId?: string): Promise<string>;
}

export type SessionOrchestrationResult =
  | { type: "command-sent"; command: Command }
  | { type: "prompt-prepared"; requestId: string; clientMessageId: string; text: string; attachments?: PromptAttachment[] };

export interface PendingSessionPrompt {
  text: string;
  requestId: string;
  clientMessageId: string;
  attachments?: PromptAttachment[];
  frame: Command;
  provisionalId?: string;
}

export interface SessionWorkflowPort {
  navigateNew(): void;
  focusComposer(): void;
  clearPendingPromptAndFollowups(): void;
  resetActiveSession(): void;
  seedDraftDefaults(): void;
  listRuntimes(): void;
  listModels(): void;
  hasNodeSettings(): boolean;
  getNodeSettings(): void;
  listRepos(): void;
  draftRepo(): string | null;
  listBranches(repo: string): void;
  activeSessionId(): string | null;
  isPendingLaunch(id: string): boolean;
  appendPendingLaunchFollowup(id: string, prompt: { text: string; clientMessageId: string; attachments?: PromptAttachment[] }): void;
  addUserMessage(text: string, clientMessageId: string, attachments?: PromptAttachment[]): void;
  mustQueue(sessionId: string): boolean;
  enqueueFollowup(sessionId: string, prompt: { id: string; text: string; attachments?: PromptAttachment[] }): void;
  persistFollowup(sessionId: string, id: string, text: string): void;
  drainFollowups(sessionId: string): void;
  shouldAutoResume(): boolean;
  bufferResume(prompt: { sessionId: string; text: string; clientMessageId: string; attachments?: PromptAttachment[] }): void;
  resumeNodeForSession(sessionId: string): void;
  hasPendingPrompt(): boolean;
  appendPendingFollowup(prompt: { text: string; clientMessageId: string; attachments?: PromptAttachment[] }): void;
  draftSessionFields(): Record<string, unknown>;
  setPendingPrompt(prompt: PendingSessionPrompt): void;
  draftEphemeralRunner(): EphemeralNodeConfig | null;
  startEphemeralLaunch(provisionalId: string, prompt: PendingSessionPrompt, runner: EphemeralNodeConfig): void;
  send(command: Command): void;
  resetDeletedActiveSession(): void;
  removeSessionLocal(sessionId: string): void;
  persistDeletedSessionTombstones(): void;
  deleteTranscriptCache(sessionId: string): void;
  refreshSessions(): void;
  resolveSessionId(sessionId?: string): string | null;
}

/** Owns multi-step session protocol workflows; browser navigation and state mutation are ports. */
export class SessionOrchestrator {
  private readonly pending = new Map<string, {
    resolve: (event: ServerEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly deps: SessionOrchestrationDependencies,
    private readonly workflow?: SessionWorkflowPort,
  ) {}

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

  newSession(opts: { navigate?: boolean } = {}): void {
    const port = this.workflowPort();
    if (opts.navigate !== false) port.navigateNew();
    port.focusComposer();
    port.clearPendingPromptAndFollowups();
    port.resetActiveSession();
    port.seedDraftDefaults();
    port.listRuntimes();
    port.listModels();
    if (!port.hasNodeSettings()) port.getNodeSettings();
    port.listRepos();
    const repo = port.draftRepo();
    if (repo) port.listBranches(repo);
  }

  sendPrompt(text: string, attachments?: PromptAttachment[]): void {
    const port = this.workflowPort();
    const trimmed = text.trim();
    const files = attachments?.length ? attachments : undefined;
    if (!trimmed && !files) return;
    const requestId = this.deps.createRequestId();
    const clientMessageId = this.deps.createClientMessageId();
    const active = port.activeSessionId();

    if (active && port.isPendingLaunch(active)) {
      port.addUserMessage(trimmed, clientMessageId, files);
      port.appendPendingLaunchFollowup(active, { text: trimmed, clientMessageId, attachments: files });
      return;
    }
    if (active) {
      if (port.mustQueue(active)) {
        port.enqueueFollowup(active, { id: clientMessageId, text: trimmed, attachments: files });
        port.persistFollowup(active, clientMessageId, trimmed);
        port.drainFollowups(active);
        return;
      }
      port.addUserMessage(trimmed, clientMessageId, files);
      if (port.shouldAutoResume()) {
        port.bufferResume({ sessionId: active, text: trimmed, clientMessageId, attachments: files });
        port.resumeNodeForSession(active);
      } else {
        port.send({ kind: "prompt", sessionId: active, text: trimmed, clientMessageId, attachments: files });
      }
      return;
    }
    if (port.hasPendingPrompt()) {
      port.addUserMessage(trimmed, clientMessageId, files);
      port.appendPendingFollowup({ text: trimmed, clientMessageId, attachments: files });
      return;
    }

    const frame: Command = { kind: "session.new", requestId, title: trimmed || undefined, ...port.draftSessionFields() };
    const prompt: PendingSessionPrompt = { text: trimmed, requestId, clientMessageId, attachments: files, frame };
    const runner = port.draftEphemeralRunner();
    if (runner) {
      const provisionalId = `starting-${requestId}`;
      prompt.provisionalId = provisionalId;
      port.setPendingPrompt(prompt);
      port.addUserMessage(trimmed, clientMessageId, files);
      port.startEphemeralLaunch(provisionalId, prompt, runner);
      return;
    }
    port.setPendingPrompt(prompt);
    port.addUserMessage(trimmed, clientMessageId, files);
    port.send(frame);
  }

  deleteSession(sessionId: string, path?: string): void {
    const port = this.workflowPort();
    port.send({ kind: "session.delete", sessionId, path });
    if (sessionId === port.activeSessionId()) port.resetDeletedActiveSession();
    port.removeSessionLocal(sessionId);
    port.persistDeletedSessionTombstones();
    port.deleteTranscriptCache(sessionId);
    port.refreshSessions();
  }

  pauseSession(sessionId?: string): void {
    const port = this.workflowPort();
    const id = port.resolveSessionId(sessionId);
    if (id) port.send({ kind: "session.pause", sessionId: id });
  }

  resumeSession(sessionId?: string): void {
    const port = this.workflowPort();
    const id = port.resolveSessionId(sessionId);
    if (id) port.send({ kind: "session.resume", sessionId: id });
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
    let destNodeId = opts.destNodeId ?? sourceNodeId;
    const managedDestination = Boolean(opts.managedConfigId);
    const crossNode = managedDestination || (!this.deps.isDirect() && Boolean(destNodeId) && destNodeId !== sourceNodeId);
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

    if (opts.managedConfigId) {
      // Export first while the source transport is authoritative. Provisioning
      // happens only after a complete bundle exists, and source retirement stays
      // confirmation-gated below, so every failure leaves the original intact.
      destNodeId = await this.deps.launchManagedDestination(opts.managedConfigId, opts.agentId);
    }
    if (crossNode) {
      this.deps.switchNode(destNodeId!);
      await this.deps.waitForOnline(managedDestination ? 120_000 : undefined);
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
      // Retire the MOVE's source with the confirmation-gated, idempotent command
      // (1A) — it carries the destination id so the source node refuses to retire
      // unless the move actually produced `sessionId`, and is safe to re-send.
      const retire = { kind: "session.fork.retire-source" as const, sourceSessionId, newSessionId: sessionId };
      if (crossNode) {
        try {
          this.deps.switchNode(sourceNodeId);
          await this.deps.waitForOnline();
          this.deps.send(retire);
        } finally {
          this.deps.switchNode(destNodeId!);
          await this.deps.waitForOnline().catch(() => {});
          this.deps.openSession(sessionId);
        }
      } else {
        this.deps.send(retire);
      }
    }
    return { sessionId, ...this.forkResult(done, "seeded") };
  }

  private workflowPort(): SessionWorkflowPort {
    if (!this.workflow) throw new Error("SessionOrchestrator requires a workflow port");
    return this.workflow;
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
