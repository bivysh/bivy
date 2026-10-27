// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The fleet of cloud computers: one machine plus volume per account that sleeps
// when quiet and wakes on use. Core owns the node's identity and boot payload
// (asked for through CoreClient); this owns where the machine runs, when it
// starts, its disk, metering and cleanup.
import { createHash } from "node:crypto";
import type { Machine, MachineFile, MachineProvider, MachineSpec } from "./provider.js";
import type { CloudComputerRecord, FleetStore } from "./store.js";
import type { Admission, PolicyContext, PolicyDecision } from "./policy.js";
import { SIZES, sizeWeight } from "./sizes.js";

export interface CoreClient {
  bootstrap(accountId: string, input: { awakeCapMinutes: number; restoreSessionId?: string }): Promise<{ nodeId: string; files: MachineFile[]; init: { exec: string[] } }>;
  /** Enroll a runner's node. Its own endpoint, so a Core without runners
   * answers 404 instead of re-enrolling the account's computer. */
  bootstrapRunner(accountId: string, input: { runnerId: string; awakeCapMinutes: number; restoreSessionId?: string }): Promise<{ nodeId: string; files: MachineFile[]; init: { exec: string[] } }>;
  retired(accountId: string, nodeId: string): Promise<void>;
  /** Ask Core to tell the account its machine is about to be deleted. Core
   * owns the relationship with the person, so it owns the notice. `notified`
   * is false when the deployment has no way to reach them — the fleet then
   * carries on rather than keeping the disk forever. */
  notice(accountId: string, kind: "computer" | "runner", deleteAt: string): Promise<{ notified: boolean }>;
}

export interface ComputeSettings {
  /** The provider id, reported to Core with each machine. */
  provider?: string;
  /** What the app calls this machine. */
  label?: string;
  region: string;
  /** Default size, and the fallback when the deployment no longer allows the
   * picked one. */
  size: string;
  /** Machine image with Bivy and the agents already installed. */
  image: string;
  /** A new disk's size, and what every account includes. */
  volumeGb: number;
  /** The largest disk an account can grow to. */
  maxVolumeGb: number;
  awakeCapMinutes: number;
  /** Delete an untouched machine and its disk after this many days asleep. */
  idleDeleteDays: number;
  /** Warn the account this many days before deleting; deletion waits until a
   * warning has been out this long. */
  idleWarnDays: number;
  /** Stop a machine whose CPUs stay this busy (0-100) for `cpuGuardMinutes`.
   * Coding work is bursty; hours of every core pinned is mining or a runaway
   * loop. 0 disables the guard. */
  cpuGuardPercent: number;
  cpuGuardMinutes: number;
  /** Names this deployment's apps (`bivy-cc-<fleet>-…`) so deployments sharing
   * one provider organization never touch each other's. Without it, no orphan
   * sweep runs. */
  fleet?: string;
  /** Delete apps in this fleet that no record owns (default on). Turn it off
   * to adopt a fleet whose records are not in this store yet — a migration
   * from another fleet implementation, or a restore — so machines in flight
   * are never mistaken for litter. Turn it back on once the records match. */
  sweepOrphans?: boolean;
  /** Start computers early (at sign-up, on presence) and meter early starts
   * from first use (SPECULATIVE_STARTS). Off: every start is use. */
  earlyStarts?: boolean;
}

const APP_PREFIX = "bivy-cc-";
/** An app must look orphaned this long before the sweep deletes it, so a
 * machine being created right now is never mistaken for one. */
const ORPHAN_GRACE_MS = 30 * 60_000;

/** Tell an account its idle machine will be deleted at `deleteAt`. Resolves
 * once the account has been told, or when it can't be (no address). */
export type WarnIdle = (accountId: string, deleteAt: string) => Promise<void>;

/** Where metered awake time goes. Each awake period holds exactly one run, so
 * a sleeping machine never counts against the account. */
export interface RunLedger {
  /** `machineSeconds` are Standard seconds: awake time times the size's weight. */
  settle(accountId: string, runId: string, at: string, machineSeconds: number): Promise<void>;
  fail(accountId: string, runId: string, at: string): Promise<void>;
}

export type AcquireResult =
  | { allowed: true; nodeId: string; state: "awake" | "waking" | "launching" }
  | { allowed: false; decision: PolicyDecision };

