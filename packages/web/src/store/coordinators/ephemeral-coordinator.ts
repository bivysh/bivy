// SPDX-License-Identifier: AGPL-3.0-only
import type {
  EphemeralConfigInput,
  EphemeralMachine,
  EphemeralModelKeyInfo,
  EphemeralNodeConfig,
  EphemeralPrefs,
  EphemeralQueueDefault,
  EphemeralSetup,
  ProviderKeyInfo,
  ProviderSize,
} from "@bivy/core";

export type EphemeralCoordinatorEvent =
  | { type: "ephemeral.requested"; operation: string }
  | { type: "ephemeral.completed"; operation: string; result?: unknown };

export interface EphemeralDependencies {
  listKeys(): Promise<ProviderKeyInfo[]>;
  listModelKeys(): Promise<EphemeralModelKeyInfo[]>;
  setModelKey(provider: string, key: string, scope: "account" | "device"): Promise<void>;
  removeModelKey(provider: string): Promise<void>;
  getPrefs(id: string): Promise<EphemeralPrefs>;
  setPrefs(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs>;
  listSetups(provider?: string): Promise<EphemeralSetup[]>;
  createSetup(provider: string, input: { name: string } & Partial<EphemeralPrefs>): Promise<EphemeralSetup>;
  updateSetup(id: string, patch: Partial<Pick<EphemeralSetup, "name" | keyof EphemeralPrefs>>): Promise<EphemeralSetup>;
  removeSetup(id: string): Promise<void>;
  listMachines(): Promise<EphemeralMachine[]>;
  listSizes(providerId: string, region?: string): Promise<ProviderSize[]>;
  getQueueDefault(): Promise<EphemeralQueueDefault>;
  setQueueDefault(patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault>;
  listConfigs(): Promise<EphemeralNodeConfig[]>;
  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig>;
  updateConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig>;
  removeConfig(id: string): Promise<void>;
  emit(event: EphemeralCoordinatorEvent): void;
}

/** Provider-neutral ephemeral data coordinator. Provider adapters stay behind ports. */
export class EphemeralCoordinator {
  constructor(private readonly deps: EphemeralDependencies) {}

  private async run<T>(operation: string, effect: () => Promise<T>): Promise<T> {
    this.deps.emit({ type: "ephemeral.requested", operation });
    const result = await effect();
    this.deps.emit({ type: "ephemeral.completed", operation, result });
    return result;
  }

  listKeys(): Promise<ProviderKeyInfo[]> { return this.run("list-keys", () => this.deps.listKeys()); }
  listModelKeys(): Promise<EphemeralModelKeyInfo[]> { return this.run("list-model-keys", () => this.deps.listModelKeys()); }
  setModelKey(provider: string, key: string, scope: "account" | "device" = "account"): Promise<void> {
    return this.run("set-model-key", () => this.deps.setModelKey(provider, key, scope));
  }
  removeModelKey(provider: string): Promise<void> { return this.run("remove-model-key", () => this.deps.removeModelKey(provider)); }
  getPrefs(id: string): Promise<EphemeralPrefs> { return this.run("get-prefs", () => this.deps.getPrefs(id)); }
  setPrefs(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs> { return this.run("set-prefs", () => this.deps.setPrefs(id, patch)); }
  listSetups(provider?: string): Promise<EphemeralSetup[]> { return this.run("list-setups", () => this.deps.listSetups(provider)); }
  createSetup(provider: string, input: { name: string } & Partial<EphemeralPrefs>): Promise<EphemeralSetup> { return this.run("create-setup", () => this.deps.createSetup(provider, input)); }
  updateSetup(id: string, patch: Partial<Pick<EphemeralSetup, "name" | keyof EphemeralPrefs>>): Promise<EphemeralSetup> { return this.run("update-setup", () => this.deps.updateSetup(id, patch)); }
  removeSetup(id: string): Promise<void> { return this.run("remove-setup", () => this.deps.removeSetup(id)); }
  listMachines(): Promise<EphemeralMachine[]> { return this.run("list-machines", () => this.deps.listMachines()); }
  listSizes(providerId: string, region?: string): Promise<ProviderSize[]> { return this.run("list-sizes", () => this.deps.listSizes(providerId, region)); }
  getQueueDefault(): Promise<EphemeralQueueDefault> { return this.run("get-queue-default", () => this.deps.getQueueDefault()); }
  setQueueDefault(patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault> { return this.run("set-queue-default", () => this.deps.setQueueDefault(patch)); }
  listConfigs(): Promise<EphemeralNodeConfig[]> { return this.run("list-configs", () => this.deps.listConfigs()); }
  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig> { return this.run("create-config", () => this.deps.createConfig(input)); }
  updateConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig> { return this.run("update-config", () => this.deps.updateConfig(id, patch)); }
  removeConfig(id: string): Promise<void> { return this.run("remove-config", () => this.deps.removeConfig(id)); }
}
