// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Command,
  LocalModelDiscoveryResult,
  LocalModelEndpointResult,
  ModelInfo,
  ServerEvent,
} from "@bivy/core";

export interface CredentialsModelsDependencies {
  send(command: Command): void;
  awaitAck(command: Command, timeoutMs?: number): Promise<ServerEvent>;
  rememberModel(model: ModelInfo): void;
  selectModelLocally(model: ModelInfo): void;
  isDirect(): boolean;
  now(): number;
}

export type CredentialsModelsResult =
  | { type: "catalog-requested"; catalog: "providers" | "credentials" | "models" }
  | { type: "model-selected"; model: ModelInfo; command?: Command };

/** Owns credential, provider-auth and custom-model protocol decisions. */
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

  listProviders(): void { this.request({ kind: "providers.list" }, "providers"); }
  getProviderAuth(provider: string): void { this.deps.send({ kind: "provider.auth.get", provider }); }
  saveApiKey(provider: string, key: string): Promise<void> { return this.ack({ kind: "provider.apiKey", provider, key }); }
  removeProvider(provider: string): void { this.deps.send({ kind: "provider.remove", provider }); }
  resetOauth(provider: string): void { this.deps.send({ kind: "provider.oauth.reset", provider }); }
  startOauth(provider: string): void { this.deps.send({ kind: "provider.oauth.start", provider }); }
  submitOauthCode(id: string, code: string): void { this.deps.send({ kind: "provider.oauth.code", id, code }); }

  listCredentials(): void { this.request({ kind: "credentials.list" }, "credentials"); }
  setCredential(provider: string, label: string, value: { key?: string; ref?: string }): Promise<void> {
    return this.ack({ kind: "credential.set", provider, label, ...value });
  }
  removeCredential(provider: string, label: string): void { this.deps.send({ kind: "credential.remove", provider, label }); }
  setCredentialSync(provider: string, label: string, sync: "account" | "node"): void {
    this.deps.send({ kind: "credential.sync.set", provider, label, sync });
  }
  async testCredential(provider: string, label: string): Promise<{ ok: boolean; at: number; reason?: string }> {
    if (this.deps.isDirect()) return { ok: false, at: this.deps.now(), reason: "not_supported" };
    const event = await this.deps.awaitAck({ kind: "credential.test", provider, label }, 15_000) as { ok?: boolean; at?: number; reason?: string };
    return { ok: Boolean(event.ok), at: Number(event.at) || this.deps.now(), ...(event.reason ? { reason: event.reason } : {}) };
  }
  getPresets(): void { this.deps.send({ kind: "credentials.presets.get" }); }
  setActivePreset(active: string): void { this.deps.send({ kind: "credentials.presets.setActive", active }); }
  setPresetMapping(preset: string, provider: string, label: string): void {
    this.deps.send({ kind: "credentials.presets.setMapping", preset, provider, label });
  }

  listLocalModels(): void { this.deps.send({ kind: "models.custom.list" }); }
  listLocalModelPresets(): void { this.deps.send({ kind: "models.custom.presets" }); }
  async discoverLocalModels(): Promise<LocalModelDiscoveryResult> {
    return await this.deps.awaitAck({ kind: "models.custom.discover" }, 10_000) as unknown as LocalModelDiscoveryResult;
  }
  async verifyLocalModel(baseUrl: string, apiKey?: string): Promise<LocalModelEndpointResult> {
    const event = await this.deps.awaitAck({ kind: "models.custom.verify", baseUrl, ...(apiKey ? { apiKey } : {}) }, 10_000) as unknown as { result: LocalModelEndpointResult };
    return event.result;
  }
  async saveLocalModel(spec: Record<string, unknown>): Promise<string> {
    const event = await this.deps.awaitAck({ kind: "models.custom.save", spec }) as { provider?: unknown };
    return String(event.provider ?? spec.providerId ?? "local");
  }
  removeLocalModel(id: string): void { this.deps.send({ kind: "models.custom.remove", id }); }

  private ack(command: Command): Promise<void> {
    return this.deps.awaitAck(command).then(() => undefined);
  }
}
