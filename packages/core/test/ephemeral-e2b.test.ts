// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  ALLOWED_HOSTS,
  ephemeralAdapter,
  ephemeralProviderSuspendsWhenIdle,
  unb64,
  type BootstrapOpts,
  type EphemeralMachine,
  type ExecRequest,
  type ExecResult,
} from "../src/index.js";

const BOOTSTRAP: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  repo: "owner/repo",
};

const utf8Decode = (raw: string) => new TextDecoder().decode(unb64(raw));

// Fake E2B transport: 201 for create, 200 for status, 204 for kill; records
// every request so the test can assert the exact REST shapes.
function fakeE2bExec(overrides: Record<string, ExecResult> = {}) {
  const calls: ExecRequest[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    const key = `${req.method || "GET"} ${req.url}`;
    if (overrides[key]) return overrides[key];
    if (req.method === "POST" && /\/v2\/sandboxes$/.test(req.url)) return { status: 201, body: { sandboxID: "sbx_123", state: "running" } };
    if (req.method === "POST" && /\/resume$/.test(req.url)) return { status: 200, body: {} };
    if (req.method === "GET") return { status: 200, body: { sandboxID: "sbx_123", state: "running" } };
    if (req.method === "DELETE") return { status: 204, body: null };
    return { status: 404, body: null };
  };
  return { exec, calls };
}

describe("e2b adapter — provision", () => {
  it("creates a sandbox from the size-matched template with autoPause + relay env", async () => {
    const { exec, calls } = fakeE2bExec();
    const adapter = ephemeralAdapter("e2b")!;

    const machine = await adapter.provision({
      exec,
      token: "e2b-key",
      userData: "",
      bootstrap: BOOTSTRAP,
      config: { slug: "abc123", region: "us", size: "4x8" },
    });

    expect(machine).toMatchObject({ id: "sbx_123", provider: "e2b", app: "sbx_123", status: "starting" });

    const create = calls.find((c) => c.method === "POST" && /\/v2\/sandboxes$/.test(c.url))!;
    expect(create.url).toBe("https://api.e2b.app/v2/sandboxes");
    expect((create.headers as Record<string, string>)["X-API-Key"]).toBe("e2b-key");
    const body = create.body as { templateID: string; timeout: number; autoPause: boolean; envVars: Record<string, string> };
    // each size selects a distinct published template.
    expect(body.templateID).toBe("bivy-4x8");
    // deterministic server-enforced timeout, pausing (not killing) on elapse.
    expect(body.autoPause).toBe(true);
    expect(body.timeout).toBeGreaterThan(0);
    // relay enrollment rides as env vars the template's start command reads.
    expect(JSON.parse(utf8Decode(body.envVars.BIVY_RELAY_JSON_B64))).toMatchObject({
      url: "wss://relay.bivy.sh",
      enrollmentToken: "enroll-tok",
      e2eKey: "e2e-key-b64",
    });
    expect(body.envVars.BIVY_DATA_DIR).toBe("/etc/bivy");
    expect(body.envVars.BIVY_REPO).toBe("owner/repo");
  });

  it("surfaces a create failure", async () => {
    const { exec } = fakeE2bExec({ "POST https://api.e2b.app/v2/sandboxes": { status: 402, body: { message: "over quota" } } });
    const adapter = ephemeralAdapter("e2b")!;
    await expect(
      adapter.provision({ exec, token: "t", userData: "", bootstrap: BOOTSTRAP, config: { slug: "abc123", region: "us", size: "2x4" } }),
    ).rejects.toThrow(/create sandbox/i);
  });
});

describe("e2b adapter — status/destroy/wake", () => {
  const machine: EphemeralMachine = {
    id: "sbx_123",
    provider: "e2b",
    app: "sbx_123",
    name: "bivy-abc123",
    region: "us",
    status: "running",
    ip: null,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("maps a paused sandbox to 'stopped' and a missing one to 'gone'", async () => {
    const adapter = ephemeralAdapter("e2b")!;
    expect(await adapter.status({ exec: async () => ({ status: 200, body: { state: "paused" } }), token: "t", machine })).toBe("stopped");
    expect(await adapter.status({ exec: async () => ({ status: 404, body: null }), token: "t", machine })).toBe("gone");
    expect(await adapter.status({ exec: async () => ({ status: 200, body: { state: "running" } }), token: "t", machine })).toBe("running");
  });

  it("wakes a sandbox by resuming it and tolerates already-running (409)", async () => {
    const { exec, calls } = fakeE2bExec({ "POST https://api.e2b.app/v2/sandboxes/sbx_123/resume": { status: 409, body: {} } });
    const adapter = ephemeralAdapter("e2b")!;
    await adapter.wake!({ exec, token: "t", machine });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.e2b.app/v2/sandboxes/sbx_123/resume");
  });

  it("destroys via DELETE and tolerates a 404", async () => {
    const { exec, calls } = fakeE2bExec({ "DELETE https://api.e2b.app/v2/sandboxes/sbx_123": { status: 404, body: null } });
    const adapter = ephemeralAdapter("e2b")!;
    await adapter.destroy({ exec, token: "t", machine });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.e2b.app/v2/sandboxes/sbx_123");
  });
});

describe("e2b suspend-to-zero wiring", () => {
  it("is a suspend-when-idle provider with a wake path", () => {
    const adapter = ephemeralAdapter("e2b")!;
    expect(adapter.suspendsWhenIdle).toBe(true);
    expect(typeof adapter.wake).toBe("function");
    expect(ephemeralProviderSuspendsWhenIdle("e2b")).toBe(true);
  });

  it("allowlists the E2B host in lock-step with the other providers", () => {
    expect(ALLOWED_HOSTS).toContain("api.e2b.app");
  });
});
