// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Explicit provider-side ports and value contracts. Adapter implementations
// receive transport capabilities through ExecFn and retain no secret globals.

import type { PricedMachineSize } from "./ephemeral-lifecycle.js";
import type { EphemeralMachine } from "./ephemeral-machine.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ExecRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface ExecResult {
  status: number;
  body: any;
}
export type ExecFn = (request: ExecRequest) => Promise<ExecResult>;

export interface BootstrapOpts {
  relayUrl: string;
  controlPlaneUrl: string;
  enrollmentToken: string;
  e2eKeyB64: string;
  ttlMinutes?: number;
  repo?: string;
  installUrl?: string;
  /** Opt the freshly-booted node into the hosted GitHub work queue (the same
   *  switch as the `BIVY_GITHUB_HOSTED_TASKS` node env var) — see
   *  `ControlPlaneTaskPoller`/`resolveControlPlaneTaskConfig` in
   *  src/control-plane-tasks.ts. Lets the machine serve queue items with no
   *  persistent node required (issue #532). */
  hostedTasks?: boolean;
  /** The routing-label suffix this node should additionally serve, e.g.
   *  "ab12cd34" so it also polls `bivy/ab12cd34` (see `BIVY_NODE_LABEL` in
   *  src/control-plane-tasks.ts). Lets a queue item be targeted at THIS
   *  ephemeral machine specifically, via the normal assign-to-node flow. */
  nodeLabel?: string;
  /** A GitHub token (PAT) the node uses to clone/push/open PRs for hosted
   *  queue work, since a fresh machine has no `gh auth login` of its own. Rides
   *  in the same device→provider user_data as the relay enrollment token/E2E
   *  key above — never sent to the control plane. */
  githubToken?: string;
  /** Have the machine self-mint a GitHub token from the control plane per git op
   *  (exports BIVY_HOSTED_MINT) instead of carrying a static token — the hosted
   *  GitHub App path, so no long-lived credential ever lands on the machine. */
  hostedMint?: boolean;
  /** The ephemeral provider this machine runs on (`fly`/`hetzner`/`aws`/…). Lets
   *  the daemon learn it's disposable and, for destroy-lane providers, end the
   *  machine itself once idle — see `bivyBootstrapExports`/src/ephemeral-teardown.ts.
   *  Suspend-to-zero providers (Sprites/E2B) are kept, so no self-teardown env is
   *  emitted for them. */
  provider?: string;
  /** Ask the daemon to tear the machine down promptly after the agent finishes
   *  (a short grace), not just at the idle window — the server-side equivalent of
   *  the device's "Destroy when the agent finishes" toggle, so it no longer needs
   *  the launching device to stay online. */
  teardownOnAgentFinish?: boolean;
  /** DEBUG: disable Fly `auto_destroy` so a boot-failed machine stays (stopped)
   *  with its logs retained, instead of vanishing. Staging diagnosis only. */
  debugKeepMachine?: boolean;
  /** Rebuild-resume (Gap B): the session id to restore from its control-plane
   *  snapshot on boot (exported as `BIVY_RESTORE`). The machine reuses this
   *  session's node id + room key so it can fetch and decrypt the snapshot. */
  restoreSessionId?: string;
}

/** A pickable machine size. `id` is the provider-native identifier that gets
 *  passed back as `config.size` at provision time. */
export interface ProviderSize extends PricedMachineSize {
  id: string;
  label: string;
  /** Approximate on-demand compute price per hour in the provider's currency
   *  (see `ProviderAdapter.currency`), for showing an at-a-glance cost estimate
   *  before launch. Indicative only — the provider's live bill is authoritative;
   *  storage/egress/taxes aren't included. Absent when we have no figure. */
  pricePerHour?: number;
}

export interface ProviderProvisionConfig {
  slug: string;
  region: string;
  size: string;
  image?: string;
  ttlMinutes?: number;
  attemptId: string;
  ownershipTag?: string;
  /** Provider-specific optional resource overrides used by direct adapter callers. */
  org?: string;
  cpus?: number;
  memoryMb?: number;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  /** ISO currency code the provider bills in — drives the cost-hint symbol.
   *  Fly/AWS bill in USD, Hetzner in EUR. */
  currency: string;
  regions: { id: string; label: string }[];
  defaultRegion: string;
  sizes: ProviderSize[];
  defaultSize: string;
  /** Authenticate with a read-only provider request. Used during onboarding so
   * invalid/under-scoped credentials fail before Bivy stores or launches with
   * them. Must never create, update, wake, stop, or delete a resource. */
  validateToken?(args: { exec: ExecFn; token: string; region?: string }): Promise<void>;
  /** False when guest shutdown does not delete the paid resource. Such a
   * provider may launch only when an independent controller has teardown
   * credentials; device-only TTL shutdown is not a billing guarantee. */
  guestCanEnsureDeletion?: boolean;
  /** Optionally fetch the provider's live, currently-orderable sizes so the
   *  hardcoded `sizes` list can't silently go stale (e.g. a plan gets
   *  deprecated). When a region is given, results are narrowed to what that
   *  region can actually order. Falls back to `sizes` when absent or on error. */
  listSizes?(args: { exec: ExecFn; token: string; region?: string }): Promise<ProviderSize[]>;
  /** `userData` is the ready-made cloud-init payload (used by VM providers).
   *  `bootstrap` is the same intent in structured form, for providers that can't
   *  run cloud-init and must assemble their own boot config (Fly — see its
   *  adapter). Both describe one node; an adapter uses whichever it needs. */
  provision(args: { exec: ExecFn; token: string; config: ProviderProvisionConfig; userData: string; bootstrap?: BootstrapOpts }): Promise<EphemeralMachine>;
  status(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<string>;
  destroy(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<void>;
  /** List every live resource tagged with `ownershipTag` at the provider,
   *  independent of anything Bivy currently has tracked. This is the recovery
   *  path for the one failure #554's per-attempt idempotent-create/adopt can't
   *  cover: the durable attempt row itself being lost (both the row AND the
   *  legacy inventory array) after a resource was actually created. Only
   *  implemented for providers where an orphaned resource keeps billing
   *  (Hetzner/Fly/EC2) — a suspend-when-idle managed sandbox (Sprites/E2B)
   *  doesn't carry the same cost risk and is intentionally left without one. */
  discover?(args: { exec: ExecFn; token: string; ownershipTag: string }): Promise<EphemeralMachine[]>;
  /** Compatibility projection of the catalog fact. Lifecycle policy reads the
   * catalog directly; retained for adapter consumers during migration. */
  suspendsWhenIdle?: boolean;
  /** Resume a suspended machine so it rejoins the relay and becomes reachable.
   *  Only meaningful when the provider catalog declares `suspendsWhenIdle` — one allowlisted request that
   *  forces the machine warm (for Sprites, starting its supervised `bivy`
   *  service). Idempotent: safe to call on an already-running machine. */
  wake?(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<void>;
}