export type SetSizeResult =
  | { ok: true; size: string; pending: boolean }
  | { ok: false; code: "unknown_size" | "not_allowed"; reason: string };

/** Disk beyond the included size grows in steps. */
export const DISK_STEP_GB = 10;

export interface SizesView {
  /** Used from the next start. */
  selected: string;
  /** The size the computer has now; absent before it first starts. */
  current?: string;
  sizes: Array<{ id: string; label: string; vcpus: number; memoryMiB: number; weight: number; allowed: boolean }>;
}

export interface DiskView {
  sizeGb: number;
  includedGb: number;
  maxGb: number;
  stepGb: number;
  /** As of when the machine last ran; absent before that, or when the provider
   * can't answer. */
  usedGb?: number;
  /** The account can grow its disk now. */
  canGrow: boolean;
}

export type GrowDiskResult =
  | { ok: true; sizeGb: number; needsRestart: boolean }
  | { ok: false; code: "no_computer" | "not_allowed" | "invalid_size"; reason: string };

export const AWAKE = new Set(["started", "starting", "replacing"]);

/**
 * Starts that are not use yet, and the minutes each may stay up unused. A new
 * account's computer starts at sign-up and while its owner signs in to their
 * AI; Core wakes it when someone is in the app or a client connects. These are
 * metered only from the first real use in that awake period (`used`: an agent
 * turn or a terminal), and stopped once their grace runs out unused. Any other
 * start (a session sent to it, an automation, a preview link) is use from the
 * start.
 */
export const SPECULATIVE_STARTS: Readonly<Record<string, number>> = {
  "signup": 30,
  "auth-runner": 30,
  "app-open": 15,
  "app-visible": 15,
  "composer": 15,
  "connect": 15,
};

export function fleetPrefix(fleet?: string): string {
  return fleet ? `${APP_PREFIX}${fleet}-` : APP_PREFIX;
}

export function cloudComputerApp(accountId: string, fleet?: string): string {
  return `${fleetPrefix(fleet)}${createHash("sha256").update(accountId).digest("hex").slice(0, 20)}`;
}

export class CloudComputers {
  private readonly now: () => number;
  /** When each app without a record was first seen (see sweepOrphans). */
  private readonly orphanSeen = new Map<string, number>();

  constructor(private readonly deps: {
    store: FleetStore;
    provider: MachineProvider;
    core: CoreClient;
    settings: ComputeSettings;
    admission: Admission;
    runs: RunLedger;
    /** Without it, idle machines are deleted unannounced. */
    warnIdle?: WarnIdle;
    now?: () => number;
  }) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Make the account's cloud computer available: reuse it if awake, start it
   * if asleep, create it if it doesn't exist. Admission applies whenever this
   * starts compute. */
  acquire(input: { accountId: string; purpose: string; requestId: string; sessionId?: string }): Promise<AcquireResult> {
    const { accountId } = input;
    return this.deps.store.withAccountLock(accountId, async () => {
      const record = await this.deps.store.get(accountId);
      const machine = record?.machineId ? await this.deps.provider.getMachine(record.app, record.machineId) : null;
      if (record && machine && AWAKE.has(machine.state)) {
        const now = this.iso();
        // Asked for to do work on (not to sign in or be ready): this awake
        // period is in use from now.
        const usedNow = this.speculative(record.startedFor) && !record.meteredFrom && !this.speculative(input.purpose);
        await this.save({ ...record, state: "awake", awakeSince: record.awakeSince ?? now, ...(usedNow ? { meteredFrom: now } : {}) });
        return { allowed: true, nodeId: record.nodeId, state: "awake" };
      }
      let settled = record ? await this.settleRun(record) : undefined;
      const size = await this.sizeFor(accountId);
      const decision = await this.deps.admission.admit(accountId, input.requestId, this.context(input.purpose, 0, size));
      if (!decision.allowed) return { allowed: false, decision };
      return this.failRunOnError(accountId, input.requestId, async () => {
        // An app from before this fleet's naming (and its per-account network)
        // is replaced while asleep: a new app and disk, with the session restored.
        if (settled && !this.ownApp(settled.app)) {
          await this.deps.provider.destroyAll(settled.app, settled.machineId);
          settled = { ...settled, app: cloudComputerApp(accountId, this.deps.settings.fleet), machineId: undefined, volumeId: undefined };
          await this.save(settled);
        } else if (settled && machine) {
          await this.start(settled, machine, input.requestId, size, input.purpose);
          return { allowed: true, nodeId: settled.nodeId, state: "waking" };
        }
        const created = await this.create(accountId, settled, input.requestId, size, input.sessionId, input.purpose);
        return { allowed: true, nodeId: created.nodeId, state: "launching" };
      });
    });
  }

