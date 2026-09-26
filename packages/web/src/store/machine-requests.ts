// SPDX-License-Identifier: AGPL-3.0-only
import type { Command, LocalStore, ServerEvent, Transport, TransportHandlers } from "@bivy/core";

type Pending = { resolve: (event: ServerEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

interface Link {
  transport: Transport;
  /** Settles when the link is online (or can't get there). */
  ready: Promise<void>;
  fail: (error: Error) => void;
  pending: Map<string, Pending>;
  idle?: ReturnType<typeof setTimeout>;
  connecting: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const unreachable = () => new Error("The machine is not reachable.");

/** Request/reply to any enrolled machine without changing the selected one, so
 * the Artifacts and Apps pages can list and open items on every machine. One
 * quiet link per machine (paired, but no session sync), closed when idle. */
export class MachineRequests {
  private readonly links = new Map<string, Link>();
  private seq = 0;

  constructor(
    private readonly local: LocalStore,
    private readonly connect: (store: LocalStore, handlers: TransportHandlers) => Transport,
    private readonly idleMs = 60_000,
  ) {}

  async request(nodeId: string, command: Command, timeoutMs = 30_000): Promise<ServerEvent> {
    const link = this.link(nodeId);
    await link.ready;
    if (link.idle) clearTimeout(link.idle);
    const requestId = `mr-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(nodeId, link, requestId, new Error("The machine didn't answer.")), timeoutMs);
      link.pending.set(requestId, { resolve, reject, timer });
      void link.transport.send({ ...command, requestId });
    });
  }

  close(): void {
    for (const nodeId of [...this.links.keys()]) this.drop(nodeId, new Error("Closed."));
  }

  private link(nodeId: string): Link {
    const existing = this.links.get(nodeId);
    if (existing) return existing;
    // RelayTransport reads `cur` from its store; scope only that to this machine.
    const scoped = new Proxy(this.local, {
      get: (target, property, receiver) => property === "cur" ? nodeId : Reflect.get(target, property, receiver),
      set: (target, property, value, receiver) => property === "cur" ? true : Reflect.set(target, property, value, receiver),
    });
    let online!: () => void;
    const link = { pending: new Map() } as Link;
    link.ready = new Promise<void>((resolve, reject) => { online = resolve; link.fail = reject; });
    link.ready.catch(() => {});
    // Compared by identity, so a stale timer can't drop a newer link.
    link.connecting = setTimeout(() => { if (this.links.get(nodeId) === link) this.drop(nodeId, unreachable()); }, CONNECT_TIMEOUT_MS);
    link.transport = this.connect(scoped, {
      onStatus: (status) => { if (status === "online") { clearTimeout(link.connecting); online(); } },
      onEvent: (event) => {
        const requestId = String(event.requestId ?? "");
        if (!link.pending.has(requestId)) return;
        const failed = String(event.type ?? "").endsWith(".error");
        this.settle(nodeId, link, requestId, failed ? new Error(String((event as { error?: unknown }).error || "Request failed.")) : event);
      },
    });
    this.links.set(nodeId, link);
    void link.transport.connect().catch(() => { if (this.links.get(nodeId) === link) this.drop(nodeId, unreachable()); });
    return link;
  }

  private settle(nodeId: string, link: Link, requestId: string, outcome: ServerEvent | Error): void {
    const pending = link.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    link.pending.delete(requestId);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
    if (link.pending.size === 0) link.idle = setTimeout(() => { if (this.links.get(nodeId) === link) this.drop(nodeId, new Error("Closed.")); }, this.idleMs);
  }

  private drop(nodeId: string, error: Error): void {
    const link = this.links.get(nodeId);
    if (!link) return;
    this.links.delete(nodeId);
    if (link.idle) clearTimeout(link.idle);
    clearTimeout(link.connecting);
    link.fail(error);
    for (const pending of link.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    link.transport.close();
  }
}
