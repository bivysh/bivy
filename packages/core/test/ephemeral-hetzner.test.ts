// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralAdapter, type ExecRequest } from "../src/index.js";

const config = { slug: "abc", region: "nbg1", size: "cpx21", ttlMinutes: 30, attemptId: "attempt-abc" };

describe("Hetzner recoverable create", () => {
  it("adopts a server carrying the stable attempt label before retrying create", async () => {
    const calls: ExecRequest[] = [];
    const machine = await ephemeralAdapter("hetzner")!.provision({
      token: "token", config, userData: "#cloud-config",
      exec: async (request) => {
        calls.push(request);
        return { status: 200, body: { servers: [{ id: 42, status: "running", public_net: { ipv4: { ip: "192.0.2.4" } } }] } };
      },
    });
    expect(machine).toMatchObject({ id: "42", status: "running" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("label_selector=");
  });

  it("tags a new server when no prior attempt resource exists", async () => {
    const calls: ExecRequest[] = [];
    await ephemeralAdapter("hetzner")!.provision({
      token: "token", config, userData: "#cloud-config",
      exec: async (request) => {
        calls.push(request);
        if (request.method === "GET") return { status: 200, body: { servers: [] } };
        return { status: 201, body: { server: { id: 43, status: "initializing", public_net: {} } } };
      },
    });
    const create = calls.find((request) => request.method === "POST")!;
    expect((create.body as { labels: Record<string, string> }).labels).toEqual({ bivy: "ephemeral", "bivy-attempt": "attempt-abc" });
  });

  it("tags a new server with both the attempt and account ownership labels when given", async () => {
    const calls: ExecRequest[] = [];
    await ephemeralAdapter("hetzner")!.provision({
      token: "token", config: { ...config, ownershipTag: "owner-tag-1" }, userData: "#cloud-config",
      exec: async (request) => {
        calls.push(request);
        if (request.method === "GET") return { status: 200, body: { servers: [] } };
        return { status: 201, body: { server: { id: 44, status: "initializing", public_net: {} } } };
      },
    });
    const create = calls.find((request) => request.method === "POST")!;
    expect((create.body as { labels: Record<string, string> }).labels).toEqual({
      bivy: "ephemeral", "bivy-attempt": "attempt-abc", "bivy-account": "owner-tag-1",
    });
  });
});

describe("Hetzner orphan discovery", () => {
  it("lists servers by the account ownership tag and maps their attempt label", async () => {
    const calls: ExecRequest[] = [];
    const found = await ephemeralAdapter("hetzner")!.discover!({
      token: "token", ownershipTag: "owner-tag-1",
      exec: async (request) => {
        calls.push(request);
        return {
          status: 200,
          body: {
            servers: [
              { id: 99, name: "bivy-lost", status: "running", datacenter: { location: { name: "nbg1" } }, public_net: { ipv4: { ip: "192.0.2.9" } }, created: "2026-08-01T00:00:00Z", labels: { bivy: "ephemeral", "bivy-account": "owner-tag-1", "bivy-attempt": "attempt-lost" } },
            ],
          },
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain(encodeURIComponent("bivy-account=owner-tag-1"));
    expect(found).toEqual([{
      id: "99", provider: "hetzner", name: "bivy-lost", region: "nbg1", status: "running",
      ip: "192.0.2.9", createdAt: "2026-08-01T00:00:00Z", attemptId: "attempt-lost",
    }]);
  });

  it("returns an empty list when nothing is tagged for this account", async () => {
    const found = await ephemeralAdapter("hetzner")!.discover!({
      token: "token", ownershipTag: "owner-tag-empty",
      exec: async () => ({ status: 200, body: { servers: [] } }),
    });
    expect(found).toEqual([]);
  });
});
