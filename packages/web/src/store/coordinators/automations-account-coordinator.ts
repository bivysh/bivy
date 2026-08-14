// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountAutomationRun,
  AccountMe,
  GithubAppInfo,
  GithubQueueItem,
  NotificationPreferences,
} from "@bivy/core";

export type AutomationsAccountEvent =
  | { type: "automations-account.requested"; operation: string }
  | { type: "automations-account.completed"; operation: string; result?: unknown };

export interface AutomationsAccountDependencies {
  fetchMe(): Promise<AccountMe>;
  fetchGithubApp(): Promise<GithubAppInfo>;
  fetchGithubQueue(limit: number): Promise<GithubQueueItem[]>;
  fetchAutomationRuns(limit: number): Promise<AccountAutomationRun[]>;
  cancelAutomationRun(id: string): Promise<void>;
  setGithubAppDefaultNode(node: string, appId?: string): Promise<string | undefined>;
  setGithubAppTriggerAccess(access: "everyone" | "contributor" | "collaborator", appId?: string): Promise<"everyone" | "contributor" | "collaborator">;
  assignWorkItem(id: string, input: { node?: string; runtimeId?: string; model?: string; ephemeral?: boolean }): Promise<void>;
  deleteWorkItem(id: string): Promise<void>;
  clearWorkQueue(): Promise<number>;
  disconnectGithubApp(appId?: string, hookId?: string): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  refreshNodes(): Promise<void>;
  checkout(): Promise<string>;
  billingPortal(): Promise<string>;
  navigate(url: string): void;
  enablePush(): Promise<string>;
  disablePush(): Promise<string>;
  pushStatus(): Promise<{ supported: boolean; subscribed: boolean; permission: string }>;
  getNotificationPreferences(): Promise<NotificationPreferences>;
  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences>;
  emit(event: AutomationsAccountEvent): void;
}

/** Control-plane account and automation coordinator with every effect injected. */
export class AutomationsAccountCoordinator {
  constructor(private readonly deps: AutomationsAccountDependencies) {}

  private requested(operation: string): void { this.deps.emit({ type: "automations-account.requested", operation }); }
  private completed(operation: string, result?: unknown): void { this.deps.emit({ type: "automations-account.completed", operation, result }); }
  private async run<T>(operation: string, effect: () => Promise<T>): Promise<T> {
    this.requested(operation);
    const result = await effect();
    this.completed(operation, result);
    return result;
  }

  fetchMe(): Promise<AccountMe> { return this.run("fetch-me", () => this.deps.fetchMe()); }
  fetchGithubApp(): Promise<GithubAppInfo> { return this.run("fetch-github-app", () => this.deps.fetchGithubApp()); }
  fetchGithubQueue(limit = 30): Promise<GithubQueueItem[]> { return this.run("fetch-github-queue", () => this.deps.fetchGithubQueue(limit)); }
  fetchAutomationRuns(limit = 50): Promise<AccountAutomationRun[]> { return this.run("fetch-automation-runs", () => this.deps.fetchAutomationRuns(limit)); }
  async cancelAutomationRun(id: string): Promise<{ runs: AccountAutomationRun[]; queue: GithubQueueItem[] }> {
    return this.run("cancel-automation-run", async () => {
      await this.deps.cancelAutomationRun(id);
      const [runs, queue] = await Promise.all([this.deps.fetchAutomationRuns(50), this.deps.fetchGithubQueue(30)]);
      return { runs, queue };
    });
  }
  setGithubAppDefaultNode(node: string, appId?: string): Promise<string | undefined> {
    return this.run("set-github-default-node", () => this.deps.setGithubAppDefaultNode(node, appId));
  }
  setGithubAppTriggerAccess(access: "everyone" | "contributor" | "collaborator", appId?: string) {
    return this.run("set-github-trigger-access", () => this.deps.setGithubAppTriggerAccess(access, appId));
  }
  assignWorkItem(id: string, input: { node?: string; runtimeId?: string; model?: string; ephemeral?: boolean }): Promise<void> {
    return this.run("assign-work-item", () => this.deps.assignWorkItem(id, input));
  }
  deleteWorkItem(id: string): Promise<void> { return this.run("delete-work-item", () => this.deps.deleteWorkItem(id)); }
  clearWorkQueue(): Promise<number> { return this.run("clear-work-queue", () => this.deps.clearWorkQueue()); }
  disconnectGithubApp(appId?: string, hookId?: string): Promise<void> {
    return this.run("disconnect-github-app", () => this.deps.disconnectGithubApp(appId, hookId));
  }
  async removeNode(nodeId: string): Promise<void> {
    await this.run("remove-node", async () => { await this.deps.removeNode(nodeId); await this.deps.refreshNodes(); });
  }
  async startCheckout(): Promise<void> { this.deps.navigate(await this.run("checkout", () => this.deps.checkout())); }
  async openBillingPortal(): Promise<void> { this.deps.navigate(await this.run("billing-portal", () => this.deps.billingPortal())); }
  enablePush(): Promise<string> { return this.run("enable-push", () => this.deps.enablePush()); }
  disablePush(): Promise<string> { return this.run("disable-push", () => this.deps.disablePush()); }
  pushStatus(): Promise<{ supported: boolean; subscribed: boolean; permission: string }> { return this.run("push-status", () => this.deps.pushStatus()); }
  getNotificationPreferences(): Promise<NotificationPreferences> { return this.run("get-notification-preferences", () => this.deps.getNotificationPreferences()); }
  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    return this.run("set-notification-preferences", () => this.deps.setNotificationPreferences(patch));
  }
}
