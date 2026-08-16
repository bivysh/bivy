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
  isOnline(): boolean;
  importModelKeys(entries: Array<{ provider: string; label?: string; key: string }>): Promise<void>;
  removeModelKey(provider: string, label?: string): Promise<void>;
  accountModelKeys(): Promise<Array<{ provider: string; label: string; key: string; updatedAt?: string | null }>>;
  importOAuthCredentials(entries: Array<{ provider: string; label: string; access: string; refresh: string; expires: number; refreshedAt?: number; updatedAt?: number }>): Promise<void>;
  removeOAuthCredential(provider: string, label?: string, deletedAt?: number): Promise<void>;
  accountOAuthCredentials(): Promise<Array<{ provider: string; label: string; access: string; refresh: string; expires: number; refreshedAt?: number; updatedAt?: number }>>;
  oauthRecoveryEnabled(): boolean;
}

export type CredentialsModelsResult =
  | { type: "catalog-requested"; catalog: "providers" | "credentials" | "models" }
  | { type: "model-selected"; model: ModelInfo; command?: Command };

/** Owns credential, provider-auth and custom-model protocol decisions. */
export class CredentialsModelsCoordinator {
  private accountSyncInFlight: Promise<void> | null = null;

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
  startOauth(provider: string, label?: string): void { this.deps.send({ kind: "provider.oauth.start", provider, ...(label ? { label } : {}) }); }
  async openOauthOnNode(id: string): Promise<{ opened: boolean; error?: string }> {
    const event = await this.deps.awaitAck({ kind: "provider.oauth.open_on_node", id }) as { opened?: boolean; error?: string };
    return { opened: event.opened === true, ...(event.error ? { error: event.error } : {}) };
  }
  submitOauthCode(id: string, code: string): void { this.deps.send({ kind: "provider.oauth.code", id, code }); }

