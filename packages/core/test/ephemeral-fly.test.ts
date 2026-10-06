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
    const script = cfg.init.exec![5];
    expect(cfg.init.exec!.slice(0, 5)).toEqual(["/usr/bin/timeout", "--kill-after=10s", "5400", "/bin/bash", "-c"]);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("command -v bivy");
    expect(script).toContain("apt-get install -y -qq curl ca-certificates");
    expect(script).toContain("--max-time 120 -fsSL");
    expect(script).toContain("exec bash /etc/bivy/start.sh");
    expect(script).toContain("/node/bootstrap-status");
    expect(script).toContain("chmod 600 /etc/bivy/relay.json /etc/bivy/start.sh");
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

  it("rejects unsupported cloud-init before creating any billable resource", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    await expect(adapter.provision({
      exec,
      token: "fly-token",
      userData: "#cloud-config\nruncmd: []\n",
      config: { slug: "abc123", region: "fra", size: "shared-1x-2gb", ttlMinutes: 60, attemptId: "test" },
    })).rejects.toThrow("structured Bivy bootstrap");
    expect(calls).toEqual([]);
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

describe("fly adapter — sleeping machine", () => {
  /** Fly fake with an app-scoped volume list and a start endpoint. */
  function sleepingFlyExec(volumes: { id: string; name: string }[] = [], machineState = "stopped") {
    const calls: ExecRequest[] = [];
    const exec = async (req: ExecRequest): Promise<ExecResult> => {
      calls.push(req);
      if (req.url === "https://api.fly.io/graphql") return FLY_ORG_GRAPHQL;
      if (req.url === "https://api.machines.dev/v1/apps") return { status: 201, body: {} };
      if (/\/volumes$/.test(req.url)) return req.method === "GET" ? { status: 200, body: volumes } : { status: 200, body: { id: "vol_new" } };
      if (/\/machines$/.test(req.url)) return req.method === "GET" ? { status: 200, body: [] } : { status: 200, body: { id: "m1", state: "starting" } };
      if (/\/start$/.test(req.url)) return machineState === "started" ? { status: 412, body: { error: "machine still active" } } : { status: 200, body: {} };
      if (/\/machines\/m1$/.test(req.url)) return { status: 200, body: { state: machineState } };
      return { status: 404, body: null };
    };
    return { exec, calls };
  }
  const provision = (exec: (req: ExecRequest) => Promise<ExecResult>) => ephemeralAdapter("fly")!.provision({
    exec, token: "t", userData: "", bootstrap: { ...BOOTSTRAP, provider: "fly", sleepOnIdle: true },
    config: { slug: "abc", region: "fra", size: "shared-4x-8gb", attemptId: "a1", persistentDiskGb: 10 },
  });

  it("mounts a persistent volume and stops instead of self-destructing", async () => {
    const { exec, calls } = sleepingFlyExec();
    await provision(exec);
    const createVolume = calls.find((c) => c.method === "POST" && /\/volumes$/.test(c.url))!;
    expect(createVolume.body).toMatchObject({ name: "bivy_data", region: "fra", size_gb: 10 });
    const cfg = machineConfig(calls.find((c) => c.method === "POST" && /\/machines$/.test(c.url))!) as FlyMachineBody["config"] & { mounts?: unknown };
    expect(cfg.auto_destroy).toBe(false);
    expect(cfg.mounts).toEqual([{ volume: "vol_new", path: "/data" }]);
    expect(cfg.init.exec![5]).toContain("install -m 600 /etc/bivy/relay.json /data/bivy/relay.json");
  });

  it("adopts the app's existing volume on a retried launch", async () => {
    const { exec, calls } = sleepingFlyExec([{ id: "vol_old", name: "bivy_data" }]);
    await provision(exec);
    expect(calls.some((c) => c.method === "POST" && /\/volumes$/.test(c.url))).toBe(false);
    const cfg = machineConfig(calls.find((c) => c.method === "POST" && /\/machines$/.test(c.url))!) as FlyMachineBody["config"] & { mounts?: unknown };
    expect(cfg.mounts).toEqual([{ volume: "vol_old", path: "/data" }]);
  });

  it("wakes a stopped machine, and treats an already-running one as awake", async () => {
    const machine = { id: "m1", provider: "fly", app: "bivy-abc", name: "bivy-abc", region: "fra", status: "stopped", ip: null, createdAt: "" };
    const stopped = sleepingFlyExec();
    await ephemeralAdapter("fly")!.wake!({ exec: stopped.exec, token: "t", machine });
    expect(stopped.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.machines.dev/v1/apps/bivy-abc/machines/m1/start" });
    const running = sleepingFlyExec([], "started");
    await expect(ephemeralAdapter("fly")!.wake!({ exec: running.exec, token: "t", machine })).resolves.toBeUndefined();
  });

  it("deletes the volume with the app on destroy", async () => {
    const calls: ExecRequest[] = [];
    const exec = async (req: ExecRequest): Promise<ExecResult> => {
      calls.push(req);
      if (/\/machines$/.test(req.url)) return { status: 200, body: [] };
      if (/\/volumes$/.test(req.url)) return { status: 200, body: [{ id: "vol_1", name: "bivy_data" }] };
      return { status: 200, body: {} };
    };
    await ephemeralAdapter("fly")!.destroy({ exec, token: "t", machine: { id: "m1", provider: "fly", app: "bivy-abc", name: "bivy-abc", region: "fra", status: "stopped", ip: null, createdAt: "" } });
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toEqual([
      "https://api.machines.dev/v1/apps/bivy-abc/machines/m1?force=true",
      "https://api.machines.dev/v1/apps/bivy-abc/volumes/vol_1",
      "https://api.machines.dev/v1/apps/bivy-abc",
    ]);
  });
});
