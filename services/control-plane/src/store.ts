// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { createHash } from "node:crypto";

/**
 * Control plane data store.
 *
 * `MeshStore` is the async interface the service depends on. There is ONE
 * implementation, `PostgresStore` (postgres-store.ts): durable against a real
 * Postgres when `DATABASE_URL` is set, and backed by an in-memory Postgres
 * (pg-mem, see pg-mem-store.ts) for dev/tests otherwise. Selected by `createStore()`
 * (store-factory.ts). This file holds the interface + shared types/helpers.
 *
 * Hard rule: the control plane stores ONLY metadata for
 * sessions/work. Never session content, files, prompts, or tool output. Model
 * provider credentials are the one explicit account-vault exception so enrolled
 * nodes can share API keys/OAuth logins across the user's runners.
 */

export type Plan = "free" | "pro" | "team";

// The paid single-user plan was originally called `individual` internally while
// being sold as "Pro". The id is now `pro` everywhere; this alias exists only to
// translate requests from clients released before the rename (the published CLI
// sends a plan id over the wire — see normalizePlan in index.ts). Accounts stored
// under the old id are migrated at boot by postgres-store's schema init.
export const LEGACY_PLAN_IDS: Record<string, Plan> = { individual: "pro" };

export interface Entitlements {
  plan: Plan;
  // Node cap. Optional: when undefined there is NO cap (unlimited nodes) — paid
  // plans omit it. Enforcement paths treat `undefined` as "no cap" so unlimited
  // needs no sentinel number. Free pins this to 1.
  maxNodes?: number;
  // Note: per-plan device and session caps were removed entirely (no limit on how
  // many devices an account pairs or sessions it runs); the vestigial always-undefined
  // `maxDevices`/`maxSessions` fields are gone with them.
  pushEnabled: boolean;
  relayEnabled: boolean;
  // Hosted GitHub/Slack work queue (label an issue → PR on your node). Available
  // on every plan; free is metered by `workQueueMonthlyLimit` below.
  workQueueEnabled: boolean;
  // Runs the plan may START per calendar month (UTC) on the hosted work queue —
  // one CLAIMED item = one run. Optional: `undefined` means UNLIMITED (paid plans
  // omit it, mirroring `maxNodes`). Free pins this to a small trial allowance.
  // Enforced at claim time and only when `ENFORCE_ENTITLEMENTS=1` (Bivy Cloud);
  // self-host stacks run unlimited regardless. See FREE_WORK_QUEUE_MONTHLY_RUNS.
  workQueueMonthlyLimit?: number;
  // Quick ephemeral cloud servers brokered from a phone (Fly/Hetzner/AWS/… with
  // the user's own token, proxied through the control-plane cold-start relay).
  // Available on every plan; free is metered by `ephemeralConcurrent` below.
  ephemeralEnabled: boolean;
  // How many ephemeral runners may be ALIVE AT ONCE. Optional: `undefined` means
  // UNLIMITED (paid plans omit it, mirroring `maxNodes`). Free pins this to 1.
  //
  // This caps concurrency, not configuration: a free account may set up as many
  // machines/providers as it likes (those live on the device, not here) and is
  // only refused when a second one tries to come up while the first is still
  // running. Counted from live ephemeral nodes rather than a stored counter —
  // see countLiveEphemeralNodes — so a machine that dies frees its slot on its
  // own and there is no counter to reset and no cron.
  //
  // Enforced at enroll and at relay connect, and only when `ENFORCE_ENTITLEMENTS=1`
  // (Bivy Cloud); self-host stacks run unlimited regardless.
  ephemeralConcurrent?: number;
}

// Whether paid-plan entitlements are enforced (Bivy Cloud). Off is the self-host /
// no-billing default, where every signed-in account reads as `free` — so numeric
// caps must be skipped there or a self-hoster is held to the free tier's 1 node and
// 1 runner on a stack they own outright. Defined here rather than in each call site
// so the store and the routes cannot drift apart.
//
// A function, not a const, because the store applies caps inside the enroll
// transaction and the tests need to exercise both a metered (Bivy Cloud) and an
// unmetered (self-host) stack in one process. Route-level callers read it once at
// module load, as before.
export function entitlementsEnforced(): boolean {
  return process.env.ENFORCE_ENTITLEMENTS === "1";
}

export interface Account {
  id: string;
  email: string;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  planUpdatedAt: string | null;
  createdAt: string;
}

export interface SubscriptionState {
  plan: Plan;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
}

