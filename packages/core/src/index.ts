// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// @bivy/core — framework-agnostic client core shared by the web PWA and,
// later, the Expo app. No DOM, no framework: just protocol, transport, crypto,
// and the reactive session store.

export * from "./base64.js";
export * from "./crypto.js";
export * from "./relay-frame.js";
export * from "./markdown.js";
export * from "./tool-activity.js";
export * from "./tool-format.js";
export * from "./approval-format.js";
export * from "./inbox.js";
export * from "./outcome.js";
export * from "./run.js";
export * from "./activation.js";
export * from "./capabilities.js";
export * from "./credentialReadiness.js";
export * from "./receipt-v1.js";
export {
  SESSION_CONTRACT_SCHEMA_VERSION,
  resolveSessionContract,
  type ContractGuaranteeState,
  type SessionContract,
  type SessionContractAgentFacts,
  type SessionContractApprovalMode,
  type SessionContractArea,
  type SessionContractAuthFacts,
  type SessionContractAuthKind,
  type SessionContractAuthOrigin,
  type SessionContractCertification,
  type SessionContractDegradedReason,
  type SessionContractEvidenceClass,
  type SessionContractExecutionModeFacts,
  type SessionContractExecutionModeKind,
  type SessionContractInput,
  type SessionContractModelFacts,
  type SessionContractResumeFacts,
  type SessionContractRuntimeEnforcement,
  type SessionContractSandboxFacts,
  type SessionContractSandboxTier,
  type SessionContractSupportTier,
  type SessionContractToolInterceptionFacts,
} from "./session-contract.js";
export * from "./linking.js";
export * from "./protocol.js";
export * from "./local-store.js";
export * from "./account.js";
// Keep the public ephemeral surface intentional: internal provider modules do
// not become API merely because a compatibility facade imports them.
export {
  ALLOWED_HOSTS,
  EPHEMERAL_PROVIDERS,
  assertAllowedUrl,
  awsSign,
  buildBootstrapUserData,
  clampTtlMinutes,
  cloudExec,
  destroyEphemeralMachine,
  ephemeralAdapter,
  ephemeralCatalogEntry,
  ephemeralColdStartMs,
  ephemeralCostEstimate,
  ephemeralCostHint,
  ephemeralLifecyclePhase,
  ephemeralMachineFromCorrelation,
  ephemeralMachineFromNode,
  ephemeralNodeLabel,
  ephemeralProviderSuspendsWhenIdle,
  extractProviderMessage,
  formatEphemeralPrice,
  indexedDbBackend,
  isEphemeralNode,
  launchEphemeralMachine,
  listEphemeralSizes,
  memoryBackend,
  parseAwsToken,
  parseXml,
  planEphemeralLaunch,
  reapOrphanEphemeralNodes,
  trackProvisionedMachine,
  validateEphemeralProviderToken,
  wakeEphemeralMachine,
  xmlChild,
  xmlChildren,
  xmlFind,
  createEphemeralExecutionEnvelope,
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  createEphemeralPrefsStore,
  createEphemeralSetupStore,
  createGithubTaskTokenStore,
  createMachineStore,
  createPendingEphemeralLaunchStore,
  type AwsCreds,
  type BootstrapOpts,
  type DeviceCredentialScope,
  type EphemeralExecutionEnvelope,
  type EphemeralExecutionEnvelopeInput,
  type EphemeralKeyStore,
  type EphemeralLaunchEvent,
  type EphemeralLaunchPhase,
  type EphemeralLaunchPlan,
  type EphemeralLaunchPlanInput,
  type EphemeralLifecycleFacts,
  type EphemeralLifecycleMilestones,
  type EphemeralLifecyclePhase,
  type EphemeralMachine,
  type EphemeralMachinePurpose,
  type EphemeralMilestones,
  type EphemeralModelKeyEntry,
  type EphemeralModelKeyInfo,
  type EphemeralModelKeyStore,
  type EphemeralPrefs,
  type EphemeralPrefsStore,
  type EphemeralProviderCatalog,
  type EphemeralSetup,
  type EphemeralSetupStore,
  type ExecFn,
  type ExecRequest,
  type ExecResult,
  type GithubTaskTokenStore,
  type KvBackend,
  type LaunchOpts,
  type MachineStore,
  type PendingEphemeralLaunch,
  type PendingEphemeralLaunchStore,
  type PricedMachineSize,
  type ProviderAdapter,
  type ProviderKeyInfo,
  type ProviderProvisionConfig,
  type ProviderSize,
  type SessionCorrelation,
  type XmlEl,
} from "./ephemeral.js";
export * from "./device-key-store.js";
export * from "./device-vault.js";
export * from "./pairing.js";
export * from "./transport-direct.js";
export * from "./transport-relay.js";
export * from "./store.js";
export {
  foldConnectionEvent,
  type ConnectionEventData,
  type ConnectionFoldResult,
  type ConnectionFoldValue,
} from "./connection-event-fold.js";
export {
  foldSessionIndexEvent,
  type PausedSessionsValue,
  type SessionIndexEventData,
  type SessionIndexFoldResult,
} from "./session-index-event-fold.js";
export {
  foldCatalogSettingsEvent,
  type CatalogSettingsEventData,
  type CatalogSettingsFoldResult,
} from "./catalog-settings-event-fold.js";
export {
  foldPresentationEvent,
  type PresentationEventData,
  type PresentationFoldResult,
  type PresentationFoldValue,
} from "./presentation-event-fold.js";
export {
  foldActiveSessionEvent,
  type ActiveLifecycleCommand,
  type ActiveLifecycleInput,
  type ActiveLifecycleResult,
} from "./active-session-event-fold.js";
export {
  foldAttentionEvent,
  type AttentionApproval,
  type AttentionFoldResult,
  type AttentionQuestion,
  type AttentionQuestionItem,
  type AttentionRowCommand,
  type AttentionTurn,
  type AttentionValue,
} from "./attention-event-fold.js";
export {
  foldTranscriptEvent,
  freshTranscriptDraft,
  type BufferedAgentAttachment,
  type TranscriptDraftValue,
  type TranscriptFoldCommand,
  type TranscriptFoldEntry,
  type TranscriptFoldResult,
  type TranscriptFoldTool,
  type TranscriptFoldValue,
} from "./transcript-event-fold.js";
export * from "./followups.js";
export * from "./transcript-cache.js";
export * from "./slash.js";
export * from "./nl-cron.js";
export * from "./artifacts.js";
export * from "./capability-routing.js";
