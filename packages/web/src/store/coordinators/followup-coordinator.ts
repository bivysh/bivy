// SPDX-License-Identifier: AGPL-3.0-only
import {
  mustQueueFollowup,
  nextQueuedFollowup,
  supportsSteering as runtimeSupportsSteering,
  type Command,
  type FollowupEditResult,
  type PendingFollowup,
  type PromptAttachment,
  type StreamingBehavior,
} from "@bivy/core";

export interface FollowupStorePort {
  getState(): {
    activeSession: { activeSessionId: string | null; working: boolean };
    catalogs: { selectedAgentId: string | null; runtimes: Array<{ id: string; capabilities?: unknown }> };
  };
  getFollowups(sessionId: string): PendingFollowup[];
  editFollowup(sessionId: string, id: string, patch: { text: string; attachments?: PromptAttachment[] }, expectedVersion: number, now: number): FollowupEditResult;
  removeFollowup(sessionId: string, id: string): boolean;
  reorderFollowup(sessionId: string, id: string, toIndex: number): boolean;
  markFollowupSending(sessionId: string, id: string, now: number): PendingFollowup | undefined;
  confirmFollowupSent(sessionId: string, id: string): void;
  addUserMessage(text: string, id: string, attachments?: PromptAttachment[]): void;
}

export interface FollowupCoordinatorPorts {
  send(command: Command): void;
  createClientMessageId(): string;
  now(): number;
  persistBackstop(sessionId: string, id: string, text: string): void;
  cancelBackstop(automationId?: string): void;
}

/** Owns visible follow-up queue timing and delivery. Persistence remains an
 * injected effect, so this workflow is independent of AppController identity. */
export class FollowupCoordinator {
  constructor(
    private readonly store: FollowupStorePort,
    private readonly ports: FollowupCoordinatorPorts,
  ) {}

  mustQueue(sessionId: string): boolean {
    const waiting = this.store.getFollowups(sessionId).filter((item) => item.status === "queued").length;
    return mustQueueFollowup(waiting, this.store.getState().activeSession.working);
  }

  supportsSteering(): boolean {
    const state = this.store.getState();
    const runtime = state.catalogs.runtimes.find((item) => item.id === state.catalogs.selectedAgentId);
    return runtimeSupportsSteering(runtime?.capabilities as { streamingBehaviors?: unknown } | undefined);
  }

  list(sessionId: string): PendingFollowup[] {
    return this.store.getFollowups(sessionId);
  }

  edit(sessionId: string, id: string, patch: { text: string; attachments?: PromptAttachment[] }, expectedVersion: number): FollowupEditResult {
    const item = this.store.getFollowups(sessionId).find((followup) => followup.id === id);
    const result = this.store.editFollowup(sessionId, id, patch, expectedVersion, this.ports.now());
    if (result.ok) {
      this.ports.cancelBackstop(item?.scheduledAutomationId);
      this.ports.persistBackstop(sessionId, id, result.item.text);
    }
    return result;
  }

  remove(sessionId: string, id: string): boolean {
    const item = this.store.getFollowups(sessionId).find((followup) => followup.id === id);
    const removed = this.store.removeFollowup(sessionId, id);
    if (removed) this.ports.cancelBackstop(item?.scheduledAutomationId);
    return removed;
  }

  reorder(sessionId: string, id: string, toIndex: number): boolean {
    return this.store.reorderFollowup(sessionId, id, toIndex);
  }

  sendNow(sessionId: string, id: string): void {
    const item = this.store.getFollowups(sessionId).find((followup) => followup.id === id);
    if (!item || item.status !== "queued") return;
    this.store.reorderFollowup(sessionId, id, 0);
    if (!this.store.getState().activeSession.working) {
      this.drain(sessionId);
      return;
    }
    if (this.supportsSteering()) this.dispatch(sessionId, item, "steer");
  }

  steer(text: string, attachments?: PromptAttachment[]): boolean {
    const trimmed = text.trim();
    const files = attachments?.length ? attachments : undefined;
    if (!trimmed && !files) return false;
    const active = this.store.getState().activeSession.activeSessionId;
    if (!active || !this.store.getState().activeSession.working || !this.supportsSteering()) return false;
    const id = this.ports.createClientMessageId();
    this.store.addUserMessage(trimmed, id, files);
    this.ports.send({ kind: "prompt", sessionId: active, text: trimmed, clientMessageId: id, attachments: files, streamingBehavior: "steer" });
    return true;
  }

  drain(sessionId: string): void {
    if (sessionId !== this.store.getState().activeSession.activeSessionId) return;
    if (this.store.getState().activeSession.working) return;
    const next = nextQueuedFollowup(this.store.getFollowups(sessionId));
    if (next) this.dispatch(sessionId, next);
  }

  confirm(event: { type?: string; sessionId?: string; clientMessageId?: unknown }): void {
    if (event.type !== "session.user_message") return;
    const sessionId = event.sessionId || this.store.getState().activeSession.activeSessionId;
    const id = typeof event.clientMessageId === "string" ? event.clientMessageId : undefined;
    if (!sessionId || !id) return;
    const item = this.store.getFollowups(sessionId).find((followup) => followup.id === id);
    if (item) this.ports.cancelBackstop(item.scheduledAutomationId);
    this.store.confirmFollowupSent(sessionId, id);
  }

  retrySending(sessionId: string): void {
    for (const item of this.store.getFollowups(sessionId)) {
      if (item.status !== "sending") continue;
      this.ports.send({ kind: "prompt", sessionId, text: item.text, clientMessageId: item.id, attachments: item.attachments });
    }
  }

  private dispatch(sessionId: string, item: PendingFollowup, streamingBehavior?: StreamingBehavior): void {
    this.store.markFollowupSending(sessionId, item.id, this.ports.now());
    this.store.addUserMessage(item.text, item.id, item.attachments);
    this.ports.send({
      kind: "prompt",
      sessionId,
      text: item.text,
      clientMessageId: item.id,
      attachments: item.attachments,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }
}
