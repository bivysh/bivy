// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Runners: short-lived machines, one per thread, so an account's agents can
// work in parallel beside its cloud computer. A runner is disposable. Core
// boots it with the session to run (restored from Core's snapshot when it is
// a continuation), the node tears itself down when the work is done, and the
// next reconcile deletes the stopped machine and its disk. A runner never
// sleeps: picking the thread up again starts a new one, or moves it to the
// computer.
//
// Each account's runners share one app (`<computer app>-r`) and its private
// network, apart from the computer's, so deleting the computer never touches
// a runner mid-run. The app is swept once no runner owns it.
//
// A session's runner (`sleeps`) is the exception: someone may come back to the
// session, so a stopped one keeps its machine and disk and wakes when used,
// like the computer. Asleep it holds no runner slot. After `sleepDeleteDays`
// asleep, with the account warned first, it is deleted.
import { createHash } from "node:crypto";
import type { MachineProvider, MachineSpec } from "./provider.js";
import type { FleetStore, RunnerRecord } from "./store.js";
import type { Admission, PolicyContext, PolicyDecision } from "./policy.js";
import { AWAKE, cloudComputerApp, fleetPrefix, type CoreClient, type RunLedger } from "./computers.js";
import { SIZES, sizeWeight } from "./sizes.js";

export interface RunnerSettings {
  /** The provider id, reported to Core with each machine. */
  provider?: string;
  region: string;
  image: string;
  fleet?: string;
  /** A runner's own disk: a clone, its dependencies and build output. */
  volumeGb: number;
  /** The node exits at this; reconcile stops a runner still awake past it. */
  awakeCapMinutes: number;
  cpuGuardPercent: number;
  cpuGuardMinutes: number;
  /** Delete a session's runner after this many days asleep. */
  sleepDeleteDays: number;
  /** Warn the account this many days before; deletion waits until a warning
   * has been out this long. */
  sleepWarnDays: number;
}

/** Tell an account a sleeping session runner will be deleted at `deleteAt`.
 * Resolves once told, or when it can't be (no address). */
export type WarnSleeping = (accountId: string, deleteAt: string) => Promise<void>;

export type WakeResult =
  | { allowed: true; state: "awake" | "waking" | "gone" | "unknown" }
  | { allowed: false; decision: PolicyDecision };

export type LaunchResult =
  | { allowed: true; nodeId: string; state: "awake" | "launching" }
  | { allowed: false; decision: PolicyDecision };

/** A runner is never created stopped, so "created" is on its way up; and a
 * stopping one may still be flushing its session snapshot. Anything else is
 * finished, or for a session's runner, asleep. */
const RUNNING = new Set([...AWAKE, "created", "stopping"]);
/** States a machine never comes back from. */
const GONE = new Set(["destroyed", "destroying"]);
/** A launch that never got a machine is abandoned after this long. */
const LAUNCH_GRACE_MS = 10 * 60_000;
/** Reconcile stops a runner this long past its awake cap: the node's own timeout should have. */
const CAP_GRACE_MS = 5 * 60_000;

/** Runners lock apart from the computer: waking the computer (an image update,
 * then a start) can take longer than a caller waits for a runner, and a runner
 * launch never touches the computer's machine or record. */
const runnerLock = (accountId: string) => `${accountId}#runners`;

export function runnerApp(accountId: string, fleet?: string): string {
  return `${cloudComputerApp(accountId, fleet)}-r`;
}

const shortHash = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);

export class Runners {
  private readonly now: () => number;

