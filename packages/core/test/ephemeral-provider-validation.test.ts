// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { validateEphemeralProviderToken, type ExecRequest } from "../src/ephemeral.js";

describe("ephemeral provider credential validation", () => {
  for (const provider of ["hetzner", "fly", "sprites"] as const) {
    it(`${provider} uses one read-only request`, async () => {
      const calls: ExecRequest[] = [];
      await validateEphemeralProviderToken(provider, "secret", async (request) => {
        calls.push(request);
        return { status: 200, body: {} };
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
    });
  }

  it("refuses credentials for a planned provider without making a request", async () => {
    const calls: ExecRequest[] = [];
    await expect(validateEphemeralProviderToken("e2b", "secret", async (request) => {
      calls.push(request);
      return { status: 200, body: {} };
    })).rejects.toThrow(/not available yet.*templates.*certification/i);
    expect(calls).toHaveLength(0);
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
