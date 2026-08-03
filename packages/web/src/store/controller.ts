// SPDX-License-Identifier: FSL-1.1-ALv2
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
  fetchAccountSessions,
  fetchMe,
  fetchGithubApp,
  fetchGithubQueue,
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
  rotateHostedProvisioning as apiRotateHostedProvisioning,
  triggerHostedProvision as apiTriggerHostedProvision,
  type EphemeralNodeConfig,
  type EphemeralConfigInput,
  type QueueRouting,
  type HostedProvisioningStatus,
  type HostedProvisioningPatch,
  type HostedAuditEvent,
  removeAccountNode,
  fetchPairedDevices,
  removePairedDevice,
  logout,
  billingCheckout,
  billingPortal,
  enablePushNotifications,
  disablePushNotifications,
  getPushSubscriptionStatus,
  getNotificationPreferences,
  setNotificationPreferences,
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  createEphemeralPrefsStore,
  createEphemeralSetupStore,
  createMachineStore,
  createGithubTaskTokenStore,
  createTranscriptCache,
  cloudExec,
  launchEphemeralMachine,
  destroyEphemeralMachine,
  wakeEphemeralMachine,
  ephemeralProviderSuspendsWhenIdle,
  ephemeralMachineFromNode,
  isEphemeralNode,
  ephemeralMachineFromCorrelation,
  type SessionCorrelation,
  createDeviceVaultKeyStore,
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
  mustQueueFollowup,
  type ModelInfo,
  nextQueuedFollowup,
  type PendingFollowup,
  type PromptAttachment,
  type Ruleset,
  type RuntimeInfo,
  type ServerEvent,
  type StreamingBehavior,
  supportsSteering as runtimeSupportsSteering,
  type Transport,
  importRoomKey,
  open as openSealed,
  unb64url,
} from "@bivy/core";
import { navigate, parseRoute, routePath, type Route } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";

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
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clientMessageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

/** How long to wait after a launched ephemeral runner comes online before
 *  concluding it has no model credentials and raising the first-run sign-in
 *  prompt — long enough for hosted-escrow / peer-vault sync to land first. */