  listCredentials(): void { this.request({ kind: "credentials.list" }, "credentials"); }
  syncAccountCredentials(): Promise<void> {
    if (!this.deps.isOnline()) return Promise.resolve();
    if (this.accountSyncInFlight) return this.accountSyncInFlight;
    this.accountSyncInFlight = (async () => {
      const event = await this.deps.awaitAck({ kind: "credentials.account.export", includeOAuth: this.deps.oauthRecoveryEnabled() }) as unknown as { entries?: unknown; oauthEntries?: unknown; records?: unknown; deletedAt?: unknown };
      const incoming = Array.isArray(event.entries)
        ? event.entries.filter((entry): entry is { provider: string; label?: string; key: string; updatedAt?: number | string } => Boolean(entry)
          && typeof (entry as { provider?: unknown }).provider === "string"
          && typeof (entry as { key?: unknown }).key === "string")
        : [];
      const incomingOAuth = this.deps.oauthRecoveryEnabled() && Array.isArray(event.oauthEntries)
        ? event.oauthEntries.filter((entry): entry is { provider: string; label: string; access: string; refresh: string; expires: number; refreshedAt?: number; updatedAt?: number } => Boolean(entry)
          && typeof (entry as { provider?: unknown }).provider === "string"
          && typeof (entry as { label?: unknown }).label === "string"
          && typeof (entry as { refresh?: unknown }).refresh === "string"
          && Number.isFinite(Number((entry as { expires?: unknown }).expires)))
        : [];
      const nodeRecords = Array.isArray(event.records)
        ? event.records.filter((record): record is { provider: string; label: string; kind: string } => Boolean(record)
          && typeof (record as { provider?: unknown }).provider === "string"
          && typeof (record as { label?: unknown }).label === "string"
          && typeof (record as { kind?: unknown }).kind === "string")
        : [];
      const deletedAt = event.deletedAt && typeof event.deletedAt === "object" ? event.deletedAt as Record<string, unknown> : {};
      const localBefore = await this.deps.accountModelKeys();
      for (const local of localBefore) {
        const recordId = local.label === "default" ? local.provider : `${local.provider}:${local.label}`;
        const tombstoneAt = Number(deletedAt[recordId]);
        const localAt = Date.parse(String(local.updatedAt ?? ""));
        if (Number.isFinite(tombstoneAt) && tombstoneAt > 0 && (!Number.isFinite(localAt) || tombstoneAt >= localAt)) await this.deps.removeModelKey(local.provider, local.label);
      }
      for (const record of nodeRecords) if (record.kind !== "api_key") await this.deps.removeModelKey(record.provider, record.label);
      const localOAuth = this.deps.oauthRecoveryEnabled() ? await this.deps.accountOAuthCredentials() : [];
      for (const local of localOAuth) {
        const record = nodeRecords.find((candidate) => candidate.provider === local.provider && candidate.label === local.label);
        const recordId = local.label === "default" ? local.provider : `${local.provider}:${local.label}`;
        const tombstoneAt = Number(deletedAt[recordId]);
        if ((record && record.kind !== "oauth") || (Number.isFinite(tombstoneAt) && tombstoneAt > Math.max(Number(local.refreshedAt) || 0, Number(local.updatedAt) || 0))) {
          await this.deps.removeOAuthCredential(local.provider, local.label, Number.isFinite(tombstoneAt) ? tombstoneAt : this.deps.now());
        }
      }
      await this.deps.importOAuthCredentials(incomingOAuth);
      const acceptedIncoming = incoming.filter((entry) => {
        const local = localBefore.find((candidate) => candidate.provider === entry.provider && candidate.label === (entry.label ?? "default"));
        if (!local) return true;
        const remoteAt = typeof entry.updatedAt === "number" ? entry.updatedAt : Date.parse(String(entry.updatedAt ?? ""));
        const localAt = Date.parse(String(local.updatedAt ?? ""));
        return Number.isFinite(remoteAt) && (!Number.isFinite(localAt) || remoteAt > localAt);
      });
      await this.deps.importModelKeys(acceptedIncoming);
      for (const { provider, label, key } of await this.deps.accountModelKeys()) {
        if (nodeRecords.some((record) => record.provider === provider && record.label === label && record.kind !== "api_key")) continue;
        await this.deps.awaitAck({ kind: "credential.set", provider, label, key });
      }
      const browserOAuth = (this.deps.oauthRecoveryEnabled() ? await this.deps.accountOAuthCredentials() : []).filter(({ provider, label }) => {
        const record = nodeRecords.find((candidate) => candidate.provider === provider && candidate.label === label);
        return !record || record.kind === "oauth";
      });
      if (browserOAuth.length) await this.deps.awaitAck({ kind: "credentials.account.import", oauthEntries: browserOAuth });
      this.listCredentials();
      this.listProviders();
    })().catch(() => {}).finally(() => { this.accountSyncInFlight = null; });
    return this.accountSyncInFlight;
  }
  setCredential(provider: string, label: string, value: { key?: string; ref?: string; sync?: "account" | "node" }): Promise<void> {
    return this.ack({ kind: "credential.set", provider, label, ...value });
  }
  removeCredential(provider: string, label: string): Promise<void> { return this.ack({ kind: "credential.remove", provider, label }); }
  setCredentialSync(provider: string, label: string, sync: "account" | "node"): Promise<void> { return this.ack({ kind: "credential.sync.set", provider, label, sync }); }
  setCredentialUnattended(provider: string, label: string, unattended: boolean): Promise<void> { return this.ack({ kind: "credential.unattended.set", provider, label, unattended }); }
  async testCredential(provider: string, label: string): Promise<{ ok: boolean; at: number; reason?: string }> {
    const event = await this.deps.awaitAck({ kind: "credential.test", provider, label }, 15_000) as { ok?: boolean; at?: number; reason?: string };
    return { ok: Boolean(event.ok), at: Number(event.at) || this.deps.now(), ...(event.reason ? { reason: event.reason } : {}) };
  }
  getPresets(): void { this.deps.send({ kind: "credentials.presets.get" }); }
  setActivePreset(active: string): void { this.deps.send({ kind: "credentials.presets.setActive", active }); }
  setPresetMapping(preset: string, provider: string, label: string): Promise<void> { return this.ack({ kind: "credentials.presets.setMapping", preset, provider, label }); }

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
