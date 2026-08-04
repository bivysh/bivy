// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { DirectTransport } from "../src/transport-direct.js";
import type { ConnectionStatus, ServerEvent } from "../src/protocol.js";

function mem(items: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(items));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = FakeWS.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }

  send(s: string) {
    this.sent.push(s);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }
}

function okFetch(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("DirectTransport", () => {
  it("sends ping over the raw event WebSocket instead of REST", async () => {
    FakeWS.instances.length = 0;
    const fetchCalls: string[] = [];
    const events: ServerEvent[] = [];
    const statuses: ConnectionStatus[] = [];
    const transport = new DirectTransport({
      origin: "http://node.local",
      tokenStore: mem({ bivy_local_token: "token" }),
      fetchImpl: okFetch(fetchCalls),
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      handlers: {
        onEvent: (e) => events.push(e),
        onStatus: (s) => statuses.push(s),
      },
    });

    await transport.connect();
    const ws = FakeWS.instances[0];
    ws.open();
    await tick();
    fetchCalls.length = 0;
    events.length = 0;
    ws.sent.length = 0;

    await transport.send({ kind: "ping", requestId: "r1" });

    expect(fetchCalls).toEqual([]);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ kind: "ping", requestId: "r1" }]);
    expect(events).toEqual([]);
    expect(statuses).toContain("online");
  });

  it("forwards the models.list runtime hint as a query param", async () => {
    FakeWS.instances.length = 0;
    const fetchCalls: string[] = [];
    const transport = new DirectTransport({
      origin: "http://node.local",
      tokenStore: mem({ bivy_local_token: "token" }),
      fetchImpl: okFetch(fetchCalls),
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      handlers: { onEvent: () => {}, onStatus: () => {} },
    });
    await transport.connect();
    FakeWS.instances[0].open();
    await tick();
    fetchCalls.length = 0;

    await transport.send({ kind: "models.list", runtimeId: "codex" });
    expect(fetchCalls.some((u) => u.includes("/api/models?") && u.includes("runtimeId=codex"))).toBe(true);
  });

  it("routes models.prefetch to the prefetch endpoint (no session/runtime query)", async () => {
    FakeWS.instances.length = 0;
    const fetchCalls: string[] = [];
    const transport = new DirectTransport({
      origin: "http://node.local",
      tokenStore: mem({ bivy_local_token: "token" }),
      fetchImpl: okFetch(fetchCalls),
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      handlers: { onEvent: () => {}, onStatus: () => {} },
    });
    await transport.connect();
    FakeWS.instances[0].open();
    await tick();
    fetchCalls.length = 0;

    await transport.send({ kind: "models.prefetch", runtimeIds: ["claude", "codex"] });
    expect(fetchCalls.some((u) => u.endsWith("/api/models/prefetch"))).toBe(true);
  });
});
