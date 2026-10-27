// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A provider and a Core that record what the fleet asked them for, so the
// suites can drive the real CloudComputers and Runners without a provider
// account or a control plane.
import type { CoreClient, ComputeSettings } from "../src/computers.js";
import type { Machine, MachineProvider, MachineSpec } from "../src/provider.js";
import type { RunnerSettings } from "../src/runners.js";

export function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`✗ FAIL: ${message}`);
  console.log(`✓ ${message}`);
}

export async function run(...suites: Array<() => Promise<void>>): Promise<void> {
  try {
    for (const suite of suites) await suite();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export interface FakeMachine extends Machine {
  app: string;
  spec: MachineSpec;
  starts: number;
  stops: number;
}

export class FakeProvider implements MachineProvider {
  readonly apps = new Set<string>();
  readonly volumes = new Map<string, { app: string; sizeGb: number }>();
  readonly machines = new Map<string, FakeMachine>();
  readonly destroyedApps: string[] = [];
  busy: string[] = [];
  usage: { usedBytes: number; totalBytes: number } | null = null;
  /** Set to make the next call of that name throw once. */
  failOnce = new Set<string>();
  private next = 0;

  async ensureApp(app: string): Promise<void> {
    this.check("ensureApp");
    this.apps.add(app);
  }

  async ensureVolume(app: string, _region: string, sizeGb: number): Promise<string> {
    this.check("ensureVolume");
    for (const [id, volume] of this.volumes) if (volume.app === app) return id;
    return this.createVolume(app, _region, sizeGb, `vol-${++this.next}`);
  }

  async createVolume(app: string, _region: string, sizeGb: number, name: string): Promise<string> {
    this.check("createVolume");
    const id = `${name}-${++this.next}`;
    this.volumes.set(id, { app, sizeGb });
    return id;
  }

  async destroyMachine(app: string, machineId?: string, volumeId?: string): Promise<void> {
    this.check("destroyMachine");
    if (machineId) this.machines.delete(machineId);
    if (volumeId) this.volumes.delete(volumeId);
    void app;
  }

  async extendVolume(_app: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }> {
    this.check("extendVolume");
    const volume = this.volumes.get(volumeId);
    if (!volume) throw new Error("no such volume");
    this.volumes.set(volumeId, { ...volume, sizeGb });
    return { needsRestart: false };
  }

  async diskUsage(): Promise<{ usedBytes: number; totalBytes: number } | null> {
    return this.usage;
  }

  async createMachine(app: string, spec: MachineSpec): Promise<Machine> {
    this.check("createMachine");
    const machine: FakeMachine = { id: `m-${++this.next}`, state: "started", region: spec.region, image: spec.image, app, spec, starts: 1, stops: 0, createdAt: new Date().toISOString() };
    this.machines.set(machine.id, machine);
    return machine;
  }

  async updateMachine(_app: string, machineId: string, spec: MachineSpec): Promise<Machine> {
    this.check("updateMachine");
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error("no such machine");
    const next = { ...machine, spec, image: spec.image };
    this.machines.set(machineId, next);
    return next;
  }

  async getMachine(_app: string, machineId: string): Promise<Machine | null> {
    return this.machines.get(machineId) ?? null;
  }

  async startMachine(_app: string, machineId: string): Promise<void> {
    this.check("startMachine");
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error("no such machine");
    this.machines.set(machineId, { ...machine, state: "started", starts: machine.starts + 1 });
  }

  async stopMachine(_app: string, machineId: string): Promise<void> {
    this.check("stopMachine");
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error("no such machine");
    this.machines.set(machineId, { ...machine, state: "stopped", stops: machine.stops + 1 });
  }

  async destroyAll(app: string, machineId?: string): Promise<void> {
    this.check("destroyAll");
    if (machineId) this.machines.delete(machineId);
    for (const [id, volume] of [...this.volumes]) if (volume.app === app) this.volumes.delete(id);
    this.apps.delete(app);
    this.destroyedApps.push(app);
  }

  async busyApps(): Promise<string[]> { return this.busy; }

  async listApps(prefix: string): Promise<string[]> {
    return [...this.apps].filter((app) => app.startsWith(prefix));
  }

  /** The one machine, for suites that only ever make one. */
  only(): FakeMachine {
    const [machine] = [...this.machines.values()];
    if (!machine) throw new Error("no machine was created");
    return machine;
  }

  private check(call: string): void {
    if (!this.failOnce.delete(call)) return;
    throw new Error(`${call} failed`);
  }
}

export class FakeCore implements CoreClient {
  readonly bootstraps: Array<{ accountId: string; restoreSessionId?: string }> = [];
  readonly runnerBootstraps: Array<{ accountId: string; runnerId: string; restoreSessionId?: string }> = [];
  readonly retiredNodes: string[] = [];
  readonly notices: Array<{ accountId: string; kind: string; deleteAt: string }> = [];
  notifies = true;
  private next = 0;

  async bootstrap(accountId: string, input: { awakeCapMinutes: number; restoreSessionId?: string }) {
    this.bootstraps.push({ accountId, ...(input.restoreSessionId ? { restoreSessionId: input.restoreSessionId } : {}) });
    return { nodeId: `eph-managed-auto-${accountId}`, files: [{ guest_path: "/data/boot", raw_value: "" }], init: { exec: ["/bin/true"] } };
  }

  async bootstrapRunner(accountId: string, input: { runnerId: string; awakeCapMinutes: number; restoreSessionId?: string }) {
    this.runnerBootstraps.push({ accountId, runnerId: input.runnerId, ...(input.restoreSessionId ? { restoreSessionId: input.restoreSessionId } : {}) });
    return { nodeId: `eph-runner-${++this.next}`, files: [{ guest_path: "/data/boot", raw_value: "" }], init: { exec: ["/bin/true"] } };
  }

  async retired(_accountId: string, nodeId: string) { this.retiredNodes.push(nodeId); }

  async notice(accountId: string, kind: "computer" | "runner", deleteAt: string) {
    this.notices.push({ accountId, kind, deleteAt });
    return { notified: this.notifies };
  }
}

export const DAY_MS = 86_400_000;

export function computeSettings(overrides: Partial<ComputeSettings> = {}): ComputeSettings {
  return {
    provider: "fake", label: "Cloud computer", region: "iad", size: "shared-4x-8gb", image: "img:1",
    volumeGb: 20, maxVolumeGb: 100, awakeCapMinutes: 360, idleDeleteDays: 30, idleWarnDays: 7,
    cpuGuardPercent: 90, cpuGuardMinutes: 60, fleet: "test",
    ...overrides,
  };
}

export function runnerSettings(overrides: Partial<RunnerSettings> = {}): RunnerSettings {
  return {
    provider: "fake", region: "iad", image: "img:1", fleet: "test", volumeGb: 10,
    awakeCapMinutes: 180, cpuGuardPercent: 90, cpuGuardMinutes: 60, sleepDeleteDays: 7, sleepWarnDays: 2,
    ...overrides,
  };
}

/** A clock the suites move by hand. */
export function clock(start = Date.parse("2026-01-01T00:00:00.000Z")) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) { at += ms; },
    iso: () => new Date(at).toISOString(),
  };
}