// Plaintext (non-secret) per-provider connection status a node pushes alongside
// its encrypted model-auth vault (src/server.ts's pushProviderSummaryToControlPlane).
// Deliberately excludes any credential material or account identity — just enough
// for the web client to render a "Connected"/"Expired"/"Not connected" chip per
// node without opening a connection to it. Same trust tier as the `online` /
// `lastSeenAt` fields below.
export interface NodeProviderSummary {
  id: string;
  name?: string;
  configured: boolean;
  expiresAt?: number;
}

export interface NodeRecord {
  id: string; // the node's self-generated nodeId
  accountId: string;
  name: string;
  enrollmentTokenHash: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  providers?: NodeProviderSummary[];
  // Set once, at enroll, when the caller declares this node a short-lived cloud
  // runner (packages/core's launchEphemeralMachine). Recorded server-side rather
  // than inferred from the `eph-` id prefix, which the client picks and could
  // simply not use. Ephemeral nodes are counted against `ephemeralConcurrent`
  // instead of `maxNodes`, so this flag decides which cap a node faces.
  ephemeral: boolean;
}

export interface ResolvedClient {
  accountId: string;
  nodeId: string | null; // non-null when the token is scoped to one node
}

// Cross-node session index (option b). The control plane holds ONLY metadata:
// ids, status, source, branch — and the title as an E2E-ENCRYPTED blob it cannot
// read (clients decrypt with the room key). See docs/product-definition.md.
export interface SessionIndexEntry {
  sessionId: string;
  nodeId: string;
  status: string; // "idle" | "working" | "needs-attention"
  source?: string; // e.g. "issue:#12"
  titleEnc?: string; // opaque ciphertext; never plaintext
  branch?: string;
  /**
   * Address of the agent service currently hosting this session's live runtime
   * (Stage 2 of docs/agent-node-decoupling.md), e.g. "unix:/run/bivy.sock" or
   * "10.0.0.4:4711". Routing metadata of the same class as `nodeId` — NOT E2E
   * payload — so it is stored/returned to NODES for re-attach routing but never
   * surfaced to clients. Absent for in-process sessions. */
  agentServiceAddress?: string;
  updatedAt: string;
}
export type SessionAdvert = Omit<SessionIndexEntry, "nodeId" | "updatedAt">;

/**
 * Ownership + warm-standby routing for a replicated session
 * (docs/session-replication.md). Kept in its OWN table, keyed by session (not
 * node), because `session_index` is rewritten wholesale on every advertise — a
 * poor home for a monotonic epoch. This row is the authority for "who owns this
 * session and who is its standby", and `ownerEpoch` is the fence that promotion
 * advances via compare-and-set so a superseded owner can't keep writing.
 *
 * All fields are ROUTING metadata (node ids), never E2E payload — the control
 * plane still never sees transcripts or workspace data.
 */
export interface SessionOwnership {
  sessionId: string;
  accountId: string;
  ownerNodeId: string;
  standbyNodeId?: string;
  /** Monotonic ownership fence; +1 on each successful promotion. */
  ownerEpoch: number;
  updatedAt: string;
}

export interface PushSubscriptionRecord {
  accountId: string;
  endpoint: string;
  subscription: unknown;
  createdAt: string;
  updatedAt: string;
}

// The kinds of Web Push notification the mesh currently emits. Each maps 1:1 to
// the `kind` a node sends on `/internal/notifications/hints`; the string flows
// end-to-end (node → hints → payload → service worker), so per-kind opt-outs can
// be enforced at the single delivery chokepoint (`sendPushToAccount`). Keep this
// list in sync with the triggers in `src/server.ts`.
export const NOTIFICATION_KINDS = [
  "question_asked",
  "approval_requested",
  "agent_waiting",
  "session_done",
  "session_error",
  "terminal_bell",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Per-account opt-in map. Opt-OUT model: a kind is enabled unless explicitly set
// to false, so newly added kinds ship enabled and older accounts (whose stored
// prefs predate a kind) keep receiving it until they turn it off.
export type NotificationPreferences = Record<NotificationKind, boolean>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.fromEntries(
  NOTIFICATION_KINDS.map((kind) => [kind, true]),
) as NotificationPreferences;

// Normalize an arbitrary stored/inbound value into a full preferences map,
// keeping only known kinds and defaulting missing ones to enabled.
export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const out: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (value && typeof value === "object") {
    for (const kind of NOTIFICATION_KINDS) {
      const v = (value as Record<string, unknown>)[kind];
      if (typeof v === "boolean") out[kind] = v;
    }
  }
  return out;
}

