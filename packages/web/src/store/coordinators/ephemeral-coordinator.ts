// SPDX-License-Identifier: AGPL-3.0-only
import { isCloudComputerNodeId } from "../../cloudDestinations.js";
import type {
  AccountNode,
  EphemeralMachine,
  EphemeralNodeConfig,
} from "@bivy/core";

export interface EphemeralDependencies {
  listConfigs(): Promise<EphemeralNodeConfig[]>;
  direct(): boolean;
  currentNodeId(): string;
  nodes(): AccountNode[];
  restoreManagedMachine(input: { configId: string; nodeId: string; sessionId: string; requestId?: string }): Promise<EphemeralMachine>;
  connectToNode(nodeId: string, timeoutMs?: number): Promise<void>;
  reportError(error: Error): void;
}

/** Deployment-provided cloud machines: listing profiles, and waking the
 * account's cloud computer for a session on it. Its lifecycle is server-side. */
export class EphemeralCoordinator {
  constructor(private readonly deps: EphemeralDependencies) {}

  listConfigs(): Promise<EphemeralNodeConfig[]> { return this.deps.listConfigs(); }

  async reprovision(nodeId: string, sessionId: string): Promise<void> {
    try {
      // The account's cloud computer keeps its sessions on its own disk: bringing
      // it back is a wake, and the control plane knows which machine that is.
      if (!isCloudComputerNodeId(nodeId)) throw new Error("This session's machine can't be rebuilt.");
      await this.deps.restoreManagedMachine({ configId: "managed-default", nodeId, sessionId, requestId: `wake:${sessionId}:${Date.now()}` });
      await this.deps.connectToNode(nodeId, 120_000);
    } catch (cause) {
      this.deps.reportError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /** A sleeping cloud computer wakes when a message is sent to it; any other
   * node (even during a transient disconnect) must reconnect on its own. */
  isCurrentNodeResumable(): boolean {
    if (this.deps.direct()) return false;
    const nodeId = this.deps.currentNodeId();
    if (!isCloudComputerNodeId(nodeId)) return false;
    return !this.deps.nodes().find((candidate) => candidate.id === nodeId)?.online;
  }
}
