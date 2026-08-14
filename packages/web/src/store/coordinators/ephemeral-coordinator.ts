// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountNode,
  EphemeralConfigInput,
  EphemeralMachine,
  EphemeralNodeConfig,
  LaunchOpts,
  ProviderSize,
  SessionCorrelation,
} from "@bivy/core";

export interface EphemeralDependencies {
  listConfigs(): Promise<EphemeralNodeConfig[]>;
  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig>;
  updateConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig>;
  removeConfig(id: string): Promise<void>;
  listSizes(providerId: string, region?: string): Promise<ProviderSize[]>;
  signedIn(): boolean;
  direct(): boolean;
  currentNodeId(): string;
  roomKey(nodeId: string): string | undefined;
  draftRepo(): string | undefined;
  githubToken(): Promise<string>;
  machines(): Promise<EphemeralMachine[]>;
  nodes(): AccountNode[];
  correlations(): SessionCorrelation[];
  launchMachine(opts: LaunchOpts): Promise<EphemeralMachine>;
  destroyMachine(machine: EphemeralMachine): Promise<void>;
  wakeMachine(machine: EphemeralMachine): Promise<void>;
  suspendsWhenIdle(provider: string): boolean;
  machineFromNode(node: AccountNode): EphemeralMachine | null;
  machineFromCorrelation(correlation: SessionCorrelation): EphemeralMachine;
  connectToNode(nodeId: string, timeoutMs?: number): Promise<void>;
  refreshNodes(): void;
  reportError(error: Error): void;
  defaultConfig(providerId: string): { name: string; region: string | null; size: string | null; suspendsWhenIdle: boolean };
}

export type EphemeralResult<T> =
  | { type: "completed"; value: T }
  | { type: "rejected"; error: Error };

/** Owns provider-neutral ephemeral launch, rebuild, wake and teardown workflows. */
export class EphemeralCoordinator {
  constructor(private readonly deps: EphemeralDependencies) {}

  listConfigs(): Promise<EphemeralNodeConfig[]> { return this.deps.listConfigs(); }
  createConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig> { return this.deps.createConfig(input); }
  updateConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig> { return this.deps.updateConfig(id, patch); }
  removeConfig(id: string): Promise<void> { return this.deps.removeConfig(id); }
  listSizes(providerId: string, region?: string): Promise<ProviderSize[]> { return this.deps.listSizes(providerId, region); }

  async ensureDefaultRunner(providerId: string): Promise<EphemeralNodeConfig | null> {
    try {
      const existing = (await this.listConfigs()).find((config) => config.provider === providerId);
      if (existing) return existing;
      const defaults = this.deps.defaultConfig(providerId);
      return await this.createConfig({
        provider: providerId,
        name: `${defaults.name} runner`,
        region: defaults.region,
        size: defaults.size,
        ttlMinutes: defaults.suspendsWhenIdle ? null : 60,
        teardownOnAgentFinish: !defaults.suspendsWhenIdle,
      });
    } catch {
      return null;
    }
  }

  async launch(opts: LaunchOpts): Promise<EphemeralMachine> {
    if (!this.deps.signedIn()) throw new Error("Sign in to launch an ephemeral machine.");
    const githubToken = opts.githubToken ?? await this.deps.githubToken();
    const machine = await this.deps.launchMachine({
      ...opts,
      repo: opts.repo ?? this.deps.draftRepo(),
      githubToken: githubToken || undefined,
    });
    this.deps.refreshNodes();
    return machine;
  }

  async destroy(machine: EphemeralMachine): Promise<void> {
    await this.deps.destroyMachine(machine);
    this.deps.refreshNodes();
  }

  async wake(machine: EphemeralMachine): Promise<void> {
    await this.deps.wakeMachine(machine);
    this.deps.refreshNodes();
  }

  async resumeAndConnect(nodeId: string, timeoutMs = 90_000): Promise<void> {
    try {
      const node = this.deps.nodes().find((candidate) => candidate.id === nodeId);
      const machine = (await this.deps.machines()).find((candidate) => candidate.nodeId === nodeId)
        ?? (node ? this.deps.machineFromNode(node) : null);
      if (machine && this.deps.suspendsWhenIdle(machine.provider)) await this.wake(machine);
      await this.deps.connectToNode(nodeId, timeoutMs);
    } catch (cause) {
      this.deps.reportError(this.error(cause));
    }
  }

  async reprovision(nodeId: string, sessionId: string): Promise<void> {
    try {
      const roomKeyB64 = this.deps.roomKey(nodeId);
      if (!roomKeyB64) throw new Error("This device no longer holds this session's key, so it can't rebuild it.");
      const correlation = this.deps.correlations().find((item) => item.nodeId === nodeId || item.sessionId === sessionId);
      const node = this.deps.nodes().find((candidate) => candidate.id === nodeId);
      const machine = (await this.deps.machines()).find((candidate) => candidate.nodeId === nodeId)
        ?? (node ? this.deps.machineFromNode(node) : null)
        ?? (correlation ? this.deps.machineFromCorrelation(correlation) : null);
      if (!machine) throw new Error("No record of the machine to rebuild — re-launch it from Ephemeral settings.");
      if (this.deps.suspendsWhenIdle(machine.provider)) {
        await this.resumeAndConnect(nodeId);
        return;
      }
      await this.launch({
        provider: machine.provider,
        region: machine.region || undefined,
        ttlMinutes: machine.ttlMinutes,
        repo: machine.repo,
        setupId: machine.setupId,
        teardownOnAgentFinish: machine.teardownOnAgentFinish,
        reuseNodeId: nodeId,
        reuseRoomKeyB64: roomKeyB64,
        restoreSessionId: sessionId,
      });
      await this.deps.connectToNode(nodeId, 120_000);
    } catch (cause) {
      this.deps.reportError(this.error(cause));
    }
  }

  isCurrentNodeResumable(): boolean {
    if (this.deps.direct()) return false;
    const nodeId = this.deps.currentNodeId();
    if (!nodeId || !this.deps.roomKey(nodeId)) return false;
    const node = this.deps.nodes().find((candidate) => candidate.id === nodeId);
    if (node) return !node.online && Boolean(this.deps.machineFromNode(node));
    return this.deps.correlations().some((item) => item.nodeId === nodeId);
  }

  private error(cause: unknown): Error { return cause instanceof Error ? cause : new Error(String(cause)); }
}
