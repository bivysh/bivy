// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { ComputeProfile, ComputePurpose, DeploymentComputeSource } from "./deployment-compute.js";

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
/**
 * A run's source is a kind plus identifiers (`agent-delegation:v1:1:<parent
 * session>:<parent run>`, `github:owner/repo#12`). Policy needs only the kind;
 * sending the whole string leaked parent ids and overflowed extensions that
 * bound the field, failing every delegated-run claim.
 */
export function policyContext(context: DeploymentPolicyContext): DeploymentPolicyContext {
  return context.source === undefined ? context : { ...context, source: context.source.split(":", 1)[0]!.slice(0, 64) };
}

export interface DeploymentPolicyContext {
  source?: string;
  computeSource?: "user" | "managed";
  provider?: string;
  sizeId?: string;
  vcpus?: number;
  memoryMiB?: number;
  ttlMinutes?: number;
  configId?: string;
  purpose?: string;
  /** Managed Machines this account already has running or launching. A fact
   * for the deployment's concurrency rule; Core sets no limit itself. */
  activeManagedMachines?: number;
}

export type DeploymentLifecycleEvent =
  | { type: "ephemeral.first-agent-event"; attemptId: string; at: string }
  | { type: "ephemeral.launch-failed"; attemptId: string; at: string }
  | { type: "ephemeral.settled"; attemptId: string; at: string; machineSeconds?: number; activeAgentSeconds?: number };

/** Account-level facts, sent with the account's email so the operator can act
 * on them (e.g. greet a new account) without its own copy of the account table. */
export type DeploymentAccountEvent =
  | { type: "account.signed-in"; at: string; accountCreatedAt: string };

export type CloudComputerAcquire =
  | { allowed: true; nodeId: string; state: string }
  | { allowed: false; decision: DeploymentDecision };

export interface AccountExtensionView {
  title?: string;
  /** Short plan/status line shown under the email in the account header. */
  summary?: string;
  /** One metered allowance for the account header. The client warns as `used`
   *  nears `limit` and, where actions are allowed, offers the primary action.
   *  `freesAt` (ISO) is when some of the allowance comes back — a rolling
   *  window's oldest use expiring, or a fixed period resetting. */
  meter?: { label: string; used: number; limit: number; freesAt?: string };
  facts?: Array<{ id: string; label: string; value: string }>;
  actions?: Array<{ id: string; label: string; kind?: "primary" | "secondary" }>;
  /** One line shown with the actions — e.g. what upgrading gets you. Hidden
   *  wherever the actions are hidden. */
  actionHint?: string;
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

  async authorize(accountId: string, operation: DeploymentOperation, idempotencyKey?: string, context: DeploymentPolicyContext = {}): Promise<DeploymentDecision> {
    if (!this.url) return { allowed: true };
    const response = await this.request("/v1/policy/check", { subject: { accountId }, operation, idempotencyKey, context: policyContext(context) });
    const decision = response as Partial<DeploymentDecision>;
    if (typeof decision.allowed !== "boolean") throw new Error("Deployment extension returned an invalid policy decision");
    return decision as DeploymentDecision;
  }

  async record(accountId: string, event: DeploymentLifecycleEvent): Promise<void> {
    if (!this.url) return;
    await this.request("/v1/events", { subject: { accountId }, event });
  }

  async recordAccount(accountId: string, email: string, event: DeploymentAccountEvent): Promise<void> {
    if (!this.url) return;
    await this.request("/v1/events", { subject: { accountId, email }, event });
  }

  async publishSessions(accountId: string, sessionIds: string[]): Promise<void> {
    if (!this.url || sessionIds.length === 0) return;
    await this.request("/v1/policy/sessions/publish", { subject: { accountId }, sessionIds });
  }

  /** Records the app IDs a node currently has published, for operator reporting. */
  async publishApps(accountId: string, appIds: string[]): Promise<void> {
    if (!this.url || appIds.length === 0) return;
    await this.request("/v1/apps/publish", { subject: { accountId }, appIds });
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

  async deleteAccount(accountId: string, email: string): Promise<void> {
    if (!this.url) return;
    await this.request("/v1/account/delete", { subject: { accountId, email } });
  }

  async accountAction(accountId: string, email: string, action: string): Promise<{ url: string }> {
    if (!this.url) throw new Error("No deployment account extension is configured");
    if (!/^[a-z0-9-]{1,64}$/.test(action)) throw new Error("Invalid account action");
    const result = await this.request(`/v1/account/actions/${action}`, { subject: { accountId, email } }) as { url?: unknown };
    if (typeof result.url !== "string" || !/^https:\/\//.test(result.url)) throw new Error("Deployment extension returned an invalid action URL");
    return { url: result.url };
  }

  /** Deployment-supplied compute (the "managed" lane), or undefined when no
   * extension is configured — then there is no managed lane at all. */
  computeSource(): DeploymentComputeSource | undefined {
    if (!this.url) return undefined;
    return {
      profile: async (purpose: ComputePurpose, accountId?: string, runtimeId?: string) => {
        const result = await this.request("/v1/compute/profile", { subject: accountId ? { accountId } : undefined, purpose, runtimeId }) as { profile?: ComputeProfile | null };
        return result.profile && typeof result.profile === "object" ? result.profile : null;
      },
      credential: async (provider: string) => {
        const result = await this.request("/v1/compute/credential", { provider }) as { token?: unknown; expiresAt?: unknown };
        return typeof result.token === "string" && result.token
          ? { token: result.token, expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : undefined }
          : null;
      },
    };
  }

  /** Ask the deployment for the account's cloud computer (create or wake it).
   * A refusal comes back as a policy decision. */
  async computeAcquire(accountId: string, input: { purpose: string; requestId: string; runtimeId?: string; sessionId?: string }): Promise<CloudComputerAcquire> {
    if (!this.url) throw new Error("No deployment compute is configured");
    const result = await this.request("/v1/compute/acquire", { subject: { accountId }, ...input }) as Partial<DeploymentDecision> & { nodeId?: unknown; state?: unknown };
    if (result.allowed === false) return { allowed: false, decision: result as DeploymentDecision };
    if (typeof result.nodeId !== "string" || !result.nodeId) throw new Error("Deployment extension returned an invalid compute acquisition");
    return { allowed: true, nodeId: result.nodeId, state: typeof result.state === "string" ? result.state : "launching" };
  }

  /** Best-effort: start the account's sleeping cloud computer. */
  async computeWake(accountId: string, nodeId: string): Promise<void> {
    if (!this.url) return;
    await this.request("/v1/compute/wake", { subject: { accountId }, nodeId });
  }

  /** The account's cloud machines, for the hosted-machines panel. */
  async computeMachines(accountId: string): Promise<Array<Record<string, unknown>>> {
    if (!this.url) return [];
    const result = await this.request("/v1/compute/machines", { subject: { accountId } }) as { machines?: unknown };
    return Array.isArray(result.machines) ? result.machines.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object") : [];
  }

  /** Destroy the account's cloud computer and its disk. */
  async computeRelease(accountId: string, nodeId: string): Promise<boolean> {
    if (!this.url) return false;
    const result = await this.request("/v1/compute/release", { subject: { accountId }, nodeId }) as { released?: unknown };
    return result.released === true;
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
