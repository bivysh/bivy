// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralAdapter, unb64, type BootstrapOpts, type ExecRequest, type ExecResult } from "../src/index.js";

// A Fly Machine is an OCI image in a microVM, not a cloud-init VM: the shared
// `#cloud-config` user_data is never executed, and a bare `ubuntu:24.04` runs
// `/bin/bash`, which exits immediately — so with `restart: no` + `auto_destroy`
// the machine boots and self-destructs before Bivy is ever installed (the
// reported "app has no machines" / node-offline bug). The adapter must instead
// write the bootstrap files and run the daemon as a blocking foreground process.

const BOOTSTRAP: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  ttlMinutes: 90,
  repo: "owner/repo",
};

const utf8Decode = (raw: string) => new TextDecoder().decode(unb64(raw));

type FlyFile = { guest_path: string; raw_value: string };
type FlyMachineBody = {
  region: string;
  config: {
    image?: string;
    auto_destroy: boolean;
    restart: { policy: string };
    guest?: { cpu_kind: string; cpus: number; memory_mb: number };
    init: { exec?: string[]; user_data?: string };
    files?: FlyFile[];
  };
};
const machineConfig = (req: ExecRequest) => (req.body as FlyMachineBody).config;

/** A Fly account created via GitHub gets a *named* org (not slugged "personal"),
 *  and that's the org the token can see — so provisioning resolves the org from
 *  the token via GraphQL before creating the app. */
const FLY_ORG_GRAPHQL: ExecResult = { status: 200, body: { data: { organizations: { nodes: [{ slug: "my-github-org", type: "PERSONAL" }] } } } };

/** Fake Fly transport: resolves the org over GraphQL, 200 on app create, returns
 *  a machine on machine create, and records the machine-create body so the test
 *  can assert its config. */
function fakeFlyExec() {
  const calls: ExecRequest[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    if (req.url === "https://api.fly.io/graphql") return FLY_ORG_GRAPHQL;
    if (req.url === "https://api.machines.dev/v1/apps") return { status: 201, body: {} };
    if (/\/machines$/.test(req.url)) return { status: 200, body: { id: "abc123", state: "starting" } };
    return { status: 404, body: null };
  };
  return { exec, calls };
}

describe("fly adapter — provision", () => {
  it("boots via files + a foreground init.exec, not cloud-init user_data", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    const machine = await adapter.provision({
      exec,
      token: "fly-token",
      userData: "#cloud-config\nruncmd: []\n",
      bootstrap: BOOTSTRAP,
      config: { slug: "abc123", region: "fra", size: "shared-2x-4gb", image: "ghcr.io/bivysh/bivy-ephemeral-runner:sha-test", ttlMinutes: 90 },
    });

    expect(machine).toMatchObject({ id: "abc123", provider: "fly", app: "bivy-abc123", region: "fra" });

    // The app is created in the org resolved from the token, not a hardcoded one.
    const appCreate = calls.find((c) => c.url === "https://api.machines.dev/v1/apps" && c.method === "POST")!;
    expect((appCreate.body as { org_slug?: string }).org_slug).toBe("my-github-org");

    const create = calls.find((c) => /\/machines$/.test(c.url))!;
    const cfg = machineConfig(create);

    // The machine still self-destructs when its process exits — but now that's
    // the daemon finishing, not a bare shell exiting on boot.
    expect(cfg.auto_destroy).toBe(true);
    expect(cfg.restart).toEqual({ policy: "no" });
    expect(cfg.image).toBe("ghcr.io/bivysh/bivy-ephemeral-runner:sha-test");

    // The broken cloud-init path must be gone.
    expect(cfg.init.user_data).toBeUndefined();

    // relay.json + start.sh are materialized as base64 files.
    const files = cfg.files!;
    const relay = files.find((f) => f.guest_path === "/etc/bivy/relay.json")!;
    const start = files.find((f) => f.guest_path === "/etc/bivy/start.sh")!;
    expect(relay).toBeTruthy();
    expect(start).toBeTruthy();

    // relay.json carries the enrollment the daemon dials the relay with.
    expect(JSON.parse(utf8Decode(relay.raw_value))).toMatchObject({
      url: "wss://relay.bivy.sh",
      enrollmentToken: "enroll-tok",
      e2eKey: "e2e-key-b64",
      controlPlaneUrl: "https://app.bivy.sh",
    });

    // start.sh exports the runtime env and runs the daemon in the foreground.
    const startScript = utf8Decode(start.raw_value);
    expect(startScript).toContain("export BIVY_DATA_DIR=/etc/bivy");
    expect(startScript).toContain("export BIVY_REPO='owner/repo'");
    expect(startScript).toContain("exec bivy start");

    // init.exec uses preinstalled Bivy when present, falls back to installing
    // curl+Bivy for a generic image, then
    // hands the foreground to start.sh under a TTL timeout (90 min → 5400s), the
    // backstop that replaces the VM shutdown. `pipefail` makes a failed install
    // abort loudly instead of limping on to a doomed `bivy start`.
    const script = cfg.init.exec![2];
    expect(cfg.init.exec[0]).toBe("/bin/bash");
    expect(cfg.init.exec[1]).toBe("-lc");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("command -v bivy");
    expect(script).toContain("apt-get install -y -qq curl ca-certificates");
    expect(script).toContain("curl -fsSL");
    expect(script).toContain("exec timeout 5400 bash /etc/bivy/start.sh");
  });

  it("derives guest cpu_kind/cpus/memory from the size row, so a new lane is a data row", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    await adapter.provision({
      exec,
      token: "fly-token",
      userData: "",
      bootstrap: BOOTSTRAP,
      config: { slug: "abc123", region: "iad", size: "shared-8x-16gb", ttlMinutes: 60 },
    });
    const create = calls.find((c) => /\/machines$/.test(c.url))!;
    expect(machineConfig(create).guest).toEqual({ cpu_kind: "shared", cpus: 8, memory_mb: 16384 });
  });

  it("catalogs the 8 vCPU / 16 GB size with an indicative price", () => {
    const size = ephemeralAdapter("fly")!.sizes.find((s) => s.id === "shared-8x-16gb")!;
    expect(size).toMatchObject({ vcpus: 8, memoryMiB: 16384, architecture: "x86_64", pricePerHour: 0.1234, priceSource: "indicative" });
  });

  it("falls back to cloud-init user_data when no structured bootstrap is given", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    await adapter.provision({
      exec,
      token: "fly-token",
      userData: "#cloud-config\nruncmd: []\n",
      config: { slug: "abc123", region: "fra", size: "shared-1x-2gb", ttlMinutes: 60 },
    });
    const create = calls.find((c) => /\/machines$/.test(c.url))!;
    const cfg = machineConfig(create);
    expect(cfg.init).toEqual({ user_data: "#cloud-config\nruncmd: []\n" });
    expect(cfg.files).toBeUndefined();
  });
});

