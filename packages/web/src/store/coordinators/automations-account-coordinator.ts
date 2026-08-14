// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountMe,
  LocalStore,
  NotificationPreferences,
} from "@bivy/core";

export interface AutomationsAccountDependencies {
  local: LocalStore;
  sendGithubDisconnect(input: { appId?: string; hookId?: string }): void;
  refreshNodes(): Promise<void>;
  navigate(url: string): void;
  api: {
    fetchMe(local: LocalStore): Promise<AccountMe>;
    fetchGithubApp(local: LocalStore): Promise<unknown>;
    fetchGithubQueue(local: LocalStore, limit: number): Promise<any>;
    fetchAutomationRuns(local: LocalStore, limit: number): Promise<any>;
    cancelAutomationRun(local: LocalStore, id: string): Promise<unknown>;
    disconnectGithubApp(local: LocalStore, input: { appId?: string; hookId?: string }): Promise<void>;
    removeNode(local: LocalStore, nodeId: string): Promise<void>;
    billingCheckout(local: LocalStore): Promise<string>;
    billingPortal(local: LocalStore): Promise<string>;
    enablePush(local: LocalStore): Promise<string>;
    disablePush(local: LocalStore): Promise<string>;
    pushStatus(): any;
    getNotificationPreferences(local: LocalStore): Promise<NotificationPreferences>;
    setNotificationPreferences(local: LocalStore, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences>;
    createOneOffRun(local: LocalStore, input: any): Promise<{ id: string }>;
  };
  runContext(): {
    accountMode: boolean;
    sessionId?: string;
    nodeId?: string;
    roomKey?: string;
    nodeLabel?: string;
    repo?: string;
    runtimeId?: string;
    model?: string;
    sandbox?: string;
  };
  encrypt(roomKey: string, text: string): Promise<string>;
  recordRunAccepted(): void;
}

/** Owns account-level workflows and their ordering; UI navigation/transport are ports. */
export class AutomationsAccountCoordinator {
  constructor(private readonly deps: AutomationsAccountDependencies) {}

  fetchMe(): Promise<AccountMe> { return this.deps.api.fetchMe(this.deps.local); }
  fetchGithubApp(): Promise<unknown> { return this.deps.api.fetchGithubApp(this.deps.local); }
  fetchGithubQueue(limit = 30): Promise<any> { return this.deps.api.fetchGithubQueue(this.deps.local, limit); }
  fetchAutomationRuns(limit = 50): Promise<any> { return this.deps.api.fetchAutomationRuns(this.deps.local, limit); }

  async cancelAutomationRun(id: string): Promise<{ runs: any; queue: any }> {
    await this.deps.api.cancelAutomationRun(this.deps.local, id);
    const [runs, queue] = await Promise.all([this.fetchAutomationRuns(50), this.fetchGithubQueue(30)]);
    return { runs, queue };
  }

  async startRun(instruction: string, options: { approvalMode: "risky" | "autonomous"; maxAttempts: number }): Promise<{ runId?: string; error?: string }> {
    const text = instruction.trim();
    if (!text) return { error: "Describe the task this Run should complete." };
    const context = this.deps.runContext();
    if (!context.accountMode) return { error: "Sign in to start a Run." };
    if (!context.nodeId) return { error: context.sessionId ? "This Session has no owning Machine." : "Choose a Machine before starting a Run." };
    if (!context.roomKey) return { error: "This Machine isn't paired on this device—open it first so the instruction can be encrypted." };
    if (!context.nodeLabel) return { error: "This Machine has no routing name. Reconnect it before starting a Run." };
    try {
      const encrypted = await this.deps.encrypt(context.roomKey, text);
      const run = await this.deps.api.createOneOffRun(this.deps.local, {
        title: (text.split(/\r?\n/, 1)[0] || "Run").slice(0, 120),
        body: `bivy-room-v1:${context.nodeId}:${encrypted}`,
        label: context.nodeLabel,
        repo: context.sessionId ? undefined : context.repo,
        runtimeId: context.sessionId ? undefined : context.runtimeId,
        model: context.sessionId ? undefined : context.model,
        approvalMode: options.approvalMode,
        sandbox: context.sandbox,
        maxAttempts: options.maxAttempts,
        targetKind: context.sessionId ? "existing_session" : "new_session",
        targetSessionId: context.sessionId,
      });
      this.deps.recordRunAccepted();
      return { runId: run.id };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "Could not start this Run." };
    }
  }

  async disconnectGithubApp(appId?: string, hookId?: string): Promise<void> {
    this.deps.sendGithubDisconnect({ appId, hookId });
    await this.deps.api.disconnectGithubApp(this.deps.local, { appId, hookId });
  }

  async removeNode(nodeId: string): Promise<void> {
    await this.deps.api.removeNode(this.deps.local, nodeId);
    await this.deps.refreshNodes();
  }

  async startCheckout(): Promise<void> { this.deps.navigate(await this.deps.api.billingCheckout(this.deps.local)); }
  async openBillingPortal(): Promise<void> { this.deps.navigate(await this.deps.api.billingPortal(this.deps.local)); }
  enablePush(): Promise<string> { return this.deps.api.enablePush(this.deps.local); }
  disablePush(): Promise<string> { return this.deps.api.disablePush(this.deps.local); }
  pushStatus(): any { return this.deps.api.pushStatus(); }
  getNotificationPreferences(): Promise<NotificationPreferences> { return this.deps.api.getNotificationPreferences(this.deps.local); }
  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    return this.deps.api.setNotificationPreferences(this.deps.local, patch);
  }
}