// Per-account preference for auto-provisioning an ephemeral runner when the
// GitHub work queue has pending items and no persistent node is online
// (issue #532). Non-secret preferences only (provider id/region/size/ttl) —
// the provider TOKEN that would actually act on this stays device-local
// (EphemeralKeyStore in packages/core/src/ephemeral.ts); the control plane
// never sees it, and can't provision anything by itself. This is display/
// routing metadata a signed-in device polls to decide whether to help out.
export interface EphemeralQueueDefault {
  enabled: boolean;
  provider?: string;
  region?: string;
  size?: string;
  ttlMinutes?: number;
}

export const DEFAULT_EPHEMERAL_QUEUE_DEFAULT: EphemeralQueueDefault = { enabled: false };

/** Normalize an arbitrary stored/inbound value into a well-typed preference,
 *  keeping only known fields and clamping ttlMinutes into a sane range. */
export function normalizeEphemeralQueueDefault(value: unknown): EphemeralQueueDefault {
  if (!value || typeof value !== "object") return { ...DEFAULT_EPHEMERAL_QUEUE_DEFAULT };
  const v = value as Record<string, unknown>;
  const out: EphemeralQueueDefault = { enabled: Boolean(v.enabled) };
  if (typeof v.provider === "string" && v.provider.trim()) out.provider = v.provider.trim();
  if (typeof v.region === "string" && v.region.trim()) out.region = v.region.trim();
  if (typeof v.size === "string" && v.size.trim()) out.size = v.size.trim();
  if (typeof v.ttlMinutes === "number" && Number.isFinite(v.ttlMinutes)) out.ttlMinutes = Math.max(5, Math.min(24 * 60, Math.floor(v.ttlMinutes)));
  return out;
}

// Cross-node model credential snapshot. Nodes push the exact provider auth
// records their local credential vault uses; other nodes on the same account can pull
// and import them so model logins/API keys are account-wide instead of per-node.
export interface ModelAuthVault {
  ciphertext: string;
  updatedAt: string;
  updatedByNodeId: string;
}

export interface ModelAuthWrappedKey {
  nodeId: string;
  wrappedKey: string;
  wrappedByNodeId: string;
  wrappedByPublicKey: string;
  updatedAt: string;
}

export interface ModelAuthKeyRequest {
  nodeId: string;
  publicKey: string;
  createdAt: string;
}

// --- Work queue (E2/E4) -------------------------------------------------------
// Inbound front doors (GitHub issue webhook, Slack command) enqueue WORK ITEMS
// on the control plane. The node — which dials outbound only (invariant #4) —
// gets a best-effort relay push hint, then PULLS/claims pending items over the
// control-plane API, runs one on its own machine with its own token (content
// never reaches the control plane), then marks it done. The
// control plane stores only routing metadata: ids, repo slug, issue number,
// title/body text of the request. Never agent output or credentials.
export type WorkItemStatus = "pending" | "claimed" | "done";
export interface WorkItem {
  id: string;
  accountId: string;
  label: string; // routing label; a node only pulls items whose label it serves
  source: string; // "github:issue" | "slack"
  status: WorkItemStatus;
  title: string;
  body?: string;
  repo?: string; // "owner/repo"
  issueNumber?: number;
  url?: string;
  createdAt: string;
  claimedByNodeId?: string;
  claimedAt?: string;
  completedAt?: string;
  dedupeKey?: string; // idempotency key (e.g. "gh:<delivery-id>"); unique per account
  // Collapse key: while an item is still pending, a second enqueue with the same
  // collapse key (same account) returns it instead of adding a duplicate. Unlike
  // `dedupeKey` (per-delivery), this is per *issue* (e.g. "gh-issue:owner/repo#7"),
  // so the many webhook deliveries a single issue emits (opened, labeled, edited)
  // collapse into one queue entry. It frees once the item leaves `pending`, so a
  // later re-label after a run finished can still start a fresh run.
  collapseKey?: string;
  // True when the item landed on the shared `bivy` queue with no explicit
  // `bivy/<node>` label or `on <node>` directive — i.e. it is re-routable when the
  // account's default node changes. Explicitly-targeted items are false.
  defaultRouted?: boolean;
  runtimeId?: string; // agent/runtime override (manual trigger); node default when unset
  model?: string; // model override (manual trigger); node default when unset
  installationId?: string; // GitHub App installation id — the node mints a token for it
  appId?: string; // which GitHub App that installation belongs to (a node may serve several)
  // True when a device dispatched this item to a freshly-provisioned ephemeral
  // server rather than an already-running node (issue #532). Display only —
  // `label` alone drives routing; an ephemeral machine serves a one-off
  // `bivy/<slug>` label no differently than a persistent node would.
  ephemeral?: boolean;
  // How many times this item has been REQUEUED after a claim went stale (the
  // claiming node died — a crash, or an ephemeral machine terminated at its TTL —
  // before completing or renewing its lease). 0/undefined on first enqueue. The
  // lease sweep bumps it on each requeue and dead-letters the item (→ done) once
  // it exceeds the retry cap, so a poison item can't loop forever. See
  // `requeueExpiredWorkItems`.
  attempts?: number;
}
export type WorkItemInput = {
  label?: string;
  source: string;
  title: string;
  body?: string;
  repo?: string;
  issueNumber?: number;
  url?: string;
  // When set, enqueue is idempotent: a second enqueue with the same key for the
  // same account returns the existing item instead of creating a duplicate.
  // Webhook redeliveries reuse their delivery id, so this stops duplicate work.
  dedupeKey?: string;
  // When set, a second enqueue with the same key (same account) returns the
  // existing *pending* item instead of a duplicate — collapses the many webhook
  // deliveries one issue emits into a single queue entry. See WorkItem.collapseKey.
  collapseKey?: string;
  defaultRouted?: boolean;
  runtimeId?: string;
  model?: string;
  installationId?: string;
  appId?: string;
};

