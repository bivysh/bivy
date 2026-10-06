// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deployment-supplied compute. A "managed" launch is the same server-side
// ephemeral path as a user's own cloud account, with one difference: the
// provider credential and the launch profile come from the deployment's
// extension service instead of the user's hosted.providerTokens. Core holds no
// operator credential configuration, images, sizes or limits; it asks.
//
// SECURITY: a credential from the extension is used transiently at launch,
// reconcile and teardown exactly like a user's hosted token. It is kept only in
// process memory, never baked into machine user-data, persisted, or returned by
// any API.

/** Which credential lane an ephemeral config launches with. */
export type ComputeSource = "user" | "managed";

/** Absent/unknown → "user", so every pre-existing config keeps its behavior. */
export function normalizeComputeSource(value: unknown): ComputeSource {
  return value === "managed" ? "managed" : "user";
}

/**
 * Deployment kill switch for NEW cloud-machine launches. Default OFF — an
 * operator opts in with EPHEMERAL_MACHINES_ENABLED=1. It gates launches only,
 * never cleanup: teardown, reconcile and orphan sweeps keep running while off.
 */
export function managedComputeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EPHEMERAL_MACHINES_ENABLED === "1";
}

export type ComputePurpose = "interactive" | "auth-runner";

/** What the deployment wants a managed Machine launched with. */
export interface ComputeProfile {
  provider: string;
  region?: string;
  size?: string;
  image?: string;
  ttlMinutes?: number;
  teardownOnAgentFinish?: boolean;
}

/** The deployment's answers. Implemented by the deployment extension; absent
 * when none is configured, which means there is no managed lane at all. */
export interface DeploymentComputeSource {
  profile(purpose: ComputePurpose, accountId?: string, runtimeId?: string): Promise<ComputeProfile | null>;
  credential(provider: string): Promise<{ token: string; expiresAt?: string } | null>;
}

const CREDENTIAL_REUSE_MS = 5 * 60_000;
const PROFILE_REUSE_MS = 60_000;

/**
 * Wraps a source with an in-memory credential cache. A fresh credential is
 * reused briefly to avoid a call per provider request; after that the source is
 * asked again, and if it can't answer the last credential is still used so
 * teardown and reconcile never depend on the extension being reachable.
 */
export class DeploymentCompute {
  private readonly cached = new Map<string, { token: string; fetchedAt: number; expiresAt?: number }>();
  private readonly profiles = new Map<string, { profile: ComputeProfile | null; fetchedAt: number }>();

  constructor(private readonly source: DeploymentComputeSource | undefined, private readonly now = () => Date.now()) {}

  get configured(): boolean { return Boolean(this.source); }

  /** The deployment's launch profile, or null when it offers none. Answers are
   * reused for a minute; an unreachable extension reads as "none". */
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

  async credential(provider: string): Promise<string | undefined> {
    if (!this.source) return undefined;
    const key = provider.trim().toLowerCase();
    const hit = this.cached.get(key);
    const usable = (entry: typeof hit) => entry && (entry.expiresAt === undefined || entry.expiresAt > this.now());
    if (hit && usable(hit) && this.now() - hit.fetchedAt < CREDENTIAL_REUSE_MS) return hit.token;
    try {
      const fresh = await this.source.credential(key);
      if (!fresh?.token) {
        this.cached.delete(key);
        return undefined;
      }
      const expiresAt = fresh.expiresAt ? Date.parse(fresh.expiresAt) : undefined;
      this.cached.set(key, { token: fresh.token, fetchedAt: this.now(), expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined });
      return fresh.token;
    } catch {
      return usable(hit) ? hit!.token : undefined;
    }
  }
}

let current = new DeploymentCompute(undefined);

/** The process-wide source; the control plane installs the extension-backed one at boot. */
export function deploymentCompute(): DeploymentCompute { return current; }
export function setDeploymentCompute(next: DeploymentCompute): void { current = next; }