  constructor(private readonly deps: {
    store: FleetStore;
    provider: MachineProvider;
    core: CoreClient;
    settings: RunnerSettings;
    admission: Admission;
    runs: RunLedger;
    /** The account's computer size, which its runners share. */
    sizeFor: (accountId: string) => Promise<string>;
    /** Without it, sleeping runners are deleted unannounced. */
    warnSleeping?: WarnSleeping;
    now?: () => number;
  }) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Start a runner for `runnerId`, or return the one already running it.
   * Admission (slots, hours) applies to every new runner. */
  launch(input: { accountId: string; runnerId: string; requestId: string; sessionId?: string; sleeps?: boolean }): Promise<LaunchResult> {
    const { accountId, runnerId } = input;
    return this.deps.store.withAccountLock(runnerLock(accountId), async () => {
      const existing = await this.deps.store.getRunner(accountId, runnerId);
      if (existing?.machineId && existing.nodeId) {
        const machine = await this.deps.provider.getMachine(existing.app, existing.machineId);
        if (machine && RUNNING.has(machine.state)) return { allowed: true, nodeId: existing.nodeId, state: "awake" };
        if (machine && existing.sleeps && !GONE.has(machine.state)) {
          const woken = await this.start(existing, `runner:${input.requestId}:${this.iso()}`);
          return woken.allowed ? { allowed: true, nodeId: existing.nodeId, state: "launching" } : woken;
        }
      }
      // A finished runner is not woken: the thread starts on a fresh one.
      if (existing) await this.dispose(existing);
      const size = await this.deps.sizeFor(accountId);
      // Its own metering run, apart from whatever else used the same request id
      // (Core wakes the computer for the same work item before handing it on).
      const runId = `runner:${input.requestId}`;
      const decision = await this.deps.admission.admit(accountId, runId, this.context(size));
      if (!decision.allowed) return { allowed: false, decision };
      const { settings, provider, core } = this.deps;
      const now = this.iso();
      // Saved before any provider call, so the orphan sweep counts the app as
      // owned and a crash part-way is cleaned up by reconcile.
      let record: RunnerRecord = {
        accountId, runnerId, app: runnerApp(accountId, settings.fleet), region: settings.region, size, image: settings.image,
        ...(input.sleeps ? { sleeps: true } : {}),
        state: "launching", awakeSince: now, openRun: runId, createdAt: now, updatedAt: now,
      };
      await this.save(record);
      try {
        await provider.ensureApp(record.app);
        record = { ...record, volumeId: await provider.createVolume(record.app, settings.region, settings.volumeGb, `runner_${shortHash(runnerId, 12)}`) };
        await this.save(record);
        const boot = await core.bootstrapRunner(accountId, { runnerId, awakeCapMinutes: settings.awakeCapMinutes, restoreSessionId: input.sessionId });
        record = { ...record, nodeId: boot.nodeId };
        await this.save(record);
        const machine = await provider.createMachine(record.app, this.spec(record, boot));
        record = { ...record, machineId: machine.id };
        await this.save(record);
        return { allowed: true, nodeId: boot.nodeId, state: "launching" };
      } catch (error) {
        await this.deps.runs.fail(accountId, runId, this.iso()).catch(() => {});
        await this.dispose({ ...record, openRun: undefined }).catch(() => {});
        throw error;
      }
    });
  }

  /** Start a session's sleeping runner because someone is using it again.
   * Waking takes a runner slot again, so admission applies. */
  wake(accountId: string, nodeId: string): Promise<WakeResult> {
    return this.deps.store.withAccountLock(runnerLock(accountId), async () => {
      const record = (await this.deps.store.listRunners(accountId)).find((r) => r.nodeId === nodeId);
      if (!record?.sleeps || !record.machineId) return { allowed: true, state: "unknown" };
      const machine = await this.deps.provider.getMachine(record.app, record.machineId);
      if (!machine || GONE.has(machine.state)) return { allowed: true, state: "gone" };
      if (RUNNING.has(machine.state)) return { allowed: true, state: "awake" };
      return this.start(record, `runner-wake:${record.runnerId}:${this.iso()}`);
    });
  }

  /** Core is done with a runner: delete its machine and disk now. */
  release(accountId: string, nodeId: string): Promise<boolean> {
    return this.deps.store.withAccountLock(runnerLock(accountId), async () => {
      const record = (await this.deps.store.listRunners(accountId)).find((r) => r.nodeId === nodeId);
      if (!record) return false;
      await this.dispose(record);
      return true;
    });
  }