  /** A new account's first sign-in: create its computer now, unless it
   * already has one. Early (SPECULATIVE_STARTS "signup"): free until used. */
  async acquireAtSignup(accountId: string): Promise<AcquireResult | undefined> {
    if (!this.deps.settings.earlyStarts || await this.deps.store.get(accountId)) return undefined;
    return this.acquire({ accountId, purpose: "signup", requestId: `signup:${accountId}` });
  }

  /** Start a sleeping machine because someone connected to it, or is in the
   * app (`reason`, see SPECULATIVE_STARTS). */
  wake(accountId: string, nodeId: string, reason = "connect"): Promise<{ state: string }> {
    return this.deps.store.withAccountLock(accountId, async () => {
      const record = await this.deps.store.get(accountId);
      if (!record || record.nodeId !== nodeId || !record.machineId) return { state: "unknown" };
      const machine = await this.deps.provider.getMachine(record.app, record.machineId);
      if (!machine) return { state: "gone" };
      if (AWAKE.has(machine.state)) return { state: "awake" };
      // A legacy app is moved by the next launch (acquire), not woken in place.
      if (!this.ownApp(record.app)) return { state: "gone" };
      // An open tab reconnecting on its own is not someone coming back.
      if (reason === "connect" && record.stoppedUnused && this.deps.settings.earlyStarts) return { state: "asleep" };
      const settled = await this.settleRun(record);
      const runId = `wake:${accountId}:${this.iso()}`;
      const size = await this.sizeFor(accountId);
      const decision = await this.deps.admission.admit(accountId, runId, this.context("wake", 0, size));
      if (!decision.allowed) return { state: "refused" };
      return this.failRunOnError(accountId, runId, async () => {
        await this.start(settled, machine, runId, size, reason);
        return { state: "waking" };
      });
    });
  }

  /** The computer was really used (Core's first agent turn or terminal of
   * this boot): an early-started awake period is metered from `at`. */
  used(accountId: string, nodeId: string, at: string): Promise<void> {
    return this.deps.store.withAccountLock(accountId, async () => {
      const record = await this.deps.store.get(accountId);
      if (!record || record.nodeId !== nodeId || !record.awakeSince || record.meteredFrom || !this.speculative(record.startedFor)) return;
      const from = Math.max(Date.parse(at) || this.now(), Date.parse(record.awakeSince));
      await this.save({ ...record, meteredFrom: new Date(Math.min(from, this.now())).toISOString() });
    });
  }

  async machines(accountId: string): Promise<Array<Record<string, unknown>>> {
    const record = await this.deps.store.get(accountId);
    if (!record) return [];
    const { provider, label } = this.deps.settings;
    return [{
      id: record.machineId ?? record.app, nodeId: record.nodeId, provider: provider ?? "fly", name: label ?? "Cloud computer",
      region: record.region, size: record.size, sizeLabel: SIZES[record.size]?.label, state: record.state, createdAt: record.createdAt,
    }];
  }

  /** The sizes an account can pick, which one it picked and which one runs now. */
  async sizes(accountId: string): Promise<SizesView> {
    const [allowed, selected, record] = await Promise.all([this.allowedClasses(accountId), this.sizeFor(accountId), this.deps.store.get(accountId)]);
    return {
      selected,
      current: record?.size,
      sizes: Object.entries(SIZES).filter(([, row]) => row.offered).map(([id, row]) => ({
        id, label: row.label, vcpus: row.vcpus, memoryMiB: row.memoryMiB, weight: row.weight,
        allowed: id === this.deps.settings.size || allowed.includes(row.class),
      })),
    };
  }

  /** Pick the computer's size. It takes effect the next time the machine
   * starts: an awake machine keeps its size, so no running agent is cut off. */
  async setSize(accountId: string, size: string): Promise<SetSizeResult> {
    const row = SIZES[size];
    if (!row?.offered) return { ok: false, code: "unknown_size", reason: `Unknown machine size ${size}.` };
    if (size !== this.deps.settings.size && !(await this.allowedClasses(accountId)).includes(row.class)) {
      return { ok: false, code: "not_allowed", reason: "This machine size is not available to your account." };
    }
    await this.deps.store.setSizePreference(accountId, size);
    const record = await this.deps.store.get(accountId);
    return { ok: true, size, pending: Boolean(record && record.size !== size) };
  }

