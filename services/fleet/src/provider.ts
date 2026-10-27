// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// What the fleet needs from a machine provider, and the table of adapters that
// supply it. Adding a provider is a row in PROVIDERS plus one adapter file; no
// call site in the fleet names a provider.
//
// `app` is the provider's per-account grouping — on Fly, one app per account,
// which also gives that account its own private network. A provider without
// such a grouping can use the name as a label.

import { FlyClient } from "./fly.js";

export interface MachineFile {
  /** Absolute path inside the guest. */
  guest_path: string;
  /** Base64 content, as the provider's machine API expects it. */
  raw_value: string;
}

export interface MachineSpec {
  region: string;
  image: string;
  /** A key of SIZES; the adapter maps it to provider hardware. */
  size: string;
  files: MachineFile[];
  init: { exec: string[] };
  volumeId: string;
  metadata: Record<string, string>;
}

export interface Machine {
  id: string;
  /** The provider's own state string. AWAKE/GONE in computers.ts read it. */
  state: string;
  region: string;
  image?: string;
  createdAt?: string;
}

/**
 * Every call must be idempotent, or tolerant of "already in that state", so
 * the reconcile loop can retry freely after a half-finished launch.
 */
export interface MachineProvider {
  ensureApp(app: string): Promise<void>;
  /** The app's one data volume, created on first use. */
  ensureVolume(app: string, region: string, sizeGb: number): Promise<string>;
  /** A new volume, always: for a runner, which gets a disk of its own. */
  createVolume(app: string, region: string, sizeGb: number, name: string): Promise<string>;
  destroyMachine(app: string, machineId?: string, volumeId?: string): Promise<void>;
  /** Grow a volume. Providers cannot shrink one. */
  extendVolume(app: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }>;
  /** Advisory: null when the provider has no reading. */
  diskUsage(app: string): Promise<{ usedBytes: number; totalBytes: number } | null>;
  createMachine(app: string, spec: MachineSpec): Promise<Machine>;
  /** Replace a stopped machine's config (new image or boot payload). */
  updateMachine(app: string, machineId: string, spec: MachineSpec): Promise<Machine>;
  getMachine(app: string, machineId: string): Promise<Machine | null>;
  startMachine(app: string, machineId: string): Promise<void>;
  stopMachine(app: string, machineId: string): Promise<void>;
  /** Delete the machine, every volume and the app itself. Absence is success. */
  destroyAll(app: string, machineId?: string): Promise<void>;
  /** Apps whose machines kept their CPUs at least `fraction` busy over the
   * last `minutes`. Measured outside the guest, so an agent with root inside
   * a machine cannot hide from it. Empty when the provider cannot answer. */
  busyApps(prefix: string, minutes: number, fraction: number): Promise<string[]>;
  /** The deployment's app names that start with `prefix`. */
  listApps(prefix: string): Promise<string[]>;
}

export interface ProviderOptions {
  /** The provider's organization/project, when it has one. Discovered from the
   * credential when absent. */
  org?: string;
}

/** Adapters by provider id, as used in FLEET_PROVIDER and the launch profile. */
export const PROVIDERS: Record<string, (token: string, options: ProviderOptions) => MachineProvider> = {
  fly: (token, options) => new FlyClient(token, options),
};

export function machineProvider(provider: string, token: string, options: ProviderOptions = {}): MachineProvider {
  const build = PROVIDERS[provider];
  if (!build) throw new Error(`Unknown machine provider "${provider}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
  return build(token, options);
}
