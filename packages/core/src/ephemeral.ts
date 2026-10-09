// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Compatibility facade for ephemeral-node facts, local persistence, and the
// boot payload. Machines are launched by the deployment, never from here.

export {
  EPHEMERAL_PROVIDERS,
  ephemeralCatalogEntry,
  type EphemeralProviderCatalog,
} from "./ephemeral-catalog.js";
export {
  EPHEMERAL_COMPUTE_INTENT_LABELS,
  ephemeralComputeIntent,
  ephemeralComputeIntentLabel,
  type EphemeralComputeIntent,
} from "./ephemeral-compute.js";
export {
  clampTtlMinutes,
  ephemeralCostEstimate,
  ephemeralCostHint,
  ephemeralLifecyclePhase,
  formatEphemeralPrice,
  type EphemeralLifecycleFacts,
  type EphemeralLifecycleMilestones,
  type EphemeralLifecyclePhase,
  type PricedMachineSize,
} from "./ephemeral-lifecycle.js";
export {
  ephemeralMachineFromCorrelation,
  ephemeralMachineFromNode,
  ephemeralNodeLabel,
  isEphemeralNode,
  type EphemeralMachine,
  type EphemeralMachinePurpose,
  type EphemeralMilestones,
  type SessionCorrelation,
} from "./ephemeral-machine.js";
export {
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  createDeviceOAuthCredentialStore,
  createMachineStore,
  createPendingEphemeralLaunchStore,
  indexedDbBackend,
  memoryBackend,
  type DeviceCredentialScope,
  type DeviceOAuthCredential,
  type DeviceOAuthCredentialStore,
  type EphemeralKeyStore,
  type EphemeralModelKeyEntry,
  type EphemeralModelKeyInfo,
  type EphemeralModelKeyStore,
  type KvBackend,
  type MachineStore,
  type PendingEphemeralLaunch,
  type PendingEphemeralLaunchStore,
  type ProviderKeyInfo,
} from "./ephemeral-storage.js";
export { flyInit as flyMachineBoot } from "./ephemeral-providers/fly.js";
export type {
  BootstrapOpts,
  ProviderAccelerator,
  ProviderSize,
} from "./ephemeral-provider-ports.js";
