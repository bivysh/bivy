// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// AppController — the single seam between the React view and @bivy/core.
//
// It owns one SessionStore and one Transport, translates UI intents into typed
// Commands, and manages the small amount of cross-event orchestration the view
// shouldn't know about (e.g. flushing a first prompt once a draft session
// becomes real). Everything the UI renders comes from `store`.

import {
  DirectTransport,
  RelayTransport,
  SessionStore,
  createLocalStore,
  consumeLinkPayload,
  fetchAccountNodes,
  fetchCentralGithubApp,
  createCentralGithubInstall,
  createManagedAuthRunner,
  managedCredentialStatus,
  ensureManagedSessionDefaults,
  ensureManagedAutomationTarget,
  launchManagedSessionMachine,
  ManagedLaunchError,
  restoreManagedSessionMachine,
  createAccountNodeClaim,
  fetchAccountNodeClaims,
  revokeAccountNodeClaim,
  fetchAccountSessions,
  fetchMe,
  invokeAccountExtensionAction,
  fetchGithubApp,
  fetchGithubQueue,
  fetchAutomationRuns,
  createOneOffRun,
  cancelAutomationRun as apiCancelAutomationRun,
  recordProductMetric,
  activationFromState,
  type ProductMetricEvent,
  type ActivationCheckId,
  assignWorkItem,
  deleteWorkItem,
  clearWorkQueue,
  disconnectGithubApp,
  setGithubAppDefaultNode,
  setGithubAppTriggerAccess,
  fetchEphemeralQueueDefault,
  setEphemeralQueueDefault,
  fetchEphemeralConfigs,
  createEphemeralConfig as apiCreateEphemeralConfig,
  updateEphemeralConfig as apiUpdateEphemeralConfig,
  deleteEphemeralConfig as apiDeleteEphemeralConfig,
  fetchQueueRouting,
  setQueueRouting as apiSetQueueRouting,
  fetchHostedProvisioning,
  setHostedProvisioning as apiSetHostedProvisioning,
  fetchHostedAudit,
  fetchHostedMachines,
  destroyHostedMachine as apiDestroyHostedMachine,
  validateHostedProviderCredential as apiValidateHostedProviderCredential,
  rotateHostedProvisioning as apiRotateHostedProvisioning,
  connectHostedGithubApp as apiConnectHostedGithubApp,
  fetchHostedGithubRepositories,
  fetchHostedGithubBranches,
  type HostedGithubAppConnection,
  triggerHostedProvision as apiTriggerHostedProvision,
  type EphemeralNodeConfig,
  type EphemeralConfigInput,
  type QueueRouting,
  type HostedProvisioningStatus,
  type HostedProvisioningPatch,
  type HostedAuditEvent,
  type HostedMachineSummary,
  type RunTerminalSummary,
  removeAccountNode,
  fetchPairedDevices,
  removePairedDevice,
  logout,
  enablePushNotifications,
  disablePushNotifications,
  getPushSubscriptionStatus,
  getNotificationPreferences,
  setNotificationPreferences,
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  createDeviceOAuthCredentialStore,
  createEphemeralPrefsStore,
  createEphemeralSetupStore,
  createMachineStore,
  createPendingEphemeralLaunchStore,
  createGithubTaskTokenStore,
  createTranscriptCache,
  cloudExec,
  validateEphemeralProviderToken,
  launchEphemeralMachine,
  destroyEphemeralMachine,
  ephemeralAdapter,
  ephemeralCatalogEntry,
  ephemeralMachineFromNode,
  ephemeralMachineFromCorrelation,
  type SessionCorrelation,
  createDeviceVaultKeyStore,
  DeviceVaultConflictError,
  deviceKeypair,
  listEphemeralSizes,
  ephemeralNodeLabel,
  type TranscriptCache,
  type DeviceVaultKeyStore,
  type DeviceVaultRemote,
  type EphemeralModelKeyStore,
  type EphemeralModelKeyInfo,
  type EphemeralPrefsStore,
  type EphemeralPrefs,
  type EphemeralSetupStore,
  type EphemeralSetup,
  type EphemeralMachine,
  type PendingEphemeralLaunch,
  type PendingEphemeralLaunchStore,
  type SessionLaunchCheckpointId,
  type GithubTaskTokenStore,
  type EphemeralQueueDefault,
  type LaunchOpts,
  type ProviderSize,
  type MachineStore,
  type ProviderKeyInfo,
  type AccountMe,
  type NotificationPreferences,
  type AccountNode,
  type AccountSessionAdvert,
  type PairedDevice,
  type Command,
  type ConnectionStatus,
  type FollowupEditResult,
  type ModelInfo,
  type PendingFollowup,
  type PromptAttachment,
  type Ruleset,
  type RuntimeInfo,
  type ServerEvent,
  type Transport,
  type LocalStore,
  type LocalModelDiscoveryResult,
  type LocalModelEndpointResult,
  importRoomKey,
  open as openSealed,
  unb64url,
  seal,
  createAutomation,
  deleteAutomation,
  fetchAutomations,
  updateAutomation,
  type AccountAutomation,
} from "@bivy/core";
import { navigate, parseRoute, routePath, type Route } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED, EPHEMERAL_KEEP_FAILED_MACHINES } from "../flags.js";
import { markFirstSuccessfulResponse } from "../pwaLifecycle.js";
import { SessionOrchestrator } from "./coordinators/session-orchestrator.js";
import { NodeConnectionCoordinator } from "./coordinators/node-connection-coordinator.js";
import { CredentialsModelsCoordinator } from "./coordinators/credentials-models-coordinator.js";
import { EphemeralCoordinator } from "./coordinators/ephemeral-coordinator.js";
import { AutomationsAccountCoordinator } from "./coordinators/automations-account-coordinator.js";
import { FollowupCoordinator } from "./coordinators/followup-coordinator.js";

/**
 * Bounded discovery metadata for a provider-native session Bivy did not start
 * (see src/runtime/types.ts's DiscoveredNativeSession, issue #156). Never
 * carries transcript content — safe to render in a list straight off the wire.
 */
export interface DiscoveredNativeSessionDto {
  runtimeId: string;
  agentName: string;
  ref: string;
  cwd?: string;
  updatedAt?: number;
  title?: string;
  active: boolean;
  resumable: boolean;
  plan: {
    mode: "native-resume" | "seeded" | "follow-only";
    disclosure?: string;
  };
  /** The provider's own CLI command to attach to this session directly, when
   *  known — the "follow/read-only" affordance for a session whose plan is
   *  "follow-only" (a live external process Bivy can't safely take over). */
  resumeCommand?: string;
}

/**
 * Thrown by `importNativeSession` when the node refuses to fall back to a
 * seeded continuation without explicit user disclosure (issue #156). Callers
 * MUST show `disclosure` and only retry with `{ acceptDisclosure: true }` on
 * the user's explicit confirmation — never automatically.
 */
export class NeedsDisclosureError extends Error {
  constructor(public readonly disclosure: string) {
    super(disclosure);
    this.name = "NeedsDisclosureError";
  }
}

function requestId(): string {
  return `r-${crypto.randomUUID()}`;
}

