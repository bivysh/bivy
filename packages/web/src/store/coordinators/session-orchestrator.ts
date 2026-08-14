// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, PromptAttachment } from "@bivy/core";

export interface SessionOrchestrationDependencies {
  send(command: Command): void;
  createRequestId(): string;
  createClientMessageId(): string;
}

export type SessionOrchestrationResult =
  | { type: "command-sent"; command: Command }
  | { type: "prompt-prepared"; requestId: string; clientMessageId: string; text: string; attachments?: PromptAttachment[] };

/** Session command coordination with explicit transport/id dependencies. */
export class SessionOrchestrator {
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
}