// Per-account inbound hook: a stable id + secret a user configures in GitHub /
// Slack so their webhooks route to THEIR account. The secret verifies the
// payload signature; it is not a third-party credential (no repo/Slack access).
export interface InboundHook {
  id: string;
  accountId: string;
  kind: string; // "github" | "github_app" | "slack"
  secret: string;
  createdAt: string;
  // GitHub App metadata registered by the node at connect time (flavor A). The
  // node holds the key; these are display/routing hints only.
  botMention?: string; // the app slug — the unique `@`-mention that triggers work
  appName?: string; // human-facing app name, for the "connected" UI
  // The GitHub App's numeric App ID, reported by the node. Display/convenience
  // only (never a credential) — lets the "connect existing app" form pre-fill the
  // App ID when reconnecting the same app onto another node.
  appId?: string;
  // Which GitHub account the app belongs to. With several apps connected this is
  // the only thing that tells them apart at a glance (personal vs each org).
  appOwner?: string;
  appOwnerType?: string;
  // How many repos/orgs the GitHub App is installed on, as last reported by the
  // node (which holds the key and queries GitHub). undefined = never synced.
  // Powers the "not installed on any repo yet" warning — the app is inert until
  // it's installed somewhere, and nothing else in the connect flow surfaces that.
  installCount?: number;
  installsSyncedAt?: string; // ISO time of the last install-count report
  // The node-label suffix (e.g. "macbook" for a node serving `bivy/macbook`)
  // that untagged/generic work should route to instead of racing across every
  // node serving the shared `bivy` label. Set from Settings → GitHub App in the
  // web UI. undefined = no default, keep the shared-queue behavior.
  defaultNode?: string;
  // The node that currently holds this GitHub App's private key and services it
  // (set when a node registers app-meta / connects). The control plane can't run
  // the app itself — only a node with the key can — so this is how the UI tells
  // "configured" from "actually being served". Cleared when that node is removed,
  // so a reinstalled/deleted node no longer shows a false "connected".
  servingNodeId?: string;
  servingNodeSeenAt?: string; // ISO time the serving node last (re)registered
}

// --- Shared normalization helpers --------------------------------------------
// Pure, DB-agnostic value normalization used by PostgresStore. Keeping the rules
// here — rather than inlining the same expression at each call site — means a rule
// change lands in one place.

/**
 * Canonicalize a display node name: collapse internal whitespace, trim, cap at
 * 80 chars, and fall back to "Node" when the result is empty. Both stores clean
 * names this way on rename (and it is the base for `disambiguateNodeName`).
 */
export function cleanNodeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 80) || "Node";
}

/**
 * Canonicalize a work-queue routing label, defaulting a missing/blank value to
 * the shared `bivy` queue. Used by enqueue/reroute/assign in both stores.
 */
export function normalizeWorkLabel(label: string | undefined): string {
  return (label || "bivy").trim() || "bivy";
}

/** Clamp a reported install count to a non-negative integer. */
export function clampInstallCount(installCount: number): number {
  return Math.max(0, Math.floor(installCount));
}

/**
 * Make a node name unique within an account by appending `-2`, `-3`, … when it
 * collides. Uses a hyphen (not a space) so the result stays valid in a routing
 * label (`bivy/<name>`) and an `@bot on <node>` directive (whose parser allows
 * only `[A-Za-z0-9._-]`). Node names route work, so uniqueness keeps a default
 * node / targeted label from racing across two same-named machines.
 */