  /** The computer's disk: its size, what's used and whether it can grow. */
  async disk(accountId: string): Promise<DiskView | undefined> {
    const record = await this.deps.store.get(accountId);
    if (!record) return undefined;
    const { volumeGb, maxVolumeGb } = this.deps.settings;
    const sizeGb = this.diskGb(record);
    // The reading is advisory: without one the size still shows.
    const usage = await this.deps.provider.diskUsage(record.app).catch(() => null);
    return {
      sizeGb, includedGb: volumeGb, maxGb: maxVolumeGb, stepGb: DISK_STEP_GB,
      ...(usage ? { usedGb: Math.round(usage.usedBytes / 1e8) / 10 } : {}),
      canGrow: await this.diskAllowed(accountId) && Boolean(record.volumeId) && sizeGb + DISK_STEP_GB <= maxVolumeGb,
    };
  }

  /** Grow the computer's disk to `sizeGb`. A provider cannot shrink a volume,
   * so neither can this. A running machine may need its next start to see the
   * space. */
  growDisk(accountId: string, sizeGb: number): Promise<GrowDiskResult> {
    return this.deps.store.withAccountLock(accountId, async () => {
      const record = await this.deps.store.get(accountId);
      if (!record?.volumeId) return { ok: false, code: "no_computer", reason: "Start your cloud computer once before adding disk." };
      const { volumeGb, maxVolumeGb } = this.deps.settings;
      const current = this.diskGb(record);
      if (!Number.isInteger(sizeGb) || sizeGb <= current || sizeGb > maxVolumeGb || (sizeGb - volumeGb) % DISK_STEP_GB !== 0) {
        return { ok: false, code: "invalid_size", reason: `Disk grows in ${DISK_STEP_GB} GB steps, from ${current} GB up to ${maxVolumeGb} GB.` };
      }
      if (!await this.diskAllowed(accountId)) {
        return { ok: false, code: "not_allowed", reason: "A bigger disk is not available to your account." };
      }
      // An operator that charges for disk takes it first and may refuse here.
      await this.deps.admission.diskChanged?.(accountId, sizeGb - volumeGb);
      let grown: { needsRestart: boolean };
      try {
        grown = await this.deps.provider.extendVolume(record.app, record.volumeId, sizeGb);
      } catch (error) {
        await this.deps.admission.diskChanged?.(accountId, current - volumeGb).catch((undo) => {
          console.warn(`[fleet] disk change for ${record.app} not reverted:`, undo instanceof Error ? undo.message : undo);
        });
        throw error;
      }
      await this.save({ ...record, diskGb: sizeGb });
      return { ok: true, sizeGb, needsRestart: grown.needsRestart };
    });
  }

  /** Destroy the machine and its disk. The node stays enrolled in Core. */
  release(accountId: string, nodeId: string): Promise<boolean> {
    return this.deps.store.withAccountLock(accountId, async () => {
      const record = await this.deps.store.get(accountId);
      if (!record || record.nodeId !== nodeId) return false;
      await this.deps.provider.destroyAll(record.app, record.machineId);
      await this.settleRun(record);
      await this.deleteRecord(record);
      await this.deps.core.retired(accountId, nodeId).catch(() => {});
      return true;
    });
  }

