// SPDX-License-Identifier: AGPL-3.0-only
import type { LocalStore, Transport } from "@bivy/core";

/** Acquire missing title keys without changing the selected machine. Failed or
 * offline machines are retried on a later index refresh, with a cooldown. */
export class SessionTitleKeys {
  private closed = false;
  private readonly pending = new Map<string, () => void>();
  private readonly attempted = new Map<string, number>();

  constructor(
    private readonly local: LocalStore,
    private readonly connect: (store: LocalStore, ready: () => void) => Transport,
    private readonly changed: () => void,
  ) {}

  ensure(nodeIds: string[]): void {
    if (this.closed) return;
    for (const nodeId of new Set(nodeIds)) {
      if (!nodeId || this.local.keys()[nodeId] || this.pending.has(nodeId)) continue;
      if (Date.now() - (this.attempted.get(nodeId) ?? 0) < 60_000) continue;
      if (this.pending.size >= 3) break;
      this.attempted.set(nodeId, Date.now());
      const scoped = new Proxy(this.local, {
        get: (target, property, receiver) => property === "cur" ? nodeId : Reflect.get(target, property, receiver),
        set: (target, property, value, receiver) => property === "cur" ? true : Reflect.set(target, property, value, receiver),
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        transport.close();
        this.pending.delete(nodeId);
      };
      const transport = this.connect(scoped, () => {
        if (finished || !this.local.keys()[nodeId]) return;
        finish();
        this.changed();
        this.ensure(nodeIds);
      });
      const timer = setTimeout(() => {
        finish();
        this.ensure(nodeIds);
      }, 15_000);
      this.pending.set(nodeId, finish);
      void transport.connect().catch(finish).finally(() => {
        // A slow ticket request may complete after timeout or sign-out.
        if (finished) transport.close();
      });
    }
  }

  close(): void {
    this.closed = true;
    for (const finish of this.pending.values()) finish();
    this.attempted.clear();
  }
}
