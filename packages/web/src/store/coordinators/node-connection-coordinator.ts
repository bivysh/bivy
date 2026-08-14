// SPDX-License-Identifier: AGPL-3.0-only

export interface ConnectionFacts {
  direct: boolean;
  solo: boolean;
  signedIn: boolean;
  currentNodeId: string | null;
}

export type ConnectionRequirement =
  | { type: "ready" }
  | { type: "authentication-required" }
  | { type: "node-required" };

export interface NodeConnectionPort {
  facts(): ConnectionFacts;
  status(): string;
  closeTransport(): void;
  setCurrentNode(nodeId: string): void;
  resetSession(): void;
  seedSessions(): void;
  rebuildTransport(): void;
  setStatus(status: "offline" | "connecting"): void;
  connectTransport(): void;
  refreshNodes(): void;
  refreshAccountSessions(): void;
  waitForOnline(timeoutMs?: number): Promise<void>;
  listProviders(): void;
}

/** Owns node-selection and connection policy; browser identity/storage are ports. */
export class NodeConnectionCoordinator {
  constructor(private readonly port?: NodeConnectionPort) {}

  requirement(facts: ConnectionFacts): ConnectionRequirement {
    if (!facts.direct && !facts.solo && !facts.signedIn) return { type: "authentication-required" };
    if (!facts.direct && facts.signedIn && !facts.currentNodeId) return { type: "node-required" };
    return { type: "ready" };
  }

  connect(): void {
    const port = this.requiredPort();
    if (this.requirement(port.facts()).type !== "ready") {
      port.setStatus("offline");
      if (port.facts().signedIn) port.refreshNodes();
      return;
    }
    if (!port.facts().direct) {
      port.setCurrentNode(port.facts().currentNodeId || "");
      port.refreshNodes();
    }
    port.connectTransport();
  }

  switchNode(nodeId: string): boolean {
    const port = this.requiredPort();
    if (nodeId === port.facts().currentNodeId && port.status() === "online") return false;
    port.closeTransport();
    port.setCurrentNode(nodeId);
    port.resetSession();
    port.seedSessions();
    port.rebuildTransport();
    port.setStatus("connecting");
    port.connectTransport();
    port.refreshAccountSessions();
    return true;
  }

  async connectToNode(nodeId: string, timeoutMs?: number): Promise<void> {
    const port = this.requiredPort();
    if (nodeId !== port.facts().currentNodeId || port.status() !== "online") {
      this.switchNode(nodeId);
      await port.waitForOnline(timeoutMs);
    }
    port.listProviders();
  }

  private requiredPort(): NodeConnectionPort {
    if (!this.port) throw new Error("NodeConnectionCoordinator requires a port for effects");
    return this.port;
  }
}
