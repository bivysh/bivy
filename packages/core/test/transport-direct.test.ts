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

function okFetch(calls: string[], responses: Record<string, unknown> = {}): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const pathname = new URL(String(url), "http://node.local").pathname;
    return { ok: true, json: async () => responses[pathname] ?? {} };
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

  it("routes session forks through the direct REST API and emits the returned fork event", async () => {
    const fetchCalls: string[] = [];
    const events: ServerEvent[] = [];
    const transport = new DirectTransport({
      origin: "http://node.local",
      tokenStore: mem({ bivy_local_token: "token" }),
      fetchImpl: okFetch(fetchCalls, {
        "/api/session/fork/local": { type: "session.fork.done", requestId: "r-fork", sessionId: "fork-1", fidelity: "full", missing: [] },
      }),
      webSocketImpl: FakeWS as unknown as typeof WebSocket,
      handlers: {
        onEvent: (e) => events.push(e),
        onStatus: () => {},
      },
    });

    await transport.send({ kind: "session.fork.local", requestId: "r-fork", sessionId: "source-1" });

    expect(fetchCalls).toEqual(["http://node.local/api/session/fork/local"]);
    expect(events).toEqual([{ type: "session.fork.done", requestId: "r-fork", sessionId: "fork-1", fidelity: "full", missing: [] }]);
  });
});
