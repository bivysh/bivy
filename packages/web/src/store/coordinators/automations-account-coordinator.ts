// SPDX-License-Identifier: AGPL-3.0-only

export interface AutomationsAccountDependencies {
  execute<T>(operation: string, input?: unknown): Promise<T>;
}

export type AccountOperationResult<T> =
  | { type: "account-operation-completed"; operation: string; value: T }
  | { type: "account-operation-failed"; operation: string; error: Error };

/** Account/automation request shell with one explicit effect dependency. */
export class AutomationsAccountCoordinator {
  constructor(private readonly deps: AutomationsAccountDependencies) {}

  async run<T>(operation: string, input?: unknown): Promise<AccountOperationResult<T>> {
    try {
      const value = await this.deps.execute<T>(operation, input);
      return { type: "account-operation-completed", operation, value };
    } catch (cause) {
      return {
        type: "account-operation-failed",
        operation,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
  }
}
