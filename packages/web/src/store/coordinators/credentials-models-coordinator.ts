// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Command,
  LocalModelDiscoveryResult,
  LocalModelEndpointResult,
  Ruleset,
  ServerEvent,
} from "@bivy/core";

export type CredentialsModelsEvent =
  | { type: "credentials-models.command-sent"; command: Command }
  | { type: "credentials-models.result"; operation: string; result: unknown };

export interface CredentialsModelsDependencies {
  send(command: Command): void;
  awaitResult(command: Command, timeoutMs?: number): Promise<ServerEvent>;
  now(): number;
  isDirect(): boolean;
  emit(event: CredentialsModelsEvent): void;
}

/** Node credential/model orchestration. It knows protocol data, never controller identity. */
export class CredentialsModelsCoordinator {
  constructor(private readonly deps: CredentialsModelsDependencies) {}

  private send(command: Command): void {
    this.deps.send(command);
    this.deps.emit({ type: "credentials-models.command-sent", command });
  }

  private async result(command: Command, operation: string, timeoutMs?: number): Promise<ServerEvent> {
    const value = await this.deps.awaitResult(command, timeoutMs);
    this.deps.emit({ type: "credentials-models.result", operation, result: value });
    return value;
  }

  listProviders(): void { this.send({ kind: "providers.list" }); }
  getProviderAuth(provider: string): void { this.send({ kind: "provider.auth.get", provider }); }
  async saveApiKey(provider: string, key: string): Promise<void> { await this.result({ kind: "provider.apiKey", provider, key }, "save-api-key"); }
  removeProvider(provider: string): void { this.send({ kind: "provider.remove", provider }); }
  resetOauth(provider: string): void { this.send({ kind: "provider.oauth.reset", provider }); }
  startOauth(provider: string): void { this.send({ kind: "provider.oauth.start", provider }); }
  submitOauthCode(id: string, code: string): void { this.send({ kind: "provider.oauth.code", id, code }); }

  listCredentialRecords(): void { this.send({ kind: "credentials.list" }); }
  async setCredential(provider: string, label: string, value: { key?: string; ref?: string }): Promise<void> {
    await this.result({ kind: "credential.set", provider, label, ...value }, "set-credential");
  }
  removeCredential(provider: string, label: string): void { this.send({ kind: "credential.remove", provider, label }); }
  setCredentialSync(provider: string, label: string, sync: "account" | "node"): void {
    this.send({ kind: "credential.sync.set", provider, label, sync });
  }
  async testCredential(provider: string, label: string): Promise<{ ok: boolean; at: number; reason?: string }> {
    if (this.deps.isDirect()) return { ok: false, at: this.deps.now(), reason: "not_supported" };
    const event = await this.result({ kind: "credential.test", provider, label }, "test-credential", 15_000) as { ok?: boolean; at?: number; reason?: string };
    return { ok: Boolean(event.ok), at: Number(event.at) || this.deps.now(), ...(event.reason ? { reason: event.reason } : {}) };
  }
  getCredentialPresets(): void { this.send({ kind: "credentials.presets.get" }); }
  setActivePreset(active: string): void { this.send({ kind: "credentials.presets.setActive", active }); }
  setPresetMapping(preset: string, provider: string, label: string): void {
    this.send({ kind: "credentials.presets.setMapping", preset, provider, label });
  }

  listLocalModels(): void { this.send({ kind: "models.custom.list" }); }
  listLocalModelPresets(): void { this.send({ kind: "models.custom.presets" }); }
  async discoverLocalModels(): Promise<LocalModelDiscoveryResult> {
    return await this.result({ kind: "models.custom.discover" }, "discover-local-models", 10_000) as unknown as LocalModelDiscoveryResult;
  }
  async verifyLocalModel(baseUrl: string, apiKey?: string): Promise<LocalModelEndpointResult> {
    const event = await this.result({ kind: "models.custom.verify", baseUrl, ...(apiKey ? { apiKey } : {}) }, "verify-local-model", 10_000) as unknown as { result: LocalModelEndpointResult };
    return event.result;
  }
  async saveLocalModel(spec: Record<string, unknown>): Promise<string> {
    const event = await this.result({ kind: "models.custom.save", spec }, "save-local-model") as { provider?: unknown };
    return String(event.provider ?? spec.providerId ?? "local");
  }
  removeLocalModel(id: string): void { this.send({ kind: "models.custom.remove", id }); }

  listRulesets(): void { this.send({ kind: "rulesets.list" }); }
  async saveRuleset(ruleset: Ruleset, active?: boolean): Promise<void> {
    await this.result({ kind: "rulesets.save", ruleset, active }, "save-ruleset");
  }
  removeRuleset(name: string): void { this.send({ kind: "rulesets.remove", name }); }

  getSttConfig(): void { this.send({ kind: "stt.config.get" }); }
  setSttProvider(provider: string): void { this.send({ kind: "stt.config.set", provider }); }
  async saveSttKey(provider: string, value: string): Promise<void> {
    await this.result({ kind: "stt.config.set", setKey: { provider, value } }, "save-stt-key");
  }
  removeSttKey(provider: string): void { this.send({ kind: "stt.config.set", removeKey: provider }); }
}
