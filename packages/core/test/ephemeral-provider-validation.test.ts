// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { validateEphemeralProviderToken, type ExecRequest } from "../src/ephemeral.js";

describe("ephemeral provider credential validation", () => {
  it("Hetzner uses one read-only request", async () => {
    const calls: ExecRequest[] = [];
    await validateEphemeralProviderToken("hetzner", "secret", async (request) => {
      calls.push(request);
      return { status: 200, body: {} };
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("Fly discovers the token's org, then scopes the list-apps check to it", async () => {
    const calls: ExecRequest[] = [];
    await validateEphemeralProviderToken("fly", "secret", async (request) => {
      calls.push(request);
      if (request.url.includes("graphql")) {
        return { status: 200, body: { data: { organizations: { nodes: [{ slug: "my-github-org", type: "PERSONAL" }] } } } };
      }
      return { status: 200, body: [] };
    });
    const graphql = calls.find((c) => c.url.includes("api.fly.io/graphql"));
    const apps = calls.find((c) => c.url.includes("api.machines.dev/v1/apps"));
    // Org is read-only GraphQL; the Machines check is scoped to the real org
    // (not the literal "personal", which a GitHub-signup account doesn't have).
    expect(graphql?.method).toBe("POST");
    expect(apps?.method).toBe("GET");
    expect(apps?.url).toContain("org_slug=my-github-org");
  });

  it("Fly rejects a token that can see no organizations", async () => {
    await expect(validateEphemeralProviderToken("fly", "bad", async () => ({ status: 200, body: { data: { organizations: { nodes: [] } } } })))
      .rejects.toThrow(/no accessible organizations/i);
  });


  it("AWS signs read-only DescribeInstances", async () => {
    const calls: ExecRequest[] = [];
    await validateEphemeralProviderToken("aws", "AKID:SECRET", async (request) => {
      calls.push(request);
      return { status: 200, body: "<DescribeInstancesResponse/>" };
    }, "us-east-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(String(calls[0].body)).toContain("Action=DescribeInstances");
    expect(String(calls[0].body)).not.toContain("RunInstances");
  });

  it("rejects provider authentication errors", async () => {
    await expect(validateEphemeralProviderToken("hetzner", "bad", async () => ({ status: 401, body: { error: { message: "unauthorized" } } })))
      .rejects.toThrow(/401.*unauthorized/i);
  });
});
