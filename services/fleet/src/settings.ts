// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Everything the fleet reads from its environment, in one table. Each row is a
// name, a default and a bound; nothing else in the service reads process.env.
//
// Names are `FLEET_*`. The `MANAGED_*` names a deployment used while this
// service lived outside Core are still accepted, so an existing fleet can move
// over without re-keying its configuration.

import { sizeClassesFrom, type FleetLimits } from "./limits.js";
import type { ComputeSettings } from "./computers.js";
import type { RunnerSettings } from "./runners.js";

/** Launch profile for one purpose, as Core asks for it. */
export interface ComputeProfile {
  provider: string;
  /** What the app calls this destination. */
  label?: string;
  region?: string;
  size?: string;
  image?: string;
  ttlMinutes?: number;
  teardownOnAgentFinish?: boolean;
  /** This fleet runs one sleeping machine per account. */
  accountMachine?: boolean;
  /** It also runs disposable per-work runners beside the computer. */
  runners?: boolean;
}

export type ComputePurpose = "interactive" | "auth-runner";

/** The image to boot for a runtime, when a deployment prebuilds one per agent.
 * A runtime-suffixed tag is never inferred: a deployment alias doesn't
 * guarantee that tag exists. */
const RUNTIME_IMAGES = [
  { prefix: "claude", key: "IMAGE_CLAUDE", legacy: "MANAGED_SESSION_IMAGE_CLAUDE" },
  { prefix: "codex", key: "IMAGE_CODEX", legacy: "MANAGED_SESSION_IMAGE_CODEX" },
  { prefix: "pi", key: "IMAGE_PI", legacy: "MANAGED_SESSION_IMAGE_PI" },
] as const;

const providerKey = (provider: string) => provider.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");