function clientMessageId(): string {
  return crypto.randomUUID();
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

// E2E template envelope for scheduled chat messages (mirrors AutomationsView).
const TEMPLATE_PREFIX = "bivy-room-v1";

/** How long to wait after a launched ephemeral runner comes online before
 *  concluding it has no model credentials and raising the first-run sign-in
 *  prompt — long enough for hosted-escrow / peer-vault sync to land first. */
const FIRST_RUN_MODEL_AUTH_GRACE_MS = 8000;

/** How long to wait for a freshly-launched ephemeral runner to come online before
 *  telling the user it likely failed to boot — generous, since a bare VM installs
 *  from scratch (1–3 min), but bounded so a self-destructed machine doesn't leave
 *  the session spinning "Reconnecting…" forever. */
const RUNNER_BOOT_TIMEOUT_MS = 4 * 60 * 1000;
/**
 * Same rule as the legacy client: a same-origin/loopback node (or explicit
 * `?local=1`) talks directly; a hosted control plane (app.bivy.sh) talks to a
 * node through the E2E relay.
 */
export function isDirectMode(store = createLocalStore(localStorage)): boolean {
  const params = new URLSearchParams(location.search);
  if (params.has("local")) return true;
  return LOOPBACK.test(location.hostname) && !store.s && !location.hash.includes("payload=");
}

export class AppController {
  readonly store = new SessionStore();
  readonly local = createLocalStore(localStorage);
  readonly direct: boolean;
  /** Account-free ("solo") mode: paired to a node over the relay via a room
   *  token from the QR, with NO control plane. Not signed in (no `local.s`), so
   *  every CP-coupled path stays off, yet the app shell renders and dials. */
  readonly solo: boolean;
  private transport: Transport;
  /** A first prompt queued while a brand-new session is being created. `frame` is
   *  the exact `session.new` command we sent; it's re-fired verbatim after a
   *  reconnect (mobile Safari can drop the reply while backgrounded) — the node
   *  dedupes by requestId, so the retry adopts the same session rather than
   *  creating a duplicate. See retryPendingSessionNew / maybeFlushPendingPrompt. */
  private pendingPrompt: { text: string; requestId: string; clientMessageId: string; attachments?: PromptAttachment[]; frame: Command; provisionalId?: string } | null = null;
  /** Ephemeral cold starts outlive the pane that launched them. Each first
   *  message gets a sidebar placeholder immediately, and its launch continues
   *  here even if the user presses New and starts another session. */
  private pendingLaunches = new Map<string, PendingEphemeralLaunch & { transport?: Transport; sessionId?: string; promptSent?: boolean }>();
  /** Timed, factual boot updates. Provider creation returning only means the VM
   *  exists; these heartbeats make the otherwise silent cloud-init wait visible. */
  private bootProgressTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private bootstrapPhaseByNode = new Map<string, string>();
  /** Further prompts sent by the user *while* that session is still being
   *  created — queued instead of firing their own `session.new`, then drained
   *  into the one real session by maybeFlushPendingPrompt. See sendPrompt. */
  private pendingFollowups: Array<{ text: string; clientMessageId: string; attachments?: PromptAttachment[] }> = [];
  /** Prompts sent into a session whose ephemeral node is offline (a suspended
   *  Sprite or a torn-down machine). Sending IS the resume gesture: the message
   *  is buffered here, the machine is woken/rebuilt, and these replay once it's
   *  back online (drainPendingResume in onReconnected). No "resume" button. */
  private pendingResume: Array<{ sessionId: string; text: string; clientMessageId: string; attachments?: PromptAttachment[] }> = [];
  /** Guards a resume/rebuild already in flight so repeated sends don't re-launch. */
  private resumingNode = new Set<string>();
  // Durable session↔machine correlations fetched from the control plane (Gap 1),
  // so a torn-down destroy-lane session stays rebuildable after its node drops
  // from the registry. Refreshed on reconnect; written (deduped) before teardown.
  private ephemeralCorrelations: SessionCorrelation[] = [];
  private correlatedSessions = new Set<string>();
  /** Subscribers for terminal / multiplexer events (the terminal overlay). */
  private terminalListeners = new Set<(e: ServerEvent) => void>();
  /** In-flight transcription and speech requests, correlated with node replies. */
  private pendingTranscriptions = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingSpeech = new Map<string, { resolve: (audio: { audio: string; mimeType: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** In-flight saves awaiting a node ack (node.settings, provider.apiKey,
   *  models.custom.save, stt.config.set), by requestId — see awaitAck/resolveAck.
   *  These commands had no protocol-level ack before #140: the UI would show
   *  "Saved" the instant the command was sent, regardless of whether the node
   *  actually accepted it. */
  private pendingAcks = new Map<string, { resolve: (event: ServerEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Persistent transcript cache (IndexedDB) for instant paint + incremental backfill. */
  private transcriptCache: TranscriptCache = createTranscriptCache({ maxSessions: 50 });
  /** De-dupe in-flight/settled attachment fetches by content hash, so several
   *  chips referencing the same blob (and re-renders) share one round-trip. Since
   *  the content is immutable per hash, successful results are cached for the
   *  session; failures are evicted so a later chip can retry. */
  private attachmentFetches = new Map<string, Promise<{ mimeType: string; data: string } | null>>();
  /** A GitHub App manifest `code` captured from a redirect, sent once connected. */
  private pendingGithubAppCode: { code: string; state: string } | null = null;
  /** The route the app was loaded on (e.g. a `/sessions/:id` deep link), applied
   *  once we're first online — see applyInitialRoute. Cleared after it runs. */
  private pendingRoute: Route | null = null;
  /** Owning node id parsed from a `?node=` deep link (a clicked push
   *  notification), applied together with `pendingRoute` on first online. */
  private pendingRouteNode: string | null = null;
  /** Session selected from another node in the all-node sidebar; opened after reconnecting to its owner node. */
  private pendingCrossNodeOpen: { sessionId: string; path?: string } | null = null;
  /** Subscribers for content-free control-plane Run-change hints. The relay
   *  never carries the Run body/evidence here; subscribers refetch canonically. */
  private runUpdateListeners = new Set<(runId: string, revision?: string) => void>();
  /** Subscribers that want the composer input focused (e.g. after "New"). */
  private composerFocusListeners = new Set<() => void>();
  /** Subscribers that accept editable text drafted by contextual UI actions. */
  private composerPrefillListeners = new Set<(text: string) => void>();
  /** Subscribers that want the composer's slash-command menu opened (the "/" pill). */
  private slashOpenListeners = new Set<() => void>();
  /** Product milestones are aggregate and content-free. Once-only activation
   *  events are latched in this browser so reconnect/history replay cannot
   *  inflate them; the in-flight guard also closes double-emission races. */
  private productMetricsInFlight = new Set<ProductMetricEvent>();
  private readonly sessionCoordinator: SessionOrchestrator;
  private readonly nodeCoordinator: NodeConnectionCoordinator;
  private readonly credentialsModelsCoordinator: CredentialsModelsCoordinator;
  private readonly ephemeralCoordinator: EphemeralCoordinator;
  private readonly accountCoordinator: AutomationsAccountCoordinator;
  private readonly followupCoordinator: FollowupCoordinator;

  constructor() {
    this.followupCoordinator = new FollowupCoordinator(this.store, {
      send: (command) => this.send(command),
      createClientMessageId: clientMessageId,
      now: Date.now,
      persistBackstop: (sessionId, id, text) => { void this.persistScheduledFollowup(sessionId, id, text); },
      cancelBackstop: (automationId) => this.cancelScheduledFollowup(automationId),
    });
    this.nodeCoordinator = new NodeConnectionCoordinator({
      facts: () => ({ direct: this.direct, solo: this.solo, signedIn: Boolean(this.local.s), currentNodeId: this.local.cur || null }),
      status: () => this.store.getState().connection.status,
      closeTransport: () => { try { this.transport.close(); } catch { /* noop */ } },
      setCurrentNode: (nodeId) => { this.local.cur = nodeId; this.store.setCurrentNode(nodeId || null); },
      resetSession: () => this.store.resetSession(),
      seedSessions: () => this.seedSessionsFromCache(),
      rebuildTransport: () => { this.transport = this.buildTransport(); },
      setStatus: (status) => this.store.setStatus(status),
      connectTransport: () => { void this.transport.connect(); },
      refreshNodes: () => { void this.refreshNodes(); },
      refreshAccountSessions: () => { void this.refreshAccountSessions(); },
      waitForOnline: (timeoutMs) => this.waitForOnline(timeoutMs),
      listProviders: () => this.listProviders(),
    });
    this.sessionCoordinator = new SessionOrchestrator({
      send: (command) => { void this.transport.send(command); },
      sendRequest: (command) => { void this.transport.send(command); },
      createRequestId: requestId,
      createClientMessageId: clientMessageId,
      currentNodeId: () => this.local.cur,
      isDirect: () => this.direct,
      sessionRuntime: (sessionId) => this.store.getState().sessionIndex.sessions.find((session) => session.sessionId === sessionId)?.runtimeId,
      switchNode: (nodeId) => this.switchNode(nodeId),
      waitForOnline: (timeoutMs) => this.waitForOnline(timeoutMs),
      openSession: (sessionId, path) => this.openSession(sessionId, path),
      addUserMessage: (text, id) => this.store.addUserMessage(text, id),
      transcriptUrl: (sessionId) => `${location.origin}${routePath({ kind: "session", id: sessionId })}`,
      refreshAccountSessions: () => { void this.refreshAccountSessions(); },
      launchManagedDestination: async (configId) => {
        const machine = await launchManagedSessionMachine(this.local, configId);
        if (!machine.nodeId) throw new Error("Managed fork destination launched without a node id");
        return machine.nodeId;
      },
    }, {
      navigateNew: () => navigate({ kind: "new" }),
      focusComposer: () => this.focusComposer(),
      clearPendingPromptAndFollowups: () => { this.pendingPrompt = null; this.pendingFollowups = []; },
      resetActiveSession: () => this.store.resetActiveSession(),
      seedDraftDefaults: () => this.seedDraftDefaults(),
      listRuntimes: () => this.listRuntimes(),
      listModels: () => this.listModels(),
      hasNodeSettings: () => Boolean(this.store.getState().settings.nodeSettings),
      getNodeSettings: () => this.getNodeSettings(),
      listRepos: () => this.listRepos(),
      draftRepo: () => this.store.getState().draft.repo,
      listBranches: (repo) => this.listBranches(repo),
      activeSessionId: () => this.store.getState().activeSession.activeSessionId,
      isPendingLaunch: (id) => this.pendingLaunches.has(id),
      appendPendingLaunchFollowup: (id, prompt) => { this.pendingLaunches.get(id)?.followups.push(prompt); },
      addUserMessage: (text, id, attachments) => this.store.addUserMessage(text, id, attachments),
      mustQueue: (id) => this.followupCoordinator.mustQueue(id),
      enqueueFollowup: (id, prompt) => this.store.enqueueFollowup(id, prompt, Date.now()),
      persistFollowup: (id, messageId, text) => { void this.persistScheduledFollowup(id, messageId, text); },
      drainFollowups: (id) => this.followupCoordinator.drain(id),
      shouldAutoResume: () => this.shouldAutoResume(),
      bufferResume: (prompt) => { this.pendingResume.push(prompt); },
      resumeNodeForSession: (id) => { void this.resumeNodeForSession(id); },
      hasPendingPrompt: () => Boolean(this.pendingPrompt),
      appendPendingFollowup: (prompt) => { this.pendingFollowups.push(prompt); },
      draftSessionFields: () => this.draftSessionFields(),
      setPendingPrompt: (prompt) => { this.pendingPrompt = prompt; },
      draftEphemeralRunner: () => this.store.getState().draft.ephemeralConfig,
      startEphemeralLaunch: (provisionalId, prompt, config) => {
        const now = new Date().toISOString();
        const task: PendingEphemeralLaunch = { id: provisionalId, prompt, config, logs: [], followups: [], phase: "provisioning", createdAt: now, updatedAt: now };
        this.pendingLaunches.set(provisionalId, task);
        void this.pendingLaunchStore.put(task);
        this.store.persistPendingSession(provisionalId, prompt.text, true, config.name);
        void this.launchDraftRunnerAndBind(provisionalId);
      },
      send: (command) => this.send(command),
      resetDeletedActiveSession: () => { this.store.resetActiveSession(); navigate({ kind: "new" }); },
      removeSessionLocal: (id) => this.store.removeSessionLocal(id),
      persistDeletedSessionTombstones: () => this.persistDeletedSessionTombstones(),
      deleteTranscriptCache: (id) => { void this.transcriptCache.delete(id); },
      refreshSessions: () => this.refreshSessions(),
      resolveSessionId: (id) => id || this.store.getState().activeSession.activeSessionId,
    });
    this.credentialsModelsCoordinator = new CredentialsModelsCoordinator({
      send: (command) => { void this.transport.send(command); },
      awaitAck: (command, timeoutMs) => this.awaitAck(command, timeoutMs),
      selectModelLocally: (model) => {
        this.store.setCurrentModelLocal(model);
        this.store.setDraftModel({ provider: (model as ModelInfo & { provider?: string }).provider, id: model.id });
      },
      rememberModel: (model) => this.local.setLastChoice({ modelProvider: (model as ModelInfo & { provider?: string }).provider, modelId: model.id }),
      isDirect: () => this.direct,
      now: () => Date.now(),
      isOnline: () => this.store.getState().connection.status === "online",
      importModelKeys: (entries) => this.ephemeralKeys.importModelKeys(entries),
      removeModelKey: (provider, label) => this.ephemeralKeys.removeModelKey(provider, label),
      accountModelKeys: async () => (await this.ephemeralKeys.modelKeyEntries()).filter((entry) => entry.scope === "account"),
      importOAuthCredentials: (entries) => this.ephemeralKeys.importOAuthCredentials(entries),
      removeOAuthCredential: (provider, label, deletedAt) => this.ephemeralKeys.removeOAuthCredential(provider, label, deletedAt),
      accountOAuthCredentials: () => this.ephemeralKeys.oauthCredentialEntries(),
      oauthRecoveryEnabled: () => this.oauthRecoveryEnabled(),
    });
    this.ephemeralCoordinator = new EphemeralCoordinator({
      listConfigs: () => fetchEphemeralConfigs(this.local),
      createConfig: (input) => apiCreateEphemeralConfig(this.local, input),
      updateConfig: (id, patch) => apiUpdateEphemeralConfig(this.local, id, patch),
      removeConfig: (id) => apiDeleteEphemeralConfig(this.local, id),
      listSizes: (providerId, region) => listEphemeralSizes(providerId, { exec: cloudExec(this.local), keys: this.ephemeralKeys }, region),
      signedIn: () => this.signedIn,
      direct: () => this.direct,
      currentNodeId: () => this.local.cur,
      roomKey: (nodeId) => this.local.keys()[nodeId],
      draftRepo: () => this.store.getState().draft.repo || undefined,
      githubToken: () => this.githubTaskToken.get(),
      machines: () => this.ephemeralMachines.list(),
      nodes: () => this.store.getState().connection.nodes,
      correlations: () => this.ephemeralCorrelations,
      launchMachine: (opts) => launchEphemeralMachine({ ...opts, debugKeepMachine: EPHEMERAL_KEEP_FAILED_MACHINES }, { store: this.local, exec: cloudExec(this.local), keys: this.ephemeralKeys, machines: this.ephemeralMachines }),
      restoreManagedMachine: (input) => restoreManagedSessionMachine(this.local, input),
      destroyMachine: (machine) => destroyEphemeralMachine(machine, { store: this.local, exec: cloudExec(this.local), keys: this.ephemeralKeys, machines: this.ephemeralMachines }),
      machineFromNode: (node) => ephemeralMachineFromNode(node),
      machineFromCorrelation: ephemeralMachineFromCorrelation,
      connectToNode: (nodeId, timeoutMs) => this.connectToNode(nodeId, timeoutMs),
      refreshNodes: () => { void this.refreshNodes(); },
      reportError: (error) => this.store.setError(error.message),
      defaultConfig: (providerId) => {
        const adapter = ephemeralAdapter(providerId);
        return {
          name: ephemeralCatalogEntry(providerId)?.name ?? providerId,
          region: adapter?.defaultRegion ?? null,
          size: adapter?.defaultSize ?? null,
        };
      },
      validateProviderToken: (id, token) => validateEphemeralProviderToken(id, token, cloudExec(this.local)),
      setProviderToken: (id, token) => this.ephemeralKeys.setToken(id, token),
      removeProviderToken: (id) => this.ephemeralKeys.remove(id),
      getProviderToken: (id) => this.ephemeralKeys.getToken(id),
      assignWorkItem: (id, input) => assignWorkItem(this.local, id, input),
      nodeLabel: (id) => ephemeralNodeLabel(id),
      followupCount: (sessionId) => this.store.getFollowups(sessionId).length,
      recordSessionCorrelation: (sessionId, machine) => { void this.recordSessionCorrelation(sessionId, machine); },
      schedule: (effect, delayMs) => { setTimeout(effect, delayMs); },
    });
    this.accountCoordinator = new AutomationsAccountCoordinator({
      local: this.local,
      sendGithubDisconnect: ({ appId, hookId }) => this.send({ kind: "github.app.disconnect", requestId: requestId(), appId: appId || undefined, hookId: hookId || undefined }),
      refreshNodes: () => this.refreshNodes(),
      api: {
        fetchMe,
        fetchGithubApp,
        fetchGithubQueue,
        fetchAutomationRuns,
        cancelAutomationRun: apiCancelAutomationRun,
        disconnectGithubApp,
        removeNode: removeAccountNode,
        enablePush: enablePushNotifications,
        disablePush: disablePushNotifications,
        pushStatus: getPushSubscriptionStatus,
        getNotificationPreferences,
        setNotificationPreferences,
        createOneOffRun,
        setGithubAppDefaultNode,
        setGithubAppTriggerAccess,
        assignWorkItem,
        deleteWorkItem,
        clearWorkQueue,
      },
      runContext: () => {
        const state = this.store.getState();
        const sessionId = state.activeSession.activeSessionId ?? undefined;
        const active = sessionId ? state.sessionIndex.sessions.find((session) => session.sessionId === sessionId) : undefined;
        const nodeId = sessionId ? this.resolveSessionNodeId(sessionId) : state.connection.currentNodeId ?? undefined;
        const node = nodeId ? state.connection.nodes.find((candidate) => candidate.id === nodeId) : undefined;
        return {
          accountMode: this.accountMode(),
          sessionId,
          nodeId,
          roomKey: nodeId ? this.local.keys()[nodeId] : undefined,
          nodeLabel: node?.name ? `bivy/${node.name}` : undefined,
          repo: state.draft.repo ?? undefined,
          runtimeId: state.catalogs.selectedAgentId ?? undefined,
          model: state.catalogs.currentModel?.id,
          sandbox: active?.sandbox ?? (!sessionId ? state.draft.sandbox ?? state.settings.nodeSettings?.defaultSandbox : undefined),
        };
      },
      encrypt: async (roomKey, text) => seal(await importRoomKey(unb64url(roomKey)), text),
      recordRunAccepted: () => this.recordProductMilestone("run_accepted"),
    });
    // Persist each applied history snapshot + cursor, and re-request canonical
    // history once a live turn settles (drives the P1.1 append-only backfill).
    this.store.onHistoryPersist = (sessionId, messages, count, historyHash) => {
      const attachments = this.store.attachmentsForHistory(messages);
      void this.transcriptCache.put(sessionId, messages, count, historyHash, attachments);
    };
    this.store.requestFreshHistory = () => {
      const sid = this.store.getState().activeSession.activeSessionId;
      if (sid) this.requestHistory(sid);
    };
    // The reassembler detected a live-stream gap (a frame lost on an uplink blip)
    // — ask the node to replay the events after the last seq we hold. The node
    // answers with the missed tail, or mode:"reset" (→ requestFreshHistory) when
    // its ring has already evicted past our cursor.
    this.store.requestReplay = (sessionId, afterSeq) => {
      void this.send({ kind: "session.replay", sessionId, afterSeq });
    };
    // A brand-new session's first turn can finish naming/persisting it on the
    // node after the one-shot refresh in maybeFlushPendingPrompt already ran —
    // that race left it invisible in the sidebar until the next reconnect.
    // Re-pull the list once the turn actually settles as a self-healing backstop.
    // The turn settling is also the drain point for any queued follow-ups (see
    // drainFollowups) — sending the next one only once the current turn is
    // fully done, never mid-stream (that would silently steer instead of
    // queueing) — and a durable-enough signal to clear a "sending" item whose
    // own delivery ack (session.user_message) never arrived (settleSendingFollowups).
    this.store.onSessionSettled = () => {
      this.refreshSessions();
      const sid = this.store.getState().activeSession.activeSessionId;
      if (sid) {
        this.store.settleSendingFollowups(sid);
        this.followupCoordinator.drain(sid);
        void this.maybeTeardownFinishedEphemeral(sid);
      }
    };
    // Live convergence: refresh the moment the node tells us a session was
    // created (ours or another client's), instead of only on this session's
    // own eventual agent_end.
    this.store.onSessionCreatedElsewhere = () => this.refreshSessions();
    // Capture the session token / node from a sign-in redirect or QR link
    // (`…#<payload>`), then clean the URL. Must run before the direct/relay
    // decision, since a fresh sign-in sets store.s.
    try {
      if (consumeLinkPayload(this.local, location.hash)) {
        history.replaceState(null, "", location.pathname + location.search);
      }
    } catch {
      /* ignore malformed payload */
    }
    // Seed the next new session's composer defaults (repo/agent/model) from the
    // last ones used, so a fresh draft opens on the user's previous choices. The
    // node (its current node id) is already remembered via this.local.cur.
    this.seedDraftDefaults();
    this.detectGithubAppReturn();
    this.direct = isDirectMode(this.local);
    // Solo: not on the hosted CP (no session) but the QR left room-token creds
    // for the selected node. Distinct from `direct` (loopback) and hosted.
    this.solo = !this.direct && !this.local.s && Boolean(this.local.solo()[this.local.cur]);
    // The hosted client remembers this origin as its control plane.
    if (!this.direct && !this.local.cp) this.local.cp = location.origin;
    this.transport = this.buildTransport();
    this.store.setCurrentNode(this.direct ? null : this.local.cur || null);
    // Restore delete guards before painting the cached sidebar. A service-worker
    // update reload can otherwise forget an in-flight deletion and immediately
    // resurrect the stale cached/control-plane row.
    this.restoreDeletedSessionTombstones();
    // Instant sidebar: paint the last known session list for this node from a
    // synchronous localStorage cache before the socket connects and the
    // authoritative sessions.list arrives. Also start persisting live updates.
    this.seedSessionsFromCache();
    this.installSessionCachePersist();
    this.installFollowupAutoDrain();
    void this.restorePendingLaunches();
    if (!this.direct && this.local.s) void this.refreshAccountSessions();
    // Seed the reactive auth flag from the token we may have just consumed above,
    // so the very first render lands on the right surface (sign-in vs. shell).
    this.store.setSignedIn(this.signedIn);
    // Remember the route we booted on (a `/sessions/:id` deep link, `/sessions/new`,
    // or root). It's replayed once we're first online — see applyInitialRoute.
    this.pendingRoute = parseRoute();
    // A push-notification deep link lands as `/sessions/:id?node=<nodeId>`. Capture
    // the owning node so the initial open can switch to it first (cross-node), then
    // strip the param so it neither lingers in the address bar nor re-fires on reload.
    this.pendingRouteNode = this.consumeDeepLinkNode();
  }

  /**
   * Read and strip the `?node=` deep-link hint. A clicked push notification lands
   * on `/sessions/:id?node=<nodeId>`; the id drives the route while the node tells
   * us which node owns that session so a cross-node open can switch to it. Other
   * query params (e.g. `?local=1`, `bootstrap`) are preserved.
   */
  private consumeDeepLinkNode(): string | null {
    try {
      const params = new URLSearchParams(location.search);
      const node = (params.get("node") || "").trim();
      if (!node) return null;
      params.delete("node");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      return node;
    } catch {
      return null;
    }
  }

  private buildTransport(): Transport {
    const handlers = {
      onEvent: (event: ServerEvent) => {
        const type = String(event.type || "");
        // Settle any save() awaiting this reply (see awaitAck) before anything
        // else — harmless no-op when the requestId doesn't match a pending save
        // (e.g. a plain .get(), or an event from an unrelated flow that happens
        // to carry its own requestId).
        this.resolveAck(event);
        if (type === "pong") {
          const rid = String(event.requestId || "");
          if (rid) this.pendingLivenessPings.delete(rid);
          return;
        }
        // The node confirms a session-scoped "always allow" by echoing the
        // remembered key; say so once, then let the card unmount as usual.
        if (type === "approval.resolved" && typeof event.remembered === "string" && event.remembered) {
          this.store.setNotice(`Allowing “${event.remembered}” without asking for the rest of this session.`);
        }
        // Terminal I/O is high-frequency and self-contained — route it straight
        // to the terminal view instead of churning the session reducer. The few
        // lifecycle/list events also update the shared store so live `bivy run`
        // sessions appear in the main sidebar even when the overlay is closed.
        // Those five go through eventWithNodeScope first (tag/merge by node,
        // same as sessions.list) so switching nodes doesn't drop another node's
        // terminals from the sidebar (issue #99); terminalListeners still get
        // the raw event — they key off termId, not node.
        if (type.startsWith("terminal.") || type.startsWith("multiplexer.")) {
          if (["terminal.list", "terminal.created", "terminal.activity", "terminal.closed", "terminal.exit"].includes(type)) {
            this.store.apply(this.eventWithNodeScope(event));
          } else if (type === "terminal.tui") {
            // Composer single-writer lock — keyed by (raw) session id, so no node
            // scoping needed; the store folds it into `tuiSessions`.
            this.store.apply(event);
          } else if (type === "terminal.takeover.result") {
            // "Continue as chat" can be fired from the Terminal overlay OR from
            // the run-terminal handoff screen (TuiLockedView) before any PTY is
            // attached. Handle it here so the handoff path still switches to the
            // new governed session when the node acks — the overlay path also
            // listens and closes itself.
            const p = event as { ok?: boolean; sessionId?: string; error?: string };
            if (p.ok && p.sessionId) {
              this.openSession(String(p.sessionId));
            } else if (p.error) {
              this.store.setError(String(p.error));
            }
          }
          for (const fn of this.terminalListeners) fn(event);
          return;
        }
        // Content-free control-plane hint delivered over the existing relay.
        // Keep it out of the Session reducer; feature subscribers refetch the
        // canonical account-scoped Run and polling remains their recovery path.
        if (type === "run.updated") {
          const runId = typeof event.runId === "string" ? event.runId : "";
          const revision = typeof event.revision === "string" ? event.revision : undefined;
          if (runId) for (const listener of this.runUpdateListeners) listener(runId, revision);
          return;
        }
        // One-shot transcription result — resolve the awaiting caller and stop;
        // it never touches the session reducer.
        if (type === "transcription") {
          this.resolveTranscription(event);
          return;
        }
        if (type === "speech.audio") {
          this.resolveSpeech(event);
          return;
        }
        // Fork/promotion request correlation belongs to the session workflow.
        if (this.sessionCoordinator.handleEvent(event)) return;
        const before = this.store.getState();
        const appliedEvent = this.eventWithNodeScope(event);
        this.store.apply(appliedEvent);
        const activeAfter = this.store.getState().activeSession;
        if (
          activeAfter.activeSessionId &&
          !before.activeSession.transcript.some((entry) => entry.role === "assistant" && Boolean(entry.text) && !entry.tool) &&
          activeAfter.transcript.some((entry) => entry.role === "assistant" && Boolean(entry.text) && !entry.tool)
        ) {
          this.store.markLaunchFirstResponse(activeAfter.activeSessionId);
        }
        this.observeActivationMilestones(before, appliedEvent);
        if (appliedEvent.type === "credentials.records") void this.maybeGrantManagedCredential();
        if (appliedEvent.type === "session.deleted") this.persistDeletedSessionTombstones();
        this.maybeFlushPendingPrompt(appliedEvent);
        this.followupCoordinator.confirm(appliedEvent);
        this.maybeRestoreDraftAgent(appliedEvent);
        this.maybeRefreshModelsForRuntime(appliedEvent);
        this.reconcileSessionList(appliedEvent);
      },
      onStatus: (status: ConnectionStatus) => {
        const before = this.store.getState();
        const prev = before.connection.status;
        this.store.setStatus(status);
        this.observeActivationMilestones(before, { type: "connection.status" });
        if (status === "online" && prev !== "online") {
          this.onReconnected();
        } else if (status === "reconnecting" || status === "offline") {
          this.store.markStreamInterrupted();
          // Re-pull the node list on the *transition* into a dropped state so the
          // header's online dot reflects the node's real presence instead of a
          // stale green left over from connect time — the "node seems online but
          // stuck reconnecting" confusion. Throttled so the reconnect backoff
          // loop can't hammer /nodes.
          if (prev !== "reconnecting" && prev !== "offline") this.refreshNodesThrottled();
        }
      },
      onError: (message: string) => {
        this.store.setError(message);
      },
    };
    return this.direct
      ? new DirectTransport({ bootstrap: new URLSearchParams(location.search).get("bootstrap") || "", handlers })
      : new RelayTransport({ store: this.local, handlers });
  }

  private productMetricClient(): "desktop" | "mobile" {
    return matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop";
  }

  /** Emit a content-free milestone. Once-only events are persisted only after
   *  the authenticated endpoint accepts them, so an offline attempt can retry. */
  recordProductMilestone(event: ProductMetricEvent, once = false): void {
    if (this.direct || this.solo || !this.local.s) return;
    const key = `bivy.product-metric.${event}`;
    if (once) {
      try { if (localStorage.getItem(key) === "1") return; } catch { /* best effort */ }
      if (this.productMetricsInFlight.has(event)) return;
      this.productMetricsInFlight.add(event);
    }
    void recordProductMetric(this.local, event, this.productMetricClient())
      .then(() => {
        if (once) {
          try { localStorage.setItem(key, "1"); } catch { /* best effort */ }
        }
      })
      .catch(() => {})
      .finally(() => this.productMetricsInFlight.delete(event));
  }

  /** One ok/failed product-metric pair per readiness-led first-run step,
   *  keyed by the activation check it tracks. `agent_answered` and
   *  `account_signed_in` are excluded: the former already has its own
   *  dedicated `first_useful_response` milestone below, and the latter is
   *  always resolved by the time this model runs (see activation.ts) so a
   *  transition into it is never observed. */
  private static readonly FIRST_RUN_STEP_EVENTS: Partial<Record<ActivationCheckId, { ok: ProductMetricEvent; failed: ProductMetricEvent }>> = {
    machine_online: { ok: "first_run_machine_ready", failed: "first_run_machine_failed" },
    agent_installed: { ok: "first_run_agent_verified", failed: "first_run_agent_failed" },
    credential_valid: { ok: "first_run_provider_connected", failed: "first_run_provider_failed" },
  };

  /** Observe only concrete state transitions. History snapshots are excluded
   *  from first response: opening an old Session must not look like activation. */
  private observeActivationMilestones(before: ReturnType<SessionStore["getState"]>, event: { type?: unknown }): void {
    const after = this.store.getState();
    const activationInput = (state: ReturnType<SessionStore["getState"]>) => ({
      direct: this.direct,
      signedIn: state.connection.signedIn,
      status: state.connection.status,
      runtimes: state.catalogs.runtimes,
      providers: state.catalogs.providers,
      reposAuthed: state.catalogs.reposAuthed,
      transcript: state.activeSession.transcript,
    });
    const beforeActivation = activationFromState(activationInput(before));
    const afterActivation = activationFromState(activationInput(after));
    // Every check but the final agent-answered one — robust to the chain
    // growing (e.g. the leading sign-in step) without re-deriving the cutoff.
    const readyBefore = beforeActivation.checks.slice(0, -1).every((check) => check.state === "passed");
    const readyAfter = afterActivation.checks.slice(0, -1).every((check) => check.state === "passed");
    if (!readyBefore && readyAfter) this.recordProductMilestone("activation_ready", true);

    for (const [id, events] of Object.entries(AppController.FIRST_RUN_STEP_EVENTS) as Array<[ActivationCheckId, { ok: ProductMetricEvent; failed: ProductMetricEvent }]>) {
      const b = beforeActivation.checks.find((c) => c.id === id)?.state;
      const a = afterActivation.checks.find((c) => c.id === id)?.state;
      if (b !== "passed" && a === "passed") this.recordProductMilestone(events.ok, true);
      if (b !== "failed" && a === "failed") this.recordProductMilestone(events.failed, true);
    }

    if (event.type === "session.history") return;
    const assistantCount = (state: typeof after) => state.activeSession.transcript.filter((entry) => entry.role === "assistant" && Boolean(entry.text) && !entry.tool).length;
    if (assistantCount(before) === 0 && assistantCount(after) > 0) {
      markFirstSuccessfulResponse();
      this.recordProductMilestone("first_useful_response", true);
    }
  }

  /** Hosted control plane, not signed in yet. */
  needsAuth(): boolean {
    return this.connectionRequirement().type === "authentication-required";
  }

  /** Signed in on the hosted control plane, but no node picked yet. */
  needsNode(): boolean {
    return this.connectionRequirement().type === "node-required";
  }

  /** True whenever the hosted client can't reach a node yet (auth or node). */
  needsSetup(): boolean {
    return this.connectionRequirement().type !== "ready";
  }

  private connectionRequirement() {
    return this.nodeCoordinator.requirement({
      direct: this.direct,
      solo: this.solo,
      signedIn: Boolean(this.local.s),
      currentNodeId: this.local.cur || null,
    });
  }

  /** List the nodes enrolled on the signed-in account. */
  listNodes(): Promise<AccountNode[]> {
    return fetchAccountNodes(this.local);
  }

  centralGithubApp() { return fetchCentralGithubApp(this.local); }
  createCentralGithubInstall(returnPath = "/") { return createCentralGithubInstall(this.local, returnPath); }
  managedAutomationTarget() { return ensureManagedAutomationTarget(this.local); }
  async createManagedAuthRunner() {
    const launch = await createManagedAuthRunner(this.local);
    if (launch.machine.nodeId) {
      await this.ephemeralMachines.add(launch.machine);
      this.managedAuthRunnerNodes.add(launch.machine.nodeId);
      this.switchNode(launch.machine.nodeId);
    }
    return launch;
  }

  async managedCredentialReady(): Promise<boolean> {
    return (await managedCredentialStatus(this.local)).ready;
  }

  async waitForManagedCredential(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await managedCredentialStatus(this.local)).ready) return;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error("The encrypted Bivy Cloud credential was not published. Try provider setup again.");
  }

  async setupManagedCredentials(): Promise<void> {
    const activeId = this.store.getState().activeSession.activeSessionId;
    if (activeId && this.pendingLaunches.has(activeId)) this.managedCredentialReturnSessionId = activeId;
    // Leave the failed session route before switching Machines. Otherwise the
    // route synchronizer immediately reopens that session on its owning node and
    // silently undoes the auth-runner switch, making the button appear inert.
    navigate({ kind: "new" });
    await this.createManagedAuthRunner();
    await this.waitForOnline(120_000);
    this.listProviders();
    this.listCredentialRecords();
  }
  ensureManagedSessionDefaults() { return ensureManagedSessionDefaults(this.local); }
  createNodeClaim() { return createAccountNodeClaim(this.local); }
  listNodeClaims() { return fetchAccountNodeClaims(this.local); }
  revokeNodeClaim(id: string) { return revokeAccountNodeClaim(this.local, id); }

  /** Pick a node and connect to it over the relay (initial selection). */
  selectNode(nodeId: string): void {
    this.switchNode(nodeId);
  }

  get signedIn(): boolean {
    return Boolean(this.local.s);
  }

  /**
   * Finish a sign-in that completed *in-app* — the installed-PWA device flow,
   * where the app opened the OAuth tab itself and polled for the session token.
   * Persist the token, flip the reactive auth flag so the app shell renders in
   * place, and dial the node.
   *
   * This replaces a bare `location.reload()`. An installed PWA returning from
   * the OAuth hand-off does not reliably honor that reload: the token was
   * written to localStorage (so a manual close+reopen worked), but the window
   * stayed on the sign-in screen because the auth gate isn't something React can
   * observe in storage. Driving the transition through the reactive store makes
   * it happen the moment the poll completes, with no navigation required.
   */
  completeSignIn(token: string): void {
    if (!token) return;
    this.local.s = token;
    if (!this.local.cp) this.local.cp = location.origin;
    // A solo (account-free QR) pairing signing in mid-session: `solo` and the
    // room-token transport were fixed at construction, so flipping the reactive
    // flag alone would leave a half-account client (hidden NodeSwitcher, stale
    // transport). The token is already persisted — reload to rebuild cleanly as
    // a signed-in hosted client.
    if (this.solo) {
      location.reload();
      return;
    }
    this.store.setSignedIn(true);
    // Reconcile the device vault once on sign-in: a producer device satisfies any
    // pending wrapped-key requests from the account's other devices; a consumer
    // device pulls its wrapped key so a synced token is ready to wake a machine.
    void this.syncDeviceVault().catch(() => { /* durable sync state exposes retry */ });
    this.connect();
  }

  connect(): void {
    this.nodeCoordinator.connect();
  }

  private foregroundTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  /** requestIds for explicit liveness pings awaiting their matching pong. */
  private pendingLivenessPings = new Set<string>();

  /**
   * Register document/window lifecycle listeners so the client re-syncs when the
   * tab returns to the foreground. Call once at startup. Mobile Safari can
   * suspend and silently resume the WebSocket without ever firing a close (so no
   * status cycle, so onReconnected never runs) — a session created while
   * backgrounded (here, the CLI/TUI, or another device) would otherwise stay
   * invisible until the next manual action. Mirrors legacy refreshAfterForeground.
   */
  installLifecycleHandlers(): void {
    if (typeof document === "undefined") return;
    const onForeground = (): void => this.refreshAfterForeground();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onForeground();
    });
    window.addEventListener("pageshow", onForeground);
    window.addEventListener("focus", onForeground);
    // Back/forward navigation between sessions: sync the app to the URL the user
    // landed on, without writing history back (the browser already did).
    window.addEventListener("popstate", () => this.applyRoute(parseRoute(), { navigate: false }));
  }

  /** Subscribe to account Run changes pushed over the relay. The callback is a
   *  cache-invalidation hint only; callers must fetch durable state. */
  onRunUpdated(fn: (runId: string, revision?: string) => void): () => void {
    this.runUpdateListeners.add(fn);
    return () => this.runUpdateListeners.delete(fn);
  }

  /** Subscribe to composer-focus requests (the Composer wires its textarea here).
   *  Returns an unsubscribe fn. */
  onComposerFocus(fn: () => void): () => void {
    this.composerFocusListeners.add(fn);
    return () => this.composerFocusListeners.delete(fn);
  }

  /** Ask the composer to focus its input — fired when a new session is started
   *  so the user can type immediately. */
  focusComposer(): void {
    for (const fn of this.composerFocusListeners) fn();
  }

  /** Subscribe to contextual prompt drafts (for example, review a changed file). */
  onComposerPrefill(fn: (text: string) => void): () => void {
    this.composerPrefillListeners.add(fn);
    return () => this.composerPrefillListeners.delete(fn);
  }

  /** Put a contextual prompt in the composer without sending an agent turn. */
  prefillComposer(text: string): void {
    for (const fn of this.composerPrefillListeners) fn(text);
    this.focusComposer();
  }

  /** Subscribe to slash-menu-open requests (the Composer wires its "/" popover
   *  here). Returns an unsubscribe fn. */
  onOpenSlash(fn: () => void): () => void {
    this.slashOpenListeners.add(fn);
    return () => this.slashOpenListeners.delete(fn);
  }

  /**
   * The "/" pill: make the active session's slash commands available, then open
   * the composer's command menu. Commands are advertised per session and only
   * reach the store once the node has the session attached — so a closed
   * ("saved") session, which the node holds no live record for, surfaces nothing
   * until it's re-opened. Reattach it first (session.open re-emits the session's
   * capabilities → commandsBySession) so the menu can populate. A draft (no
   * session) keeps the selected runtime's static catalog; an idle session is
   * already attached, so there's nothing to initialize. Either way, ask the
   * composer to pop its menu — it reactively fills in as commands arrive.
   */
  openSlashCommands(): void {
    const s = this.store.getState();
    const sid = s.activeSession.activeSessionId;
    if (sid) {
      const row = s.sessionIndex.sessions.find((r) => r.sessionId === sid);
      if (row?.status === "saved") this.openSession(sid);
    } else {
      // A draft has no attached session, so its runtime may not have advertised
      // its commands yet. Warming the selected runtime (the node stands up a
      // model-query scratch session and re-broadcasts its capabilities) folds any
      // agent-advertised commands onto the runtime row, which the composer offers
      // as the draft's command set. The menu renders reactively, so it fills in as
      // they arrive. (Agents that only learn their commands on the first turn — e.g.
      // Claude Code — still surface them once a turn has run.)
      this.listModels();
    }
    for (const fn of this.slashOpenListeners) fn();
  }

  /**
   * Drive the app to a Route. Used for the initial deep link and for
   * back/forward (popstate). `navigate` is false for those since the URL is
   * already where it should be — openSession/newSession would otherwise no-op on
   * the URL anyway (navigate() guards identical paths), but skipping it keeps
   * intent explicit. Root and the draft route both land on a fresh draft.
   *
   * A `settings` route is deliberately a no-op here: Settings is an overlay
   * rendered on top of whatever session is already open (see settingsRoute.ts),
   * not a route that replaces it — landing on `/settings/:view` (a deep link,
   * reload, or Back/Forward past it) must never reset the active session to a
   * new draft.
   */
  private applyRoute(route: Route, opts: { navigate?: boolean } = {}): void {
    if (route.kind === "session") this.openSession(route.id, undefined, opts);
    // Settings, Automations, and a Run detail (/runs/:runId) are overlays layered
    // on top of whichever session is open behind them — none should reset the
    // active session to a draft, so a deep link / reload / Back onto them keeps
    // the underlying session intact.
    else if (route.kind !== "settings" && route.kind !== "automations" && route.kind !== "run") this.newSession(opts);
  }

  /** Replay the boot route once we're first online (session.open et al. need a
   *  live transport). A no-op after it runs once. */
  private applyInitialRoute(): void {
    const route = this.pendingRoute;
    if (!route) return;
    this.pendingRoute = null;
    const node = this.pendingRouteNode;
    this.pendingRouteNode = null;
    // Root boots into the app's default draft state already — nothing to open,
    // and re-running newSession() would needlessly reset the composer. Only a
    // real deep link (a specific session) needs an explicit open.
    if (route.kind !== "session") return;
    // A notification deep link may name a session on a *different* node than the
    // one currently selected; route it through the cross-node open so we switch
    // nodes first (openSessionOnNode falls back to a plain open when the node is
    // already current or unknown / in direct mode).
    if (node) this.openSessionOnNode(route.id, undefined, node);
    else this.applyRoute(route, { navigate: false });
  }

  /** Debounced foreground re-sync: reconnect if the socket died, otherwise
   *  re-pull the session list, the active session's history, and models. */
  refreshAfterForeground(): void {
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
    this.foregroundTimer = setTimeout(() => {
      this.foregroundTimer = null;
      if (this.needsSetup()) return;
      const status = this.store.getState().connection.status;
      // A dead socket → reconnect; the transport's onopen burst re-pulls the
      // session list, models and runtimes. A live socket → refresh explicitly,
      // since no reconnect (and thus no burst) will happen on its own.
      if (status === "offline") {
        this.connect();
        return;
      }
      if (status !== "online") return; // connecting / reconnecting already in flight
      this.refreshSessions();
      const sid = this.store.getState().activeSession.activeSessionId;
      if (sid) this.requestHistory(sid);
      // A session.new whose reply was lost while backgrounded leaves activeSessionId
      // null (no sid above to refresh) and pendingPrompt outstanding. Re-fire it so
      // the wedged "creating" view recovers even when the socket stayed live.
      else this.retryPendingSessionNew();
      this.listModels();
      // The refresh above just went out over a socket we only *believe* is live.
      this.verifyLiveness();
    }, 150);
  }

  /** How long a foregrounded, "online" client waits for an explicit ping/pong
   *  before deciding the socket is a zombie and forcing a reconnect. */
  private static readonly LIVENESS_TIMEOUT_MS = 2000;

  /**
   * Confirm the "online" socket is really alive after a foreground re-sync.
   *
   * iOS can resume a backgrounded PWA's WebSocket without ever firing `onclose`:
   * the client stays "online", the composer stays enabled, but every send drops
   * into a dead pipe and no events come back — so a turn shows a stuck "working"
   * spinner and messages silently fail to send until a manual app restart. The
   * foreground refresh (refreshAfterForeground) sends an explicit ping over the
   * command path; if the matching pong does not arrive promptly over the event
   * socket, treat the socket as dead and reconnect — the same recovery a manual
   * restart gives, done automatically.
   */
  private verifyLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.pendingLivenessPings.clear();
    const rid = requestId();
    this.pendingLivenessPings.add(rid);
    this.send({ kind: "ping", requestId: rid });
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      // A reconnect already in flight (status cycled) needs no nudge, and only
      // the matching pong proves the command path and event socket are live.
      if (this.store.getState().connection.status !== "online") return;
      if (!this.pendingLivenessPings.delete(rid)) return;
      this.transport.reconnect();
    }, AppController.LIVENESS_TIMEOUT_MS);
  }

  /** Pull the account node list into the store (for the header switcher). */
  async refreshNodes(): Promise<void> {
    if (this.direct || !this.signedIn) return;
    this.lastNodeRefreshAt = Date.now();
    try {
      const nodes = await this.listNodes();
      this.store.setNodes(nodes);
      // A persisted current node the account no longer has — removed, or a
      // never-completed enrollment left behind by a sign-in/QR link — can never
      // be reached: the relay dials it forever and eventually surfaces the node's
      // "Forbidden" pairing rejection while the header spins on a raw node id.
      // Drop the stale selection so the app falls back to the graceful "No runner
      // connected" empty state instead. Guarded to a successfully fetched list
      // (the catch below leaves a transient fetch failure alone); an enrolled but
      // merely offline node still appears in the list, so this only clears nodes
      // that are genuinely gone.
      if (this.local.cur && !nodes.some((n) => n.id === this.local.cur)) {
        // A torn-down destroy-lane node is gone from the registry, but if it's
        // REBUILDABLE (durable correlation + the room key we still hold) we keep it
        // selected — offline, not dialing — so its session stays open and a send
        // rebuilds it (Gap 1). Only a genuinely-gone node falls back to the empty
        // state.
        if (this.currentNodeIsRebuildable()) this.markCurrentNodeAwaitingRebuild();
        else this.clearCurrentNode();
      }
      void this.refreshAccountSessions();
    } catch {
      /* non-fatal; header just shows the current node */
    }
  }

  /**
   * Drop the current node selection and stop dialing it. Returns the hosted app
   * to the "connect a node" empty state (needsNode) instead of spinning forever
   * on a node that isn't there. Closes the transport so the relay reconnect loop
   * halts, clears the persisted id, and resets the session pane.
   */
  private clearCurrentNode(): void {
    try {
      this.transport.close();
    } catch {
      /* noop */
    }
    this.local.cur = "";
    this.store.setCurrentNode(null);
    this.store.resetSession();
    this.store.setStatus("offline");
  }

  /** True when the current node is gone from the registry but this device can
   *  rebuild it: a durable session↔machine correlation names it and we still hold
   *  its room key. Distinguishes a torn-down-but-rebuildable node from one that is
   *  genuinely gone (which should clear to the empty state). */
  private currentNodeIsRebuildable(): boolean {
    const nodeId = this.local.cur;
    if (!nodeId) return false;
    try {
      if (!this.local.keys()[nodeId]) return false;
    } catch {
      return false;
    }
    return this.ephemeralCorrelations.some((c) => c.nodeId === nodeId);
  }

  /** Keep a torn-down-but-rebuildable node SELECTED without dialing it: stop the
   *  transport (so the header doesn't spin forever on a gone node / a Forbidden
   *  pairing reject), but retain `local.cur` + the session pane so the composer
   *  stays enabled (isCurrentNodeResumable) and a send fires reprovisionEphemeral.
   *  Idempotent — a repeated refreshNodes while offline just no-ops. */
  private markCurrentNodeAwaitingRebuild(): void {
    if (this.store.getState().connection.status === "offline") return; // already parked
    try {
      this.transport.close();
    } catch {
      /* noop */
    }
    this.store.setStatus("offline");
  }

  private lastNodeRefreshAt = 0;

  /** Re-pull /nodes at most once every 10s. Used on a connection drop so the
   *  header online dot converges to the node's real state without the reconnect
   *  backoff loop turning into a /nodes request storm. */
  private refreshNodesThrottled(): void {
    if (this.direct || !this.signedIn) return;
    if (Date.now() - this.lastNodeRefreshAt < 10_000) return;
    void this.refreshNodes();
  }

  /**
   * Pick a saved ephemeral runner as the target for the next new session. No
   * machine is created and nothing on the current pane is torn down — the draft
   * simply remembers this runner, and the first `sendPrompt` launches it and
   * binds the session (see `launchDraftRunnerAndBind`). Selecting an actual node
   * (switchNode) clears this.
   */
  pickDraftEphemeralRunner(config: EphemeralNodeConfig): void {
    this.store.setDraftEphemeralConfig(config);
  }

  /** Switch to another node without a full reload. Selecting a concrete node
   *  also withdraws any Cloud profile previously targeted by the unsent draft. */
  switchNode(nodeId: string): void {
    this.store.setDraftEphemeralConfig(null);
    this.nodeCoordinator.switchNode(nodeId);
  }

  /** Switch to a node, await online, and refresh its provider catalog. */
  connectToNode(nodeId: string, timeoutMs?: number): Promise<void> {
    return this.nodeCoordinator.connectToNode(nodeId, timeoutMs);
  }

  /** Sign out: revoke the session server-side (and free this device's slot),
   *  then clear local state and return to the sign-in screen. */
  async signOut(): Promise<void> {
    try {
      this.transport.close();
    } catch {
      /* noop */
    }
    // Best effort before we wipe the token locally: revoke the account session
    // and drop this device's pairing so the account's device count reflects it.
    try {
      await logout(this.local, this.local.device()?.pub);
    } catch {
      /* offline / already gone — clear locally regardless */
    }
    this.local.clear();
    this.store.setSignedIn(false);
    // Return to the root shell rather than reloading into a `/sessions/:id` deep
    // link we can no longer open (and to drop any stale query/hash).
    location.assign("/");
  }

  /** List the account's paired devices (device manager). */
  listDevices(): Promise<PairedDevice[]> {
    return fetchPairedDevices(this.local);
  }

  /** True for the device this client itself is signed in on. */
  isCurrentDevice(deviceId: string): boolean {
    return Boolean(deviceId) && this.local.device()?.pub === deviceId;
  }

  /** Remove (sign out) a paired device, freeing its slot. */
  removeDevice(deviceId: string): Promise<void> {
    return removePairedDevice(this.local, deviceId);
  }

  private send(command: Command): void {
    this.sessionCoordinator.send(command);
  }

  /** Trigger `bivy update` on the connected node from the version-mismatch
   *  banner. Optimistically marks the node updating so the button can't be
   *  double-tapped; on success the node restarts and the socket reconnects on
   *  the new build (the banner clears itself — see the store's node.update
   *  handler), and a start failure comes back as node.update.result. */
  updateNode(): void {
    if (this.store.getState().connection.nodeUpdating) return;
    this.store.setNodeUpdating(true);
    this.send({ kind: "node.update" });
  }

  /**
   * Send a command and await its correlated reply instead of assuming success
   * the moment it was handed to the transport. A handful of node-settings-style
   * saves (node.settings.set, provider.apiKey, models.custom.save,
   * stt.config.set) used to be fire-and-forget with no ack at all — the UI
   * showed "Saved" immediately regardless of whether the node accepted the
   * change (#140). The node now echoes our requestId back on both success and
   * failure (a `*.error`-suffixed type rejects; anything else resolves).
   */
  private awaitAck(command: Command, timeoutMs = 10000): Promise<ServerEvent> {
    const rid = requestId();
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(rid);
        reject(new Error("Timed out waiting for the machine to respond."));
      }, timeoutMs);
      this.pendingAcks.set(rid, { resolve, reject, timer });
      void this.transport.send({ ...command, requestId: rid });
    });
  }

  /**
   * Fetch a stored attachment's bytes by content hash, returning base64 data +
   * mime (or null if unavailable). Works over both transports: the relay replies
   * with base64 directly; the direct transport fetches the HTTP endpoint and
   * re-emits the same `attachment.data` shape (see transport-direct). Used by the
   * chat to rehydrate a thumbnail whose bytes aren't in the local cache — the
   * re-findable path after a reload or on another device.
   */
  fetchAttachment(hash: string): Promise<{ mimeType: string; data: string } | null> {
    if (!hash) return Promise.resolve(null);
    const existing = this.attachmentFetches.get(hash);
    if (existing) return existing;
    const p = (async () => {
      try {
        const ev = (await this.awaitAck({ kind: "attachment.fetch", hash }, 30000)) as { data?: unknown; mimeType?: unknown };
        if (ev && typeof ev.data === "string") return { mimeType: String(ev.mimeType || "application/octet-stream"), data: ev.data };
        this.attachmentFetches.delete(hash);
        return null;
      } catch {
        this.attachmentFetches.delete(hash); // allow a later retry
        return null;
      }
    })();
    this.attachmentFetches.set(hash, p);
    return p;
  }

  /** Resolve/reject an in-flight awaitAck() call from its matching reply. */
  private resolveAck(event: ServerEvent): void {
    const rid = String(event.requestId || "");
    const pending = rid ? this.pendingAcks.get(rid) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(rid);
    if (String(event.type || "").endsWith(".error")) {
      const error = new Error(String((event as { error?: unknown }).error || "Save failed"));
      // Preserve any extra fields the error event carried (e.g. session.import's
      // `needsDisclosure`/`disclosure`) so a caller that needs more than the
      // message can read them off the thrown Error.
      Object.assign(error, event);
      pending.reject(error);
    } else {
      pending.resolve(event);
    }
  }

  // --- Native session discovery/adoption (issue #156) -------------------------
  // "Browse, follow, and take over" provider-native sessions (a bare `claude` or
  // `codex` run outside Bivy) that the current node can see. Capability-driven:
  // the node decides per-runtime whether a session is discoverable/adoptable
  // (see src/runtime/native-session-discovery.ts) — this is just the transport.

  /** Every provider-native session the current node can discover, bounded
   *  metadata only (never transcript content). Throws on a transport/node error. */
  async discoverNativeSessions(): Promise<DiscoveredNativeSessionDto[]> {
    const event = await this.awaitAck({ kind: "session.discover" }, 20000);
    const sessions = (event as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as DiscoveredNativeSessionDto[]) : [];
  }

  /**
   * Import a discovered session into Bivy and switch the view to it. The node
   * re-validates the ref against a fresh discovery pass (so a stale/removed
   * session, or one with a live external process, is rejected server-side even
   * if this client's cached list is out of date).
   *
   * Two outcomes:
   *  - native resume (the common case for Claude Code / Codex): reopens
   *    through the ordinary path/id resume, same as clicking any saved
   *    session — the provider's own history is never touched.
   *  - seeded continuation (a runtime that can discover but not natively
   *    resume this session): the node refuses on the first call with a
   *    NeedsDisclosureError carrying the disclosure text — callers MUST show
   *    that to the user and only retry with `acceptDisclosure: true` on
   *    explicit confirmation (issue #156: never fall back to a seeded
   *    continuation silently). On acceptance a fresh session is created and
   *    its seed prompt is sent as the first turn, mirroring how a
   *    cross-runtime session fork seeds its first turn (see forkSession below).
   */
  async importNativeSession(runtimeId: string, ref: string, opts: { acceptDisclosure?: boolean } = {}): Promise<string> {
    let event: ServerEvent;
    try {
      event = await this.awaitAck({ kind: "session.import", runtimeId, ref, acceptDisclosure: opts.acceptDisclosure ?? false }, 60000);
    } catch (error) {
      const e = error as { needsDisclosure?: unknown; disclosure?: unknown; message?: unknown };
      if (e?.needsDisclosure) throw new NeedsDisclosureError(String(e.disclosure ?? e.message ?? "This import needs your confirmation."));
      throw error;
    }
    const sessionId = String((event as { sessionId?: unknown }).sessionId || "");
    if (!sessionId) throw new Error("Import did not return a session id");
    const seedPrompt = (event as { seedPrompt?: unknown }).seedPrompt;
    if (typeof seedPrompt === "string" && seedPrompt.trim()) {
      // Seeded continuation: a FRESH session with no native resume ref, so open
      // by id alone (never pass the old provider ref as a resume path here —
      // it isn't this new session's resume token) and seed its first turn the
      // same way forkSession does for a cross-runtime fork.
      this.openSession(sessionId);
      const cmid = clientMessageId();
      this.store.addUserMessage(seedPrompt, cmid);
      this.send({ kind: "prompt", sessionId, text: seedPrompt, clientMessageId: cmid });
    } else {
      this.openSession(sessionId, ref);
    }
    return sessionId;
  }

  // --- Session fork -------------------------------------------------------------
  // Continue a session in a new one on another node/agent/model. Client-mediated:
  // export the bundle from the source node, (optionally) switch to the
  // destination node, import it there, open the new session, seed it when the
  // fork was cross-runtime, and — for a "move" — retire the source only after the
  // import confirms, so a failed fork never loses the session.

  /** Resolve once the (current) transport reports online, else reject on timeout. */
  private waitForOnline(timeoutMs = 20000): Promise<void> {
    if (this.store.getState().connection.status === "online") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error("Destination machine did not come online")); }, timeoutMs);
      const unsub = this.store.subscribe(() => {
        if (this.store.getState().connection.status === "online") { clearTimeout(timer); unsub(); resolve(); }
      });
    });
  }

  /** Continue a replicated session on its standby node. */
  promoteSession(sessionId: string, standbyNodeId: string): Promise<{ epoch: number }> {
    return this.sessionCoordinator.promote(sessionId, standbyNodeId);
  }

  /** Fork/copy/move orchestration is owned by SessionOrchestrator. */
  forkSession(
    sourceSessionId: string,
    opts: { destNodeId?: string; managedConfigId?: string; agentId?: string; sourceAgentId?: string; model?: { provider: string; id: string }; retireSource?: boolean } = {},
  ): Promise<{ sessionId: string; fidelity: string; missing: Array<{ label?: string; detail?: string }> }> {
    return this.sessionCoordinator.fork(sourceSessionId, opts);
  }

  refreshSessions(): void {
    // Live `bivy run` PTYs have their own list endpoint/event. Pull it whenever
    // the sidebar refreshes durable sessions too, so a created event missed
    // during startup or a reconnect self-heals without reselecting the node.
    this.send({ kind: "terminal.list" });
    if (!this.direct && this.signedIn) {
      void this.refreshAccountSessions();
      // Also ask the connected node for its richer live rows; eventWithNodeScope
      // merges that node-scoped answer into the all-node list instead of letting
      // it become a global sidebar selector.
      if (this.local.cur) this.send({ kind: "sessions.list" });
      return;
    }
    this.send({ kind: "sessions.list" });
  }

  private async decryptSessionTitle(row: AccountSessionAdvert): Promise<string> {
    if (!row.titleEnc) return "Untitled session";
    const encodedKey = this.local.keys()[row.nodeId];
    if (!encodedKey) return "Untitled session";
    try {
      const key = await importRoomKey(unb64url(encodedKey));
      const name = await openSealed(key, row.titleEnc);
      return name.trim() || "Untitled session";
    } catch {
      return "Untitled session";
    }
  }

  private async refreshAccountSessions(): Promise<void> {
    if (this.direct || !this.signedIn) return;
    try {
      const rows = await fetchAccountSessions(this.local);
      const existing = this.store.getState().sessionIndex.sessions;
      const sessions = await Promise.all(rows.map(async (s) => {
        const sessionId = String(s.sessionId || s.id || "");
        const nodeId = String(s.nodeId || "");
        const previous = existing.find((row) => row.sessionId === sessionId && (!row.nodeId || row.nodeId === nodeId));
        const decryptedName = await this.decryptSessionTitle(s);
        return {
          ...previous,
          sessionId,
          nodeId,
          name: decryptedName === "Untitled session" ? previous?.name || decryptedName : decryptedName,
          source: s.source || previous?.source,
          branch: s.branch || previous?.branch,
          status: s.status,
          attention: Array.isArray(s.attention) ? s.attention : previous?.attention,
          updatedAt: s.updatedAt || previous?.updatedAt,
        };
      }));
      const live = sessions.filter((s) => s.sessionId && s.nodeId);
      // Gap 1 visibility: a torn-down destroy-lane session cascades out of the
      // control-plane session index when its node is unenrolled, so it would vanish
      // from the sidebar — with nothing to open and send into to trigger a rebuild.
      // Re-add it from the durable correlation (offline, rebuildable), keeping any
      // name/branch we cached before teardown.
      const liveIds = new Set(live.map((s) => s.sessionId));
      const previous = this.store.getState().sessionIndex.sessions;
      const ghosts = this.ephemeralCorrelations
        .filter((c) => !liveIds.has(c.sessionId) && !!this.local.keys()[c.nodeId])
        .map((c) => {
          const prior = previous.find((s) => s.sessionId === c.sessionId);
          return {
            ...prior,
            sessionId: c.sessionId,
            nodeId: c.nodeId,
            name: prior?.name || (c.repo ? `${c.repo}` : "Rebuildable session"),
            source: prior?.source,
            status: "saved" as const,
            rebuildable: true,
            updatedAt: prior?.updatedAt,
          };
        });
      this.store.setSessions([...live, ...ghosts]);
    } catch {
      // Best-effort; the connected node's E2E sessions.list still keeps the app usable.
    }
  }

  /**
   * Tag/merge a node-scoped event against the unified all-node lists the
   * sidebar renders, so a connected node's own (necessarily node-local)
   * answer never clobbers what we already know about other nodes:
   *  - `sessions.list` / `terminal.list`: merge the incoming, freshly-tagged
   *    rows with whatever other-node rows are already in the store.
   *  - `session.created` / `terminal.created`: tag the new row with the
   *    connected node so it sorts/filters correctly once merged.
   * Untouched otherwise (e.g. terminal.activity/closed/exit key off termId
   * alone and need no node tag to apply correctly across nodes).
   */
  private eventWithNodeScope(event: ServerEvent): ServerEvent {
    if (this.direct || !this.local.cur) return event;
    const currentNode = this.local.cur;
    if (event.type === "sessions.list") {
      const payload = event as unknown as { sessions?: unknown };
      const incoming = Array.isArray(payload.sessions) ? payload.sessions as Array<Record<string, unknown>> : [];
      const currentIds = new Set(incoming.map((s) => String(s?.sessionId || s?.id || "")).filter(Boolean));
      const others = this.store.getState().sessionIndex.sessions.filter((s) => s.nodeId && s.nodeId !== currentNode && !currentIds.has(s.sessionId));
      return { ...event, sessions: [...incoming.map((s) => ({ ...s, nodeId: s.nodeId || currentNode })), ...others] } as ServerEvent;
    }
    if (event.type === "session.created") {
      return { ...event, nodeId: currentNode } as ServerEvent;
    }
    if (event.type === "terminal.list") {
      const payload = event as unknown as { terminals?: unknown };
      const incoming = Array.isArray(payload.terminals) ? payload.terminals as Array<Record<string, unknown>> : [];
      const currentIds = new Set(incoming.map((t) => String(t?.termId || "")).filter(Boolean));
      const others = this.store.getState().sessionIndex.runTerminals.filter((t) => t.nodeId && t.nodeId !== currentNode && !currentIds.has(t.termId));
      return { ...event, terminals: [...incoming.map((t) => ({ ...t, nodeId: t.nodeId || currentNode })), ...others] } as ServerEvent;
    }
    if (event.type === "terminal.created") {
      const payload = event as unknown as { terminal?: Record<string, unknown> };
      if (!payload.terminal) return event;
      return { ...event, terminal: { ...payload.terminal, nodeId: payload.terminal.nodeId || currentNode } } as ServerEvent;
    }
    return event;
  }

  // --- Session-list cache (instant sidebar paint) ------------------------
  // The sidebar otherwise sits empty until the socket connects and the node
  // answers sessions.list — the slowest part of "becoming responsive" on a cold
  // load, especially over the relay. We cache the last list per node in
  // localStorage (small metadata; synchronous, so it seeds before first paint)
  // and reconcile against the live list the instant it lands.

  private static readonly DELETED_SESSIONS_KEY = "bivy.deleted-sessions";

  private restoreDeletedSessionTombstones(): void {
    try {
      const raw = localStorage.getItem(AppController.DELETED_SESSIONS_KEY);
      if (raw) this.store.seedDeletedSessionTombstones(JSON.parse(raw));
      this.persistDeletedSessionTombstones(); // also drops expired entries
    } catch {
      /* corrupt/unavailable localStorage — live reconciliation still works */
    }
  }

  private persistDeletedSessionTombstones(): void {
    try {
      const tombstones = this.store.deletedSessionTombstones();
      if (Object.keys(tombstones).length) {
        localStorage.setItem(AppController.DELETED_SESSIONS_KEY, JSON.stringify(tombstones));
      } else {
        localStorage.removeItem(AppController.DELETED_SESSIONS_KEY);
      }
    } catch {
      /* best-effort */
    }
  }

  /** localStorage key for the current node's cached list (per-node so switching
   *  nodes never shows the wrong node's sessions). */
  private sessionCacheKey(): string {
    const node = this.direct ? "direct" : this.local.cur || "";
    return `bivy.sessions.${node}`;
  }

  /** Seed the store from the current node's cached list (no-op if none / if a
   *  live list already exists — see store.seedSessions). */
  private seedSessionsFromCache(): void {
    if (!this.direct && !this.local.cur) return; // no node selected yet
    try {
      const raw = localStorage.getItem(this.sessionCacheKey());
      if (raw) this.store.seedSessions(JSON.parse(raw));
    } catch {
      /* corrupt/unavailable cache — fall through to the live list */
    }
  }

  /** Persist the session list whenever it changes. The store swaps in a new
   *  immutable state on every change, but the `sessions` array reference only
   *  changes when the list itself does, so this writes rarely. Empty lists are
   *  significant: deleting the final session must overwrite the old cache or a
   *  PWA reload paints that deleted row again. Node switches no longer clear the
   *  unified list, so there is no transient-empty case to protect here. */
  private installSessionCachePersist(): void {
    if (typeof localStorage === "undefined") return;
    let last = this.store.getState().sessionIndex.sessions;
    this.store.subscribe(() => {
      const sessions = this.store.getState().sessionIndex.sessions;
      if (sessions === last) return;
      last = sessions;
      try {
        // Cap the cached rows so a node with a very long history can't bloat
        // localStorage; the node's list is newest-first, so keep the head.
        localStorage.setItem(this.sessionCacheKey(), JSON.stringify(sessions.slice(0, 100)));
      } catch {
        /* quota / private mode — caching is best-effort */
      }
    });
  }

  /** Auto-send the next queued follow-up the instant the active session's turn
   *  ends — regardless of *how* it ended. `onSessionSettled` already drains on a
   *  live `agent_end`, but that event never arrives when a turn finishes while
   *  the socket is down: the reconnect reconciles `working` back to false from
   *  history, not from a fresh agent_end, so the queue would otherwise wedge
   *  until the user sends manually. Watching the `working` true→false edge on the
   *  active session covers every such path with one rule (and is a harmless
   *  no-op double when agent_end already drained). Deliberately only the *same*
   *  active session's edge — never a session-switch, since `beginOpen` paints
   *  `working:false` optimistically before history reconciles, which would risk
   *  firing a queued message into a background session that's actually mid-turn. */
  private installFollowupAutoDrain(): void {
    let wasWorking = this.store.getState().activeSession.working;
    let lastActive = this.store.getState().activeSession.activeSessionId;
    this.store.subscribe(() => {
      const active = this.store.getState().activeSession.activeSessionId;
      const working = this.store.getState().activeSession.working;
      const settledNow = active != null && active === lastActive && wasWorking && !working;
      wasWorking = working;
      lastActive = active;
      if (settledNow) this.followupCoordinator.drain(active);
    });
  }

  /**
   * Resolve the live `bivy run` PTY pinned to a session, if the owning node still
   * has one. A session the node advertises as `source: "cli"` + `status:
   * "working"` is a running terminal, so a tap on it must land on the run
   * handoff (open terminal / continue in chat), not on a chat resume that would
   * open a second writer over the live TUI. Run terminals only reach this client
   * from the connected node's terminal.list, so a row learned via the account
   * list may need a node switch first; the open burst's terminal.list answer
   * then arrives a beat after "online", hence the short wait. Resolves null when
   * the PTY is gone (the run ended — its saved session resumes as a normal chat).
   */
  async findLiveRunTerminal(sessionId: string, nodeId?: string, timeoutMs = 4000): Promise<RunTerminalSummary | null> {
    const find = () => this.store.getState().sessionIndex.runTerminals.find((t) => t.sessionId === sessionId && (!nodeId || !t.nodeId || t.nodeId === nodeId)) ?? null;
    const known = find();
    if (known) return known;
    const connected = this.direct || !nodeId || (nodeId === this.local.cur && this.store.getState().connection.status === "online");
    if (connected) {
      // Already on the owning node: its terminal list is current (open burst +
      // terminal.created pushes), so a miss means the PTY is gone.
      return null;
    }
    await this.connectToNode(nodeId);
    this.send({ kind: "terminal.list" });
    return new Promise<RunTerminalSummary | null>((resolve) => {
      const timer = setTimeout(() => { unsub(); resolve(find()); }, timeoutMs);
      const unsub = this.store.subscribe(() => {
        const hit = find();
        if (hit) { clearTimeout(timer); unsub(); resolve(hit); }
      });
    });
  }

  openSessionOnNode(sessionId: string, path?: string, nodeId?: string): void {
    if (this.pendingLaunches.has(sessionId)) {
      this.openPendingLaunch(sessionId);
      return;
    }
    if (!this.direct && nodeId && nodeId !== this.local.cur) {
      this.pendingCrossNodeOpen = { sessionId, path };
      navigate({ kind: "session", id: sessionId });
      this.switchNode(nodeId);
      // switchNode clears the previous node's active pane. Immediately mark the
      // selected existing session as opening again (the unified session list has
      // already been restored synchronously), so the cross-node reconnect wait
      // shows the transcript spinner rather than masquerading as a fresh draft.
      // onReconnected calls openSession and starts the actual history fetch.
      this.store.beginOpen(sessionId);
      return;
    }
    this.openSession(sessionId, path);
  }

  openSession(sessionId: string, path?: string, opts: { navigate?: boolean } = {}): void {
    if (this.pendingLaunches.has(sessionId)) {
      this.openPendingLaunch(sessionId, opts);
      return;
    }
    // Reflect the open session in the URL (/sessions/:id) so it's copyable and
    // survives a reload. Skipped when the change *came from* the URL (initial
    // deep link / popstate); navigate() also no-ops on an identical path.
    if (opts.navigate !== false) navigate({ kind: "session", id: sessionId });
    // Paint cached history immediately so switching feels instant; the
    // session.open/history round-trip then reconciles to the canonical
    // transcript. Without this the previous session's messages linger (or the
    // pane blanks) until the network answers.
    this.store.beginOpen(sessionId);
    this.send({ kind: "session.open", sessionId, path });
    // beginOpen deliberately clears the New-session draft model. Resolve the
    // opened session's actual model in session scope immediately, rather than
    // leaving the draft selection in the shared composer (or waiting for the
    // user to open the model picker to trigger a refresh).
    this.listModels();
    // Seed from the persistent cache first (paints even before the node answers),
    // then request history with the cursor so the node sends only the new tail.
    void this.seedAndRequestHistory(sessionId);
  }

  /** Preload the persisted transcript, then request history echoing its cursor. */
  private async seedAndRequestHistory(sessionId: string): Promise<void> {
    try {
      const cached = await this.transcriptCache.get(sessionId);
      // A slow disk read must not clobber a session the user already switched away from.
      if (cached && this.store.getState().activeSession.activeSessionId === sessionId) {
        // Restore real attachment bytes before seeding, so the seeded transcript
        // shows them instead of the node's plain-text placeholder.
        this.store.restoreAttachments(cached.attachments);
        this.store.seedHistory(sessionId, cached.messages, cached.count, cached.historyHash);
      }
    } catch {
      /* cache miss / unavailable — fall through to a full history request */
    }
    this.requestHistory(sessionId);
  }

  /**
   * The connection just came back. Reconcile the open session: re-request its
   * history (via the append cursor, so only the tail it missed comes down) so a
   * turn that streamed during the outage appears and any stuck "working" clears.
   */
  private onReconnected(): void {
    this.send({ kind: "activation.readiness" });
    let openedAfterNodeSwitch = false;
    if (this.pendingCrossNodeOpen) {
      const pending = this.pendingCrossNodeOpen;
      this.pendingCrossNodeOpen = null;
      this.openSession(pending.sessionId, pending.path);
      openedAfterNodeSwitch = true;
    }
    void this.refreshAccountSessions();
    // Converge account API keys in both directions. This also handles the
    // node-less-first flow: keys added in the PWA are installed when the user's
    // first persistent or ephemeral node appears.
    void this.syncAccountCredentialsWithNode();
    // A scheduled message may have delivered while this device was offline —
    // drop its queue row so it stops showing as "scheduled" (see the method doc).
    void this.resyncScheduledFollowups();
    // If this is a machine we just launched, seed its vault with the model API
    // keys held on this device (closes the cold-start gap — see the method doc).
    void this.seedEphemeralNodeIfNeeded();
    // First-run subscription-OAuth: a launched runner that ends up with no model
    // credentials at all (nothing seeded, no peer vault, no hosted escrow) needs
    // the user to sign in once. See the method doc.
    void this.maybePromptFirstRunModelAuth();
    // Pull durable session↔machine correlations so a torn-down session stays
    // rebuildable (Gap 1); then record one for the machine we're on, if owned.
    void this.refreshEphemeralCorrelations();
    // Replay a `/sessions/:id` deep link now that a live transport exists — must
    // run before the requestHistory below so the session it opens is the one we
    // refresh. A cross-node selection was already opened just above.
    if (!openedAfterNodeSwitch) this.applyInitialRoute();
    const sid = this.store.getState().activeSession.activeSessionId;
    if (sid && !openedAfterNodeSwitch) {
      this.requestHistory(sid);
      this.followupCoordinator.retrySending(sid);
      // Deliver anything the user typed while the node was offline/resuming.
      this.drainPendingResume(sid);
    }
    // No active session but a session.new is still pending → its session.history
    // was lost to the drop. Re-fire it (idempotent on the node by requestId) so the
    // draft that wedged on the opening spinner finally binds and flushes its prompt.
    else if (!sid) this.retryPendingSessionNew();
    // A GitHub App redirect reloads the whole SPA, so finish the flow as soon as
    // we're reconnected to the node (which alone can exchange the code).
    if (this.pendingGithubAppCode) {
      const { code, state } = this.pendingGithubAppCode;
      this.pendingGithubAppCode = null;
      this.githubAppManifestCode(code, state);
    }
  }

  /**
   * On boot, recognise a redirect back from GitHub's App-manifest flow
   * (`/?bivy_github_app=1&code=…&state=…`). We stash the one-time code, mark the
   * flow as returning (so the UI re-opens the panel), and clean the URL; the
   * code is relayed to the node once connected. Works the same whether the
   * browser is same-origin with the node or on the hosted control plane.
   */
  private detectGithubAppReturn(): void {
    try {
      const params = new URLSearchParams(location.search);
      let pending = false;
      try {
        pending = sessionStorage.getItem("bivy.githubAppPending") === "1";
        if (pending) sessionStorage.removeItem("bivy.githubAppPending");
      } catch {
        /* ignore */
      }
      // Recognise the return either by our query marker or by the flag we set
      // just before navigating to GitHub (in case GitHub drops the marker).
      if (!params.has("bivy_github_app") && !pending) return;
      const code = (params.get("code") || "").trim();
      const state = (params.get("state") || "").trim();
      // Strip our params but preserve anything else (e.g. ?local=1, bootstrap).
      params.delete("bivy_github_app");
      params.delete("code");
      params.delete("state");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      if (code && state) {
        this.pendingGithubAppCode = { code, state };
        this.store.setGithubAppPhase("completing", { returning: true, state });
      } else {
        this.store.setGithubAppPhase("error", { returning: true, error: "GitHub did not return a code." });
      }
    } catch {
      /* ignore malformed URL */
    }
  }

  /** Request canonical history, echoing the append cursor we hold for the session. */
  private requestHistory(sessionId: string): void {
    const cursor = this.store.getHistoryCursor(sessionId);
    this.send({ kind: "history", sessionId, ...cursor });
  }

  /** Draft repo/branch/agent/model to thread into the next session.new. */
  private draftSessionFields(): Record<string, unknown> {
    const s = this.store.getState();
    // Model catalogs and their `configured` flags belong to the connected
    // Machine. A Cloud/ephemeral draft targets a different, not-yet-booted
    // Machine, so forwarding the current Machine's model selection can make an
    // otherwise healthy launch fail with "Model is not available on this
    // node." Let the destination runtime choose its credential-backed default;
    // its own catalog becomes authoritative once it connects.
    const model = !s.draft.ephemeralConfig && s.catalogs.currentModel
      ? { provider: (s.catalogs.currentModel as any).provider, id: s.catalogs.currentModel.id }
      : undefined;
    return {
      repo: s.draft.repo || undefined,
      // Only meaningful alongside `repo` — a branch is only ever set together
      // with its repo (chooseRepoBranch) and reset when the repo changes
      // (chooseRepo), so this can never leak onto an unrelated repo/workspace.
      branch: s.draft.repo ? s.draft.branch || undefined : undefined,
      agent: s.catalogs.selectedAgentId || undefined,
      sandbox: s.draft.sandbox || undefined,
      acknowledgeReducedProtections: s.draft.acknowledgeReducedProtections || undefined,
      model,
    };
  }

  /** Node settings (Settings → Nodes) for the currently-connected node. */
  getNodeSettings(): void {
    this.send({ kind: "node.settings.get" });
  }
  /** Save node settings and resolve once the node acks the change (or reject
   *  with its error) instead of assuming success the moment it was sent. */
  setNodeSettings(patch: Record<string, unknown>): Promise<void> {
    return this.awaitAck({ kind: "node.settings.set", settings: patch }).then(() => undefined);
  }

  /** Sandbox tier for the next new session (null = use the node default). */
  setSessionSandbox(tier: import("@bivy/core").SandboxTier | null): void {
    this.store.setDraftSandbox(tier);
  }

  /** Record the confirm-to-continue acknowledgement for the currently selected
   *  agent's Effective Session Contract preview (see AgentPicker) so the next
   *  session.new carries it — the node re-checks server-side and would
   *  otherwise reject a "supported" profile whose live protection is degraded. */
  acknowledgeSessionAgentReducedProtections(value: boolean): void {
    this.store.setDraftAcknowledgeReducedProtections(value);
  }

  /**
   * Start a new session as a pure local draft. Nothing is created on the node
   * yet — the user can still change node/agent/model/repo — and the real
   * session (bound to those choices) is created lazily by the first sendPrompt.
   */
  newSession(opts: { navigate?: boolean } = {}): void {
    this.sessionCoordinator.newSession(opts);
  }

  /** Load the remembered composer defaults into the store so the next fresh
   *  draft resolves to them. Repo is a plain draft value; the model is a
   *  preference the models.list reducer honors while no session is active. The
   *  last-used *agent* is restored on the next runtimes.list (see
   *  maybeRestoreDraftAgent), which reads local storage directly. */
  private seedDraftDefaults(): void {
    const last = this.local.lastChoice();
    if (last.repo) this.store.setDraftRepo(last.repo);
    const model = last.modelId ? { provider: last.modelProvider, id: last.modelId } : null;
    this.store.setDraftModel(model);
    // Paint the composer's agent/model pills from the lists we already hold, so a
    // fresh draft shows the real agent and model at once instead of the bare
    // "Agent"/"Default" placeholders while listRuntimes()/listModels() below are
    // still in flight (and after resetActiveSession() blanked the agent pill).
    this.store.seedDraftAgentModel(last.agentId, model);
  }

  /**
   * Restore the user's last-used agent onto a fresh draft when the node's
   * runtimes.list arrives, so a new session opens on the same agent they last
   * picked instead of the node default. Unlike the model (a pure store
   * preference), the agent needs a runtime.select round-trip so the node
   * previews *that* agent's models — hence chooseAgent, not a store field. It's
   * a no-op once the selection already matches, so it won't fight a manual pick
   * or fire repeatedly. Mirrors the legacy client's applyLastAgentAndModel.
   */
  private maybeRestoreDraftAgent(event: { type?: string }): void {
    if (event.type !== "runtimes.list") return;
    const s = this.store.getState();
    if (s.activeSession.activeSessionId) return; // only a fresh draft, never a live session
    const wanted = this.local.lastChoice().agentId;
    const target = wanted ? s.catalogs.runtimes.find((r) => r.id === wanted) : undefined;
    if (
      target &&
      wanted !== s.catalogs.selectedAgentId &&
      String((target as any).status || "available") === "available"
    ) {
      // Switching to the remembered agent runtime-selects it, and the resulting
      // runtime.updated drives a fresh, runtime-tagged models.list (see
      // maybeRefreshModelsForRuntime) — nothing more to do here.
      this.chooseAgent(target);
      return;
    }
    // The draft's agent is already the one we'd pick (remembered == node default,
    // or nothing remembered). The connect-time burst's models.list carries no
    // runtime hint, so the node may have answered it for its global-active
    // session on a *different* agent — leaving `state.catalogs.models` tagged for the
    // wrong runtime (or empty). That's the "no models on the new-session screen
    // until I send the first message" bug: only session.new ever re-listed for
    // the draft's real agent. Re-list explicitly for the selected runtime so its
    // models resolve up front. Guarded on a mismatch so a correct list isn't
    // needlessly refetched on every runtimes.list.
    if (s.catalogs.selectedAgentId && s.catalogs.modelsRuntimeId !== s.catalogs.selectedAgentId) this.listModels();
  }

  /**
   * Send a prompt, creating a session first if there isn't an active one. A
   * prompt for an already-active session is either sent right away or held in
   * the visible follow-up queue (AppState.followupsBySession) — see mustQueue.
   * Queued items are edit/reorder/removable (see editFollowup etc.) and drain
   * out one at a time as each turn settles (drainFollowups), or can be pushed
   * through early via sendFollowupNow/steerNow.
   */
  sendPrompt(text: string, attachments?: PromptAttachment[]): void {
    this.sessionCoordinator.sendPrompt(text, attachments);
  }

  /** Provision the selected runner while its local sidebar row remains usable. */
  private async launchDraftRunnerAndBind(provisionalId: string): Promise<void> {
    const task = this.pendingLaunches.get(provisionalId);
    if (!task) return;
    const { config } = task;
    const logSetup = (message: string) => {
      task.logs.push(message);
      task.updatedAt = new Date().toISOString();
      void this.pendingLaunchStore.put(task);
    };
    try {
      this.store.updateLaunchCheckpoint(provisionalId, "account", "done");
      this.store.updateLaunchCheckpoint(provisionalId, "capacity", "active");
      if (!task.prompt.frame || !("repo" in task.prompt.frame) || !task.prompt.frame.repo) {
        this.store.updateLaunchCheckpoint(provisionalId, "repository", "skipped");
      }
      if (config.computeSource === "managed") logSetup("Reserving secure managed compute…");
      const machine = config.computeSource === "managed"
        ? await launchManagedSessionMachine(this.local, config.id)
        : await this.launchEphemeral({
            provider: config.provider,
            region: config.region ?? undefined,
            size: config.size ?? undefined,
            image: config.image ?? undefined,
            ttlMinutes: config.ttlMinutes ?? undefined,
            teardownOnAgentFinish: config.teardownOnAgentFinish === true,
            name: config.name,
            setupId: config.id,
            onProgress: logSetup,
          });
      if (!machine.nodeId) throw new Error("machine launched without a node id");
      this.store.updateLaunchCheckpoint(provisionalId, "capacity", "done");
      this.store.updateLaunchCheckpoint(provisionalId, "machine", "done");
      this.store.updateLaunchCheckpoint(provisionalId, "service", "active");
      task.machine = machine;
      task.phase = "booting";
      task.updatedAt = new Date().toISOString();
      await this.pendingLaunchStore.put(task);
      this.store.bindPendingSessionNode(provisionalId, machine.nodeId);
      this.startPendingRunner(provisionalId);
    } catch (e) {
      const message = `Launch failed: ${(e as Error)?.message || e}`;
      task.logs.push(message);
      task.phase = "failed";
      task.updatedAt = new Date().toISOString();
      void this.pendingLaunchStore.put(task);
      if (this.pendingPrompt?.provisionalId === provisionalId) this.pendingPrompt = null;
      if (e instanceof ManagedLaunchError && e.code === "managed_credentials_required") {
        this.store.updateLaunchCheckpoint(provisionalId, "capacity", "waiting");
        this.store.updateLaunchCheckpoint(provisionalId, "account", "failed", (e as Error).message);
      } else {
        this.failLaunchCheckpoint(provisionalId, message);
      }
      this.store.failPendingSession(provisionalId);
      const actions = e instanceof ManagedLaunchError ? e.actions : [];
      this.store.setError(`Couldn't start ${config.name}: ${(e as Error)?.message || e}`, actions);
    }
  }

  private failLaunchCheckpoint(provisionalId: string, message: string): void {
    const progress = this.store.getState().sessionIndex.sessions.find((session) => session.sessionId === provisionalId)?.launchProgress;
    const order: SessionLaunchCheckpointId[] = ["account", "capacity", "machine", "service", "credentials", "repository", "agent", "message"];
    const id = order.find((checkpoint) => progress?.checkpoints[checkpoint]?.state === "active")
      ?? order.find((checkpoint) => !progress?.checkpoints[checkpoint] || progress.checkpoints[checkpoint]?.state === "waiting")
      ?? "message";
    this.store.updateLaunchCheckpoint(provisionalId, id, "failed", message);
  }

  private openPendingLaunch(provisionalId: string, opts: { navigate?: boolean } = {}): void {
    const task = this.pendingLaunches.get(provisionalId);
    if (!task) return;
    if (opts.navigate !== false) navigate({ kind: "session", id: provisionalId });
    this.store.beginOpen(provisionalId);
    this.store.addUserMessage(task.prompt.text, task.prompt.clientMessageId, task.prompt.attachments);
    this.pendingPrompt = task.prompt;
  }

  /** Connect a freshly-created runner on its own small transport. This is what
   *  makes the placeholder genuinely independent: pressing New can switch the
   *  main pane anywhere while this node finishes booting and starts its prompt. */
  private startPendingRunner(provisionalId: string): void {
    const task = this.pendingLaunches.get(provisionalId);
    const nodeId = task?.machine?.nodeId;
    if (!task || !nodeId || task.transport) return;
    const log = (message: string) => {
      task.logs.push(message);
      task.updatedAt = new Date().toISOString();
      void this.pendingLaunchStore.put(task);
    };
    log("Machine accepted. Waiting for its secure Bivy service to come online…");
    this.startBootProgress(nodeId, provisionalId, log);
    this.pollBootstrapStatus(nodeId, provisionalId, log);

    // RelayTransport reads `cur` from its store. Scope only that property to the
    // new node; credentials and room keys still come from the normal local store.
    const scopedStore = new Proxy(this.local, {
      get: (target, property, receiver) => property === "cur" ? nodeId : Reflect.get(target, property, receiver),
      set: (target, property, value, receiver) => property === "cur" ? true : Reflect.set(target, property, value, receiver),
    }) as LocalStore;
    let transport: Transport;
    transport = new RelayTransport({
      store: scopedStore,
      handlers: {
        onStatus: (status) => {
          if (status !== "online") return;
          log(`${task.config.name} is online. Preparing credentials, repository, and agent…`);
          this.store.updateLaunchCheckpoint(provisionalId, "service", "done");
          this.store.updateLaunchCheckpoint(provisionalId, "credentials", "active");
          this.clearBootProgress(nodeId);
          void transport.send(task.prompt.frame);
        },
        onEvent: (event) => {
          if (event.type === "session.error") {
            this.failPendingLaunch(provisionalId, String(event.error || "Session creation failed."));
            return;
          }
          if (event.type === "session.history" && event.requestId === task.prompt.requestId && event.sessionId) {
            if (task.prompt.frame && "repo" in task.prompt.frame && task.prompt.frame.repo) {
              this.store.updateLaunchCheckpoint(provisionalId, "repository", "done");
            }
            this.store.updateLaunchCheckpoint(provisionalId, "agent", "done");
            this.store.updateLaunchCheckpoint(provisionalId, "message", "active");
            void this.sendPendingLaunchPrompt(provisionalId, String(event.sessionId), transport);
            return;
          }
          // Do not replace the provisional row or close this transport merely
          // because session.new succeeded. The first prompt can still fail its
          // credential/runtime preflight; keep ownership until the node confirms
          // that exact user message, otherwise the prompt disappears and its
          // subsequent session.error is lost with the temporary transport.
          if (
            event.type === "session.user_message" &&
            task.promptSent &&
            event.sessionId === task.sessionId &&
            event.clientMessageId === task.prompt.clientMessageId
          ) {
            void this.finishPendingLaunch(provisionalId, String(task.sessionId), transport);
          }
        },
        onError: (message) => {
          if (!/^node offline$/i.test(message.trim())) log(`Connection retry: ${message}`);
        },
      },
    });
    task.transport = transport;
    void transport.connect();
  }

  private async sendPendingLaunchPrompt(provisionalId: string, sessionId: string, transport: Transport): Promise<void> {
    const task = this.pendingLaunches.get(provisionalId);
    if (!task || task.promptSent) return;
    task.sessionId = sessionId;
    task.promptSent = true;
    if (this.store.getState().activeSession.activeSessionId === provisionalId) {
      this.store.pushSystemMessage("Setup · Repository and agent are ready. Sending your prompt…");
    }
    await transport.send({ kind: "prompt", sessionId, text: task.prompt.text, clientMessageId: task.prompt.clientMessageId, attachments: task.prompt.attachments });
  }

  private async finishPendingLaunch(provisionalId: string, sessionId: string, transport: Transport): Promise<void> {
    const task = this.pendingLaunches.get(provisionalId);
    const nodeId = task?.machine?.nodeId;
    if (!task || !nodeId) return;
    this.store.updateLaunchCheckpoint(provisionalId, "message", "done");
    for (const followup of task.followups) {
      await transport.send({ kind: "prompt", sessionId, ...followup });
    }
    this.clearBootProgress(nodeId);
    this.pendingLaunches.delete(provisionalId);
    await this.pendingLaunchStore.remove(provisionalId);
    if (this.pendingPrompt?.provisionalId === provisionalId) this.pendingPrompt = null;
    this.store.completePendingSession(provisionalId, sessionId, nodeId);
    const wasOpen = this.store.getState().activeSession.activeSessionId === sessionId;
    if (wasOpen) this.openSessionOnNode(sessionId, undefined, nodeId);
    // Keep the transport alive long enough to flush its sealed frames, then let
    // the normal account index/main connection own the now-real session.
    setTimeout(() => transport.close(), 1000);
    setTimeout(() => this.refreshSessions(), 1500);
  }

  private failPendingLaunch(provisionalId: string, message: string): void {
    const task = this.pendingLaunches.get(provisionalId);
    if (!task) return;
    if (task.machine?.nodeId) this.clearBootProgress(task.machine.nodeId);
    task.transport?.close();
    task.logs.push(`Startup failed: ${message}`);
    task.phase = "failed";
    task.updatedAt = new Date().toISOString();
    void this.pendingLaunchStore.put(task);
    this.failLaunchCheckpoint(provisionalId, message);
    this.store.failPendingSession(provisionalId);
    this.store.setError(`Couldn't start ${task.config.name}: ${message}`);
  }

  private startBootProgress(nodeId: string, provisionalId: string, log: (message: string) => void): void {
    this.clearBootProgress(nodeId);
    const updates = [
      [15_000, "Booting the machine and installing Bivy…"],
      [45_000, "Still installing Bivy (45s elapsed). A first boot can take a few minutes…"],
      [90_000, "Still waiting for Bivy to join the secure relay (90s elapsed)…"],
      [180_000, "Boot is taking longer than usual (3 min elapsed). Still retrying…"],
      [RUNNER_BOOT_TIMEOUT_MS, `Still offline after ${Math.round(RUNNER_BOOT_TIMEOUT_MS / 60000)} min. Check the provider's machine logs for a failed install.`],
    ] as const;
    const timers = updates.map(([delay, message]) => setTimeout(() => {
      if (this.pendingLaunches.has(provisionalId)) log(message);
    }, delay));
    this.bootProgressTimers.set(nodeId, timers);
  }

  private clearBootProgress(nodeId: string): void {
    for (const timer of this.bootProgressTimers.get(nodeId) ?? []) clearTimeout(timer);
    this.bootProgressTimers.delete(nodeId);
    this.bootstrapPhaseByNode.delete(nodeId);
  }

  private pollBootstrapStatus(nodeId: string, provisionalId: string, log: (message: string) => void): void {
    const labels: Record<string, string> = {
      booting: "The machine booted and cloud-init started.",
      installing: "Cloud-init is installing Bivy…",
      starting: "Bivy is installed. Starting its secure service…",
      ready: "The secure Bivy service and encrypted credentials are ready.",
      failed: "Cloud-init reported that the Bivy install failed.",
    };
    const poll = async () => {
      const task = this.pendingLaunches.get(provisionalId);
      if (!task || task.machine?.nodeId !== nodeId) return;
      try {
        const nodes = await fetchAccountNodes(this.local);
        const phase = nodes.find((n) => n.id === nodeId)?.bootstrapStatus?.phase;
        if (phase && phase !== this.bootstrapPhaseByNode.get(nodeId)) {
          this.bootstrapPhaseByNode.set(nodeId, phase);
          log(labels[phase] || `Bootstrap: ${phase}`);
          if (phase === "ready") {
            this.store.updateLaunchCheckpoint(provisionalId, "service", "done");
            this.store.updateLaunchCheckpoint(provisionalId, "credentials", "done");
          }
          if (phase === "failed") this.failPendingLaunch(provisionalId, labels.failed!);
        }
      } catch {
        // The relay connection remains authoritative; status polling is additive.
      }
      if (this.pendingLaunches.has(provisionalId)) setTimeout(poll, 3000);
    };
    void poll();
  }

  /** Restore pending first messages after a reload. A machine record means the
   *  provider already accepted it, so reconnect without provisioning twice.
   *  An interrupted provider request is marked failed and offered as a retry. */
  private async restorePendingLaunches(): Promise<void> {
    const launches = await this.pendingLaunchStore.list();
    for (const launch of launches) {
      this.pendingLaunches.set(launch.id, launch);
      this.store.persistPendingSession(launch.id, launch.prompt.text, false, launch.config.name, Date.parse(launch.createdAt) || Date.now());
      if (launch.machine?.nodeId && launch.phase !== "failed") {
        this.store.updateLaunchCheckpoint(launch.id, "account", "done");
        this.store.updateLaunchCheckpoint(launch.id, "capacity", "done");
        this.store.updateLaunchCheckpoint(launch.id, "machine", "done");
        this.store.updateLaunchCheckpoint(launch.id, "service", "active");
        if (!launch.prompt.frame || !("repo" in launch.prompt.frame) || !launch.prompt.frame.repo) {
          this.store.updateLaunchCheckpoint(launch.id, "repository", "skipped");
        }
        this.store.bindPendingSessionNode(launch.id, launch.machine.nodeId);
        this.startPendingRunner(launch.id);
      } else if (launch.phase === "provisioning") {
        launch.phase = "failed";
        launch.logs.push("Startup was interrupted before the cloud provider confirmed the machine.");
        launch.updatedAt = new Date().toISOString();
        await this.pendingLaunchStore.put(launch);
        this.store.failPendingSession(launch.id);
      } else if (launch.phase === "failed") {
        this.store.failPendingSession(launch.id);
      }
    }
  }

  async retryPendingLaunch(id: string): Promise<void> {
    const task = this.pendingLaunches.get(id);
    if (!task) return;
    task.transport?.close();
    task.transport = undefined;
    task.logs.push("Retrying startup…");
    task.phase = task.machine?.nodeId ? "booting" : "provisioning";
    task.updatedAt = new Date().toISOString();
    this.store.retryPendingSession(id);
    await this.pendingLaunchStore.put(task);
    if (task.machine?.nodeId) this.startPendingRunner(id);
    else await this.launchDraftRunnerAndBind(id);
  }

  async dismissPendingLaunch(id: string): Promise<void> {
    const task = this.pendingLaunches.get(id);
    task?.transport?.close();
    if (task?.machine?.nodeId) this.clearBootProgress(task.machine.nodeId);
    this.pendingLaunches.delete(id);
    await this.pendingLaunchStore.remove(id);
    this.store.dismissPendingSession(id);
    if (this.store.getState().activeSession.activeSessionId == null) this.newSession();
  }

  /**
   * Invoke a protocol-mode agent command (AgentCommand.mode === "protocol") on the
   * active session. Prompt-mode agent commands are NOT sent here — the composer
   * forwards those as an ordinary prompt. No-op without an active session (there's
   * nothing to run the command against yet).
   */
  invokeAgentCommand(name: string, args: string): void {
    const active = this.store.getState().activeSession.activeSessionId;
    if (!active) return;
    this.send({ kind: "session.command.invoke", sessionId: active, name, args });
  }

  // --- Composer pickers ---------------------------------------------------

  /** GitHub repos available on the node (for a new session). Stale-while-
   *  revalidate: only show the "Loading repos…" state when we have nothing
   *  cached yet, so a prefetch/reopen paints the last list instantly and
   *  refreshes it in the background instead of flashing a spinner. */
  listRepos(): void {
    if (this.store.getState().catalogs.repos.length === 0) this.store.setReposLoading(true);
    const managedDraft = this.store.getState().draft.ephemeralConfig?.computeSource === "managed";
    if (!this.direct && this.signedIn && (!this.local.cur || managedDraft)) {
      void fetchHostedGithubRepositories(this.local)
        .then((repos) => this.store.apply({ type: "repos.list", repos, authed: true } as never))
        .catch((error) => this.store.apply({ type: "repos.list", repos: [], authed: false, error: String((error as Error)?.message || error) } as never));
      return;
    }
    this.send({ kind: "repos.list" });
  }

  /** Begin the repo-picker "Connect GitHub" device flow on the node. The node
   *  replies with a github.connect.status ("waiting" + a user code, or
   *  "unconfigured" if it has no device-flow client id). Optimistically flips to
   *  "starting" so the button shows progress before the round trip. */
  githubConnectStart(): void {
    this.store.setGithubConnect({ status: "starting" });
    this.send({ kind: "github.connect.start" });
  }

  /** Ask the node whether the user has authorized yet (drives the flow forward).
   *  The picker calls this on the node-provided interval while status is "waiting". */
  githubConnectPoll(): void {
    this.send({ kind: "github.connect.poll" });
  }

  /** Drop any Connect-GitHub flow state (e.g. on cancel, or after success once
   *  the repo list has refreshed) so reopening the picker starts clean. */
  githubConnectReset(): void {
    this.store.setGithubConnect({ status: "idle" });
  }

  /** Choose a repo for the next new session (persisted for next time). A plain
   *  repo tap PRESERVES an already-chosen branch when it's the same repo — the
   *  branch belongs to it — and only resets the branch/list when the repo
   *  actually changes (or is cleared), since a branch from a different repo is
   *  meaningless here. Use chooseRepoBranch to set an explicit branch. */
  chooseRepo(slug: string | null): void {
    const changed = slug !== this.store.getState().draft.repo;
    this.store.setDraftRepo(slug);
    if (changed) this.store.clearBranches();
    this.local.setLastChoice({ repo: slug });
  }

  /** Choose a repo AND the exact branch to clone/base the next new session
   *  from (the repo picker's branch drill-in). `branch` null = the repo's
   *  default branch — set authoritatively, so an explicit "default branch"
   *  pick clears a prior branch even when the repo is unchanged. */
  chooseRepoBranch(slug: string, branch: string | null): void {
    this.store.setDraftRepo(slug);
    this.store.setDraftBranch(branch);
    this.local.setLastChoice({ repo: slug });
  }

  /** Remote branches of a repo, for the branch drill-in in the repo picker.
   *  Stale-while-revalidate like listRepos: only show "Loading branches…" when
   *  we don't already hold this repo's list, so a prefetch/reopen is instant. */
  listBranches(repo: string): void {
    const s = this.store.getState();
    const haveThisRepo = s.catalogs.branchesRepo === repo && s.catalogs.branches.length > 0;
    if (!haveThisRepo) this.store.setBranchesLoading(true);
    const managedDraft = s.draft.ephemeralConfig?.computeSource === "managed";
    if (!this.direct && this.signedIn && (!this.local.cur || managedDraft)) {
      void fetchHostedGithubBranches(this.local, repo)
        .then((branches) => this.store.apply({ type: "branches.list", repo, branches } as never))
        .catch((error) => this.store.apply({ type: "branches.list", repo, branches: [], error: String((error as Error)?.message || error) } as never));
      return;
    }
    this.send({ kind: "branches.list", repo });
  }

  listRuntimes(): void {
    this.send({ kind: "runtimes.list" });
  }

  /** Ask the node for a fresh Machine capability inventory. The reply arrives
   *  as a `capabilities` event and lands in `state.settings.capabilities`. Fetched on
   *  demand (panel open / explicit refresh) — capabilities change rarely,
   *  unlike live resource stats, so this is not polled. */
  requestCapabilities(): void {
    this.send({ kind: "capabilities.get" });
  }

  listModels(): void {
    const s = this.store.getState();
    const activeId = s.activeSession.activeSessionId;
    // A managed launch installs a provisional UI identity before session.new is
    // accepted by the guest. Never send that placeholder as a real session id:
    // the newly connected Machine correctly has no such session and would
    // answer "Session not found" while it is still booting.
    const provisional = activeId
      ? s.sessionIndex.sessions.find((session) => session.sessionId === activeId)?.pendingLaunch === true
      : false;
    const sessionId = activeId && !provisional ? activeId : undefined;
    // On a draft/provisional launch, hint the agent we're previewing so the node
    // answers for THAT runtime. A live session answers for itself — no hint.
    const runtimeId = sessionId
      ? undefined
      : (s.activeSession.activeRuntimeId ?? s.catalogs.selectedAgentId ?? undefined);
    this.send({ kind: "models.list", sessionId, runtimeId });
  }

  /** Warm the node's per-runtime model scratch for every installed agent when the
   *  agent picker opens, so the first switch to any of them lists models instantly
   *  instead of paying the runtime spin-up on the critical path. No-op once a
   *  session is live (its agent is fixed) or when no runtimes are known yet. */
  prefetchModels(): void {
    if (this.store.getState().activeSession.activeSessionId) return;
    const runtimeIds = this.store
      .getState()
      .catalogs.runtimes.filter((r) => String((r as any).status || "available") === "available")
      .map((r) => r.id);
    if (runtimeIds.length) this.send({ kind: "models.prefetch", runtimeIds });
  }

  /** Pick a model. Live session → select now; draft → keep local for session.new. */
  chooseModel(model: ModelInfo): void {
    this.credentialsModelsCoordinator.selectModel(model, this.store.getState().activeSession.activeSessionId);
  }

  setThinkingLevel(level: string): void {
    const sessionId = this.store.getState().activeSession.activeSessionId ?? undefined;
    this.store.setThinkingLevel(level);
    this.send({ kind: "thinking.set_level", level, sessionId });
  }

  /** Pick a runtime/agent. Draft → select + remember; installable → install. */
  chooseAgent(rt: RuntimeInfo): void {
    const status = String((rt as any).status || "available");
    const available = status === "available";
    if (!available && (rt as any).install) {
      this.installAgent(rt.id);
      return;
    }
    const state = this.store.getState();
    const activeSessionId = state.activeSession.activeSessionId;
    if (activeSessionId) {
      // Agent handoff is a real cross-runtime fork, not a client-side summary in
      // a blank draft. The shared fork path carries normalized history, repo and
      // dirty files, creates the target runtime session, and opens it.
      const sourceAgentId = state.activeSession.activeRuntimeId
        ?? state.sessionIndex.sessions.find((session) => session.sessionId === activeSessionId)?.runtimeId;
      this.pendingPrompt = null;
      this.pendingFollowups = [];
      void this.forkSession(activeSessionId, {
        agentId: rt.id,
        sourceAgentId,
        retireSource: false,
      }).catch((error) => this.store.setError(error instanceof Error ? error.message : String(error)));
      return;
    }

    this.store.setSelectedAgentLocal(rt.id);
    this.local.setLastChoice({ agentId: rt.id });
    // Tell the node to switch its default runtime. Do NOT request models here:
    // runtime.select flips the default asynchronously on the node, so a
    // models.list sent now would race the switch and be answered against the
    // *old* runtime — leaving the composer on a model the new agent can't use.
    // The node broadcasts `runtime.updated` once the switch actually lands, and
    // that event drives the fresh models.list (see maybeRefreshModelsForRuntime).
    this.send({ kind: "runtime.select", id: rt.id });
  }

  installAgent(id: string): void {
    this.store.setInstalling(id);
    this.send({ kind: "runtime.install", id });
  }

  // --- Settings: providers, credentials and custom models -----------------
  listProviders(): void { this.credentialsModelsCoordinator.listProviders(); }
  getProviderAuth(provider: string): void { this.credentialsModelsCoordinator.getProviderAuth(provider); }
  saveApiKey(provider: string, key: string): Promise<void> { return this.credentialsModelsCoordinator.saveApiKey(provider, key); }
  removeProvider(provider: string): void { this.credentialsModelsCoordinator.removeProvider(provider); }
  resetOauth(provider: string): void { this.credentialsModelsCoordinator.resetOauth(provider); }
  startOauth(provider: string, label?: string): void { this.credentialsModelsCoordinator.startOauth(provider, label); }
  openOauthOnNode(id: string): Promise<{ opened: boolean; error?: string }> { return this.credentialsModelsCoordinator.openOauthOnNode(id); }
  submitOauthCode(id: string, code: string): void { this.credentialsModelsCoordinator.submitOauthCode(id, code); }
  listCredentialRecords(): void { this.credentialsModelsCoordinator.listCredentials(); }

  /** Bidirectional API-key convergence between the PWA account vault and node. */
  private syncAccountCredentialsWithNode(): Promise<void> {
    return this.credentialsModelsCoordinator.syncAccountCredentials();
  }

  setCredential(provider: string, label: string, value: { key?: string; ref?: string; sync?: "account" | "node" }): Promise<void> { return this.credentialsModelsCoordinator.setCredential(provider, label, value); }
  removeCredential(provider: string, label: string): Promise<void> { return this.credentialsModelsCoordinator.removeCredential(provider, label); }
  setCredentialSync(provider: string, label: string, sync: "account" | "node"): Promise<void> { return this.credentialsModelsCoordinator.setCredentialSync(provider, label, sync); }
  setCredentialUnattended(provider: string, label: string, unattended: boolean): Promise<void> { return this.credentialsModelsCoordinator.setCredentialUnattended(provider, label, unattended); }
  testCredential(provider: string, label: string): Promise<{ ok: boolean; at: number; reason?: string }> { return this.credentialsModelsCoordinator.testCredential(provider, label); }
  getCredentialPresets(): void { this.credentialsModelsCoordinator.getPresets(); }
  setActivePreset(active: string): void { this.credentialsModelsCoordinator.setActivePreset(active); }
  setPresetMapping(preset: string, provider: string, label: string): Promise<void> { return this.credentialsModelsCoordinator.setPresetMapping(preset, provider, label); }
  listLocalModels(): void { this.credentialsModelsCoordinator.listLocalModels(); }
  listLocalModelPresets(): void { this.credentialsModelsCoordinator.listLocalModelPresets(); }
  discoverLocalModels(): Promise<LocalModelDiscoveryResult> { return this.credentialsModelsCoordinator.discoverLocalModels(); }
  verifyLocalModel(baseUrl: string, apiKey?: string): Promise<LocalModelEndpointResult> { return this.credentialsModelsCoordinator.verifyLocalModel(baseUrl, apiKey); }
  saveLocalModel(spec: Record<string, unknown>): Promise<string> { return this.credentialsModelsCoordinator.saveLocalModel(spec); }
  removeLocalModel(id: string): void { this.credentialsModelsCoordinator.removeLocalModel(id); }

  // --- Settings: rulesets (run-orchestration policy) ----------------------

  /** Pull the ruleset list into state (each with its `active` flag). */
  listRulesets(): void {
    this.send({ kind: "rulesets.list" });
  }
  /** Save (create or update) a ruleset. `active` optionally (de)selects it as the
   *  queue's active ruleset. Resolves once the node acks (validation passes) or
   *  rejects with the node's validation error. */
  saveRuleset(ruleset: Ruleset, active?: boolean): Promise<void> {
    return this.awaitAck({ kind: "rulesets.save", ruleset, active }).then(() => undefined);
  }
  removeRuleset(name: string): void {
    this.send({ kind: "rulesets.remove", name });
  }

  // --- Settings: voice input (speech-to-text) ----------------------------

  /** Pull the current voice-input config into state (provider + which keys exist). */
  getSttConfig(): void {
    this.send({ kind: "stt.config.get" });
  }
  setSttProvider(provider: string): void {
    this.send({ kind: "stt.config.set", provider });
  }
  /** Save a speech-to-text provider key and resolve once the node acks it (or
   *  reject with its error) instead of assuming success the moment it was sent. */
  saveSttKey(provider: string, value: string): Promise<void> {
    return this.awaitAck({ kind: "stt.config.set", setKey: { provider, value } }).then(() => undefined);
  }
  removeSttKey(provider: string): void {
    this.send({ kind: "stt.config.set", removeKey: provider });
  }

  /**
   * Send recorded audio to the node for transcription and resolve with the text.
   * Works over both transports: the node replies with a `transcription` event
   * carrying our requestId (or an error), which resolveTranscription() routes back.
   */
  transcribe(audioBase64: string, mimeType: string): Promise<string> {
    const rid = requestId();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTranscriptions.delete(rid);
        reject(new Error("Transcription timed out. Check your connection and try again."));
      }, 60_000);
      this.pendingTranscriptions.set(rid, { resolve, reject, timer });
      void this.transport.send({ kind: "transcribe", requestId: rid, audio: audioBase64, mimeType });
    });
  }

  private resolveTranscription(event: ServerEvent): void {
    const rid = String(event.requestId || "");
    const pending = rid ? this.pendingTranscriptions.get(rid) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTranscriptions.delete(rid);
    const error = (event as any).error;
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve(String((event as any).text ?? "").trim());
  }

  /** Generate neural read-aloud audio on the node using its OpenAI key. */
  synthesize(text: string, voice: string, instructions: string): Promise<{ audio: string; mimeType: string }> {
    const rid = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSpeech.delete(rid);
        reject(new Error("Speech generation timed out. Check your connection and try again."));
      }, 60_000);
      this.pendingSpeech.set(rid, { resolve, reject, timer });
      void this.transport.send({ kind: "synthesize", requestId: rid, text, voice, instructions });
    });
  }

  private resolveSpeech(event: ServerEvent): void {
    const rid = String(event.requestId || "");
    const pending = rid ? this.pendingSpeech.get(rid) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpeech.delete(rid);
    const error = (event as any).error;
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve({ audio: String((event as any).audio ?? ""), mimeType: String((event as any).mimeType ?? "audio/mpeg") });
  }

  // --- Settings: GitHub App one-click (manifest) flow --------------------
  // Works on a headless/remote node: we hand the node *this browser's* origin
  // as the redirect base, so GitHub sends the code back to wherever the user
  // is (control-plane origin or the node itself), and we relay it to the node.

  /** Ask the node to mint a manifest + hook. The reply drives a GitHub redirect. */
  githubAppManifestStart(org?: string): void {
    this.store.setGithubAppPhase("starting");
    this.send({ kind: "github.app.manifest.start", requestId: requestId(), origin: location.origin, org: org || undefined });
  }

  /** Relay the one-time code GitHub returned back to the node to finish setup. */
  githubAppManifestCode(code: string, state: string): void {
    this.store.setGithubAppPhase("completing");
    this.send({ kind: "github.app.manifest.code", requestId: requestId(), code, state });
  }

  /**
   * Connect an ALREADY-EXISTING GitHub App on the active node: the user supplies
   * the App ID + `.pem` key; the node adopts the account's existing hook so the
   * app's webhook keeps working. Reuses the manifest flow's done/error events, so
   * the phase machine surfaces success/failure just like the create flow.
   */
  async githubAppConnectExisting(input: { appId: string; privateKeyPem: string; nodeLabel?: string }): Promise<void> {
    this.store.setGithubAppPhase("completing");
    try {
      // This used to be fire-and-forget. A dropped relay command, offline node,
      // or validation failure therefore left the form looking unchanged (or
      // stuck on “Connecting…”) with no actionable result for the user.
      await this.awaitAck({
        kind: "github.app.connect-existing",
        appId: input.appId,
        privateKeyPem: input.privateKeyPem,
        nodeLabel: input.nodeLabel || undefined,
      }, 60_000);
    } catch (error) {
      this.store.setGithubAppPhase("error", {
        error: error instanceof Error ? error.message : String(error),
        returning: false,
      });
      throw error;
    }
  }

  /** Store and validate an App for unattended execution without a node. */
  connectHostedGithubApp(input: { appId: string; privateKeyPem: string; installationId?: string }): Promise<HostedGithubAppConnection> {
    return apiConnectHostedGithubApp(this.local, input);
  }

  // --- Settings: account / push -------------------------------------------

  fetchMe(): Promise<AccountMe> { return this.accountCoordinator.fetchMe(); }
  invokeAccountExtensionAction(action: string): Promise<{ url: string }> { return invokeAccountExtensionAction(this.local, action); }
  fetchGithubApp(): ReturnType<typeof fetchGithubApp> { return this.accountCoordinator.fetchGithubApp() as ReturnType<typeof fetchGithubApp>; }
  fetchGithubQueue(limit = 30): ReturnType<typeof fetchGithubQueue> { return this.accountCoordinator.fetchGithubQueue(limit); }
  fetchAutomationRuns(limit = 50): ReturnType<typeof fetchAutomationRuns> { return this.accountCoordinator.fetchAutomationRuns(limit); }
  cancelAutomationRun(id: string): Promise<{ runs: Awaited<ReturnType<typeof fetchAutomationRuns>>; queue: Awaited<ReturnType<typeof fetchGithubQueue>> }> {
    return this.accountCoordinator.cancelAutomationRun(id);
  }
  /** Set (empty string clears) the default node for untagged GitHub work. Without
   *  an appId it covers every connected app — it's an account-level preference. */
  setGithubAppDefaultNode(node: string, appId?: string): Promise<string | undefined> {
    return this.accountCoordinator.setGithubAppDefaultNode(node, appId);
  }
  /** Set who may @-mention-trigger a run (issue #259). Without an appId it
   *  covers every connected app — it's an account-level preference. */
  setGithubAppTriggerAccess(
    triggerAccess: "everyone" | "contributor" | "collaborator",
    appId?: string,
  ): Promise<"everyone" | "contributor" | "collaborator"> {
    return this.accountCoordinator.setGithubAppTriggerAccess(triggerAccess, appId);
  }
  /** Manually dispatch a pending queue item to a chosen node + agent/model. */
  assignWorkItem(id: string, input: { node?: string; runtimeId?: string; model?: string; ephemeral?: boolean }): Promise<void> {
    return this.accountCoordinator.assignWorkItem(id, input);
  }
  /** Remove a single item from the GitHub queue. */
  deleteWorkItem(id: string): Promise<void> {
    return this.accountCoordinator.deleteWorkItem(id);
  }
  /** Clear every pending (waiting) item from the GitHub queue. */
  clearWorkQueue(): Promise<number> {
    return this.accountCoordinator.clearWorkQueue();
  }
  githubAppDisconnect(appId?: string, hookId?: string): Promise<void> { return this.accountCoordinator.disconnectGithubApp(appId, hookId); }
  removeNode(nodeId: string): Promise<void> { return this.accountCoordinator.removeNode(nodeId); }
  enablePush(): Promise<string> { return this.accountCoordinator.enablePush(); }
  disablePush(): Promise<string> { return this.accountCoordinator.disablePush(); }
  pushStatus(): ReturnType<typeof getPushSubscriptionStatus> { return this.accountCoordinator.pushStatus(); }
  getNotificationPreferences(): Promise<NotificationPreferences> { return this.accountCoordinator.getNotificationPreferences(); }
  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> { return this.accountCoordinator.setNotificationPreferences(patch); }

  // --- Ephemeral machines ------------------------------------------------

  // Compute-provider tokens are account credentials: signed-in devices converge
  // them through the E2E device vault, so any device can launch/wake/destroy the
  // user's machines. The control plane only ever sees ciphertext.
  private ephemeralModelKeys: EphemeralModelKeyStore = createEphemeralModelKeyStore();
  private deviceOAuthCredentials = createDeviceOAuthCredentialStore();
  private ephemeralKeys: DeviceVaultKeyStore = createDeviceVaultKeyStore({
    local: createEphemeralKeyStore(),
    modelKeys: this.ephemeralModelKeys,
    oauthCredentials: this.deviceOAuthCredentials,
    oauthRecoveryEnabled: () => this.oauthRecoveryEnabled(),
    remote: this.deviceVaultRemote(),
    device: () => deviceKeypair(this.local),
    // The account credential vault is available before the first node exists.
    enabled: () => !this.direct && Boolean(this.local.s),
    providerTokenSyncEnabled: () => !this.direct && Boolean(this.local.s),
    state: {
      load: async () => {
        try { return JSON.parse(localStorage.getItem("bivy_device_vault_state") || "null") ?? undefined; } catch { return undefined; }
      },
      save: async (value) => { try { localStorage.setItem("bivy_device_vault_state", JSON.stringify(value)); } catch { /* status remains in memory */ } },
    },
  });
  private ephemeralPrefs: EphemeralPrefsStore = createEphemeralPrefsStore();
  private ephemeralSetups: EphemeralSetupStore = createEphemeralSetupStore();
  private ephemeralMachines: MachineStore = createMachineStore();
  private pendingLaunchStore: PendingEphemeralLaunchStore = createPendingEphemeralLaunchStore();
  /** Ephemeral node ids we've already seeded with device-held model keys this
   *  session, so a reconnect doesn't re-push (the node write is idempotent
   *  regardless). See `seedEphemeralNodeIfNeeded`. */
  private seededEphemeralNodes = new Set<string>();
  /** Launched ephemeral node ids we've already run the first-run model-auth
   *  check for this session, so a reconnect doesn't re-schedule it. */
  private firstRunAuthNodes = new Set<string>();
  /** Managed credential-only Machines this browser launched. Credentials saved
   * there are explicitly intended for the separately encrypted Cloud snapshot. */
  private managedAuthRunnerNodes = new Set<string>();
  private managedCredentialGrantInFlight = false;
  private managedCredentialReturnSessionId: string | null = null;
  listEphemeralKeys(): Promise<ProviderKeyInfo[]> {
    return this.ephemeralKeys.list();
  }
  /** Device-held model **API keys** used to seed a freshly-launched machine's
   *  vault over the E2E channel (closes the cold-start gap — see
   *  docs/ephemeral-sessions.md, "Closing the cold-start gap"). API keys only. */
  listEphemeralModelKeys(): Promise<EphemeralModelKeyInfo[]> {
    return this.ephemeralKeys.listModelKeys();
  }
  setEphemeralModelKey(provider: string, key: string, scope: "account" | "device" = "account", label = "default"): Promise<void> {
    return this.ephemeralKeys.setModelKey(provider, key, scope, label);
  }
  removeEphemeralModelKey(provider: string, label = "default"): Promise<void> {
    return this.ephemeralKeys.removeModelKey(provider, label);
  }
  getEphemeralToken(id: string): Promise<string> {
    return this.ephemeralCoordinator.getProviderToken(id);
  }
  setEphemeralToken(id: string, token: string): Promise<void> {
    return this.ephemeralCoordinator.setProviderToken(id, token);
  }
  /** Save a provider token and return the provider's default runner (creating one
   *  if needed), so the connect UI can immediately pick it for the draft session. */
  connectEphemeralProvider(providerId: string, token: string): Promise<EphemeralNodeConfig | null> {
    return this.ephemeralCoordinator.connectProvider(providerId, token);
  }
  /** The provider's default runner (creating one if needed) — for the connect
   *  UI's "use this runner" action on an already-connected provider. */
  defaultEphemeralRunner(providerId: string): Promise<EphemeralNodeConfig | null> {
    return this.ensureDefaultRunner(providerId);
  }
  /** The provider's default ephemeral runner (account config), creating one if it
   *  has none yet — so a freshly-connected provider is immediately pickable. */
  private ensureDefaultRunner(providerId: string): Promise<EphemeralNodeConfig | null> {
    return this.ephemeralCoordinator.ensureDefaultRunner(providerId);
  }

  removeEphemeralToken(id: string): Promise<void> {
    return this.ephemeralCoordinator.removeProviderToken(id);
  }

  // --- Cross-device credential sync --------------------------------------
  private oauthRecoveryEnabled(): boolean {
    try { return !this.direct && !!this.local.s && localStorage.getItem("bivy_oauth_browser_recovery") === "1"; }
    catch { return false; }
  }
  getOAuthBrowserRecovery(): boolean { return this.oauthRecoveryEnabled(); }
  async setOAuthBrowserRecovery(enabled: boolean): Promise<void> {
    if (this.direct) throw new Error("OAuth browser recovery requires a signed-in account");
    if (!enabled) {
      // Write tombstones while recovery is still enabled, then close the gate.
      for (const entry of await this.ephemeralKeys.oauthCredentialEntries()) await this.ephemeralKeys.removeOAuthCredential(entry.provider, entry.label);
    }
    try { localStorage.setItem("bivy_oauth_browser_recovery", enabled ? "1" : "0"); } catch { /* noop */ }
    if (enabled) await this.syncAccountCredentialsWithNode();
  }

  /** Reconcile the device vault. Failures remain observable through
   * `getDeviceVaultSyncState()` and reject explicit callers instead of being
   * silently swallowed. */
  syncDeviceVault(): Promise<void> {
    return this.ephemeralKeys.sync();
  }
  getDeviceVaultSyncState() {
    return this.ephemeralKeys.getSyncState();
  }
  /** Fetch-backed control-plane transport for the device vault. Ciphertext +
   *  wrapped keys only — never a token. */
  private deviceVaultRemote(): DeviceVaultRemote {
    const base = () => (this.local.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
    const jsonAuth = () => ({ authorization: `Bearer ${this.local.s}`, "content-type": "application/json" });
    return {
      get: async () => {
        const dev = await deviceKeypair(this.local);
        const res = await fetch(`${base()}/device-vault?device=${encodeURIComponent(dev.pub)}`, { headers: { authorization: `Bearer ${this.local.s}` } });
        if (!res.ok) throw new Error(`device-vault get failed (${res.status})`);
        const data = (await res.json()) as { vault?: string | null; wrappedKey?: { wrappedKey: string; wrappedByPublicKeyB64: string; generation?: number } | null; requests?: string[]; generation?: number; keyGeneration?: number; recipients?: string[] };
        return { vault: data.vault ?? null, wrappedKey: data.wrappedKey ?? null, requests: Array.isArray(data.requests) ? data.requests : [], generation: data.generation ?? 0, keyGeneration: data.keyGeneration ?? 0, recipients: Array.isArray(data.recipients) ? data.recipients : [] };
      },
      putVault: async (ciphertext: string, expectedGeneration?: number, keyGeneration?: number) => {
        const dev = await deviceKeypair(this.local);
        const res = await fetch(`${base()}/device-vault`, { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ devicePublicKeyB64: dev.pub, ciphertext, expectedGeneration, keyGeneration }) });
        if (res.status === 409) throw new DeviceVaultConflictError();
        if (!res.ok) throw new Error(`device-vault put failed (${res.status})`);
        const data = await res.json() as { generation?: number };
        return { generation: data.generation ?? (expectedGeneration ?? 0) + 1 };
      },
      requestKey: async () => {
        const dev = await deviceKeypair(this.local);
        await fetch(`${base()}/device-vault/key/request`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ devicePublicKeyB64: dev.pub }) });
      },
      putWrapped: async (target: string, wrappedKey: string, wrappedByPublicKeyB64: string, generation?: number) => {
        const res = await fetch(`${base()}/device-vault/key/wrapped`, { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ targetDevicePublicKeyB64: target, wrappedKey, wrappedByPublicKeyB64, generation }) });
        if (!res.ok) throw new Error(`device-vault wrapped-key put failed (${res.status})`);
      },
    };
  }
  /** Per-provider saved launch preferences (region/size/TTL/repo) configured in
   *  Settings → Ephemeral machines; used to pre-fill the launch flow. */
  getEphemeralPrefs(id: string): Promise<EphemeralPrefs> {
    return this.ephemeralPrefs.get(id);
  }
  setEphemeralPrefs(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs> {
    return this.ephemeralPrefs.set(id, patch);
  }
  listEphemeralSetups(provider?: string): Promise<EphemeralSetup[]> {
    return this.ephemeralSetups.list(provider);
  }
  createEphemeralSetup(provider: string, input: { name: string } & Partial<EphemeralPrefs>): Promise<EphemeralSetup> {
    return this.ephemeralSetups.create(provider, input);
  }
  updateEphemeralSetup(id: string, patch: Partial<Pick<EphemeralSetup, "name" | keyof EphemeralPrefs>>): Promise<EphemeralSetup> {
    return this.ephemeralSetups.update(id, patch);
  }
  removeEphemeralSetup(id: string): Promise<void> {
    return this.ephemeralSetups.remove(id);
  }
  listEphemeralMachines(): Promise<EphemeralMachine[]> {
    return this.ephemeralMachines.list();
  }
  /**
   * When we come online on a node WE launched (a device-local `MachineStore`
   * record), push the model API keys held on THIS device into its vault so a
   * brand-new machine has model credentials even when it's the account's only
   * node and there's no peer to sync the model-auth vault from — the cold-start
   * gap (docs/ephemeral-sessions.md, "Closing the cold-start gap").
   *
   * Uses the ordinary `provider.apiKey` frame over the already-paired E2E
   * channel — the same path Settings → Keys uses — so the relay/control plane
   * only ever see ciphertext and nothing lands in the machine's user-data. API
   * keys only; agent-native OAuth logins are out of scope. Guarded per session
   * (the node write is idempotent regardless).
   */
  private async seedEphemeralNodeIfNeeded(): Promise<void> {
    if (!EPHEMERAL_MACHINES_ENABLED || this.direct) return;
    const nodeId = this.local.cur;
    if (!nodeId || this.seededEphemeralNodes.has(nodeId)) return;
    let machines: EphemeralMachine[];
    try {
      machines = await this.ephemeralMachines.list();
    } catch {
      return;
    }
    // Only seed nodes this device provisioned — never a normal, persistent one.
    if (!machines.some((m) => m.nodeId === nodeId)) return;
    let entries: { provider: string; key: string }[];
    try {
      entries = await this.ephemeralKeys.modelKeyEntries();
    } catch {
      return;
    }
    // Mark seeded regardless of whether there were keys — an empty device just
    // has nothing to contribute, and re-checking on every reconnect is wasteful.
    this.seededEphemeralNodes.add(nodeId);
    if (!entries.length) return;
    // Push only while the transport is still live on this same node — an async
    // hop above could have switched it out from under us.
    if (this.store.getState().connection.status !== "online" || this.local.cur !== nodeId) {
      this.seededEphemeralNodes.delete(nodeId); // let a later online retry
      return;
    }
    for (const { provider, key } of entries) {
      this.send({ kind: "provider.apiKey", provider, key });
    }
  }
  /**
   * First-run model access for a launched ephemeral runner.
   *
   * The vault-sync paths (device API-key seed, peer node→node wrap, hosted
   * escrow) cover every case where the account *already has* a model login
   * somewhere. The one they can't cover is the genuine first run — a phone-only
   * account whose very first runner has no device key to seed, no peer online,
   * and nothing escrowed yet. That runner boots with no model credentials and
   * would silently fail on the first turn. Here we detect that and raise the
   * `needsModelAuth` prompt so the user signs in once (over the existing
   * `provider.oauth.start` paste-back on this same node); the node then escrows
   * the login so every future runner inherits it with no prompt.
   *
   * Timing: model-auth can arrive a beat after connect (escrow/peer sync), so we
   * wait a grace before concluding "no creds", and the store auto-dismisses the
   * prompt the moment any provider becomes configured — so a slow sync that
   * lands during the grace just means the prompt never shows (or briefly shows
   * then clears), never a wrong dead-end.
   */
  private async maybeGrantManagedCredential(): Promise<void> {
    const nodeId = this.local.cur;
    if (!nodeId || !this.managedAuthRunnerNodes.has(nodeId) || this.managedCredentialGrantInFlight) return;
    const candidate = this.store.getState().settings.credentialRecords.find(
      (record) => record.sync === "account" && record.kind !== "reference" && !record.unattended,
    );
    if (!candidate) return;
    this.managedCredentialGrantInFlight = true;
    try {
      await this.setCredentialUnattended(candidate.provider, candidate.label, true);
      await this.waitForManagedCredential();
      const returnId = this.managedCredentialReturnSessionId;
      this.managedCredentialReturnSessionId = null;
      if (returnId && this.pendingLaunches.has(returnId)) {
        this.openPendingLaunch(returnId);
        await this.retryPendingLaunch(returnId);
      }
    } catch (error) {
      this.store.setError(error instanceof Error ? error.message : String(error));
    } finally {
      this.managedCredentialGrantInFlight = false;
    }
  }

  private async maybePromptFirstRunModelAuth(): Promise<void> {
    if (!EPHEMERAL_MACHINES_ENABLED || this.direct) return;
    const nodeId = this.local.cur;
    if (!nodeId || this.firstRunAuthNodes.has(nodeId)) return;
    // Only a machine THIS device launched — never a normal persistent node,
    // which manages its own logins through Settings.
    const machines = await this.ephemeralMachines.list().catch(() => [] as EphemeralMachine[]);
    if (!machines.some((m) => m.nodeId === nodeId)) return;
    this.firstRunAuthNodes.add(nodeId);
    // Ask the node for its provider status now; the freshest list will have
    // arrived well before the grace elapses.
    this.listProviders();
    setTimeout(() => {
      const st = this.store.getState();
      // Bail if we've moved on, a login is already in flight, the prompt is
      // already up, or creds have since landed.
      if (st.connection.status !== "online" || this.local.cur !== nodeId) return;
      if (st.presentation.needsModelAuth || st.presentation.oauth) return;
      if (st.catalogs.providers.some((p) => p.configured)) return;
      // Prefer an OAuth-capable provider (Anthropic first — subscription login
      // is the whole point here), falling back to anthropic by id.
      const provider =
        st.catalogs.providers.find((p) => p.oauth && p.id === "anthropic")?.id ??
        st.catalogs.providers.find((p) => p.oauth)?.id ??
        "anthropic";
      this.store.setNeedsModelAuth({ nodeId, provider });
    }, FIRST_RUN_MODEL_AUTH_GRACE_MS);
  }

  /** Dismiss the first-run model-auth prompt (user chose to handle it later). */
  dismissModelAuthPrompt(): void {
    this.store.setNeedsModelAuth(null);
  }

  /** Destroy a configured ephemeral machine shortly after agent_end. The short
   * grace period lets final transcript/PR metadata flush first. A queued
   * follow-up suppresses teardown; its eventual agent_end will try again.
   *
   * This is the device-driven FAST PATH, kept for snappy teardown while a device
   * is watching. It is no longer the sole authority: the machine's own daemon now
   * self-terminates once idle (BIVY_EPHEMERAL — see src/ephemeral-teardown.ts) and
   * the control-plane reconciler reaps leak-prone providers, so teardown happens
   * even with no device online. Provider destroy is idempotent/404-tolerant, so
   * these paths race harmlessly; TTL remains the final backstop. */
  private maybeTeardownFinishedEphemeral(sessionId: string): Promise<void> {
    return this.ephemeralCoordinator.teardownFinishedSession(sessionId);
  }

  listEphemeralSizes(providerId: string, region?: string): Promise<ProviderSize[]> {
    return this.ephemeralCoordinator.listSizes(providerId, region);
  }
  launchEphemeral(opts: LaunchOpts): Promise<EphemeralMachine> { return this.ephemeralCoordinator.launch(opts); }
  destroyEphemeral(machine: EphemeralMachine): Promise<void> { return this.ephemeralCoordinator.destroy(machine); }
  resumeAndConnectNode(nodeId: string, timeoutMs = 90_000): Promise<void> { return this.ephemeralCoordinator.resumeAndConnect(nodeId, timeoutMs); }

  /** Base control-plane URL + bearer for the account-authenticated (`requireUser`)
   *  session-correlation endpoints. */
  private correlationApi() {
    const base = (this.local.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
    return { base, auth: { authorization: `Bearer ${this.local.s}`, "content-type": "application/json" } };
  }

  /** Pull the account's durable session↔machine correlations so a torn-down
   *  session stays rebuildable (Gap 1). Best-effort; failures leave the cache. */
  private async refreshEphemeralCorrelations(): Promise<void> {
    if (this.direct || !this.local.s) return;
    try {
      const { base, auth } = this.correlationApi();
      const res = await fetch(`${base}/session-correlation`, { headers: { authorization: auth.authorization } });
      if (!res.ok) return;
      const data = (await res.json()) as { correlations?: SessionCorrelation[] };
      if (Array.isArray(data.correlations)) this.ephemeralCorrelations = data.correlations;
    } catch {
      // best-effort — keep whatever we had
    }
  }

  /** Persist (upsert) the session↔machine correlation for a machine this device
   *  launched, so it survives the node's teardown/unenroll (Gap 1). Deduped per
   *  (node, session); updates the local cache so an immediate rebuild sees it. */
  private async recordSessionCorrelation(sessionId: string, machine: EphemeralMachine): Promise<void> {
    if (this.direct || !this.local.s || !machine.nodeId || !sessionId) return;
    const dedupe = `${machine.nodeId}:${sessionId}`;
    if (this.correlatedSessions.has(dedupe)) return;
    this.correlatedSessions.add(dedupe);
    const body: SessionCorrelation = {
      sessionId,
      nodeId: machine.nodeId,
      provider: machine.provider,
      region: machine.region || undefined,
      ttlMinutes: machine.ttlMinutes,
      repo: machine.repo,
      setupId: machine.setupId,
      machineId: machine.id,
      app: machine.app,
      computeSource: machine.computeSource,
    };
    try {
      const { base, auth } = this.correlationApi();
      await fetch(`${base}/session-correlation/${encodeURIComponent(sessionId)}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
      this.ephemeralCorrelations = [body, ...this.ephemeralCorrelations.filter((c) => c.sessionId !== sessionId)];
    } catch {
      this.correlatedSessions.delete(dedupe); // let a later attempt retry
    }
  }

  reprovisionEphemeral(nodeId: string, sessionId: string): Promise<void> {
    return this.ephemeralCoordinator.reprovision(nodeId, sessionId);
  }
  isCurrentNodeResumable(): boolean { return this.ephemeralCoordinator.isCurrentNodeResumable(); }
  private shouldAutoResume(): boolean {
    return this.isCurrentNodeResumable() && !this.resumingNode.has(this.local.cur);
  }
  /** Bring the current session's node back: `reprovisionEphemeral` self-selects
   *  wake (suspend providers) vs rebuild (destroy providers). Guarded so repeated
   *  sends while it's coming up don't re-trigger it. */
  private async resumeNodeForSession(sessionId: string): Promise<void> {
    const nodeId = this.local.cur;
    if (!nodeId || this.resumingNode.has(nodeId)) return;
    this.resumingNode.add(nodeId);
    try {
      await this.reprovisionEphemeral(nodeId, sessionId);
    } finally {
      this.resumingNode.delete(nodeId);
    }
  }
  /** Replay prompts buffered while the node was offline/resuming, once it's back
   *  online — the deferred half of the "sending is the resume gesture" flow. */
  private drainPendingResume(sessionId: string): void {
    const mine = this.pendingResume.filter((p) => p.sessionId === sessionId);
    if (!mine.length) return;
    this.pendingResume = this.pendingResume.filter((p) => p.sessionId !== sessionId);
    for (const p of mine) {
      this.send({ kind: "prompt", sessionId, text: p.text, clientMessageId: p.clientMessageId, attachments: p.attachments });
    }
  }

  // --- GitHub work queue on ephemeral servers (issue #532) ----------------
  // Reuses the exact provision/destroy lifecycle above; the only new pieces are
  // (1) booting the machine opted into the hosted work queue and pre-labelled so
  // it can be targeted, and (2) the account-level default that lets a signed-in
  // device offer to auto-provision a general-purpose runner when the queue has
  // work and no persistent node is online.

  private githubTaskToken: GithubTaskTokenStore = createGithubTaskTokenStore();

  /** The saved GitHub token (if any) an ephemeral queue runner boots with. */
  getGithubTaskToken(): Promise<string> {
    return this.githubTaskToken.get();
  }
  setGithubTaskToken(token: string): Promise<void> {
    return this.githubTaskToken.set(token);
  }
  removeGithubTaskToken(): Promise<void> {
    return this.githubTaskToken.remove();
  }

  /**
   * Provision an ephemeral server for ONE pending queue item and assign the item
   * to it — the per-item "Run on ephemeral server" action in the queue UI. The
   * label is known as soon as the machine is provisioned (derived from its node
   * id), so the item can be assigned before the machine has even booted; the
   * machine then picks it up via the normal hosted-queue poll once it's up.
   */
  runWorkItemOnEphemeral(
    id: string,
    opts: { provider: string; region?: string; size?: string; ttlMinutes?: number; runtimeId?: string; model?: string; configId?: string },
  ): Promise<EphemeralMachine> {
    return this.ephemeralCoordinator.runWorkItem(id, opts);
  }

  /**
   * Provision a general-purpose ephemeral server that serves the shared queue
   * (no specific item), so incoming work can run without a persistent node —
   * the queue-level "auto-provision" default's manual/triggered form.
   */
  launchEphemeralQueueWorker(opts: { provider: string; region?: string; size?: string; ttlMinutes?: number; configId?: string }): Promise<EphemeralMachine> {
    return this.ephemeralCoordinator.launchQueueWorker(opts);
  }

  /** The account's saved ephemeral-queue-default preference (whether/how to
   *  auto-provision), shared across the account's devices. */
  getEphemeralQueueDefault(): Promise<EphemeralQueueDefault> {
    return fetchEphemeralQueueDefault(this.local);
  }
  setEphemeralQueueDefault(patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault> {
    return setEphemeralQueueDefault(this.local, patch);
  }
  /** Account-level ephemeral node configs (shared across the account's devices). */
  listEphemeralConfigs(): Promise<EphemeralNodeConfig[]> {
    return this.ephemeralCoordinator.listConfigs();
  }
  createEphemeralConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig> {
    return this.ephemeralCoordinator.createConfig(input);
  }
  updateEphemeralConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig> {
    return this.ephemeralCoordinator.updateConfig(id, patch);
  }
  removeEphemeralConfig(id: string): Promise<void> {
    return this.ephemeralCoordinator.removeConfig(id);
  }
  /** The account's default queue routing (primary runner + optional fallback). */
  getQueueRouting(): Promise<QueueRouting> {
    return fetchQueueRouting(this.local);
  }
  setQueueRouting(routing: QueueRouting): Promise<QueueRouting> {
    return apiSetQueueRouting(this.local, routing);
  }
  /** Hosted (control-plane-orchestrated) provisioning: status, credentials, audit. */
  getHostedProvisioning(): Promise<HostedProvisioningStatus> {
    return fetchHostedProvisioning(this.local);
  }
  setHostedProvisioning(patch: HostedProvisioningPatch): Promise<HostedProvisioningStatus> {
    return apiSetHostedProvisioning(this.local, patch);
  }
  listHostedAudit(): Promise<HostedAuditEvent[]> {
    return fetchHostedAudit(this.local);
  }
  listHostedMachines(): Promise<HostedMachineSummary[]> {
    return fetchHostedMachines(this.local);
  }
  destroyHostedMachine(nodeId: string): Promise<void> {
    return apiDestroyHostedMachine(this.local, nodeId);
  }
  validateHostedProviderCredential(provider: string, token: string, region?: string): Promise<void> {
    return apiValidateHostedProviderCredential(this.local, provider, token, region);
  }
  rotateHostedProvisioning(): Promise<HostedProvisioningStatus> {
    return apiRotateHostedProvisioning(this.local);
  }
  triggerHostedProvision(execute = false) {
    return apiTriggerHostedProvision(this.local, execute);
  }

  // --- Terminal ----------------------------------------------------------

  onTerminal(fn: (e: ServerEvent) => void): () => void {
    this.terminalListeners.add(fn);
    return () => this.terminalListeners.delete(fn);
  }

  /** Send a terminal.* command (open/attach/input/resize/close, list, mux). */
  sendTerminal(cmd: Command): void {
    this.send(cmd);
  }

  /** "Take over in chat": stop the interactive TUI that currently owns a session
   *  and return it to governed chat. The node closes the PTY, rebuilds the
   *  session from disk, and broadcasts `terminal.tui {active:false}` to unlock
   *  the composer everywhere. */
  closeSessionTui(sessionId: string): void {
    this.send({ kind: "terminal.close.tui", sessionId });
  }

  /** Apply a pasted device-link payload (QR text) and reconnect. */
  applyLinkPayload(text: string): boolean {
    if (!consumeLinkPayload(this.local, text)) return false;
    // A QR/device-link payload can carry a fresh session token — keep the
    // reactive auth flag in step so the shell renders even if this is the first
    // token this client has held.
    this.store.setSignedIn(this.signedIn);
    this.switchNode(this.local.cur);
    void this.refreshNodes();
    return true;
  }

  /**
   * A session lifecycle broadcast changed the set of sessions on the node (a
   * session was created — possibly by the CLI/terminal or another device —
   * renamed by its first message, or removed). The store already folds the event
   * into local state for an instant sidebar update; re-pull the authoritative
   * `sessions.list` so names/order/status converge exactly as the legacy client
   * did. Drop the transcript cache for a deleted session. Mirrors the
   * `sendFrame({kind:"sessions.list"})` calls in public/app/remote-app.js.
   */
  private reconcileSessionList(event: { type?: string; sessionId?: string }): void {
    switch (String(event.type || "")) {
      // session.created is reconciled via store.onSessionCreatedElsewhere.
      case "session.renamed":
      case "session.branch_renamed":
      case "session.closed":
        this.refreshSessions();
        return;
      case "session.deleted":
        if (event.sessionId) void this.transcriptCache.delete(event.sessionId);
        this.refreshSessions();
        return;
      default:
        return;
    }
  }

  /**
   * The node broadcasts `runtime.updated` once a `runtime.select` (agent switch)
   * has actually landed — and only then is the new runtime authoritative for a
   * model query. Pull a fresh models.list so the composer shows the models the
   * new agent supports and defaults to its own model, instead of whatever the
   * previous agent had. Requesting models any earlier races the switch and reads
   * the old runtime (the agent/model mismatch bug); this is the same ordering the
   * legacy client relies on.
   */
  private maybeRefreshModelsForRuntime(event: { type?: string }): void {
    if (event.type === "runtime.updated") this.listModels();
  }

  /**
   * Re-send the in-flight `session.new` after a reconnect/foreground when its
   * reply never arrived (mobile Safari silently drops a backgrounded PWA's
   * WebSocket events). Fires the exact same frame — same requestId — so the node,
   * which dedupes `session.new` by requestId, re-emits the existing session's
   * `session.history` instead of creating a duplicate. That reply is matched by
   * maybeFlushPendingPrompt, which binds the session and flushes the queued
   * prompt. No-op once the session has bound (pendingPrompt cleared).
   */
  private retryPendingSessionNew(): void {
    if (!this.pendingPrompt) return;
    if (this.store.getState().activeSession.activeSessionId) return;
    this.send(this.pendingPrompt.frame);
  }

  private maybeFlushPendingPrompt(event: { type?: string; requestId?: string; sessionId?: string }): void {
    if (!this.pendingPrompt) return;
    if (event.type !== "session.history") return;
    // Must be *our* session.new response, not any other session.history event
    // (e.g. opening an unrelated existing session, or a post-reconnect history
    // refresh) — those never carry our requestId. A falsy-requestId fallthrough
    // here used to let such an event match by accident, silently misdirecting
    // the very first message (and the naming it triggers) into the wrong
    // session while this one was permanently stranded on its placeholder name.
    if (event.requestId !== this.pendingPrompt.requestId) return;
    const sessionId = event.sessionId || this.store.getState().activeSession.activeSessionId;
    if (!sessionId) return;
    // The draft just became a real session — swap /sessions/new for its id so the
    // URL is copyable. Replace (not push) so Back doesn't land on an empty draft.
    navigate({ kind: "session", id: sessionId }, { replace: true });
    const { text, clientMessageId: cmid, attachments } = this.pendingPrompt;
    this.pendingPrompt = null;
    this.send({ kind: "prompt", sessionId, text, clientMessageId: cmid, attachments });
    // Drain any prompts the user sent while this session was still being created.
    // They were queued (not fired as their own session.new) precisely so they'd
    // land in this one session instead of spawning duplicates — send them now,
    // in order, to the session that just came into being.
    const followups = this.pendingFollowups;
    this.pendingFollowups = [];
    for (const f of followups) {
      this.send({ kind: "prompt", sessionId, text: f.text, clientMessageId: f.clientMessageId, attachments: f.attachments });
    }
    // The session now exists on the node — pull it into the sidebar list, which
    // otherwise wouldn't show a freshly created session until the next reconnect.
    this.refreshSessions();
  }

  abort(): void {
    const active = this.store.getState().activeSession.activeSessionId;
    if (active) this.send({ kind: "abort", sessionId: active });
  }

  resolveTurnAttention(sessionId: string, action: "stop" | "continue"): void {
    this.send({ kind: "session.turn_attention.resolve", sessionId, action });
  }

  // --- Queued follow-ups (issue #154) -------------------------------------
  //
  // A prompt sent to an already-busy session used to go straight over the
  // wire and rely on the node/runtime to sort out ordering (its default is to
  // "steer" the running turn — see src/server.ts's promptOptionsFor). That left
  // a follow-up invisible and uneditable the instant it was sent. Now it's
  // held in AppState.followupsBySession (visible, editable, reorderable) until
  // either the current turn settles (auto-drain, one at a time, in display
  // order) or the user explicitly pushes it through early (sendFollowupNow /
  // steerNow). See SessionStore's queued-follow-ups CRUD for the data-shape
  // invariants; everything here is about *when* to call it.

  /** Whether this device is signed in to a control plane (account/relay mode),
   *  so scheduled-message persistence has somewhere durable to land. */
  private accountMode(): boolean {
    return Boolean(this.local.s && this.local.cp);
  }

  /** The node that owns a session (SessionSummary.nodeId), when known. */
  private resolveSessionNodeId(sessionId: string): string | undefined {
    return this.store.getState().sessionIndex.sessions.find((s) => s.sessionId === sessionId)?.nodeId;
  }

  /** The routing label a node serves, from its enrolled name (`bivy/<name>`). */
  private resolveNodeLabel(nodeId: string): string | undefined {
    const node = this.store.getState().connection.nodes.find((n) => n.id === nodeId);
    return node?.name ? `bivy/${node.name}` : undefined;
  }

  /**
   * "Send when the turn ends, even if I close the app": mirror a queued
   * follow-up as a one-off scheduled message on the control plane (kind "once",
   * ~60s out, message:true → plain chat turn, targeting this existing session),
   * E2E-sealed with this session's node room key. The node waits for the session
   * to go idle and dedupes against the transcript, so this backstop can never
   * double-send a follow-up the app already delivered in-app — it only fires if
   * the app never got to deliver it. Non-fatal everywhere: failure just means
   * the in-memory queue is the only delivery path.
   */
  private async persistScheduledFollowup(sessionId: string, id: string, text: string): Promise<void> {
    if (!this.accountMode() || !text) return;
    const nodeId = this.resolveSessionNodeId(sessionId);
    if (!nodeId) return;
    const roomKeyB64 = this.local.keys()[nodeId];
    if (!roomKeyB64) return;
    try {
      const roomKey = await importRoomKey(unb64url(roomKeyB64));
      const encrypted = await seal(roomKey, text);
      const at = new Date(Date.now() + 60_000).toISOString();
      const created = await createAutomation(this.local, {
        name: "Follow-up",
        templateCiphertext: `${TEMPLATE_PREFIX}:${nodeId}:${encrypted}`,
        trigger: "schedule",
        schedule: { kind: "once", at },
        nodeLabel: this.resolveNodeLabel(nodeId),
        targetKind: "existing_session",
        targetSessionId: sessionId,
        message: true,
        enabled: true,
      });
      // If the item already dispatched/confirmed while the create round-trip was
      // in flight, it no longer needs the backstop — cancel it.
      if (!this.store.attachFollowupAutomation(sessionId, id, created.id)) {
        this.cancelScheduledFollowup(created.id);
      }
    } catch {
      // Best-effort: keep the in-memory queue path as the only delivery.
    }
  }

  /** Start a durable account Run; validation, encryption and routing live in the account coordinator. */
  startRun(instruction: string, options: { approvalMode: "risky" | "autonomous"; maxAttempts: number }): Promise<{ runId?: string; error?: string }> {
    return this.accountCoordinator.startRun(instruction, options);
  }

  /** Drop the control-plane backstop for a follow-up (user cancelled it, or it
   *  was delivered in-app). */
  private cancelScheduledFollowup(automationId?: string): void {
    if (!automationId) return;
    void deleteAutomation(this.local, automationId).catch(() => {});
  }

  /** Reschedule a pending scheduled-message row (the queue's "edit schedule"
   *  action): move the control-plane automation to the new time and update the
   *  row's fire time in place. The automation keeps its id, so the row id still
   *  matches it and cancel/resync keep working. Returns an error message on
   *  failure, null on success. */
  async editScheduledFollowup(sessionId: string, id: string, at: Date): Promise<string | null> {
    const item = this.store.getFollowups(sessionId).find((f) => f.id === id);
    if (!item || item.status !== "scheduled") return "This message is no longer pending.";
    if (!item.scheduledAutomationId) return "This message has no automation to update.";
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return "Pick a time in the future.";
    try {
      await updateAutomation(this.local, item.scheduledAutomationId, { schedule: { kind: "once", at: at.toISOString() } });
    } catch (e) {
      return e instanceof Error ? e.message : "Could not reschedule the message.";
    }
    this.store.rescheduleFollowup(sessionId, id, at.getTime(), Date.now());
    return null;
  }

  /** Reconcile the queue's "scheduled" rows against the control plane: drop any
   *  whose automation is gone or no longer pending — it fired (a one-off
   *  scheduled message flips `enabled` off and clears `nextRunAt` the moment
   *  it's enqueued for delivery), was cancelled from another device, or was
   *  deleted. Runs on reconnect so a message that delivered while this app was
   *  closed stops showing as "scheduled" in the queue. Non-fatal everywhere. */
  private async resyncScheduledFollowups(): Promise<void> {
    if (!this.accountMode()) return;
    let all: AccountAutomation[];
    try {
      all = await fetchAutomations(this.local);
    } catch {
      return; // offline / control plane unreachable — leave rows in place
    }
    const pending = new Set(all.filter((a) => a.enabled && a.nextRunAt != null).map((a) => a.id));
    for (const sessionId of Object.keys(this.store.getState().sessionIndex.followupsBySession)) {
      this.store.pruneScheduledFollowups(sessionId, pending);
    }
  }

  /** Whether the active runtime has advertised it can safely accept an
   *  explicit mid-turn interrupt (`streamingBehavior: "steer"`). Read from the
   *  live capabilities merged onto the selected runtime row (session.created /
   *  session.capabilities — see SessionStore.mergeRuntimeCapabilities and
   *  src/runtime/types.ts's RuntimeCapabilities.streamingBehaviors on the
   *  node). The composer/queue UI use this to decide whether "Steer current
   *  turn" is even offered; when false, a busy session only ever queues —
   *  never attempts an interrupt the runtime hasn't promised to honor. See
   *  packages/core/src/followups.ts's supportsSteering for the (unit tested)
   *  capability check itself. */
  supportsSteering(): boolean {
    return this.followupCoordinator.supportsSteering();
  }

  /** The queue for a session, in delivery order. */
  getFollowups(sessionId: string): PendingFollowup[] {
    return this.followupCoordinator.list(sessionId);
  }

  /** Edit a still-queued item. `expectedVersion` must match the version the
   *  caller last read (see PendingFollowup.version) — a mismatch means it
   *  changed underneath the editor (another tab, or it started sending while
   *  the edit was open) and is rejected rather than silently overwritten; the
   *  caller should show the current (already-reactive) state and let the user
   *  retry instead of reapplying their edit over it. */
  editFollowup(sessionId: string, id: string, patch: { text: string; attachments?: PromptAttachment[] }, expectedVersion: number): FollowupEditResult {
    return this.followupCoordinator.edit(sessionId, id, patch, expectedVersion);
  }

  /** Remove a still-queued item. No-op once it's already dispatched. */
  removeFollowup(sessionId: string, id: string): boolean {
    return this.followupCoordinator.remove(sessionId, id);
  }

  /** Reorder a still-queued item to `toIndex` among the queue. No-op once it's
   *  already dispatched. */
  reorderFollowup(sessionId: string, id: string, toIndex: number): boolean {
    return this.followupCoordinator.reorder(sessionId, id, toIndex);
  }

  /**
   * Force a still-queued item to the front and deliver it as soon as possible:
   * immediately if the session has gone idle since it was queued, as an
   * explicit steer if it's busy and the runtime supports one (see
   * supportsSteering), or otherwise just promoted to the front — sending it
   * into a busy runtime with no real steer semantics would silently interrupt
   * it, so it stays queued for the normal turn-end drain instead. No-op for an
   * item that isn't (or is no longer) queued.
   */
  sendFollowupNow(sessionId: string, id: string): void {
    this.followupCoordinator.sendNow(sessionId, id);
  }

  /**
   * The explicit "Steer current turn" action: inject `text` into the running
   * turn right now, bypassing the queue entirely (it never becomes a queued
   * item). No-op unless the session is actually busy and the runtime
   * advertised steer support — the composer only offers this action when both
   * hold, but a stale click (the turn just ended, or the runtime changed) must
   * not fall back to silently queueing something the user asked to inject NOW
   * — so this returns whether it actually sent, and the caller (the composer)
   * only clears the draft on a true send, never discarding unsent text.
   */
  steerNow(text: string, attachments?: PromptAttachment[]): boolean {
    return this.followupCoordinator.steer(text, attachments);
  }

  // --- Session lifecycle actions -----------------------------------------

  renameSession(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Optimistically reflect the rename in the list + title.
    const s = this.store.getState();
    if (sessionId === s.activeSession.activeSessionId) this.store.setActiveTitle(trimmed);
    this.store.renameSessionLocal(sessionId, trimmed);
    this.send({ kind: "session.rename", sessionId, name: trimmed });
    this.refreshSessions();
  }

  deleteSession(sessionId: string, path?: string): void {
    this.sessionCoordinator.deleteSession(sessionId, path);
  }

  pauseSession(sessionId?: string): void {
    this.sessionCoordinator.pauseSession(sessionId);
  }

  resumeSession(sessionId?: string): void {
    this.sessionCoordinator.resumeSession(sessionId);
  }

  /** Force this session's PR status to re-sync with GitHub right now, instead
   *  of waiting for its next turn. Works even when the session isn't live — the
   *  node resumes it just enough to check. */
  refreshPrStatus(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSession.activeSessionId;
    if (id) this.send({ kind: "session.pr.refresh", sessionId: id });
  }

  /** Global scan: reconcile every session this node has tracked that carries
   *  PR state against GitHub, so stale `open` badges left by finished/detached
   *  sessions get a chance to flip to merged/closed without an in-session
   *  round trip. Result arrives as `sessions.pr_refresh_result`. */
  refreshAllPrStatus(): void {
    this.send({ kind: "sessions.pr.refresh_all" });
  }

  /** Universal Agent Harness: restore the session's workspace to a checkpoint
   *  (e.g. the state before the last turn). */
  rewind(checkpointId: string, sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSession.activeSessionId;
    if (id && checkpointId) this.send({ kind: "session.rewind", sessionId: id, checkpointId });
  }

  /** Revert one changed file to its pre-turn content (C3d) — a per-file undo that
   *  doesn't rewind the whole turn. `content` is the file's pre-turn text, or null
   *  when the turn added the file (revert = remove it). */
  revertFile(path: string, content: string | null, sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSession.activeSessionId;
    if (id && path) this.send({ kind: "session.revert_file", sessionId: id, path, content });
  }

  /** Ask the node for this session's checkpoint list (rewind targets). */
  listCheckpoints(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSession.activeSessionId;
    if (id) this.send({ kind: "session.checkpoints", sessionId: id });
  }

  /** `remember` = "and allow this for the rest of the session" — only offered
   *  when the node set `rememberKey` on the request; the node ignores it on a
   *  reject or on a backstop prompt. */
  resolveApproval(id: string, approved: boolean, remember = false): void {
    this.send({ kind: "approval", id, approved, ...(approved && remember ? { remember: true } : {}) });
    if (!this.direct) void recordProductMetric(this.local, "remote_intervention", matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop").catch(() => {});
  }

  /** Answer a pending clarifying question (see UserQuestionRequest). Unlike
   *  resolveApproval, the node needs `sessionId` to find the right session —
   *  approvals are looked up in a single global list keyed by id alone. */
  answerQuestion(requestId: string, sessionId: string | undefined, answers: Record<string, string>): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, answers });
    if (!this.direct) void recordProductMetric(this.local, "remote_intervention", matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop").catch(() => {});
  }

  cancelQuestion(requestId: string, sessionId: string | undefined): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, cancelled: true });
    if (!this.direct) void recordProductMetric(this.local, "remote_intervention", matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop").catch(() => {});
  }
}

export const controller = new AppController();
