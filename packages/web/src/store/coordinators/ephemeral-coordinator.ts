// SPDX-License-Identifier: AGPL-3.0-only
import type { EphemeralConfigInput, EphemeralNodeConfig, LaunchOpts } from "@bivy/core";

export interface EphemeralDependencies {
  listConfigs(): Promise<EphemeralNodeConfig[]>;
  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig>;
  launch(opts: LaunchOpts): Promise<unknown>;
}

export type EphemeralResult<T> =
  | { type: "completed"; value: T }
  | { type: "rejected"; error: Error };

/** Provider-neutral ephemeral orchestration; provider effects are injected. */
export class EphemeralCoordinator {
  constructor(private readonly deps: EphemeralDependencies) {}

  listConfigs(): Promise<EphemeralNodeConfig[]> {
    return this.deps.listConfigs();
  }

  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig> {
    return this.deps.createConfig(input);
  }

  async launch(opts: LaunchOpts): Promise<EphemeralResult<unknown>> {
    try {
      return { type: "completed", value: await this.deps.launch(opts) };
    } catch (cause) {
      return { type: "rejected", error: cause instanceof Error ? cause : new Error(String(cause)) };
    }
  }
}