  /** Sync observed state, meter awake time, stop machines pinning their CPUs
   * or past their allowance, warn about and then delete long-idle machines,
   * and sweep apps no record owns. */
  async reconcile(): Promise<{ checked: number; deleted: number; failed: number; warned: number; stopped: string[]; outOfAllowance: string[]; unused: string[]; retired: string[]; swept: string[] }> {
    const result = { checked: 0, deleted: 0, failed: 0, warned: 0, stopped: [] as string[], outOfAllowance: [] as string[], unused: [] as string[], retired: [] as string[], swept: [] as string[] };
    const busy = new Set(await this.busyApps());
    for (const listed of await this.deps.store.list()) {
      result.checked++;
      try {
        await this.deps.store.withAccountLock(listed.accountId, async () => {
          const record = await this.deps.store.get(listed.accountId);
          if (!record?.machineId) return;
          const machine = await this.deps.provider.getMachine(record.app, record.machineId);
          let awake = Boolean(machine && AWAKE.has(machine.state));
          const stopFor = !awake ? undefined
            : busy.has(record.app) ? result.stopped
            : await this.allowanceUsedUp(record.accountId) ? result.outOfAllowance
            : this.unusedPastGrace(record) ? result.unused
            : undefined;
          if (stopFor) {
            await this.deps.provider.stopMachine(record.app, record.machineId);
            stopFor.push(record.app);
            awake = false;
          }
          let next: CloudComputerRecord = { ...record, state: !machine ? "gone" : awake ? "awake" : "asleep", ...(stopFor === result.unused ? { stoppedUnused: true } : {}) };
          if (awake && !next.awakeSince) next.awakeSince = this.iso();
          if (!awake) next = await this.settleRun(next);
          if (!awake && await this.retireExhausted(record.accountId)) {
            await this.deps.provider.destroyAll(record.app, record.machineId);
            await this.deleteRecord(record);
            await this.deps.core.retired(record.accountId, record.nodeId).catch(() => {});
            result.retired.push(record.app);
            return;
          }
          if (!awake && !next.deletionWarnedAt && this.deps.warnIdle && this.now() >= this.deleteAt(next) - this.warnMs()) {
            // A warning sent late still gets its full notice period. A failed
            // send is retried next round; the run settled above must still save.
            const deleteAt = new Date(Math.max(this.deleteAt(next), this.now() + this.warnMs())).toISOString();
            try {
              await this.deps.warnIdle(record.accountId, deleteAt);
              next.deletionWarnedAt = this.iso();
              result.warned++;
            } catch (error) {
              console.warn("[fleet] idle warning failed:", error instanceof Error ? error.message : error);
            }
          }
          const noticeGiven = !this.deps.warnIdle || (next.deletionWarnedAt !== undefined && this.now() - Date.parse(next.deletionWarnedAt) >= this.warnMs());
          if (!awake && this.now() > this.deleteAt(next) && noticeGiven) {
            await this.deps.provider.destroyAll(record.app, record.machineId);
            await this.deleteRecord(record);
            await this.deps.core.retired(record.accountId, record.nodeId).catch(() => {});
            result.deleted++;
            return;
          }
          await this.save(next);
        });
      } catch {
        result.failed++;
      }
    }
    result.swept = await this.sweepOrphans();
    return result;
  }

  /** Delete this fleet's apps that no record owns: left behind when a create
   * or a release failed partway. Each costs money until deleted. */
  private async sweepOrphans(): Promise<string[]> {
    const { fleet, sweepOrphans } = this.deps.settings;
    // The fleet name alone used to decide this, so there was no way to adopt
    // existing machines without also renaming (and so orphaning) them.
    if (!fleet || sweepOrphans === false) return [];
    const apps = await this.deps.provider.listApps(fleetPrefix(fleet)).catch((error) => {
      console.warn("[fleet] orphan sweep skipped:", error instanceof Error ? error.message : error);
      return null;
    });
    if (!apps) return [];
    const owned = new Set([
      ...(await this.deps.store.list()).map((record) => record.app),
      ...(await this.deps.store.listRunners()).map((record) => record.app),
    ]);
    const now = this.now();
    for (const app of [...this.orphanSeen.keys()]) if (!apps.includes(app) || owned.has(app)) this.orphanSeen.delete(app);
    const swept: string[] = [];
    for (const app of apps) {
      if (owned.has(app)) continue;
      const first = this.orphanSeen.get(app);
      if (first === undefined) { this.orphanSeen.set(app, now); continue; }
      if (now - first < ORPHAN_GRACE_MS) continue;
      try {
        await this.deps.provider.destroyAll(app);
        this.orphanSeen.delete(app);
        swept.push(app);
      } catch (error) {
        console.warn("[fleet] orphan delete failed:", error instanceof Error ? error.message : error);
      }
    }
    return swept;
  }

  /** An early start, metered from first use (SPECULATIVE_STARTS). */
  private speculative(startedFor: string | undefined): boolean {
    return Boolean(this.deps.settings.earlyStarts) && startedFor !== undefined && startedFor in SPECULATIVE_STARTS;
  }