export class FleetConfig {
  /** Reasons launches are withheld; empty when the fleet can run machines. */
  readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (!this.providerToken()) {
      this.problems.push(`no provider credential (FLEET_PROVIDER_TOKEN, or FLEET_PROVIDER_TOKEN_${providerKey(this.provider())} for a named provider)`);
    }
    if (!this.image()) this.problems.push("FLEET_IMAGE must name a machine image with Bivy already installed");
    if (this.env.NODE_ENV === "production" && this.attested() !== true) {
      this.problems.push("FLEET_GUEST_HARDENING_ATTESTED=1 is required: confirm the image's egress and process controls before running other people's agents on it");
    }
    if (!this.coreUrl()) this.problems.push("FLEET_CORE_URL must point at the control plane's internal address");
    if (!this.coreToken()) this.problems.push("DEPLOYMENT_COMPUTE_TOKEN must be the same secret the control plane is configured with");
  }

  get offered(): boolean { return this.problems.length === 0; }

  /** Disposable per-work runners beside each account's computer. */
  get runners(): boolean { return this.flag("RUNNERS", "MANAGED_RUNNERS"); }

  provider(): string { return this.value("PROVIDER", "MANAGED_SESSION_PROVIDER") ?? "fly"; }

  providerToken(): string | undefined {
    return this.value(`PROVIDER_TOKEN_${providerKey(this.provider())}`, `MANAGED_PROVIDER_TOKEN_${providerKey(this.provider())}`)
      ?? this.value("PROVIDER_TOKEN", undefined);
  }

  providerOrg(): string | undefined { return this.value("PROVIDER_ORG", "MANAGED_FLY_ORG"); }

  /** Without one the fleet keeps its records in memory: fine for a trial run,
   * but a restart then forgets which machines it owns. */
  databaseUrl(): string | undefined { return this.value("DATABASE_URL", "DATABASE_URL"); }

  coreUrl(): string | undefined { return this.value("CORE_URL", "CORE_INTERNAL_URL"); }

  coreToken(): string | undefined {
    return this.env.DEPLOYMENT_COMPUTE_TOKEN?.trim() || this.env.DEPLOYMENT_EXTENSION_TOKEN?.trim() || this.env.CLOUD_EXTENSION_TOKEN?.trim() || undefined;
  }

  /** An operator policy service in front of the fleet's own caps. */
  policy(): { url: string; token: string } | undefined {
    const url = this.value("POLICY_URL", "DEPLOYMENT_EXTENSION_URL");
    const token = this.value("POLICY_TOKEN", "DEPLOYMENT_EXTENSION_TOKEN");
    return url && token ? { url, token } : undefined;
  }

  port(): number {
    const port = Number(this.value("PORT", undefined) ?? this.env.PORT ?? 4600);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
    return port;
  }

  /** How often the reconcile loop sweeps the fleet. */
  reconcileMs(): number { return this.number("RECONCILE_SECONDS", undefined, 60) * 1000; }

  /** Account email for deletion notices, when the deployment can send it. */
  email(): { apiKey: string; from: string; supportEmail: string; appUrl: string } | undefined {
    const apiKey = this.env.RESEND_API_KEY?.trim();
    const from = this.env.FLEET_EMAIL_FROM?.trim() || this.env.WELCOME_EMAIL_FROM?.trim() || this.env.AUTH_EMAIL_FROM?.trim();
    const appUrl = this.value("APP_URL", undefined) ?? this.env.PUBLIC_CONTROL_PLANE_URL?.trim();
    if (!apiKey || !from || !appUrl) return undefined;
    return { apiKey, from, supportEmail: this.env.SUPPORT_EMAIL?.trim() || from, appUrl };
  }

  computeSettings(): ComputeSettings {
    return {
      provider: this.provider(),
      label: this.value("LABEL", undefined) ?? "Cloud computer",
      region: this.value("REGION", "MANAGED_SESSION_REGION") ?? "iad",
      size: this.value("SIZE", "MANAGED_SESSION_SIZE") ?? "shared-4x-8gb",
      image: this.image() ?? "",
      volumeGb: this.number("DISK_GB", "MANAGED_VOLUME_GB", 20),
      maxVolumeGb: this.number("DISK_MAX_GB", "MANAGED_VOLUME_MAX_GB", 100),
      awakeCapMinutes: this.number("AWAKE_CAP_MINUTES", "MANAGED_AWAKE_CAP_MINUTES", 360),
      idleDeleteDays: this.number("IDLE_DELETE_DAYS", "MANAGED_IDLE_DELETE_DAYS", 30),
      idleWarnDays: this.number("IDLE_WARN_DAYS", "MANAGED_IDLE_WARN_DAYS", 7),
      // "0" turns the guard off, so it can't go through `number`.
      cpuGuardPercent: this.zeroable("CPU_GUARD_PERCENT", "MANAGED_CPU_GUARD_PERCENT", 90, 100),
      cpuGuardMinutes: this.number("CPU_GUARD_MINUTES", "MANAGED_CPU_GUARD_MINUTES", 60),
      fleet: this.name(),
      earlyStarts: this.flag("EARLY_STARTS", "MANAGED_EARLY_STARTS"),
    };
  }

  runnerSettings(): RunnerSettings {
    const compute = this.computeSettings();
    return {
      provider: compute.provider, region: compute.region, image: compute.image, fleet: compute.fleet,
      volumeGb: this.number("RUNNER_DISK_GB", "MANAGED_RUNNER_VOLUME_GB", 10),
      awakeCapMinutes: this.number("RUNNER_AWAKE_CAP_MINUTES", "MANAGED_RUNNER_AWAKE_CAP_MINUTES", 180),
      cpuGuardPercent: compute.cpuGuardPercent,
      cpuGuardMinutes: compute.cpuGuardMinutes,
      sleepDeleteDays: this.number("RUNNER_SLEEP_DELETE_DAYS", "MANAGED_RUNNER_SLEEP_DELETE_DAYS", 7),
      sleepWarnDays: this.number("RUNNER_SLEEP_WARN_DAYS", "MANAGED_RUNNER_SLEEP_WARN_DAYS", 2),
    };
  }

  limits(): FleetLimits {
    const compute = this.computeSettings();
    return {
      maxMachines: this.zeroable("MAX_MACHINES", undefined, 0, 100_000),
      maxRunnersPerAccount: this.zeroable("MAX_RUNNERS_PER_ACCOUNT", undefined, this.runners ? 3 : 0, 100),
      monthlyHours: this.zeroable("MONTHLY_HOURS", undefined, 0, 100_000),
      sizeClasses: sizeClassesFrom(this.value("SIZE_CLASSES", undefined) ?? "standard boost performance"),
      maxDiskGb: compute.maxVolumeGb,
      includedDiskGb: compute.volumeGb,
    };
  }

  /** Names this deployment's apps so two fleets sharing one provider
   * organization never touch each other's. Without it, no orphan sweep runs. */
  name(): string | undefined {
    const raw = (this.value("NAME", "MANAGED_FLEET") ?? "").trim();
    // Lowercase letters and digits only: it becomes part of provider app names.
    return /^[a-z0-9]{1,12}$/.test(raw) ? raw : undefined;
  }

  /** The launch profile Core asks for. Null while launches are withheld. */
  profile(purpose: ComputePurpose, runtimeId?: string): ComputeProfile | null {
    if (!this.offered) return null;
    const compute = this.computeSettings();
    if (purpose === "auth-runner") {
      return {
        provider: this.provider(),
        label: compute.label,
        region: compute.region,
        size: compute.size,
        // Several CLIs are needed because the agent is chosen after boot.
        image: compute.image,
        ttlMinutes: Math.min(15, this.number("AUTH_RUNNER_TTL_MINUTES", "MANAGED_AUTH_RUNNER_TTL_MINUTES", 15)),
      };
    }
    return {
      provider: this.provider(),
      label: compute.label,
      region: compute.region,
      size: compute.size,
      image: this.image(runtimeId),
      ttlMinutes: compute.awakeCapMinutes,
      teardownOnAgentFinish: true,
      accountMachine: true,
      ...(this.runners ? { runners: true } : {}),
    };
  }

  private image(runtimeId?: string): string | undefined {
    const runtime = String(runtimeId || "").trim().toLowerCase();
    const variant = RUNTIME_IMAGES.find(({ prefix }) => runtime.startsWith(prefix));
    return (variant ? this.value(variant.key, variant.legacy) : undefined) ?? this.value("IMAGE", "MANAGED_SESSION_IMAGE");
  }

  private attested(): boolean { return this.flag("GUEST_HARDENING_ATTESTED", "MANAGED_GUEST_HARDENING_ATTESTED"); }

  private value(key: string, legacy: string | undefined): string | undefined {
    const raw = this.env[`FLEET_${key}`] ?? (legacy ? this.env[legacy] : undefined);
    return raw?.trim() || undefined;
  }

  private flag(key: string, legacy: string | undefined): boolean {
    return this.value(key, legacy) === "1";
  }

  private number(key: string, legacy: string | undefined, fallback: number): number {
    const parsed = Number(this.value(key, legacy));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /** Like `number`, but an explicit 0 is kept: it turns the setting off. */
  private zeroable(key: string, legacy: string | undefined, fallback: number, max: number): number {
    const raw = this.value(key, legacy);
    if (raw === "0") return 0;
    return Math.min(max, this.number(key, legacy, fallback));
  }
}
