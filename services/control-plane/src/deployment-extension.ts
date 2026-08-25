// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Deployment-neutral hooks for operators that compose Core with an external
 * account or admission service. With no URL configured every operation is
 * allowed and no account presentation is added. Once configured, transport or
 * malformed-response failures fail closed: a broken policy service must not
 * silently bypass an operator's rules.
 */
export type DeploymentOperation =
  | "relay.connect"
  | "push.deliver"
  | "automation.run"
  | "ephemeral.provision"
  | "session.create";

export interface DeploymentDecisionAction {
  /** Opaque deployment-owned action handled by /account/extension/actions/:id. */
  id: string;
  label: string;
  kind?: "primary" | "secondary";
}

export interface DeploymentDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
  usage?: { used: number; limit?: number };
  /** Optional remediation such as upgrade, add payment, or switch to BYO. */
  actions?: DeploymentDecisionAction[];
}

/** Opaque technical facts an operator may use for admission. Core never puts
 * product tiers, prices, or commercial cap names in this contract. */
export interface DeploymentPolicyContext {
  computeSource?: "user" | "managed";
  provider?: string;
  sizeId?: string;
  vcpus?: number;
  memoryMiB?: number;
  ttlMinutes?: number;
  configId?: string;
  purpose?: string;
}

export type DeploymentLifecycleEvent =
  | { type: "ephemeral.first-agent-event"; attemptId: string; at: string }
  | { type: "ephemeral.launch-failed"; attemptId: string; at: string }
  | { type: "ephemeral.settled"; attemptId: string; at: string; machineSeconds?: number; activeAgentSeconds?: number };

export interface AccountExtensionView {
  title?: string;
  facts?: Array<{ id: string; label: string; value: string }>;
  actions?: Array<{ id: string; label: string; kind?: "primary" | "secondary" }>;
}

export class DeploymentExtension {
  constructor(
    private readonly url = process.env.DEPLOYMENT_EXTENSION_URL?.replace(/\/$/, ""),
    private readonly token = process.env.DEPLOYMENT_EXTENSION_TOKEN,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (Boolean(this.url) !== Boolean(this.token)) {
      throw new Error("DEPLOYMENT_EXTENSION_URL and DEPLOYMENT_EXTENSION_TOKEN must be configured together");
    }
  }

  get configured(): boolean { return Boolean(this.url); }

  async authorize(
    accountId: string,
    operation: DeploymentOperation,
    idempotencyKey?: string,
    context?: DeploymentPolicyContext,
  ): Promise<DeploymentDecision> {
    if (!this.url) return { allowed: true };
    const response = await this.request("/v1/policy/check", { subject: { accountId }, operation, idempotencyKey, context });
    const decision = response as Partial<DeploymentDecision>;
    if (typeof decision.allowed !== "boolean") throw new Error("Deployment extension returned an invalid policy decision");
    return decision as DeploymentDecision;
  }

  async record(accountId: string, event: DeploymentLifecycleEvent): Promise<void> {
    if (!this.url) return;
    await this.request("/v1/events", { subject: { accountId }, event });
  }

  async publishSessions(accountId: string, sessionIds: string[]): Promise<void> {
    if (!this.url || sessionIds.length === 0) return;
    await this.request("/v1/policy/sessions/publish", { subject: { accountId }, sessionIds });
  }

  async filterSessions(accountId: string, sessionIds: string[]): Promise<Set<string>> {
    if (!this.url) return new Set(sessionIds);
    const result = await this.request("/v1/policy/sessions/filter", { subject: { accountId }, sessionIds }) as { allowedIds?: unknown };
    if (!Array.isArray(result.allowedIds) || result.allowedIds.some((id) => typeof id !== "string")) {
      throw new Error("Deployment extension returned an invalid session filter");
    }
    return new Set(result.allowedIds as string[]);
  }

  async account(accountId: string): Promise<AccountExtensionView | undefined> {
    if (!this.url) return undefined;
    const result = await this.request("/v1/account", { subject: { accountId } }) as { presentation?: AccountExtensionView };
    if (!result.presentation || typeof result.presentation !== "object") throw new Error("Deployment extension returned invalid account presentation");
    return result.presentation;
  }

  async accountAction(accountId: string, email: string, action: string): Promise<{ url: string }> {
    if (!this.url) throw new Error("No deployment account extension is configured");
    if (!/^[a-z0-9-]{1,64}$/.test(action)) throw new Error("Invalid account action");
    const result = await this.request(`/v1/account/actions/${action}`, { subject: { accountId, email } }) as { url?: unknown };
    if (typeof result.url !== "string" || !/^https:\/\//.test(result.url)) throw new Error("Deployment extension returned an invalid action URL");
    return { url: result.url };
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok && response.status !== 429) throw new Error(data.error || `Deployment extension failed (${response.status})`);
    return data;
  }
}
