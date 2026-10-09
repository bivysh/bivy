// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deployment-supplied compute. The deployment's extension service runs one
// sleeping machine per account (the "cloud computer") and owns its lifecycle;
// Core asks it which profile an account gets and then acquires/wakes/releases
// that machine through the extension (see cloud-computer.ts). Core holds no
// provider credential, image, size or limit configuration and launches no
// machines itself.

/**
 * Deployment kill switch for cloud compute. Default OFF — an operator opts in
 * with EPHEMERAL_MACHINES_ENABLED=1. It gates acquiring the cloud computer for
 * new sessions and onboarding.
 */
export function managedComputeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EPHEMERAL_MACHINES_ENABLED === "1";
}

export type ComputePurpose = "interactive" | "auth-runner";

/** What the deployment offers an account. */
export interface ComputeProfile {
  provider: string;
  region?: string;
  size?: string;
  image?: string;
  ttlMinutes?: number;
  /** The deployment runs the account's cloud computer. Without it the account
   * is offered no managed compute. */
  accountMachine?: boolean;
}

/** The deployment's answers. Implemented by the deployment extension; absent
 * when none is configured, which means there is no managed lane at all. */
export interface DeploymentComputeSource {
  profile(purpose: ComputePurpose, accountId?: string, runtimeId?: string): Promise<ComputeProfile | null>;
}

const PROFILE_REUSE_MS = 60_000;

/** Wraps a source with a short in-memory profile cache. */
export class DeploymentCompute {
  private readonly profiles = new Map<string, { profile: ComputeProfile | null; fetchedAt: number }>();

  constructor(private readonly source: DeploymentComputeSource | undefined, private readonly now = () => Date.now()) {}

  get configured(): boolean { return Boolean(this.source); }

  /** The deployment's profile, or null when it offers none. Answers are reused
   * for a minute; an unreachable extension reads as the last answer, else none. */
  async profile(purpose: ComputePurpose, accountId?: string, runtimeId?: string): Promise<ComputeProfile | null> {
    if (!this.source) return null;
    const key = JSON.stringify([purpose, accountId ?? "", runtimeId ?? ""]);
    const hit = this.profiles.get(key);
    if (hit && this.now() - hit.fetchedAt < PROFILE_REUSE_MS) return hit.profile;
    let profile: ComputeProfile | null;
    try {
      const answer = await this.source.profile(purpose, accountId, runtimeId);
      profile = answer && typeof answer.provider === "string" && answer.provider ? answer : null;
    } catch {
      return hit?.profile ?? null;
    }
    this.profiles.set(key, { profile, fetchedAt: this.now() });
    return profile;
  }
}

let current = new DeploymentCompute(undefined);

/** The process-wide source; the control plane installs the extension-backed one at boot. */
export function deploymentCompute(): DeploymentCompute { return current; }
export function setDeploymentCompute(next: DeploymentCompute): void { current = next; }
