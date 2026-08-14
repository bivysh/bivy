// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, PromptAttachment } from "@bivy/core";

export interface PreparedPrompt {
  text: string;
  requestId: string;
  clientMessageId: string;
  attachments?: PromptAttachment[];
}

export type SessionOrchestrationEvent =
  | { type: "session-orchestration.command-sent"; command: Command }
  | { type: "session-orchestration.prompt-prepared"; prompt: PreparedPrompt };

export interface SessionOrchestrationDependencies {
  send(command: Command): void;
  createRequestId(): string;
  createClientMessageId(): string;
  emit(event: SessionOrchestrationEvent): void;
}

/** Session protocol intent coordinator; transport and identity generation are ports. */
export class SessionOrchestrator {
  constructor(private readonly deps: SessionOrchestrationDependencies) {}

  send(command: Command): void {
    this.deps.send(command);
    this.deps.emit({ type: "session-orchestration.command-sent", command });
  }

  preparePrompt(text: string, attachments?: PromptAttachment[]): PreparedPrompt {
    const prompt: PreparedPrompt = {
      text,
      requestId: this.deps.createRequestId(),
      clientMessageId: this.deps.createClientMessageId(),
      ...(attachments?.length ? { attachments } : {}),
    };
    this.deps.emit({ type: "session-orchestration.prompt-prepared", prompt });
    return prompt;
  }

  rename(sessionId: string, name: string): void { this.send({ kind: "session.rename", sessionId, name }); }
  pause(sessionId?: string): void { this.send({ kind: "session.pause", sessionId }); }
  resume(sessionId?: string): void { this.send({ kind: "session.resume", sessionId }); }
  resolveApproval(id: string, approved: boolean): void { this.send({ kind: "approval", id, approved }); }
  answerQuestion(requestId: string, sessionId: string | undefined, answers: Record<string, string>): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, answers });
  }
  cancelQuestion(requestId: string, sessionId: string | undefined): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, cancelled: true });
  }
}