  async machines(accountId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.deps.store.listRunners(accountId)).map((record) => ({
      id: record.machineId ?? record.app, nodeId: record.nodeId, provider: this.deps.settings.provider ?? "fly", name: "Runner", kind: "runner",
      runnerId: record.runnerId, region: record.region, size: record.size, sizeLabel: SIZES[record.size]?.label,
      state: record.state, createdAt: record.createdAt,
      ...(record.sleeps && record.asleepSince ? { deleteAt: new Date(this.deleteAt(record)).toISOString() } : {}),
    }));
  }

  /** Delete runners that stopped (finished) or never launched, and stop ones
   * that pin their CPUs, outlive their awake cap or run past the allowance. */
  async reconcile(): Promise<{ checked: number; disposed: number; stopped: string[]; failed: number; warned: number; deleted: number }> {
    const result = { checked: 0, disposed: 0, stopped: [] as string[], failed: 0, warned: 0, deleted: 0 };
    const busy = new Set(await this.busyApps());
    for (const listed of await this.deps.store.listRunners()) {
      result.checked++;
      try {
        await this.deps.store.withAccountLock(runnerLock(listed.accountId), async () => {
          const record = await this.deps.store.getRunner(listed.accountId, listed.runnerId);
          if (!record) return;
          if (!record.machineId) {
            if (this.now() - Date.parse(record.createdAt) < LAUNCH_GRACE_MS) return;
            await this.dispose(record);
            result.disposed++;
            return;
          }
          const machine = await this.deps.provider.getMachine(record.app, record.machineId);
          if (machine && record.sleeps && !GONE.has(machine.state) && !RUNNING.has(machine.state)) {
            await this.reconcileAsleep(record, result);
            return;
          }
          if (!machine || !RUNNING.has(machine.state)) {
            await this.dispose(record);
            result.disposed++;
            return;
          }
          const overCap = record.awakeSince !== undefined
            && this.now() - Date.parse(record.awakeSince) > this.deps.settings.awakeCapMinutes * 60_000 + CAP_GRACE_MS;
          if (machine.state === "stopping") return;
          if (busy.has(record.app) || overCap || await this.allowanceUsedUp(record.accountId)) {
            // Stopped is finished (or, for a session's runner, asleep): the next round sees to it.
            await this.deps.provider.stopMachine(record.app, record.machineId);
            result.stopped.push(`${record.app}/${record.machineId}`);
          }
          if (record.state !== "awake") await this.save({ ...record, state: "awake" });
        });
      } catch {
        result.failed++;
      }
    }
    return result;
  }

  /** A session's runner is asleep: end its awake period (freeing its slot),
   * warn the account as deletion nears, and delete it once warned long enough. */
  private async reconcileAsleep(record: RunnerRecord, result: { warned: number; deleted: number }): Promise<void> {
    let next: RunnerRecord = { ...record, state: "asleep", asleepSince: record.asleepSince ?? this.iso() };
    if (next.openRun) {
      await this.deps.runs.settle(next.accountId, next.openRun, this.iso(), this.meteredSeconds(next));
      next = { ...next, openRun: undefined, awakeSince: undefined };
    }
    const warnMs = this.deps.settings.sleepWarnDays * 86_400_000;
    if (!next.deletionWarnedAt && this.deps.warnSleeping && this.now() >= this.deleteAt(next) - warnMs) {
      // A warning sent late still gets its full notice period. A failed send
      // is retried next round.
      const deleteAt = new Date(Math.max(this.deleteAt(next), this.now() + warnMs)).toISOString();
      try {
        await this.deps.warnSleeping(next.accountId, deleteAt);
        next.deletionWarnedAt = this.iso();
        result.warned++;
      } catch (error) {
        console.warn("[runners] sleep warning failed:", error instanceof Error ? error.message : error);
      }
    }
    const noticeGiven = !this.deps.warnSleeping || (next.deletionWarnedAt !== undefined && this.now() - Date.parse(next.deletionWarnedAt) >= warnMs);
    if (this.now() > this.deleteAt(next) && noticeGiven) {
      await this.dispose(next);
      result.deleted++;
      return;
    }
    await this.save(next);
  }

  /** Start a stopped session runner, on the current image. */
  private async start(record: RunnerRecord, runId: string): Promise<WakeResult> {
    const decision = await this.deps.admission.admit(record.accountId, runId, this.context(record.size));
    if (!decision.allowed) return { allowed: false, decision };
    try {
      const { settings, provider, core } = this.deps;
      if (record.image !== settings.image && record.volumeId) {
        const boot = await core.bootstrapRunner(record.accountId, { runnerId: record.runnerId, awakeCapMinutes: settings.awakeCapMinutes });
        await provider.updateMachine(record.app, record.machineId!, this.spec(record, boot));
      }
      await provider.startMachine(record.app, record.machineId!);
      const now = this.iso();
      await this.save({
        ...record, image: settings.image, state: "waking", awakeSince: now, openRun: runId,
        asleepSince: undefined, deletionWarnedAt: undefined,
      });
      return { allowed: true, state: "waking" };
    } catch (error) {
      await this.deps.runs.fail(record.accountId, runId, this.iso()).catch(() => {});
      throw error;
    }
  }

  private spec(record: RunnerRecord, boot: { files: MachineSpec["files"]; init: MachineSpec["init"] }): MachineSpec {
    const { settings } = this.deps;
    return {
      region: settings.region, image: settings.image, size: record.size, volumeId: record.volumeId!,
      files: boot.files, init: boot.init,
      metadata: { bivy: "runner", "bivy-account": shortHash(record.accountId, 32), "bivy-runner": shortHash(record.runnerId, 32) },
    };
  }

  private deleteAt(record: RunnerRecord): number {
    return Date.parse(record.asleepSince ?? record.createdAt) + this.deps.settings.sleepDeleteDays * 86_400_000;
  }

  private meteredSeconds(record: RunnerRecord): number {
    const seconds = record.awakeSince ? Math.max(0, Math.round((this.now() - Date.parse(record.awakeSince)) / 1000)) : 0;
    return Math.round(seconds * sizeWeight(record.size));
  }

  /** Meter the runner, delete its machine and disk, and forget it. */
  private async dispose(record: RunnerRecord): Promise<void> {
    await this.deps.provider.destroyMachine(record.app, record.machineId, record.volumeId);
    if (record.openRun) await this.deps.runs.settle(record.accountId, record.openRun, this.iso(), this.meteredSeconds(record));
    await this.deps.store.deleteRunner(record.accountId, record.runnerId);
    if (record.nodeId) await this.deps.core.retired(record.accountId, record.nodeId).catch(() => {});
  }

  /** An unreachable policy service never stops a runner; only a known,
   * used-up allowance does. */
  private async allowanceUsedUp(accountId: string): Promise<boolean> {
    const left = await this.deps.admission.secondsLeft?.(accountId).catch(() => undefined);
    return left !== undefined && left <= 0;
  }

  private async busyApps(): Promise<string[]> {
    const { cpuGuardPercent, cpuGuardMinutes, fleet } = this.deps.settings;
    if (cpuGuardPercent <= 0 || !(await this.deps.store.listRunners()).length) return [];
    return (await this.deps.provider.busyApps(fleetPrefix(fleet), cpuGuardMinutes, cpuGuardPercent / 100).catch((error) => {
      console.warn("[runners] CPU guard skipped:", error instanceof Error ? error.message : error);
      return [];
    })).filter((app) => app.endsWith("-r"));
  }

  private context(sizeId: string): PolicyContext {
    const size = SIZES[sizeId];
    return {
      computeSource: "managed", sizeId, vcpus: size?.vcpus, memoryMiB: size?.memoryMiB,
      ttlMinutes: this.deps.settings.awakeCapMinutes, purpose: "runner", activeManagedMachines: 0,
    };
  }

  private save(record: RunnerRecord): Promise<void> {
    return this.deps.store.putRunner({ ...record, updatedAt: this.iso() });
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}
