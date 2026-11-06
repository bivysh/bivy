// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The `command` provider: every machine operation runs a dispatcher program
// the operator supplies (FLEET_DISPATCH_COMMAND), so any platform that can
// start a Linux machine from an image and run a command in it can host Bivy
// machines without a change to the fleet. The contract is DISPATCH.md:
//
//   BIVY_DISPATCH_OP=<operation> <command>   < request JSON   > response JSON
//
// The dispatcher holds the platform's credential; the fleet never sees it.
// Each run is bounded, and every operation must be safe to repeat.

import { spawn, spawnSync } from "node:child_process";
import type { Machine, MachineProvider, MachineSpec, ProviderCapabilities } from "./provider.js";

/** Operations a dispatcher answers, by MachineProvider method. */
export const DISPATCH_OPS = [
  "describe", "ensureApp", "ensureVolume", "createVolume", "destroyMachine", "extendVolume", "diskUsage",
  "createMachine", "updateMachine", "getMachine", "startMachine", "stopMachine", "destroyAll", "busyApps", "listApps",
] as const;
export type DispatchOp = (typeof DISPATCH_OPS)[number];

const OP_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class DispatchError extends Error {}

/** The capabilities a dispatcher reports, with safe defaults for missing ones. */
export function capabilitiesFrom(value: unknown): ProviderCapabilities {
  const row = (value && typeof value === "object" ? value : {}) as Partial<ProviderCapabilities>;
  return { stopsOnExit: row.stopsOnExit === true, keepsMemory: row.keepsMemory === true, cpuReading: row.cpuReading === true };
}

export class CommandProvider implements MachineProvider {
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly command: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    if (!command) throw new DispatchError("FLEET_DISPATCH_COMMAND must name the dispatcher to run");
    // Asked once, at start: a dispatcher that can't describe itself is a
    // configuration error worth failing on, not discovering mid-launch.
    const described = spawnSync(command, { shell: true, input: "{}", env: { ...env, BIVY_DISPATCH_OP: "describe" }, timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES });
    if (described.status !== 0) throw new DispatchError(`dispatcher "describe" failed: ${String(described.stderr ?? "").slice(0, 300)}`);
    this.capabilities = capabilitiesFrom(parse(String(described.stdout), "describe").capabilities);
  }

  /** Run one operation. Exit 0 with JSON on stdout answers it; anything else fails it. */
  run(op: DispatchOp, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, { shell: true, env: { ...this.env, BIVY_DISPATCH_OP: op }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), OP_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { if (err.length < 4096) err += chunk.toString("utf8"); });
      child.on("error", (error) => { clearTimeout(timer); reject(new DispatchError(`dispatcher "${op}" didn't start: ${error.message}`)); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new DispatchError(`dispatcher "${op}" failed (${signal ?? code}): ${err.trim().slice(0, 300)}`));
        try { resolve(parse(out, op)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  async ensureApp(app: string): Promise<void> { await this.run("ensureApp", { app }); }

  async ensureVolume(app: string, region: string, sizeGb: number): Promise<string> {
    return String((await this.run("ensureVolume", { app, region, sizeGb })).volumeId ?? "");
  }

  async createVolume(app: string, region: string, sizeGb: number, name: string): Promise<string> {
    return String((await this.run("createVolume", { app, region, sizeGb, name })).volumeId ?? "");
  }

  async destroyMachine(app: string, machineId?: string, volumeId?: string): Promise<void> {
    await this.run("destroyMachine", { app, machineId, volumeId });
  }

  async extendVolume(app: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }> {
    return { needsRestart: (await this.run("extendVolume", { app, volumeId, sizeGb })).needsRestart === true };
  }

  async diskUsage(app: string): Promise<{ usedBytes: number; totalBytes: number } | null> {
    const usage = (await this.run("diskUsage", { app })).usage as { usedBytes?: unknown; totalBytes?: unknown } | null | undefined;
    return usage && typeof usage.usedBytes === "number" && typeof usage.totalBytes === "number" ? { usedBytes: usage.usedBytes, totalBytes: usage.totalBytes } : null;
  }

  async createMachine(app: string, spec: MachineSpec): Promise<Machine> {
    return machineFrom((await this.run("createMachine", { app, spec })).machine, "createMachine");
  }

  async updateMachine(app: string, machineId: string, spec: MachineSpec): Promise<Machine> {
    return machineFrom((await this.run("updateMachine", { app, machineId, spec })).machine, "updateMachine");
  }

  async getMachine(app: string, machineId: string): Promise<Machine | null> {
    const machine = (await this.run("getMachine", { app, machineId })).machine;
    return machine ? machineFrom(machine, "getMachine") : null;
  }

  async startMachine(app: string, machineId: string): Promise<void> { await this.run("startMachine", { app, machineId }); }
  async stopMachine(app: string, machineId: string): Promise<void> { await this.run("stopMachine", { app, machineId }); }
  async destroyAll(app: string, machineId?: string): Promise<void> { await this.run("destroyAll", { app, machineId }); }

  async busyApps(prefix: string, minutes: number, fraction: number): Promise<string[]> {
    if (!this.capabilities.cpuReading) return [];
    return strings((await this.run("busyApps", { prefix, minutes, fraction })).apps);
  }

  async listApps(prefix: string): Promise<string[]> {
    return strings((await this.run("listApps", { prefix })).apps);
  }
}

function parse(stdout: string, op: string): Record<string, unknown> {
  const text = stdout.trim() || "{}";
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new DispatchError(`dispatcher "${op}" didn't answer with a JSON object`);
}

function machineFrom(value: unknown, op: string): Machine {
  const m = (value ?? {}) as Partial<Machine>;
  if (typeof m.id !== "string" || !m.id || typeof m.state !== "string") throw new DispatchError(`dispatcher "${op}" returned no machine id and state`);
  return { id: m.id, state: m.state, region: typeof m.region === "string" ? m.region : "", ...(typeof m.image === "string" ? { image: m.image } : {}), ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}) };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