  /** Started early, never used, and out of its grace (SPECULATIVE_STARTS). */
  private unusedPastGrace(record: CloudComputerRecord): boolean {
    if (!this.speculative(record.startedFor) || record.meteredFrom || !record.awakeSince) return false;
    const grace = SPECULATIVE_STARTS[record.startedFor!]!;
    return this.now() - Date.parse(record.awakeSince) > grace * 60_000;
  }

  /** An unreachable policy service never stops a machine; only a known,
   * used-up allowance does. */
  private async allowanceUsedUp(accountId: string): Promise<boolean> {
    const left = await this.deps.admission.secondsLeft?.(accountId).catch(() => undefined);
    return left !== undefined && left <= 0;
  }

  /** A used-up allowance with nothing left to come takes the disk with it.
   * Errors leave the computer asleep. */
  private async retireExhausted(accountId: string): Promise<boolean> {
    if (!this.deps.admission.retireWhenExhausted || !await this.allowanceUsedUp(accountId)) return false;
    return this.deps.admission.retireWhenExhausted(accountId).catch(() => false);
  }

  private async diskAllowed(accountId: string): Promise<boolean> {
    if (!this.deps.admission.diskAllowed) return false;
    return this.deps.admission.diskAllowed(accountId).catch(() => false);
  }

  private ownApp(app: string): boolean {
    return !this.deps.settings.fleet || app.startsWith(fleetPrefix(this.deps.settings.fleet));
  }

  private deleteAt(record: CloudComputerRecord): number {
    return Date.parse(record.lastWokeAt ?? record.createdAt) + this.deps.settings.idleDeleteDays * 86_400_000;
  }

  private warnMs(): number { return this.deps.settings.idleWarnDays * 86_400_000; }

  /** The CPU reading is advisory: when the provider can't answer, reconcile
   * carries on. */
  private async busyApps(): Promise<string[]> {
    const { cpuGuardPercent, cpuGuardMinutes } = this.deps.settings;
    if (cpuGuardPercent <= 0) return [];
    return this.deps.provider.busyApps(APP_PREFIX, cpuGuardMinutes, cpuGuardPercent / 100).catch((error) => {
      console.warn("[fleet] CPU guard skipped:", error instanceof Error ? error.message : error);
      return [];
    });
  }

  private async create(accountId: string, previous: CloudComputerRecord | undefined, runId: string, size: string, restoreSessionId?: string, startedFor?: string): Promise<CloudComputerRecord> {
    const { settings, provider } = this.deps;
    const app = previous?.app ?? cloudComputerApp(accountId, settings.fleet);
    await provider.ensureApp(app);
    const hadVolume = Boolean(previous?.volumeId);
    // A disk recreated (an app move) keeps the size the account already had.
    const diskGb = previous ? this.diskGb(previous) : settings.volumeGb;
    const volumeId = await provider.ensureVolume(app, settings.region, diskGb);
    // A session snapshot is only needed when the disk is new: an existing
    // volume already holds the sessions.
    const boot = await this.deps.core.bootstrap(accountId, {
      awakeCapMinutes: settings.awakeCapMinutes,
      restoreSessionId: hadVolume && volumeId === previous?.volumeId ? undefined : restoreSessionId,
    });
    const machine = await provider.createMachine(app, this.spec(accountId, boot, volumeId, size));
    const now = this.iso();
    const record: CloudComputerRecord = {
      accountId, nodeId: boot.nodeId, app, machineId: machine.id, volumeId, diskGb,
      region: settings.region, size, image: settings.image,
      state: "launching", awakeSince: now, awakeSeconds: previous?.awakeSeconds ?? 0, openRun: runId,
      startedFor, meteredFrom: undefined, stoppedUnused: undefined,
      lastWokeAt: now, createdAt: previous?.createdAt ?? now, updatedAt: now,
    };
    await this.save(record);
    return record;
  }

