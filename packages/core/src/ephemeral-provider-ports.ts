// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Boot contract for an ephemeral node and the machine-size facts shared by
// lifecycle and compute projections.

import type { PricedMachineSize } from "./ephemeral-lifecycle.js";

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
  /** Consume only the separately encrypted, explicitly granted hosted credential
   * snapshot. Interactive managed Machines need this even though they must not
   * poll the unattended hosted task queue. */
  hostedCredentialCustody?: boolean;
  /** Allow a credential-setup guest to publish the account's initial filtered
   * hosted snapshot. The control plane accepts this from managed guests only
   * while no snapshot exists, so an agent-bearing guest cannot replace one. */
  hostedCredentialPublisher?: boolean;
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
   *  Every supported ephemeral provider is a destroy lane. */
  provider?: string;
  /** Ask the daemon to tear the machine down promptly after the agent finishes
   *  (a short grace), not just at the idle window — the server-side equivalent of
   *  the device's "Destroy when the agent finishes" toggle, so it no longer needs
   *  the launching device to stay online. */
  teardownOnAgentFinish?: boolean;
  /** Rebuild-resume (Gap B): the session id to restore from its control-plane
   *  snapshot on boot (exported as `BIVY_RESTORE`). The machine reuses this
   *  session's node id + room key so it can fetch and decrypt the snapshot. */
  restoreSessionId?: string;
  /** The machine sleeps instead of being destroyed: when idle the daemon exits
   *  without signalling settled, the provider keeps the stopped machine and its
   *  persistent disk, and the deployment starts it again on use. Bivy's data
   *  dir, the workspace and HOME (agent sign-ins, package caches, user-installed
   *  tools) live on that disk at `PERSISTENT_ROOT`. */
  sleepOnIdle?: boolean;
}

/** Mount point of a sleeping machine's persistent disk. */
export const PERSISTENT_ROOT = "/data";

/** A pickable machine size. `id` is the provider-native identifier that gets
 *  passed back as the machine size. */
export interface ProviderAccelerator {
  vendor: "nvidia" | "amd";
  model: string;
  count: number;
  memoryMiB?: number;
}

export interface ProviderSize extends PricedMachineSize {
  id: string;
  label: string;
  /** Structured workload facts. Keep these separate from `label`: product
   *  policy uses them to recommend agent-fit compute and reject incompatible
   *  architectures/images without parsing provider copy. */
  vcpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
  architecture?: "x86_64" | "arm64";
  accelerator?: ProviderAccelerator;
  /** Approximate on-demand compute price per hour in the provider's currency
   *  (see the provider catalog), for showing an at-a-glance cost estimate
   *  before launch. Storage/egress/taxes aren't included. */
  pricePerHour?: number;
  priceSource?: "live" | "indicative";
}
