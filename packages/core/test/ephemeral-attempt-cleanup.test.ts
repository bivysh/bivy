// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { flyProvider } from "../src/ephemeral-providers/fly.js";
import type { ExecRequest } from "../src/ephemeral-provider-ports.js";

describe("canceled Fly launch cleanup", () => {
  async function cleanup(responses: Array<{ status: number; body?: unknown }>) {
    const requests: ExecRequest[] = [];
    const gone = await flyProvider.cleanupAttempt!({ token: "test", nodeId: "eph-0123456789abcdef", attemptId: "attempt", ownershipTag: "owner", exec: async req => {
      requests.push(req);
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return { status: response.status, body: response.body ?? null };
    } });
    return { gone, requests };
  }
  it("confirms an already absent app independently of the machine-list 404", async () => {
    expect((await cleanup([{ status: 404 }, { status: 404 }])).gone).toBe(true);
    expect((await cleanup([{ status: 404 }, { status: 403 }])).gone).toBe(false);
  });
  it("removes an empty dedicated app and waits for provider absence", async () => {
    const result = await cleanup([{ status: 200, body: [] }, { status: 202 }, { status: 404 }]);
    expect(result.gone).toBe(true);
    expect(result.requests.map(r => r.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(result.requests[1]?.url).toMatch(/\/apps\/bivy-0123456789abcdef$/);
    expect((await cleanup([{ status: 200, body: [] }, { status: 202 }, { status: 200 }])).gone).toBe(false);
  });
  it("retains ambiguous or foreign machines without deleting anything", async () => {
    const result = await cleanup([{ status: 200, body: [{ id: "foreign", config: { metadata: { "bivy-attempt": "other" } } }] }]);
    expect(result.gone).toBe(false);
    expect(result.requests).toHaveLength(1);
  });
  it("cleans an accepted machine whose response was lost using both ownership markers", async () => {
    const result = await cleanup([{ status: 200, body: [{ id: "owned", config: { metadata: { "bivy-attempt": "attempt", "bivy-account": "owner" } } }] }, { status: 200 }, { status: 202 }, { status: 404 }]);
    expect(result.gone).toBe(true);
    expect(result.requests[1]?.url).toContain("/machines/owned?force=true");
  });
});