export function disambiguateNodeName(desired: string, taken: Iterable<string>): string {
  const base = cleanNodeName(desired);
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export type RelayRole = "node" | "client";

export interface RelayTicket {
  role: RelayRole;
  accountId: string;
  nodeId: string | null;
}

// Hands-free CLI sign-in. The CLI starts a device login, the user clicks the
// emailed magic link in a browser, and the CLI polls until complete. No bearer
// token is stored at rest — the session is minted only when the CLI polls
// successfully (see pollDeviceLogin).
export type DeviceLoginStatus =
  | { status: "pending" }
  | { status: "complete"; token: string }
  | { status: "expired" };

// A paired device as surfaced to the account's device manager. `id` is the
// device's X25519 public key (base64url) — the same value used as the pairing
// key — so the client can both address it for removal and recognise itself.
export interface PairedDeviceInfo {
  id: string;
  label: string;
  updatedAt: string;
}

// Free trial allowance for the hosted work queue: how many runs a free account
// may START per calendar month. A taste of "label an issue → PR on your node"
// without a paywall; heavy users upgrade. Paid plans omit the limit (unlimited).
export const FREE_WORK_QUEUE_MONTHLY_RUNS = 5;

// Free allowance for ephemeral cloud runners: how many may be alive at once.
// Ephemeral is the answer to "I have no spare machine", which is the objection
// that blocks onboarding hardest, so gating it outright put a paywall exactly
// where a new user is deciding whether Bivy is for them. It also costs us
// nothing — the machine runs on the user's own cloud account, on their own
// token. Concurrency is the axis that stays paid: running a fleet in parallel
// is the Pro-shaped need.
export const FREE_CONCURRENT_EPHEMERAL = 1;

export const PLAN_ENTITLEMENTS: Record<Plan, Omit<Entitlements, "plan">> = {
  // Launch policy: every signed-in user gets one hosted-relay node for free so
  // onboarding can go straight from installer → remote PWA without a paywall.
  // The work queue is now on every plan; free is capped at FREE_WORK_QUEUE_MONTHLY_RUNS
  // runs/month (paid plans omit the limit ⇒ unlimited). Ephemeral runners are on
  // every plan too, free metered by FREE_CONCURRENT_EPHEMERAL live at a time.
  // Push notifications remain paid. Paid plans omit `maxNodes` and
  // `ephemeralConcurrent` ("unlimited").
  free: { maxNodes: 1, pushEnabled: false, relayEnabled: true, workQueueEnabled: true, workQueueMonthlyLimit: FREE_WORK_QUEUE_MONTHLY_RUNS, ephemeralEnabled: true, ephemeralConcurrent: FREE_CONCURRENT_EPHEMERAL },
  pro: { pushEnabled: true, relayEnabled: true, workQueueEnabled: true, ephemeralEnabled: true },
  team: { pushEnabled: true, relayEnabled: true, workQueueEnabled: true, ephemeralEnabled: true },
};

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000; // 15 minutes

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function entitlementsForPlan(plan: Plan): Entitlements {
  return { plan, ...PLAN_ENTITLEMENTS[plan] };
}

// Aggregate counts for the operational/business dashboard. Pure metadata — row
// counts and group-bys over existing tables, never any row contents. Refreshed
// on an interval by the metrics collector (metrics.ts) and exposed as Prometheus
// gauges. See docs/ops/monitoring.md in bivysh/bivy-cloud.
export interface UsageMetrics {
  accountsTotal: number;
  accountsByPlan: Record<string, number>;
  nodesTotal: number;
  nodesOnline: number;
  workItemsByStatus: Record<string, number>;
  sessionsByStatus: Record<string, number>;
}

export interface MeshStore {
  init(): Promise<void>;
  // Lightweight liveness check for the backing store. Resolves when the store is
  // reachable, rejects when it is not (e.g. Postgres unreachable). Used by the
  // /readyz readiness probe so an unreachable database surfaces as an unhealthy
  // container instead of a green light over an outage.
  ping(): Promise<void>;

  // Aggregate counts for the monitoring dashboard (metadata only). See
  // UsageMetrics above.
  usageMetrics(): Promise<UsageMetrics>;

  // Accounts & auth
  findOrCreateAccount(email: string): Promise<Account>;
  getAccount(accountId: string): Promise<Account | undefined>;
  accountFromStripeCustomer(stripeCustomerId: string): Promise<Account | undefined>;
  setStripeCustomer(accountId: string, stripeCustomerId: string): Promise<void>;
  createLoginToken(email: string): Promise<string>; // magic-link, returns raw token
  consumeLoginToken(token: string): Promise<Account | undefined>;
  createSession(accountId: string): Promise<string>; // returns raw session token
  accountFromSession(token: string | null): Promise<Account | undefined>;
  revokeSession(token: string): Promise<void>;

  // Device login (hands-free CLI sign-in)
  createDeviceLogin(ttlMs?: number): Promise<{ deviceId: string; deviceSecret: string }>;
  completeDeviceLogin(deviceId: string, accountId: string): Promise<void>;
  pollDeviceLogin(deviceId: string, deviceSecret: string): Promise<DeviceLoginStatus>;

  // Client tokens (relay)
  createLinkGrant(accountId: string, nodeId: string, ttlMs?: number): Promise<string>;
  resolveClient(token: string | null): Promise<ResolvedClient | undefined>;
  registerPairedDevice(accountId: string, publicKeyB64: string, label?: string): Promise<void>;
  countPairedDevices(accountId: string): Promise<number>;
  listPairedDevices(accountId: string): Promise<PairedDeviceInfo[]>;
  // Remove a paired device (by its public key) from the account, freeing a
  // device slot. Returns true if a matching device was removed.
  removePairedDevice(accountId: string, publicKeyB64: string): Promise<boolean>;

  // Single-use relay connection tickets. Minted directly (over TLS) by a node
  // or client in exchange for its long-lived bearer, then handed to the relay.
  // The relay never sees the reusable bearer, only a short-lived ticket it
  // cannot replay for anything beyond a single routing introspection.
  createRelayTicket(input: { role: RelayRole; accountId: string; nodeId: string | null; ttlMs?: number }): Promise<string>;
  consumeRelayTicket(token: string | null): Promise<RelayTicket | undefined>;

  // Billing
  setPlan(accountId: string, plan: Plan, stripeCustomerId?: string): Promise<void>;
  // Records full subscription metadata from a Stripe webhook (plan, status, and
  // the customer/subscription ids) so the account page can show real billing
  // state and support can reconcile against Stripe.
  setSubscriptionState(accountId: string, state: SubscriptionState): Promise<void>;
  entitlements(accountId: string): Promise<Entitlements>;

  // Nodes
  listNodes(accountId: string): Promise<NodeRecord[]>;
  enrollNode(
    accountId: string,
    nodeId: string,
    name: string,
    opts?: { ephemeral?: boolean },
  ): Promise<{ node: Omit<NodeRecord, "enrollmentTokenHash">; enrollmentToken: string }>;
  // Ephemeral runners currently ALIVE for the account — the live half of the
  // `ephemeralConcurrent` cap. "Alive" means still connected to the relay
  // (`online`), deliberately: nothing reliably tells the control plane that a
  // cloud machine died. The TTL backstop runs `shutdown -h now` on the box, an
  // explicit destroy unenrolls fire-and-forget, and a browser that closes
  // mid-run reaps nothing at all — so counting *enrolled* rows would let one
  // orphan permanently consume a free account's only slot. Counting online rows
  // makes the slot free itself: the machine stops heartbeating, the relay marks
  // it offline, the slot returns.
  countLiveEphemeralNodes(accountId: string): Promise<number>;
  nodeFromEnrollmentToken(token: string | null): Promise<NodeRecord | undefined>;
  setNodeOnline(nodeId: string, online: boolean): Promise<void>;
  setNodeName(nodeId: string, name: string): Promise<NodeRecord | undefined>;
  removeNode(accountId: string, nodeId: string): Promise<boolean>;
  // Plaintext per-node provider status summary (see NodeProviderSummary) —
  // overwritten wholesale by the owning node on every credential change.
  setNodeProviders(nodeId: string, providers: NodeProviderSummary[]): Promise<void>;

  // Session index (cross-node unified view). A node replaces its full current
  // session list; clients read the merged list for the account.
  replaceNodeSessions(accountId: string, nodeId: string, sessions: SessionAdvert[]): Promise<void>;
  listAccountSessions(accountId: string): Promise<SessionIndexEntry[]>;
  // A single node reads back its OWN sessions, including the node-only
  // `agentServiceAddress` routing metadata (Stage 3: a restarting daemon adopts
  // its still-live sessions by looking their host address up here). Account-scoped
  // to `accountId` so a node can only ever see rows it owns.
  listNodeSessions(accountId: string, nodeId: string): Promise<SessionIndexEntry[]>;

  // Session replication ownership (docs/session-replication.md). Separate from
  // the session_index churn so the epoch is stable.
  /** Read a session's ownership/standby row, or undefined if not replicated. */
  getSessionOwnership(accountId: string, sessionId: string): Promise<SessionOwnership | undefined>;
  /**
   * The current owner declares (or clears, with `standbyNodeId: undefined`) the
   * standby for a session it owns. Upserts the row without touching `ownerEpoch`.
   * Returns the effective ownership row.
   */
  setSessionStandby(
    accountId: string,
    sessionId: string,
    ownerNodeId: string,
    standbyNodeId: string | undefined,
  ): Promise<SessionOwnership>;
  /**
   * Promote `toNodeId` to owner via compare-and-set on `ownerEpoch`: succeeds
   * only when `expectedEpoch` matches the stored epoch, bumping it by one, moving
   * ownership, and clearing the standby. Returns the updated row, or `undefined`
   * on an epoch mismatch (a lost race / stale caller) — the fence that prevents
   * two nodes from both believing they own the session.
   */
  promoteSession(
    accountId: string,
    sessionId: string,
    toNodeId: string,
    expectedEpoch: number,
  ): Promise<SessionOwnership | undefined>;

  // Web Push subscriptions for hosted PWA notifications.
  upsertPushSubscription(accountId: string, endpoint: string, subscription: unknown): Promise<void>;
  removePushSubscription(accountId: string, endpoint: string): Promise<void>;
  listPushSubscriptions(accountId: string): Promise<PushSubscriptionRecord[]>;

  // Per-account notification preferences (which push kinds are enabled). The
  // getter always returns a full, normalized map; the setter merges a partial
  // patch and returns the effective preferences.
  getNotificationPreferences(accountId: string): Promise<NotificationPreferences>;
  setNotificationPreferences(accountId: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences>;

  // Per-account ephemeral-queue-default preference (issue #532): whether/how a
  // signed-in device should auto-provision an ephemeral runner for the GitHub
  // work queue when nothing persistent is online. Same getter/setter shape as
  // notification preferences above.
  getEphemeralQueueDefault(accountId: string): Promise<EphemeralQueueDefault>;
  setEphemeralQueueDefault(accountId: string, patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault>;

  // Account-wide model provider credentials, shared across enrolled nodes.
  getModelAuthVault(accountId: string): Promise<ModelAuthVault | undefined>;
  setModelAuthVault(accountId: string, nodeId: string, ciphertext: string): Promise<ModelAuthVault>;
  setModelAuthNodePublicKey(accountId: string, nodeId: string, publicKey: string): Promise<void>;
  getModelAuthWrappedKey(accountId: string, nodeId: string): Promise<ModelAuthWrappedKey | undefined>;
  requestModelAuthWrappedKey(accountId: string, nodeId: string, publicKey: string): Promise<void>;
  listModelAuthKeyRequests(accountId: string, exceptNodeId: string): Promise<ModelAuthKeyRequest[]>;
  setModelAuthWrappedKey(accountId: string, targetNodeId: string, wrappedByNodeId: string, wrappedByPublicKey: string, wrappedKey: string): Promise<ModelAuthWrappedKey>;

  // Inbound hooks (route a third-party webhook to an account) + work queue.
  createInboundHook(accountId: string, kind: string): Promise<InboundHook>;
  getInboundHook(id: string): Promise<InboundHook | undefined>;
  // Adopt an externally-generated secret (e.g. a GitHub App manifest returns the
  // webhook secret at creation time). Scoped to the owning account.
  setInboundHookSecret(accountId: string, id: string, secret: string): Promise<InboundHook | undefined>;
  // Register GitHub App display/routing metadata (slug → mention handle, name, and
  // the numeric App ID for the reconnect form's pre-fill).
  setInboundHookAppMeta(
    accountId: string,
    id: string,
    meta: { mention?: string; name?: string; appId?: string; owner?: string; ownerType?: string },
  ): Promise<InboundHook | undefined>;
  // Record that `nodeId` currently serves this hook's GitHub App (holds the key,
  // polls the queue). Stamps servingNodeSeenAt. Called when a node registers its
  // app-meta on connect/boot. Scoped to the owning account.
  setInboundHookServingNode(accountId: string, id: string, nodeId: string): Promise<InboundHook | undefined>;
  // Record how many repos/orgs the GitHub App is installed on (reported by the
  // node). Powers the "not installed yet" warning; the app is inert until it's
  // installed on at least one repo.
  setInboundHookInstallStatus(accountId: string, id: string, installCount: number): Promise<InboundHook | undefined>;
  // Set (or clear, with undefined/empty) the node-label suffix that untagged
  // `bivy`-routed work should default to, e.g. "macbook" routes it as
  // `bivy/macbook` instead of the shared queue. Settings → GitHub App in the web UI.
  setInboundHookDefaultNode(accountId: string, id: string, defaultNode: string | undefined): Promise<InboundHook | undefined>;
  // The account's GitHub App hook, if one is connected (flavor A: one per
  // account). Prefers a completed hook (one with a registered mention) over an
  // orphan left by an abandoned create flow.
  // The account's github_app hooks. A node may serve several apps (a private
  // GitHub App only installs on the account that owns it, so covering a personal
  // account plus orgs takes one app each), and every app gets its own hook so an
  // inbound delivery identifies the app whose key should mint the token.
  listGithubAppHooks(accountId: string): Promise<InboundHook[]>;
  // A single github_app hook. With `appId`, the hook belonging to that app;
  // without it, the account's primary one (completed hooks preferred).
  getGithubAppHook(accountId: string, appId?: string): Promise<InboundHook | undefined>;
  // Remove a hook (e.g. the user disconnected their GitHub App). Account-scoped.
  deleteInboundHook(accountId: string, id: string): Promise<boolean>;
  // Remove ALL of an account's github_app hooks (disconnect, incl. orphans left
  // by abandoned create flows). Returns how many were removed.
  deleteGithubAppHooks(accountId: string): Promise<number>;
  // Remove just one app's hooks (disconnecting a single app, leaving the rest).
  deleteGithubAppHooksForApp(accountId: string, appId: string): Promise<number>;
  enqueueWorkItem(accountId: string, input: WorkItemInput): Promise<WorkItem>;
  // Pending items a node may run: the account's items whose label the node serves
  // (a node serving "bivy" also serves "bivy/<self>"; pass the labels it accepts).
  listPendingWorkItems(accountId: string, labels: string[]): Promise<WorkItem[]>;
  // Recent work items for the account (any status) — powers the incoming-queue UI.
  listWorkItems(accountId: string, limit?: number): Promise<WorkItem[]>;
  claimWorkItem(accountId: string, nodeId: string, id: string): Promise<WorkItem | undefined>;
  // How many runs the account has STARTED (items claimed) at/after `sinceIso`.
  // Powers the free-tier monthly quota — one claimed item = one run. Counts every
  // claimed/done item whose `claimedAt` is in range (deleting a done item after it
  // ran does not refund the run).
  countWorkRunsSince(accountId: string, sinceIso: string): Promise<number>;
  completeWorkItem(accountId: string, id: string): Promise<void>;
  // Renew the lease on an item this node currently holds (status='claimed' and
  // claimed_by_node_id = nodeId), stamping a fresh `claimedAt`. The running node
  // calls this on an interval so a long job isn't mistaken for an abandoned claim
  // by `requeueExpiredWorkItems`. Returns false when the node no longer holds the
  // claim (the item was requeued/completed/deleted, or another node re-claimed it)
  // — a signal the node has lost the lease and should stop.
  heartbeatWorkItem(accountId: string, nodeId: string, id: string): Promise<boolean>;
  // Lease sweep (control-plane background job, all accounts). An item that has been
  // `claimed` since before `cutoffIso` without a heartbeat is treated as abandoned:
  // the claiming node died between claim and complete (a crash, or — the case that
  // makes this non-optional for ephemeral runners — a machine terminated at its TTL
  // mid-run). Such items are RETURNED to `pending` (clearing claim + bumping
  // `attempts`) so another node or a fresh machine can pick them up, EXCEPT those
  // whose `attempts` already reached `maxAttempts`, which are DEAD-LETTERED (→ done)
  // so a poison item can't be retried forever. Returns both sets for logging/metrics.
  requeueExpiredWorkItems(
    cutoffIso: string,
    maxAttempts: number,
  ): Promise<{ requeued: WorkItem[]; deadLettered: WorkItem[] }>;
  // Re-route every *pending* item that landed on the shared/default queue
  // (defaultRouted === true) to `label` — used when the account's default node
  // changes so already-queued work follows the new default. Returns the updated items.
  rerouteDefaultRoutedPending(accountId: string, label: string): Promise<WorkItem[]>;
  // Manually assign a *pending* item to a specific routing label and optional
  // agent/model (the queue "Run…" action). Marks it explicitly-targeted
  // (defaultRouted = false). Returns the updated item, or undefined if it is
  // unknown / not pending / not on this account.
  assignWorkItem(
    accountId: string,
    id: string,
    input: { label: string; runtimeId?: string; model?: string; ephemeral?: boolean },
  ): Promise<WorkItem | undefined>;
  // Remove a single work item from the queue (the "×" on a row). Account-scoped;
  // returns whether it existed.
  deleteWorkItem(accountId: string, id: string): Promise<boolean>;
  // Clear every *pending* (not-yet-claimed) item from the account's queue (the
  // "Clear queue" action). Leaves claimed/running and done items untouched.
  // Returns how many were removed.
  clearPendingWorkItems(accountId: string): Promise<number>;
}