  /** Start a stopped machine, first moving it to the current image and the
   * account's size. */
  private async start(record: CloudComputerRecord, machine: Machine, runId: string, size: string, startedFor?: string): Promise<void> {
    const { settings, provider } = this.deps;
    let running = record.size;
    if ((record.image !== settings.image || record.size !== size) && record.volumeId) {
      const boot = await this.deps.core.bootstrap(record.accountId, { awakeCapMinutes: settings.awakeCapMinutes });
      try {
        await provider.updateMachine(record.app, machine.id, this.spec(record.accountId, boot, record.volumeId, size));
        running = size;
      } catch (error) {
        if (record.size === size) throw error;
        // A volume is pinned to its host, which may not fit the new size.
        // Waking at the old size beats not waking; the next start tries again.
        console.warn(`[fleet] resize of ${record.app} to ${size} failed:`, error instanceof Error ? error.message : error);
        if (record.image !== settings.image) await provider.updateMachine(record.app, machine.id, this.spec(record.accountId, boot, record.volumeId, record.size));
      }
    }
    await provider.startMachine(record.app, machine.id);
    const now = this.iso();
    await this.save({ ...record, size: running, image: settings.image, state: "waking", lastWokeAt: now, awakeSince: now, openRun: runId, deletionWarnedAt: undefined, startedFor, meteredFrom: undefined, stoppedUnused: undefined });
  }

  /** The picked size while it is still allowed, otherwise the default. */
  async sizeFor(accountId: string): Promise<string> {
    const picked = await this.deps.store.sizePreference(accountId);
    const row = picked ? SIZES[picked] : undefined;
    if (!picked || !row?.offered || picked === this.deps.settings.size) return this.deps.settings.size;
    return (await this.allowedClasses(accountId)).includes(row.class) ? picked : this.deps.settings.size;
  }

  /** A policy-service error falls back to the default size rather than failing
   * a wake. */
  private async allowedClasses(accountId: string): Promise<string[]> {
    if (!this.deps.admission.sizeClasses) return [];
    return this.deps.admission.sizeClasses(accountId).catch(() => []);
  }

  private spec(accountId: string, boot: { files: MachineFile[]; init: { exec: string[] } }, volumeId: string, size: string): MachineSpec {
    const { settings } = this.deps;
    return {
      region: settings.region, image: settings.image, size, volumeId,
      files: boot.files, init: boot.init,
      metadata: { bivy: "cloud-computer", "bivy-account": createHash("sha256").update(accountId).digest("hex").slice(0, 32) },
    };
  }

  private context(purpose: string, activeManagedMachines: number, sizeId: string): PolicyContext {
    const size = SIZES[sizeId];
    return {
      computeSource: "managed", sizeId, vcpus: size?.vcpus, memoryMiB: size?.memoryMiB,
      ttlMinutes: this.deps.settings.awakeCapMinutes,
      // Signing in starts the account's own computer, which stays on for the
      // sessions after it, so it is admitted as that computer and not as a
      // disposable 15-minute authentication machine.
      purpose: purpose === "auth-runner" || purpose === "signup" ? "interactive" : purpose, activeManagedMachines,
    };
  }

  /** End the current awake period: meter it and settle its run. The record
   * keeps wall-clock seconds; the allowance is charged weighted ones. */
  private async settleRun(record: CloudComputerRecord): Promise<CloudComputerRecord> {
    const since = (iso: string | undefined) => iso ? Math.max(0, Math.round((this.now() - Date.parse(iso)) / 1000)) : 0;
    const seconds = since(record.awakeSince);
    // An early start is charged from its first real use; unused, it is free.
    const metered = this.speculative(record.startedFor) ? since(record.meteredFrom) : seconds;
    if (record.openRun) await this.deps.runs.settle(record.accountId, record.openRun, this.iso(), Math.round(metered * sizeWeight(record.size)));
    return { ...record, awakeSince: undefined, openRun: undefined, meteredFrom: undefined, awakeSeconds: record.awakeSeconds + seconds };
  }

  private async failRunOnError<T>(accountId: string, runId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      await this.deps.runs.fail(accountId, runId, this.iso()).catch(() => {});
      throw error;
    }
  }

  private diskGb(record: CloudComputerRecord): number {
    return record.diskGb ?? this.deps.settings.volumeGb;
  }

  /** Forget a computer whose disk is gone, and stop charging extra disk for
   * it. A policy error never keeps a deleted computer around. */
  private async deleteRecord(record: CloudComputerRecord): Promise<void> {
    await this.deps.store.delete(record.accountId);
    if (record.diskGb && record.diskGb > this.deps.settings.volumeGb) {
      await this.deps.admission.diskChanged?.(record.accountId, 0).catch((error) => {
        console.warn(`[fleet] disk change for deleted ${record.app} not recorded:`, error instanceof Error ? error.message : error);
      });
    }
  }

  private save(record: CloudComputerRecord): Promise<void> {
    return this.deps.store.put({ ...record, updatedAt: this.iso() });
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}