const FIRST_RUN_MODEL_AUTH_GRACE_MS = 8000;

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
  private transport: Transport;
  /** A first prompt queued while a brand-new session is being created. `frame` is
   *  the exact `session.new` command we sent; it's re-fired verbatim after a
   *  reconnect (mobile Safari can drop the reply while backgrounded) — the node
   *  dedupes by requestId, so the retry adopts the same session rather than
   *  creating a duplicate. See retryPendingSessionNew / maybeFlushPendingPrompt. */
  private pendingPrompt: { text: string; requestId: string; clientMessageId: string; attachments?: PromptAttachment[]; frame: Command } | null = null;
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
  /** In-flight transcription requests, resolved when the node returns text. */
  private pendingTranscriptions = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** In-flight session-fork requests (export → bundle, import → done), by requestId. */
  private pendingForks = new Map<string, { resolve: (event: ServerEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
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
  /** Subscribers that want the composer input focused (e.g. after "New"). */
  private composerFocusListeners = new Set<() => void>();
  /** Subscribers that want the composer's slash-command menu opened (the "/" pill). */
  private slashOpenListeners = new Set<() => void>();

  constructor() {
    // Persist each applied history snapshot + cursor, and re-request canonical
    // history once a live turn settles (drives the P1.1 append-only backfill).
    this.store.onHistoryPersist = (sessionId, messages, count, historyHash) => {
      const attachments = this.store.attachmentsForHistory(messages);
      void this.transcriptCache.put(sessionId, messages, count, historyHash, attachments);
    };
    this.store.requestFreshHistory = () => {
      const sid = this.store.getState().activeSessionId;
      if (sid) this.requestHistory(sid);
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
      const sid = this.store.getState().activeSessionId;
      if (sid) {
        this.store.settleSendingFollowups(sid);
        this.drainFollowups(sid);
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
    // The hosted client remembers this origin as its control plane.
    if (!this.direct && !this.local.cp) this.local.cp = location.origin;
    this.transport = this.buildTransport();
    this.store.setCurrentNode(this.direct ? null : this.local.cur || null);
    // Instant sidebar: paint the last known session list for this node from a
    // synchronous localStorage cache before the socket connects and the
    // authoritative sessions.list arrives. Also start persisting live updates.
    this.seedSessionsFromCache();
    this.installSessionCachePersist();
    if (!this.direct && this.local.s) void this.refreshAccountSessions();
    // Seed the reactive auth flag from the token we may have just consumed above,
    // so the very first render lands on the right surface (sign-in vs. shell).
    this.store.setSignedIn(this.signedIn);
    // Handle a return from Stripe checkout (?checkout=success|cancel) and a
    // "Go Pro" deep link from the marketing site (?intent=upgrade). Runs after
    // the auth flag is seeded so the upgrade intent can resume the moment the
    // user is signed in (a fresh sign-in redirect lands here already signed in).
    this.handleBillingReturn();
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

  /** localStorage key marking a pending "Go Pro" intent that must survive the
   *  full-page sign-in redirect (which drops the query string). */
  private static readonly UPGRADE_INTENT_KEY = "bivy_upgrade_intent";

  /**
   * React to a Stripe checkout return and to a "Go Pro" deep link:
   *   - `?checkout=success` → confirmation banner (the plan flips via webhook,
   *     which the Account panel picks up on its next /me fetch).
   *   - `?checkout=cancel`  → neutral "still on free" banner, no dead-end.
   *   - `?intent=upgrade`   → resume checkout. If signed in, redirect straight to
   *     Stripe; if not, remember the intent so it fires once sign-in completes.
   * Consumed params are stripped so they neither linger nor re-fire on reload.
   */
  private handleBillingReturn(): void {
    let checkout = "";
    let intent = "";
    try {
      const params = new URLSearchParams(location.search);
      checkout = (params.get("checkout") || "").trim();
      intent = (params.get("intent") || "").trim();
      if (checkout || intent) {
        params.delete("checkout");
        params.delete("intent");
        const qs = params.toString();
        history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      }
    } catch {
      /* ignore malformed query */
    }

    if (checkout === "success") {
      // A completed checkout supersedes any remembered intent.
      this.clearUpgradeIntent();
      this.store.setNotice("You're on Pro — thanks! Unlimited runs are unlocked. It may take a few seconds to show in Settings.");
      return;
    }
    if (checkout === "cancel") {
      this.clearUpgradeIntent();
      this.store.setNotice("Checkout canceled — you're still on the free plan. Upgrade any time from Settings.");
      return;
    }

    if (intent === "upgrade") {
      if (this.signedIn) {
        void this.startCheckout().catch((e) => this.store.setError(e instanceof Error ? e.message : String(e)));
      } else {
        // Persist across the sign-in redirect; resumed below on the next load.
        try { localStorage.setItem(AppController.UPGRADE_INTENT_KEY, "1"); } catch { /* ignore */ }
      }
      return;
    }

    // No billing params this load: resume a remembered "Go Pro" intent once the
    // user has signed in (e.g. right after the OAuth/magic-link redirect).
    if (this.signedIn && this.hasUpgradeIntent()) {
      this.clearUpgradeIntent();
      void this.startCheckout().catch((e) => this.store.setError(e instanceof Error ? e.message : String(e)));
    }
  }

  private hasUpgradeIntent(): boolean {
    try { return localStorage.getItem(AppController.UPGRADE_INTENT_KEY) === "1"; } catch { return false; }
  }

  private clearUpgradeIntent(): void {
    try { localStorage.removeItem(AppController.UPGRADE_INTENT_KEY); } catch { /* ignore */ }
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
          }
          for (const fn of this.terminalListeners) fn(event);
          return;
        }
        // One-shot transcription result — resolve the awaiting caller and stop;
        // it never touches the session reducer.
        if (type === "transcription") {
          this.resolveTranscription(event);
          return;
        }
        // One-shot session-fork replies (bundle / done / error) resolve the
        // awaiting forkSession() step; only the error variant is surfaced in the
        // reducer (as a toast) — the rest is orchestration, not session state.
        if (type === "session.fork.bundle" || type === "session.fork.done" || type === "session.fork.error") {
          this.resolveFork(event);
          return;
        }
        // Promotion reply (continue a replicated session on the standby) reuses
        // the same keyed request/reply correlation as fork.
        if (type === "session.promote.result") {
          this.resolveFork(event);
          return;
        }
        const appliedEvent = this.eventWithNodeScope(event);
        this.store.apply(appliedEvent);
        this.maybeFlushPendingPrompt(appliedEvent);
        this.maybeConfirmFollowup(appliedEvent);
        this.maybeRestoreDraftAgent(appliedEvent);
        this.maybeRefreshModelsForRuntime(appliedEvent);
        this.reconcileSessionList(appliedEvent);
      },
      onStatus: (status: ConnectionStatus) => {
        const prev = this.store.getState().status;
        this.store.setStatus(status);
        if (status === "online" && prev !== "online") this.onReconnected();
        else if (status === "reconnecting" || status === "offline") {
          this.store.markStreamInterrupted();
          // Re-pull the node list on the *transition* into a dropped state so the
          // header's online dot reflects the node's real presence instead of a
          // stale green left over from connect time — the "node seems online but
          // stuck reconnecting" confusion. Throttled so the reconnect backoff
          // loop can't hammer /nodes.
          if (prev !== "reconnecting" && prev !== "offline") this.refreshNodesThrottled();
        }
      },
      onError: (message: string) => this.store.setError(message),
    };
    return this.direct
      ? new DirectTransport({ bootstrap: new URLSearchParams(location.search).get("bootstrap") || "", handlers })
      : new RelayTransport({ store: this.local, handlers });
  }

  /** Hosted control plane, not signed in yet. */
  needsAuth(): boolean {
    return !this.direct && !this.local.s;
  }

  /** Signed in on the hosted control plane, but no node picked yet. */
  needsNode(): boolean {
    return !this.direct && Boolean(this.local.s) && !this.local.cur;
  }

  /** True whenever the hosted client can't reach a node yet (auth or node). */
  needsSetup(): boolean {
    return this.needsAuth() || this.needsNode();
  }

  /** List the nodes enrolled on the signed-in account. */
  listNodes(): Promise<AccountNode[]> {
    return fetchAccountNodes(this.local);
  }

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
    this.store.setSignedIn(true);
    // Reconcile the device vault once on sign-in: a producer device satisfies any
    // pending wrapped-key requests from the account's other devices; a consumer
    // device pulls its wrapped key so a synced token is ready to wake a machine.
    void this.syncDeviceVault();
    this.connect();
  }

  connect(): void {
    // On the hosted control plane, don't dial the relay until the user has a
    // session token and a selected node — otherwise surface the setup state.
    if (this.needsSetup()) {
      this.store.setStatus("offline");
      if (this.signedIn) void this.refreshNodes();
      return;
    }
    if (!this.direct) {
      this.store.setCurrentNode(this.local.cur || null);
      void this.refreshNodes();
    }
    void this.transport.connect();
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
    const sid = s.activeSessionId;
    if (sid) {
      const row = s.sessions.find((r) => r.sessionId === sid);
      if (row?.status === "saved") this.openSession(sid);
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
    else if (route.kind !== "settings") this.newSession(opts);
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
      const status = this.store.getState().status;
      // A dead socket → reconnect; the transport's onopen burst re-pulls the
      // session list, models and runtimes. A live socket → refresh explicitly,
      // since no reconnect (and thus no burst) will happen on its own.
      if (status === "offline") {
        this.connect();
        return;
      }
      if (status !== "online") return; // connecting / reconnecting already in flight
      this.refreshSessions();
      const sid = this.store.getState().activeSessionId;
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
      if (this.store.getState().status !== "online") return;
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
    if (this.store.getState().status === "offline") return; // already parked
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

  /** Switch to another node without a full reload. */
  switchNode(nodeId: string): void {
    if (nodeId === this.local.cur && this.store.getState().status === "online") return;
    try {
      this.transport.close();
    } catch {
      /* noop */
    }
    this.local.cur = nodeId;
    this.store.resetSession();
    this.store.setCurrentNode(nodeId);
    // Node selection changes which transport owns the session pane, not which
    // sessions/terminals exist in the sidebar — resetSession() deliberately
    // leaves both alone (issue #99), so there's nothing to restore here.
    // seedSessionsFromCache is a no-op unless the list is genuinely still
    // empty (e.g. switching before the very first load ever completed), in
    // which case it paints instantly from the last cached list while the new
    // node connects and refreshAccountSessions below fetches the
    // authoritative one.
    this.seedSessionsFromCache();
    this.transport = this.buildTransport();
    this.store.setStatus("connecting");
    void this.transport.connect();
    void this.refreshAccountSessions();
  }

  /**
   * Switch to `nodeId` (a no-op if already the current, online node) and wait
   * for the new transport to come online, then refresh `state.providers` for
   * it — `providers.list` is never sent automatically on (re)connect. Used by
   * flows that need a specific node's live state before proceeding (e.g.
   * reconnecting that node's provider OAuth from NodeSwitcher). Throws if the
   * node doesn't come online within `timeoutMs` (see `waitForOnline`).
   */
  async connectToNode(nodeId: string, timeoutMs?: number): Promise<void> {
    if (nodeId !== this.local.cur || this.store.getState().status !== "online") {
      this.switchNode(nodeId);
      await this.waitForOnline(timeoutMs);
    }
    this.listProviders();
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
    void this.transport.send(command);
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
        reject(new Error("Timed out waiting for the node to respond."));
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

  // --- Session fork (docs/session-fork-plan.md) --------------------------------
  // Continue a session in a new one on another node/agent/model. Client-mediated:
  // export the bundle from the source node, (optionally) switch to the
  // destination node, import it there, open the new session, seed it when the
  // fork was cross-runtime, and — for a "move" — retire the source only after the
  // import confirms, so a failed fork never loses the session.

  /** Resolve/reject an in-flight fork step from its matching server reply. */
  private resolveFork(event: ServerEvent): void {
    const rid = String(event.requestId || "");
    const pending = rid ? this.pendingForks.get(rid) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingForks.delete(rid);
    const error = (event as { error?: unknown }).error;
    if (error) pending.reject(new Error(String(error)));
    else pending.resolve(event);
  }

  /**
   * Continue a replicated session on `standbyNodeId` (the warm standby) when its
   * owner is offline: switch to the standby, ask it to promote (control-plane
   * epoch compare-and-set + materialize the replica), and refresh the list.
   * Throws on failure so the caller can surface it.
   */
  async promoteSession(sessionId: string, standbyNodeId: string): Promise<{ epoch: number }> {
    if (standbyNodeId && standbyNodeId !== this.local.cur) {
      this.switchNode(standbyNodeId);
      await this.waitForOnline();
    }
    const reply = await this.forkRequest({ kind: "session.promote", sessionId }, 30000);
    const epoch = Number((reply as { epoch?: unknown }).epoch ?? 0);
    this.refreshAccountSessions();
    return { epoch };
  }

  /** Send a fork command on the current transport and await its keyed reply. */
  private forkRequest(command: Command, timeoutMs: number): Promise<ServerEvent> {
    const rid = requestId();
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingForks.delete(rid);
        reject(new Error("Fork request timed out"));
      }, timeoutMs);
      this.pendingForks.set(rid, { resolve, reject, timer });
      void this.transport.send({ ...command, requestId: rid });
    });
  }

  /** Resolve once the (current) transport reports online, else reject on timeout. */
  private waitForOnline(timeoutMs = 20000): Promise<void> {
    if (this.store.getState().status === "online") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error("Destination node did not come online")); }, timeoutMs);
      const unsub = this.store.subscribe(() => {
        if (this.store.getState().status === "online") { clearTimeout(timer); unsub(); resolve(); }
      });
    });
  }

  /**
   * Fork `sourceSessionId` onto `destNodeId` (default: same node), optionally on a
   * different agent/model, keeping (copy) or retiring (move) the source. `agentId`
   * is the selected TARGET agent (not merely an "agent changed" flag). Returns
   * the new session id + fidelity ("full" | "seeded"). Throws on any step so the
   * caller can surface it and — critically — NOT retire the source.
   */
  async forkSession(
    sourceSessionId: string,
    opts: { destNodeId?: string; agentId?: string; sourceAgentId?: string; model?: { provider: string; id: string }; retireSource?: boolean } = {},
  ): Promise<{ sessionId: string; fidelity: string; missing: Array<{ label?: string; detail?: string }> }> {
    const sourceNodeId = this.local.cur;
    const destNodeId = opts.destNodeId ?? sourceNodeId;
    const crossNode = !this.direct && Boolean(destNodeId) && destNodeId !== sourceNodeId;
    const state = this.store.getState();
    const sourceAgentId = opts.sourceAgentId ?? state.sessions.find((session) => session.sessionId === sourceSessionId)?.runtimeId;
    const targetAgentId = opts.agentId ?? sourceAgentId;
    // If the source runtime is absent from a stale session summary, prefer the
    // explicit target path over silently assuming the source/default runtime.
    const crossAgent = Boolean(targetAgentId && (!sourceAgentId || targetAgentId !== sourceAgentId));

    // Fast path: a same-node, same-agent fork is done entirely on the node — the
    // transcript never round-trips out to the client and back. The model may
    // still change (applied cheaply on the new session). An explicitly selected
    // different target agent falls through to export/import.
    if (!crossNode && !crossAgent) {
      const doneEvent = await this.forkRequest(
        { kind: "session.fork.local", sessionId: sourceSessionId, ...(opts.model ? { model: opts.model } : {}) },
        180000,
      );
      const newSessionId = String((doneEvent as { sessionId?: unknown }).sessionId || "");
      if (!newSessionId) throw new Error("Local fork returned no session id");
      const fidelity = String((doneEvent as { fidelity?: unknown }).fidelity || "full");
      const missingRaw = (doneEvent as { missing?: unknown }).missing;
      const missing = Array.isArray(missingRaw) ? (missingRaw as Array<{ label?: string; detail?: string }>) : [];
      this.openSession(newSessionId);
      // A same-node move retires the source only after the fork confirms.
      if (opts.retireSource) this.send({ kind: "session.delete", sessionId: sourceSessionId });
      return { sessionId: newSessionId, fidelity, missing };
    }

    // 1. Export the bundle from the source node (current transport). Pass the
    //    chosen agent so the source can drop the native transcript payload when
    //    the fork targets a different runtime that could never replay it.
    const exportEvent = await this.forkRequest(
      { kind: "session.fork.export", sessionId: sourceSessionId, ...(targetAgentId ? { agent: targetAgentId } : {}) },
      60000,
    );
    const bundle = (exportEvent as { bundle?: unknown }).bundle;
    if (!bundle) throw new Error("Fork export returned no bundle");

    // 2. Move onto the destination node's transport.
    if (crossNode) {
      this.switchNode(destNodeId!);
      await this.waitForOnline();
    }

    // 3. Import on the destination.
    const transcriptUrl = `${location.origin}${routePath({ kind: "session", id: sourceSessionId })}`;
    const doneEvent = await this.forkRequest({
      kind: "session.fork.import",
      bundle,
      transcriptUrl,
      // A same-node cross-agent fork still shares the source repository. It
      // needs a fresh branch/worktree; adopting the checked-out source branch
      // makes git fail with “already used by worktree”.
      sameNode: !crossNode,
      ...(targetAgentId ? { agent: targetAgentId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    }, 180000);
    const newSessionId = String((doneEvent as { sessionId?: unknown }).sessionId || "");
    const actualAgentId = String((doneEvent as { runtimeId?: unknown }).runtimeId || "");
    if (targetAgentId && actualAgentId && actualAgentId !== targetAgentId) {
      throw new Error(`Fork requested agent ${targetAgentId}, but the destination used ${actualAgentId}`);
    }
    const fidelity = String((doneEvent as { fidelity?: unknown }).fidelity || "seeded");
    const seedPrompt = (doneEvent as { seedPrompt?: unknown }).seedPrompt;
    const missingRaw = (doneEvent as { missing?: unknown }).missing;
    const missing = Array.isArray(missingRaw) ? (missingRaw as Array<{ label?: string; detail?: string }>) : [];
    if (!newSessionId) throw new Error("Fork import returned no session id");

    // 4. Open the new session (already on the destination transport).
    this.openSession(newSessionId);

    // 5. Seed a cross-runtime fork's first turn.
    if (typeof seedPrompt === "string" && seedPrompt.trim()) {
      const cmid = clientMessageId();
      this.store.addUserMessage(seedPrompt, cmid);
      this.send({ kind: "prompt", sessionId: newSessionId, text: seedPrompt, clientMessageId: cmid });
    }

    // 6. Retire the source for a "move" — only now that the import has confirmed.
    if (opts.retireSource) {
      if (crossNode) {
        try {
          this.switchNode(sourceNodeId);
          await this.waitForOnline();
          this.send({ kind: "session.delete", sessionId: sourceSessionId });
        } finally {
          this.switchNode(destNodeId!);
          await this.waitForOnline().catch(() => {});
          this.openSession(newSessionId);
        }
      } else {
        this.send({ kind: "session.delete", sessionId: sourceSessionId });
      }
    }

    return { sessionId: newSessionId, fidelity, missing };
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
      const existing = this.store.getState().sessions;
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
          updatedAt: previous?.updatedAt || s.updatedAt,
        };
      }));
      const live = sessions.filter((s) => s.sessionId && s.nodeId);
      // Gap 1 visibility: a torn-down destroy-lane session cascades out of the
      // control-plane session index when its node is unenrolled, so it would vanish
      // from the sidebar — with nothing to open and send into to trigger a rebuild.
      // Re-add it from the durable correlation (offline, rebuildable), keeping any
      // name/branch we cached before teardown.
      const liveIds = new Set(live.map((s) => s.sessionId));
      const previous = this.store.getState().sessions;
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
      const others = this.store.getState().sessions.filter((s) => s.nodeId && s.nodeId !== currentNode && !currentIds.has(s.sessionId));
      return { ...event, sessions: [...incoming.map((s) => ({ ...s, nodeId: s.nodeId || currentNode })), ...others] } as ServerEvent;
    }
    if (event.type === "session.created") {
      return { ...event, nodeId: currentNode } as ServerEvent;
    }
    if (event.type === "terminal.list") {
      const payload = event as unknown as { terminals?: unknown };
      const incoming = Array.isArray(payload.terminals) ? payload.terminals as Array<Record<string, unknown>> : [];
      const currentIds = new Set(incoming.map((t) => String(t?.termId || "")).filter(Boolean));
      const others = this.store.getState().runTerminals.filter((t) => t.nodeId && t.nodeId !== currentNode && !currentIds.has(t.termId));
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
   *  never persisted, so a transient reset (e.g. switching nodes) can't wipe a
   *  good cache before the new node's list arrives. */
  private installSessionCachePersist(): void {
    if (typeof localStorage === "undefined") return;
    let last = this.store.getState().sessions;
    this.store.subscribe(() => {
      const sessions = this.store.getState().sessions;
      if (sessions === last) return;
      last = sessions;
      if (sessions.length === 0) return;
      try {
        // Cap the cached rows so a node with a very long history can't bloat
        // localStorage; the node's list is newest-first, so keep the head.
        localStorage.setItem(this.sessionCacheKey(), JSON.stringify(sessions.slice(0, 100)));
      } catch {
        /* quota / private mode — caching is best-effort */
      }
    });
  }

  openSessionOnNode(sessionId: string, path?: string, nodeId?: string): void {
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
    // Seed from the persistent cache first (paints even before the node answers),
    // then request history with the cursor so the node sends only the new tail.
    void this.seedAndRequestHistory(sessionId);
  }

  /** Preload the persisted transcript, then request history echoing its cursor. */
  private async seedAndRequestHistory(sessionId: string): Promise<void> {
    try {
      const cached = await this.transcriptCache.get(sessionId);
      // A slow disk read must not clobber a session the user already switched away from.
      if (cached && this.store.getState().activeSessionId === sessionId) {
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
    let openedAfterNodeSwitch = false;
    if (this.pendingCrossNodeOpen) {
      const pending = this.pendingCrossNodeOpen;
      this.pendingCrossNodeOpen = null;
      this.openSession(pending.sessionId, pending.path);
      openedAfterNodeSwitch = true;
    }
    void this.refreshAccountSessions();
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
    const sid = this.store.getState().activeSessionId;
    if (sid && !openedAfterNodeSwitch) {
      this.requestHistory(sid);
      this.retryStuckFollowups(sid);
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
    const model = s.currentModel ? { provider: (s.currentModel as any).provider, id: s.currentModel.id } : undefined;
    return {
      repo: s.draftRepo || undefined,
      // Only meaningful alongside `repo` — a branch is only ever set together
      // with its repo (chooseRepoBranch) and reset when the repo changes
      // (chooseRepo), so this can never leak onto an unrelated repo/workspace.
      branch: s.draftRepo ? s.draftBranch || undefined : undefined,
      agent: s.selectedAgentId || undefined,
      sandbox: s.draftSandbox || undefined,
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

  /**
   * Start a new session as a pure local draft. Nothing is created on the node
   * yet — the user can still change node/agent/model/repo — and the real
   * session (bound to those choices) is created lazily by the first sendPrompt.
   */
  newSession(opts: { navigate?: boolean } = {}): void {
    // Point the URL at the draft route (/sessions/new) so a reload/copy comes
    // back to a fresh session rather than the last one. Skipped when the change
    // originated from the URL itself (popstate).
    if (opts.navigate !== false) navigate({ kind: "new" });
    // Autofocus the composer so the user can start typing right away.
    this.focusComposer();
    this.pendingPrompt = null;
    this.pendingFollowups = [];
    this.store.resetActiveSession();
    // resetActiveSession() just cleared the agent pill (it must not keep
    // showing whichever agent the previously viewed session used). Re-seed the
    // remembered agent/model/repo, then refetch runtimes + models so the picks
    // resolve against what this node supports and the composer repopulates with
    // the user's last-used choices (falling back to the node default when a
    // remembered choice isn't available here).
    this.seedDraftDefaults();
    this.listRuntimes();
    this.listModels();
    // Pull the node's sandbox default so the new-session sandbox pill (and its
    // picker) can label "Node default (<tier>)" up front, before the user opens
    // Settings — the sandbox is chosen here, so its default should be visible here.
    if (!this.store.getState().nodeSettings) this.getNodeSettings();
    // Warm the repo picker in the background so it's ready — usually instantly —
    // by the time the user taps the repo pill, instead of a multi-second wait on
    // first open. Both listings are cached briefly on the node, so re-drafting
    // is cheap. If a repo is already remembered, prefetch its branches too so
    // the branch drill-in is ready as well.
    this.listRepos();
    const repo = this.store.getState().draftRepo;
    if (repo) this.listBranches(repo);
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
    if (s.activeSessionId) return; // only a fresh draft, never a live session
    const wanted = this.local.lastChoice().agentId;
    if (!wanted || wanted === s.selectedAgentId) return;
    const target = s.runtimes.find((r) => r.id === wanted);
    if (!target) return; // not offered on this node — keep the node default
    if (String((target as any).status || "available") !== "available") return;
    this.chooseAgent(target);
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
    const trimmed = text.trim();
    const files = attachments && attachments.length ? attachments : undefined;
    if (!trimmed && !files) return;
    const cmid = clientMessageId();
    const active = this.store.getState().activeSessionId;
    if (active) {
      if (this.mustQueue(active)) {
        this.store.enqueueFollowup(active, { id: cmid, text: trimmed, attachments: files }, Date.now());
        return;
      }
      // The node is offline but this is an ephemeral machine we can bring back
      // (a suspended Sprite, or a torn-down destroy-lane machine we hold the key
      // to rebuild). Sending IS the resume: show the bubble, buffer the prompt,
      // wake/rebuild the machine, and replay on reconnect — no separate button.
      if (this.shouldAutoResume()) {
        this.store.addUserMessage(trimmed, cmid, files);
        this.pendingResume.push({ sessionId: active, text: trimmed, clientMessageId: cmid, attachments: files });
        void this.resumeNodeForSession(active);
        return;
      }
      this.store.addUserMessage(trimmed, cmid, files);
      this.send({ kind: "prompt", sessionId: active, text: trimmed, clientMessageId: cmid, attachments: files });
      return;
    }
    // A session.new is already in flight for this draft: its session.history
    // hasn't landed yet, so activeSessionId is still null. Firing a second
    // session.new here would create a *separate* session on the node — and
    // because each request carries `title`, the node names both immediately, so
    // both surface as duplicate sidebar rows (the duplicate-sessions bug). Queue
    // the extra prompt instead; maybeFlushPendingPrompt drains it into the one
    // session once it's created. Guards double-tapped Send / Enter-before-clear
    // and any rapid resend on a slow link.
    if (this.pendingPrompt) {
      this.store.addUserMessage(trimmed, cmid, files);
      this.pendingFollowups.push({ text: trimmed, clientMessageId: cmid, attachments: files });
      return;
    }
    // No session yet: optimistically show the bubble, create a session, and
    // flush this prompt once session.history arrives for our requestId.
    const rid = requestId();
    // The node names the session (and a repo session's worktree branch) from
    // `title`; send the first message so the sidebar row and branch aren't blank.
    // Keep the exact frame so a post-reconnect retry re-sends it byte-identically.
    const frame: Command = { kind: "session.new", requestId: rid, title: trimmed || undefined, ...this.draftSessionFields() };
    this.pendingPrompt = { text: trimmed, requestId: rid, clientMessageId: cmid, attachments: files, frame };
    this.store.addUserMessage(trimmed, cmid, files);
    this.send(frame);
  }

  /**
   * Invoke a protocol-mode agent command (AgentCommand.mode === "protocol") on the
   * active session. Prompt-mode agent commands are NOT sent here — the composer
   * forwards those as an ordinary prompt. No-op without an active session (there's
   * nothing to run the command against yet).
   */
  invokeAgentCommand(name: string, args: string): void {
    const active = this.store.getState().activeSessionId;
    if (!active) return;
    this.send({ kind: "session.command.invoke", sessionId: active, name, args });
  }

  // --- Composer pickers ---------------------------------------------------

  /** GitHub repos available on the node (for a new session). Stale-while-
   *  revalidate: only show the "Loading repos…" state when we have nothing
   *  cached yet, so a prefetch/reopen paints the last list instantly and
   *  refreshes it in the background instead of flashing a spinner. */
  listRepos(): void {
    if (this.store.getState().repos.length === 0) this.store.setReposLoading(true);
    this.send({ kind: "repos.list" });
  }

  /** Choose a repo for the next new session (persisted for next time). A plain
   *  repo tap PRESERVES an already-chosen branch when it's the same repo — the
   *  branch belongs to it — and only resets the branch/list when the repo
   *  actually changes (or is cleared), since a branch from a different repo is
   *  meaningless here. Use chooseRepoBranch to set an explicit branch. */
  chooseRepo(slug: string | null): void {
    const changed = slug !== this.store.getState().draftRepo;
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
    const haveThisRepo = s.branchesRepo === repo && s.branches.length > 0;
    if (!haveThisRepo) this.store.setBranchesLoading(true);
    this.send({ kind: "branches.list", repo });
  }

  listRuntimes(): void {
    this.send({ kind: "runtimes.list" });
  }

  /** Ask the node for a fresh memory/CPU/storage snapshot. The reply arrives as
   *  a `node.stats` event and lands in `state.nodeStats`. Fire-and-forget; the
   *  stats panel polls this while it's open. */
  requestNodeStats(sessionId?: string): void {
    this.send({ kind: "node.stats", sessionId });
  }

  listModels(): void {
    const sessionId = this.store.getState().activeSessionId ?? undefined;
    this.send({ kind: "models.list", sessionId });
  }

  /** Pick a model. Live session → select now; draft → keep local for session.new. */
  chooseModel(model: ModelInfo): void {
    this.store.setCurrentModelLocal(model);
    this.store.setDraftModel({ provider: (model as any).provider, id: model.id });
    this.local.setLastChoice({ modelProvider: (model as any).provider, modelId: model.id });
    const sessionId = this.store.getState().activeSessionId;
    if (sessionId) this.send({ kind: "model.select", provider: (model as any).provider, id: model.id, sessionId });
  }

  setThinkingLevel(level: string): void {
    const sessionId = this.store.getState().activeSessionId ?? undefined;
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
    const activeSessionId = state.activeSessionId;
    if (activeSessionId) {
      // Agent handoff is a real cross-runtime fork, not a client-side summary in
      // a blank draft. The shared fork path carries normalized history, repo and
      // dirty files, creates the target runtime session, and opens it.
      const sourceAgentId = state.activeRuntimeId
        ?? state.sessions.find((session) => session.sessionId === activeSessionId)?.runtimeId;
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

  // --- Settings: providers / OAuth ---------------------------------------

  listProviders(): void {
    this.send({ kind: "providers.list" });
  }
  getProviderAuth(provider: string): void {
    this.send({ kind: "provider.auth.get", provider });
  }
  /** Save an API key and resolve once the node acks it (or reject with its
   *  error) instead of assuming success the moment it was sent. */
  saveApiKey(provider: string, key: string): Promise<void> {
    return this.awaitAck({ kind: "provider.apiKey", provider, key }).then(() => undefined);
  }
  removeProvider(provider: string): void {
    this.send({ kind: "provider.remove", provider });
  }
  resetOauth(provider: string): void {
    this.send({ kind: "provider.oauth.reset", provider });
  }
  startOauth(provider: string): void {
    this.send({ kind: "provider.oauth.start", provider });
  }
  submitOauthCode(id: string, code: string): void {
    this.send({ kind: "provider.oauth.code", id, code });
  }

  // --- Settings: local / custom model endpoints ---------------------------

  listLocalModels(): void {
    this.send({ kind: "models.custom.list" });
  }
  listLocalModelPresets(): void {
    this.send({ kind: "models.custom.presets" });
  }
  /** Save (create or update) a local/custom provider. `spec` matches the node's
   *  save shape: { providerId, name?, baseUrl, api?, apiKey?, compat?, models[] }.
   *  Resolves once the node acks the save (or rejects with its error) instead
   *  of assuming success the moment it was sent. */
  saveLocalModel(spec: Record<string, unknown>): Promise<void> {
    return this.awaitAck({ kind: "models.custom.save", spec }).then(() => undefined);
  }
  removeLocalModel(id: string): void {
    this.send({ kind: "models.custom.remove", id });
  }

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
  githubAppConnectExisting(input: { appId: string; privateKeyPem: string; nodeLabel?: string }): void {
    this.store.setGithubAppPhase("completing");
    this.send({
      kind: "github.app.connect-existing",
      requestId: requestId(),
      appId: input.appId,
      privateKeyPem: input.privateKeyPem,
      nodeLabel: input.nodeLabel || undefined,
    });
  }

  // --- Settings: account / billing / push --------------------------------

  fetchMe(): Promise<AccountMe> {
    return fetchMe(this.local);
  }
  /** Connected GitHub App info (name + mention handle) for the settings UI. */
  fetchGithubApp(): ReturnType<typeof fetchGithubApp> {
    return fetchGithubApp(this.local);
  }
  /** Recent incoming work items (the GitHub queue), newest first. */
  fetchGithubQueue(limit = 30): ReturnType<typeof fetchGithubQueue> {
    return fetchGithubQueue(this.local, limit);
  }
  /** Set (empty string clears) the default node for untagged GitHub work. Without
   *  an appId it covers every connected app — it's an account-level preference. */
  setGithubAppDefaultNode(node: string, appId?: string): Promise<string | undefined> {
    return setGithubAppDefaultNode(this.local, node, appId);
  }
  /** Set who may @-mention-trigger a run (issue #259). Without an appId it
   *  covers every connected app — it's an account-level preference. */
  setGithubAppTriggerAccess(
    triggerAccess: "everyone" | "contributor" | "collaborator",
    appId?: string,
  ): Promise<"everyone" | "contributor" | "collaborator"> {
    return setGithubAppTriggerAccess(this.local, triggerAccess, appId);
  }
  /** Manually dispatch a pending queue item to a chosen node + agent/model. */
  assignWorkItem(id: string, input: { node?: string; runtimeId?: string; model?: string; ephemeral?: boolean }): Promise<void> {
    return assignWorkItem(this.local, id, input);
  }
  /** Remove a single item from the GitHub queue. */
  deleteWorkItem(id: string): Promise<void> {
    return deleteWorkItem(this.local, id);
  }
  /** Clear every pending (waiting) item from the GitHub queue. */
  clearWorkQueue(): Promise<number> {
    return clearWorkQueue(this.local);
  }
  /**
   * Disconnect a GitHub App: drop the control-plane hook AND wipe the node's key.
   * `appId` scopes it to one of the account's apps; without one every app goes,
   * which is the only option for a hook old enough to have no App ID recorded.
   */
  async githubAppDisconnect(appId?: string, hookId?: string): Promise<void> {
    // Tell the node to clear its local key/config (over the active transport)…
    this.send({ kind: "github.app.disconnect", requestId: requestId(), appId: appId || undefined, hookId: hookId || undefined });
    // …and drop the account's hooks on the control plane. Errors propagate so the
    // UI can tell the user it didn't take (e.g. control plane mid-deploy). Passing
    // hookId lets a stale app with no App ID be removed on its own.
    await disconnectGithubApp(this.local, { appId, hookId });
  }
  async removeNode(nodeId: string): Promise<void> {
    await removeAccountNode(this.local, nodeId);
    await this.refreshNodes();
  }
  async startCheckout(): Promise<void> {
    location.assign(await billingCheckout(this.local));
  }
  async openBillingPortal(): Promise<void> {
    location.assign(await billingPortal(this.local));
  }
  enablePush(): Promise<string> {
    return enablePushNotifications(this.local);
  }
  disablePush(): Promise<string> {
    return disablePushNotifications(this.local);
  }
  pushStatus(): ReturnType<typeof getPushSubscriptionStatus> {
    return getPushSubscriptionStatus();
  }
  getNotificationPreferences(): Promise<NotificationPreferences> {
    return getNotificationPreferences(this.local);
  }
  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    return setNotificationPreferences(this.local, patch);
  }

  // --- Ephemeral machines ------------------------------------------------

  // Provider tokens are device-local by default. When cross-device sync is opted
  // in (Settings), they're additionally synced to the account's other devices
  // through an E2E device vault so a second device can wake/reach a machine the
  // first launched (P2 / Gap A) — the control plane only ever sees ciphertext.
  private ephemeralKeys: DeviceVaultKeyStore = createDeviceVaultKeyStore({
    local: createEphemeralKeyStore(),
    remote: this.deviceVaultRemote(),
    device: () => deviceKeypair(this.local),
    enabled: () => this.deviceTokenSyncEnabled(),
  });
  private ephemeralModelKeys: EphemeralModelKeyStore = createEphemeralModelKeyStore();
  private ephemeralPrefs: EphemeralPrefsStore = createEphemeralPrefsStore();
  private ephemeralSetups: EphemeralSetupStore = createEphemeralSetupStore();
  private ephemeralMachines: MachineStore = createMachineStore();
  /** Ephemeral node ids we've already seeded with device-held model keys this
   *  session, so a reconnect doesn't re-push (the node write is idempotent
   *  regardless). See `seedEphemeralNodeIfNeeded`. */
  private seededEphemeralNodes = new Set<string>();
  /** Launched ephemeral node ids we've already run the first-run model-auth
   *  check for this session, so a reconnect doesn't re-schedule it. */
  private firstRunAuthNodes = new Set<string>();
  /** Machines already scheduled for finish-triggered teardown. */
  private finishingEphemeralMachines = new Set<string>();

  listEphemeralKeys(): Promise<ProviderKeyInfo[]> {
    return this.ephemeralKeys.list();
  }
  /** Device-held model **API keys** used to seed a freshly-launched machine's
   *  vault over the E2E channel (closes the cold-start gap — see
   *  docs/ephemeral-sessions.md, "Closing the cold-start gap"). API keys only. */
  listEphemeralModelKeys(): Promise<EphemeralModelKeyInfo[]> {
    return this.ephemeralModelKeys.list();
  }
  setEphemeralModelKey(provider: string, key: string): Promise<void> {
    return this.ephemeralModelKeys.set(provider, key);
  }
  removeEphemeralModelKey(provider: string): Promise<void> {
    return this.ephemeralModelKeys.remove(provider);
  }
  getEphemeralToken(id: string): Promise<string> {
    return this.ephemeralKeys.getToken(id);
  }
  setEphemeralToken(id: string, token: string): Promise<void> {
    return this.ephemeralKeys.setToken(id, token);
  }
  removeEphemeralToken(id: string): Promise<void> {
    return this.ephemeralKeys.remove(id);
  }

  // --- Cross-device provider-token sync (P2 / Gap A) ---------------------
  // Opt-in, off by default (per the CLOUD.md credential-widening precedent). When
  // on, ephemeral provider tokens are E2E-synced to the account's other devices
  // so a second device can wake/reach a machine the first launched.
  private deviceTokenSyncEnabled(): boolean {
    try {
      return !this.direct && !!this.local.s && localStorage.getItem("bivy_device_token_sync") === "1";
    } catch {
      return false;
    }
  }
  getDeviceTokenSync(): boolean {
    return this.deviceTokenSyncEnabled();
  }
  setDeviceTokenSync(enabled: boolean): void {
    try {
      localStorage.setItem("bivy_device_token_sync", enabled ? "1" : "0");
    } catch {
      /* noop */
    }
    if (enabled) void this.syncDeviceVault();
  }
  /** Reconcile the device vault (consume a wrapped key, or publish + satisfy
   *  peers' requests). Safe/no-op when disabled. */
  syncDeviceVault(): Promise<void> {
    return this.ephemeralKeys.sync().catch(() => {});
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
        const data = (await res.json()) as { vault?: string | null; wrappedKey?: { wrappedKey: string; wrappedByPublicKeyB64: string } | null; requests?: string[] };
        return { vault: data.vault ?? null, wrappedKey: data.wrappedKey ?? null, requests: Array.isArray(data.requests) ? data.requests : [] };
      },
      putVault: async (ciphertext: string) => {
        const dev = await deviceKeypair(this.local);
        await fetch(`${base()}/device-vault`, { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ devicePublicKeyB64: dev.pub, ciphertext }) });
      },
      requestKey: async () => {
        const dev = await deviceKeypair(this.local);
        await fetch(`${base()}/device-vault/key/request`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ devicePublicKeyB64: dev.pub }) });
      },
      putWrapped: async (target: string, wrappedKey: string, wrappedByPublicKeyB64: string) => {
        await fetch(`${base()}/device-vault/key/wrapped`, { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ targetDevicePublicKeyB64: target, wrappedKey, wrappedByPublicKeyB64 }) });
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
      entries = await this.ephemeralModelKeys.entries();
    } catch {
      return;
    }
    // Mark seeded regardless of whether there were keys — an empty device just
    // has nothing to contribute, and re-checking on every reconnect is wasteful.
    this.seededEphemeralNodes.add(nodeId);
    if (!entries.length) return;
    // Push only while the transport is still live on this same node — an async
    // hop above could have switched it out from under us.
    if (this.store.getState().status !== "online" || this.local.cur !== nodeId) {
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
      if (st.status !== "online" || this.local.cur !== nodeId) return;
      if (st.needsModelAuth || st.oauth) return;
      if (st.providers.some((p) => p.configured)) return;
      // Prefer an OAuth-capable provider (Anthropic first — subscription login
      // is the whole point here), falling back to anthropic by id.
      const provider =
        st.providers.find((p) => p.oauth && p.id === "anthropic")?.id ??
        st.providers.find((p) => p.oauth)?.id ??
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
  private async maybeTeardownFinishedEphemeral(sessionId: string): Promise<void> {
    if (this.direct || this.store.getFollowups(sessionId).length > 0) return;
    const nodeId = this.local.cur;
    if (!nodeId) return;
    const machine = (await this.ephemeralMachines.list().catch(() => []))
      // Suspend-to-zero machines (Fly Sprites) are kept, never destroyed on
      // finish — they self-suspend to ~$0 and resume with state intact, which is
      // the whole point; destroying one would throw away its memory.
      .find((m) => m.nodeId === nodeId && m.teardownOnAgentFinish && !ephemeralProviderSuspendsWhenIdle(m.provider));
    if (!machine || this.finishingEphemeralMachines.has(machine.id)) return;
    // Persist the session↔machine correlation BEFORE teardown so this session can
    // be rebuilt after the node is unenrolled and drops from the registry (Gap 1).
    void this.recordSessionCorrelation(sessionId, machine);
    this.finishingEphemeralMachines.add(machine.id);
    setTimeout(() => {
      // A follow-up may have been queued during the grace period.
      if (this.store.getFollowups(sessionId).length > 0 || this.local.cur !== nodeId) {
        this.finishingEphemeralMachines.delete(machine.id);
        return;
      }
      void this.destroyEphemeral(machine).catch((e) => {
        this.finishingEphemeralMachines.delete(machine.id);
        this.store.setError(e instanceof Error ? e.message : String(e));
      });
    }, 3000);
  }

  listEphemeralSizes(providerId: string, region?: string): Promise<ProviderSize[]> {
    return listEphemeralSizes(providerId, { exec: cloudExec(this.local), keys: this.ephemeralKeys }, region);
  }
  async launchEphemeral(opts: LaunchOpts): Promise<EphemeralMachine> {
    if (!this.signedIn) throw new Error("Sign in to launch an ephemeral machine.");
    // The repo a freshly-booted machine pre-clones is the new-session composer's
    // repo selection, not a per-machine setting — so a configured machine works
    // on whatever repo the draft targets. An explicit opts.repo (e.g. a queue
    // caller) still wins.
    const repo = opts.repo ?? (this.store.getState().draftRepo || undefined);
    // A first-run ephemeral node has no native GitHub login to inherit. Seed the
    // device-local GitHub token during bootstrap so its very first repo picker,
    // clone, push, and PR work instead of failing after the machine boots.
    const githubToken = opts.githubToken ?? await this.githubTaskToken.get();
    const machine = await launchEphemeralMachine({ ...opts, repo, githubToken: githubToken || undefined }, {
      store: this.local,
      exec: cloudExec(this.local),
      keys: this.ephemeralKeys,
      machines: this.ephemeralMachines,
    });
    void this.refreshNodes();
    return machine;
  }
  async destroyEphemeral(machine: EphemeralMachine): Promise<void> {
    await destroyEphemeralMachine(machine, {
      store: this.local,
      exec: cloudExec(this.local),
      keys: this.ephemeralKeys,
      machines: this.ephemeralMachines,
    });
    void this.refreshNodes();
  }

  /** Wake a suspended machine (Fly Sprites) so it rejoins the relay. No-op for
   *  providers whose machines don't suspend. */
  async wakeEphemeral(machine: EphemeralMachine): Promise<void> {
    await wakeEphemeralMachine(machine, { exec: cloudExec(this.local), keys: this.ephemeralKeys });
    void this.refreshNodes();
  }

  /**
   * Open a node that may be a suspended, suspend-to-zero ephemeral machine (Fly
   * Sprites): wake it first if needed — a suspended machine is off the relay, so
   * plain `switchNode` would sit at "connecting" forever — then connect and wait
   * for it to come online. For an already-online node this is just a connect.
   * This is the "reopen the session to resume it" path behind the node switcher.
   */
  async resumeAndConnectNode(nodeId: string, timeoutMs = 90_000): Promise<void> {
    try {
      // The launching device holds the machine record locally; a second account
      // device doesn't, so fall back to the non-secret machine identity carried
      // on the account node registry entry (cross-device resume — Gap A in
      // docs/ephemeral-sessions.md). Reconstructing it lets this device wake a
      // suspended node instead of hanging while connecting to it off-relay.
      const machine =
        (await this.ephemeralMachines.list().catch(() => [])).find((m) => m.nodeId === nodeId) ??
        ephemeralMachineFromNode(this.store.getState().nodes.find((n) => n.id === nodeId) ?? { id: nodeId });
      if (machine && ephemeralProviderSuspendsWhenIdle(machine.provider)) {
        await this.wakeEphemeral(machine);
      }
      await this.connectToNode(nodeId, timeoutMs);
    } catch (e) {
      // Surface a wake/connect failure (bad token, provider hiccup, slow resume)
      // to the error toast rather than leaving the UI silently at "connecting".
      this.store.setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Rebuild-resume (Gap B): re-provision a torn-down destroy-lane session onto a
   * NEW machine and restore it from its control-plane snapshot. Reuses the old
   * node id + room key (this device holds it) so the new machine can decrypt the
   * snapshot, and the old session id so its daemon knows what to restore. The
   * machine's shape comes from its device-local record (or the node registry).
   */
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
    };
    try {
      const { base, auth } = this.correlationApi();
      await fetch(`${base}/session-correlation/${encodeURIComponent(sessionId)}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
      this.ephemeralCorrelations = [body, ...this.ephemeralCorrelations.filter((c) => c.sessionId !== sessionId)];
    } catch {
      this.correlatedSessions.delete(dedupe); // let a later attempt retry
    }
  }

  async reprovisionEphemeral(nodeId: string, sessionId: string): Promise<void> {
    try {
      const roomKeyB64 = this.local.keys()[nodeId];
      if (!roomKeyB64) throw new Error("This device no longer holds this session's key, so it can't rebuild it.");
      // Prefer the device-local record; fall back to the registry node; finally,
      // for a torn-down machine (record + node both gone) fall back to the durable
      // server-side correlation (Gap 1) matched by node or session.
      const corr = this.ephemeralCorrelations.find((c) => c.nodeId === nodeId || c.sessionId === sessionId);
      const machine =
        (await this.ephemeralMachines.list().catch(() => [])).find((m) => m.nodeId === nodeId) ??
        ephemeralMachineFromNode(this.store.getState().nodes.find((n) => n.id === nodeId) ?? { id: nodeId }) ??
        (corr ? ephemeralMachineFromCorrelation(corr) : null);
      if (!machine) throw new Error("No record of the machine to rebuild — re-launch it from Ephemeral settings.");
      if (ephemeralProviderSuspendsWhenIdle(machine.provider)) {
        // A suspend provider is never destroyed — just wake it.
        await this.resumeAndConnectNode(nodeId);
        return;
      }
      await this.launchEphemeral({
        provider: machine.provider,
        region: machine.region || undefined,
        ttlMinutes: machine.ttlMinutes,
        repo: machine.repo,
        setupId: machine.setupId,
        teardownOnAgentFinish: machine.teardownOnAgentFinish,
        reuseNodeId: nodeId,
        reuseRoomKeyB64: roomKeyB64,
        restoreSessionId: sessionId,
      });
      await this.connectToNode(nodeId, 120_000);
    } catch (e) {
      this.store.setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * True when the current node is an ephemeral machine this device can bring back
   * with a send, so it should auto-resume rather than being blocked (drives both
   * `shouldAutoResume` and the composer's enabled state). Two cases, both requiring
   * that we still hold the node's room key:
   *  - a suspended/offline enrolled node (Sprite/E2B) — wake it; or
   *  - a torn-down destroy-lane node that dropped from the registry but has a
   *    durable session↔machine correlation (Gap 1) — rebuild it.
   */
  isCurrentNodeResumable(): boolean {
    if (this.direct) return false;
    const nodeId = this.local.cur;
    if (!nodeId) return false;
    let hasKey = false;
    try {
      hasKey = !!this.local.keys()[nodeId];
    } catch {
      return false;
    }
    if (!hasKey) return false;
    const node = this.store.getState().nodes.find((n) => n.id === nodeId);
    // Enrolled but offline → resumable ONLY when it's actually an ephemeral machine
    // we can wake. A persistent node that's merely offline is NOT resumable from this
    // device: it reconnects on its own when its daemon rejoins the relay, and sweeping
    // it into the ephemeral wake/rebuild path throws a misleading "no record of the
    // machine to rebuild" error (reprovisionEphemeral). Absent from the registry →
    // resumable only if a durable correlation lets us rebuild it.
    if (node) return !node.online && isEphemeralNode(node);
    return this.ephemeralCorrelations.some((c) => c.nodeId === nodeId);
  }
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
  async runWorkItemOnEphemeral(
    id: string,
    opts: { provider: string; region?: string; size?: string; ttlMinutes?: number; runtimeId?: string; model?: string; configId?: string },
  ): Promise<EphemeralMachine> {
    if (!this.signedIn) throw new Error("Sign in to launch an ephemeral machine.");
    const githubToken = await this.githubTaskToken.get();
    const machine = await launchEphemeralMachine(
      { ...opts, setupId: opts.configId, hostedTasks: true, githubToken: githubToken || undefined, workItemId: id, purpose: "queue-item", name: "Ephemeral queue runner" },
      { store: this.local, exec: cloudExec(this.local), keys: this.ephemeralKeys, machines: this.ephemeralMachines },
    );
    try {
      await assignWorkItem(this.local, id, { node: ephemeralNodeLabel(machine.nodeId ?? ""), runtimeId: opts.runtimeId, model: opts.model, ephemeral: true });
    } catch (e) {
      // The machine is already booting — better to leave it running (it still
      // serves the shared "bivy" queue) than to tear it down mid-provision and
      // strand it. Surface the assign failure so the UI can report it.
      void this.refreshNodes();
      throw e;
    }
    void this.refreshNodes();
    return machine;
  }

  /**
   * Provision a general-purpose ephemeral server that serves the shared queue
   * (no specific item), so incoming work can run without a persistent node —
   * the queue-level "auto-provision" default's manual/triggered form.
   */
  async launchEphemeralQueueWorker(opts: { provider: string; region?: string; size?: string; ttlMinutes?: number; configId?: string }): Promise<EphemeralMachine> {
    if (!this.signedIn) throw new Error("Sign in to launch an ephemeral machine.");
    const githubToken = await this.githubTaskToken.get();
    const machine = await launchEphemeralMachine(
      { ...opts, setupId: opts.configId, hostedTasks: true, githubToken: githubToken || undefined, purpose: "queue-default", name: "Ephemeral queue worker" },
      { store: this.local, exec: cloudExec(this.local), keys: this.ephemeralKeys, machines: this.ephemeralMachines },
    );
    void this.refreshNodes();
    return machine;
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
    return fetchEphemeralConfigs(this.local);
  }
  createEphemeralConfig(input: EphemeralConfigInput): Promise<EphemeralNodeConfig> {
    return apiCreateEphemeralConfig(this.local, input);
  }
  updateEphemeralConfig(id: string, patch: Partial<EphemeralConfigInput>): Promise<EphemeralNodeConfig> {
    return apiUpdateEphemeralConfig(this.local, id, patch);
  }
  removeEphemeralConfig(id: string): Promise<void> {
    return apiDeleteEphemeralConfig(this.local, id);
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
    if (this.store.getState().activeSessionId) return;
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
    const sessionId = event.sessionId || this.store.getState().activeSessionId;
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
    const active = this.store.getState().activeSessionId;
    if (active) this.send({ kind: "abort", sessionId: active });
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

  /** A new prompt for this session must be held in the visible queue rather
   *  than sent immediately: the session is mid-turn, or earlier queued items
   *  are still waiting (sending straight through would silently jump the
   *  queue and reorder ahead of them — see the reordering acceptance test).
   *  See packages/core/src/followups.ts's mustQueueFollowup for the (unit
   *  tested) decision itself. */
  private mustQueue(sessionId: string): boolean {
    return mustQueueFollowup(this.store.getFollowups(sessionId).length, this.store.getState().working);
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
    const s = this.store.getState();
    const runtime = s.runtimes.find((r) => r.id === s.selectedAgentId);
    return runtimeSupportsSteering(runtime?.capabilities as { streamingBehaviors?: unknown } | undefined);
  }

  /** The queue for a session, in delivery order. */
  getFollowups(sessionId: string): PendingFollowup[] {
    return this.store.getFollowups(sessionId);
  }

  /** Edit a still-queued item. `expectedVersion` must match the version the
   *  caller last read (see PendingFollowup.version) — a mismatch means it
   *  changed underneath the editor (another tab, or it started sending while
   *  the edit was open) and is rejected rather than silently overwritten; the
   *  caller should show the current (already-reactive) state and let the user
   *  retry instead of reapplying their edit over it. */
  editFollowup(sessionId: string, id: string, patch: { text: string; attachments?: PromptAttachment[] }, expectedVersion: number): FollowupEditResult {
    return this.store.editFollowup(sessionId, id, patch, expectedVersion, Date.now());
  }

  /** Remove a still-queued item. No-op once it's already dispatched. */
  removeFollowup(sessionId: string, id: string): boolean {
    return this.store.removeFollowup(sessionId, id);
  }

  /** Reorder a still-queued item to `toIndex` among the queue. No-op once it's
   *  already dispatched. */
  reorderFollowup(sessionId: string, id: string, toIndex: number): boolean {
    return this.store.reorderFollowup(sessionId, id, toIndex);
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
    const item = this.store.getFollowups(sessionId).find((f) => f.id === id);
    if (!item || item.status !== "queued") return;
    this.store.reorderFollowup(sessionId, id, 0);
    if (!this.store.getState().working) {
      this.drainFollowups(sessionId);
      return;
    }
    if (this.supportsSteering()) this.dispatchFollowup(sessionId, item, "steer");
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
    const trimmed = text.trim();
    const files = attachments && attachments.length ? attachments : undefined;
    if (!trimmed && !files) return false;
    const active = this.store.getState().activeSessionId;
    if (!active || !this.store.getState().working || !this.supportsSteering()) return false;
    const cmid = clientMessageId();
    this.store.addUserMessage(trimmed, cmid, files);
    this.send({ kind: "prompt", sessionId: active, text: trimmed, clientMessageId: cmid, attachments: files, streamingBehavior: "steer" });
    return true;
  }

  /** Send the front queued item now. Called once a turn settles (agent_end),
   *  and defensively whenever the session might have gone idle between an
   *  enqueue and this check. No-op while busy or with nothing queued — the
   *  queue only ever has one item in flight ("sending") at a time. */
  private drainFollowups(sessionId: string): void {
    if (sessionId !== this.store.getState().activeSessionId) return;
    if (this.store.getState().working) return;
    const next = nextQueuedFollowup(this.store.getFollowups(sessionId));
    if (!next) return;
    this.dispatchFollowup(sessionId, next);
  }

  /** Actually send a queued item: mark it "sending" (so it can't be double-
   *  dispatched or edited mid-flight), fold it into the transcript exactly
   *  like any other sent prompt, and put it on the wire. Confirmed sent — and
   *  dropped from the queue — by maybeConfirmFollowup once the node echoes it
   *  back (or, failing that, once the turn it started settles regardless —
   *  see settleSendingFollowups). */
  private dispatchFollowup(sessionId: string, item: PendingFollowup, streamingBehavior?: StreamingBehavior): void {
    this.store.markFollowupSending(sessionId, item.id, Date.now());
    this.store.addUserMessage(item.text, item.id, item.attachments);
    this.send({
      kind: "prompt",
      sessionId,
      text: item.text,
      clientMessageId: item.id,
      attachments: item.attachments,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  /** The node's echo of a prompt (session.user_message) is the protocol
   *  acknowledgement that a dispatched follow-up actually reached it —
   *  matched by clientMessageId. Drop it from the visible queue; it's a normal
   *  transcript message now (deduped against the optimistic bubble exactly
   *  like any other send — see SessionStore's `pending` map). This never fires
   *  for a plain (non-queued) send: confirmFollowupSent no-ops when the id
   *  isn't in the queue. */
  private maybeConfirmFollowup(event: { type?: string; sessionId?: string; clientMessageId?: unknown }): void {
    if (event.type !== "session.user_message") return;
    const sid = event.sessionId || this.store.getState().activeSessionId;
    const cmid = typeof event.clientMessageId === "string" ? event.clientMessageId : undefined;
    if (!sid || !cmid) return;
    this.store.confirmFollowupSent(sid, cmid);
  }

  /** A follow-up left "sending" when the socket dropped before its delivery
   *  could be confirmed is retried verbatim (same clientMessageId) once
   *  reconnected — see onReconnected. Safe to resend even if it DID land: the
   *  node dedupes `prompt` by clientMessageId (mirroring session.new's
   *  requestId dedupe — see src/session/session-new-dedupe.ts and its prompt
   *  reuse in src/server.ts), so a prompt that already landed is a no-op
   *  rather than a duplicate turn. */
  private retryStuckFollowups(sessionId: string): void {
    for (const item of this.store.getFollowups(sessionId)) {
      if (item.status !== "sending") continue;
      this.send({ kind: "prompt", sessionId, text: item.text, clientMessageId: item.id, attachments: item.attachments });
    }
  }

  // --- Session lifecycle actions -----------------------------------------

  renameSession(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Optimistically reflect the rename in the list + title.
    const s = this.store.getState();
    if (sessionId === s.activeSessionId) this.store.setActiveTitle(trimmed);
    this.store.renameSessionLocal(sessionId, trimmed);
    this.send({ kind: "session.rename", sessionId, name: trimmed });
    this.refreshSessions();
  }

  deleteSession(sessionId: string, path?: string): void {
    this.send({ kind: "session.delete", sessionId, path });
    if (sessionId === this.store.getState().activeSessionId) {
      this.store.resetActiveSession();
      // The open session was just deleted — drop back to the draft route.
      navigate({ kind: "new" });
    }
    this.store.removeSessionLocal(sessionId);
    void this.transcriptCache.delete(sessionId);
    this.refreshSessions();
  }

  pauseSession(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSessionId;
    if (id) this.send({ kind: "session.pause", sessionId: id });
  }

  resumeSession(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSessionId;
    if (id) this.send({ kind: "session.resume", sessionId: id });
  }

  /** Force this session's PR status to re-sync with GitHub right now, instead
   *  of waiting for its next turn. Works even when the session isn't live — the
   *  node resumes it just enough to check. */
  refreshPrStatus(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSessionId;
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
    const id = sessionId || this.store.getState().activeSessionId;
    if (id && checkpointId) this.send({ kind: "session.rewind", sessionId: id, checkpointId });
  }

  /** Ask the node for this session's checkpoint list (rewind targets). */
  listCheckpoints(sessionId?: string): void {
    const id = sessionId || this.store.getState().activeSessionId;
    if (id) this.send({ kind: "session.checkpoints", sessionId: id });
  }

  resolveApproval(id: string, approved: boolean): void {
    this.send({ kind: "approval", id, approved });
  }

  /** Answer a pending clarifying question (see UserQuestionRequest). Unlike
   *  resolveApproval, the node needs `sessionId` to find the right session —
   *  approvals are looked up in a single global list keyed by id alone. */
  answerQuestion(requestId: string, sessionId: string | undefined, answers: Record<string, string>): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, answers });
  }

  cancelQuestion(requestId: string, sessionId: string | undefined): void {
    this.send({ kind: "session.question.answer", requestId, sessionId, cancelled: true });
  }
}

export const controller = new AppController();