describe("fly adapter — orphan discovery", () => {
  it("only lists bivy- apps and filters machines by the account ownership tag", async () => {
    const calls: ExecRequest[] = [];
    const exec = async (req: ExecRequest): Promise<ExecResult> => {
      calls.push(req);
      if (req.url === "https://api.fly.io/graphql") return FLY_ORG_GRAPHQL;
      if (req.url.startsWith("https://api.machines.dev/v1/apps?org_slug=")) {
        return { status: 200, body: { apps: [{ name: "bivy-abc123" }, { name: "someone-elses-app" }] } };
      }
      if (req.url === "https://api.machines.dev/v1/apps/bivy-abc123/machines") {
        return {
          status: 200,
          body: [
            { id: "mine", region: "fra", state: "started", config: { metadata: { bivy: "ephemeral", "bivy-account": "owner-tag-1", "bivy-attempt": "attempt-1" } }, created_at: "2026-08-01T00:00:00Z" },
            { id: "not-mine", region: "fra", state: "started", config: { metadata: { bivy: "ephemeral", "bivy-account": "owner-tag-OTHER" } } },
            { id: "not-bivy", region: "fra", state: "started", config: { metadata: {} } },
          ],
        };
      }
      return { status: 404, body: null };
    };
    const found = await ephemeralAdapter("fly")!.discover!({ exec, token: "fly-token", ownershipTag: "owner-tag-1" });
    expect(found).toEqual([{ id: "mine", provider: "fly", app: "bivy-abc123", name: "bivy-abc123", region: "fra", status: "running", ip: null, createdAt: "2026-08-01T00:00:00Z", attemptId: "attempt-1" }]);
    // Never touched the non-bivy- app.
    expect(calls.some((c) => c.url.includes("someone-elses-app"))).toBe(false);
  });

  it("skips an app whose machine list fails, rather than aborting the whole scan", async () => {
    const exec = async (req: ExecRequest): Promise<ExecResult> => {
      if (req.url === "https://api.fly.io/graphql") return FLY_ORG_GRAPHQL;
      if (req.url.startsWith("https://api.machines.dev/v1/apps?org_slug=")) return { status: 200, body: { apps: [{ name: "bivy-broken" }, { name: "bivy-ok" }] } };
      if (req.url === "https://api.machines.dev/v1/apps/bivy-broken/machines") return { status: 500, body: { error: "boom" } };
      if (req.url === "https://api.machines.dev/v1/apps/bivy-ok/machines") {
        return { status: 200, body: [{ id: "ok1", region: "iad", state: "started", config: { metadata: { bivy: "ephemeral", "bivy-account": "owner-tag-1" } } }] };
      }
      return { status: 404, body: null };
    };
    const found = await ephemeralAdapter("fly")!.discover!({ exec, token: "fly-token", ownershipTag: "owner-tag-1" });
    expect(found).toEqual([{ id: "ok1", provider: "fly", app: "bivy-ok", name: "bivy-ok", region: "iad", status: "running", ip: null, createdAt: "", attemptId: undefined }]);
  });
});
