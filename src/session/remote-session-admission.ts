// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { AsyncLocalStorage } from "node:async_hooks";

export class RemoteSessionAdmissionError extends Error {
  constructor(message: string, readonly code = "deployment_policy") {
    super(message);
    this.name = "RemoteSessionAdmissionError";
  }
}

type Decision = { allowed: boolean; reason?: string; code?: string };

/** Scope admission to remote commands and hosted work, not local sessions or
 * history publication. The scope follows async creation helpers (including
 * GitHub/Linear), so a new path cannot forget to forward a billing option.
 * Each creation gets its own slot; retrying the same request reuses those keys.
 * No plan names or allowances belong in Core.
 */
export function createRemoteSessionAdmission(authorize: (key: string) => Promise<Decision>) {
  const context = new AsyncLocalStorage<{ key: string; next: number } | undefined>();
  return {
    run<T>(key: string, work: () => T): T {
      return context.run({ key, next: 0 }, work);
    },
    async admit(options: { resume?: boolean; internal?: boolean } = {}): Promise<void> {
      const scope = context.getStore();
      if (!scope || options.resume || options.internal) return;
      const key = JSON.stringify([scope.key, scope.next++]);
      let decision: Decision;
      try {
        decision = await authorize(key);
      } catch {
        throw new RemoteSessionAdmissionError("Remote session admission is temporarily unavailable. Try again shortly.", "extension_unavailable");
      }
      if (decision.allowed !== true) {
        throw new RemoteSessionAdmissionError(decision.reason || "New remote sessions are unavailable for this account.", decision.code);
      }
    },
  };
}
