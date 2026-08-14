// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, ModelInfo } from "@bivy/core";

export interface CredentialsModelsDependencies {
  send(command: Command): void;
  rememberModel(model: ModelInfo): void;
  selectModelLocally(model: ModelInfo): void;
}

export type CredentialsModelsResult =
  | { type: "catalog-requested"; catalog: "providers" | "credentials" | "models" }
  | { type: "model-selected"; model: ModelInfo; command?: Command };

/** Coordinates credential/model UI intents without owning transport or storage. */
export class CredentialsModelsCoordinator {
  constructor(private readonly deps: CredentialsModelsDependencies) {}

  request(command: Command, catalog: "providers" | "credentials" | "models"): CredentialsModelsResult {
    this.deps.send(command);
    return { type: "catalog-requested", catalog };
  }

  selectModel(model: ModelInfo, sessionId: string | null): CredentialsModelsResult {
    this.deps.selectModelLocally(model);
    this.deps.rememberModel(model);
    const command = sessionId
      ? ({ kind: "model.select", provider: (model as ModelInfo & { provider?: string }).provider, id: model.id, sessionId } as Command)
      : undefined;
    if (command) this.deps.send(command);
    return { type: "model-selected", model, ...(command ? { command } : {}) };
  }
}
