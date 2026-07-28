// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  ephemeralAdapter,
  ephemeralProviderSuspendsWhenIdle,
  wakeEphemeralMachine,
  createEphemeralKeyStore,
  memoryBackend,
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

// Fake Sprites transport: 200/201 for create, service PUT, and service start;
// records every request so the test can assert the exact REST shapes.
function fakeSpritesExec(overrides: Record<string, ExecResult> = {}) {
  const calls: ExecRequest[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    const key = `${req.method || "GET"} ${req.url}`;
    if (overrides[key]) return overrides[key];
    if (req.method === "POST" && /\/v1\/sprites$/.test(req.url)) return { status: 201, body: { name: "bivy-abc123" } };
    if (req.method === "PUT" && /\/services\/bivy$/.test(req.url)) return { status: 200, body: {} };
    if (req.method === "POST" && /\/services\/bivy\/start$/.test(req.url)) return { status: 200, body: {} };
    if (req.method === "GET") return { status: 200, body: { name: "bivy-abc123", status: "running" } };
    if (req.method === "DELETE") return { status: 204, body: null };
    return { status: 404, body: null };
  };
  return { exec, calls };
}

describe("sprites adapter — provision", () => {
  it("creates a sprite, registers the bivy service, and starts it", async () => {
    const { exec, calls } = fakeSpritesExec();
    const adapter = ephemeralAdapter("sprites")!;

    const machine = await adapter.provision({
      exec,
      token: "sprite-token",
      userData: "",
      bootstrap: BOOTSTRAP,
      config: { slug: "abc123", region: "fra", size: "8x8" },
    });

    expect(machine).toMatchObject({ id: "bivy-abc123", provider: "sprites", app: "bivy-abc123", region: "fra", status: "starting" });

    // 1. create sprite with cpus/ram/region and the bivy label.
    const create = calls.find((c) => c.method === "POST" && /\/v1\/sprites$/.test(c.url))!;
    expect(create.url).toBe("https://api.sprites.dev/v1/sprites");
    expect(create.body).toMatchObject({ name: "bivy-abc123", labels: ["bivy"], config: { cpus: 8, ram_mb: 8192, region: "fra" } });

    // 2. register the daemon as a supervised service (PUT = create-or-replace).
    const svc = calls.find((c) => c.method === "PUT" && /\/services\/bivy$/.test(c.url))!;
    expect(svc.url).toBe("https://api.sprites.dev/v1/sprites/bivy-abc123/services/bivy");
    const svcBody = svc.body as { cmd: string; args: string[]; env: Record<string, string> };
    expect(svcBody.cmd).toBe("bash");
    // relay enrollment rides in an env var (no separate file-API call) and the
    // script decodes it, installs bivy once, then runs the daemon foreground.
    expect(JSON.parse(utf8Decode(svcBody.env.BIVY_RELAY_JSON_B64))).toMatchObject({
      url: "wss://relay.bivy.sh",
      enrollmentToken: "enroll-tok",
      e2eKey: "e2e-key-b64",
    });
    expect(svcBody.env.BIVY_DATA_DIR).toBe("/etc/bivy");
    expect(svcBody.env.BIVY_REPO).toBe("owner/repo");
    expect(svcBody.args[0]).toBe("-lc");
    expect(svcBody.args[1]).toContain("exec bivy start");
    expect(svcBody.args[1]).toContain("base64 -d > /etc/bivy/relay.json");

    // 3. start the service (also the wake path later).
    expect(calls.some((c) => c.method === "POST" && /\/services\/bivy\/start$/.test(c.url))).toBe(true);
  });

  it("surfaces a create failure", async () => {
    const { exec } = fakeSpritesExec({ "POST https://api.sprites.dev/v1/sprites": { status: 402, body: { error: "no capacity" } } });
    const adapter = ephemeralAdapter("sprites")!;
    await expect(
      adapter.provision({ exec, token: "t", userData: "", bootstrap: BOOTSTRAP, config: { slug: "abc123", region: "iad", size: "4x8" } }),
    ).rejects.toThrow(/create sprite/i);
  });
});

describe("sprites adapter — status/destroy/wake", () => {
  const machine: EphemeralMachine = {
    id: "bivy-abc123",
    provider: "sprites",
    app: "bivy-abc123",
    name: "bivy-abc123",
    region: "iad",
    status: "running",
    ip: null,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("maps a suspended (cold) sprite to 'stopped' and a missing one to 'gone'", async () => {
    const adapter = ephemeralAdapter("sprites")!;
    const cold = await adapter.status({ exec: async () => ({ status: 200, body: { status: "cold" } }), token: "t", machine });
    expect(cold).toBe("stopped");
    const gone = await adapter.status({ exec: async () => ({ status: 404, body: null }), token: "t", machine });
    expect(gone).toBe("gone");
    const running = await adapter.status({ exec: async () => ({ status: 200, body: { status: "running" } }), token: "t", machine });
    expect(running).toBe("running");
  });

  it("wakes a sprite by starting its service", async () => {
    const { exec, calls } = fakeSpritesExec();
    const adapter = ephemeralAdapter("sprites")!;
    await adapter.wake!({ exec, token: "t", machine });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.sprites.dev/v1/sprites/bivy-abc123/services/bivy/start");
  });

  it("destroys via DELETE", async () => {
    const { exec, calls } = fakeSpritesExec();
    const adapter = ephemeralAdapter("sprites")!;
    await adapter.destroy({ exec, token: "t", machine });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.sprites.dev/v1/sprites/bivy-abc123");
  });
});

describe("sprites suspend-to-zero helpers", () => {
  it("marks sprites as suspend-when-idle and the destroy-providers as not", () => {
    expect(ephemeralProviderSuspendsWhenIdle("sprites")).toBe(true);
    expect(ephemeralProviderSuspendsWhenIdle("fly")).toBe(false);
    expect(ephemeralProviderSuspendsWhenIdle("hetzner")).toBe(false);
    expect(ephemeralProviderSuspendsWhenIdle("aws")).toBe(false);
  });

  it("wakeEphemeralMachine hits the provider wake, and no-ops for non-suspend providers", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await keys.setToken("sprites", "sprite-token");
    const { exec, calls } = fakeSpritesExec();
    await wakeEphemeralMachine(
      { id: "bivy-x", provider: "sprites", app: "bivy-x", name: "bivy-x", region: "iad", status: "stopped", ip: null, createdAt: "" },
      { exec, keys },
    );
    expect(calls.some((c) => /\/services\/bivy\/start$/.test(c.url))).toBe(true);

    // A Fly machine has no wake — the helper is a no-op (never throws).
    let flyCalled = false;
    await wakeEphemeralMachine(
      { id: "m", provider: "fly", app: "bivy-m", name: "bivy-m", region: "iad", status: "stopped", ip: null, createdAt: "" },
      { exec: async () => { flyCalled = true; return { status: 200, body: {} }; }, keys },
    );
    expect(flyCalled).toBe(false);
  });

  it("wakeEphemeralMachine asks for the token when none is saved", async () => {
    const keys = createEphemeralKeyStore(memoryBackend());
    await expect(
      wakeEphemeralMachine(
        { id: "bivy-x", provider: "sprites", app: "bivy-x", name: "bivy-x", region: "iad", status: "stopped", ip: null, createdAt: "" },
        { exec: async () => ({ status: 200, body: {} }), keys },
      ),
    ).rejects.toThrow(/token/i);
  });
});
