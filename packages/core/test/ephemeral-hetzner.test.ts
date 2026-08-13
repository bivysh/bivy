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
});
