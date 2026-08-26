// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash } from "node:crypto";
import type { SecretEnvelope } from "./hosted-crypto.js";

/**
 * Control plane data store.
 *
 * Cohesive repository ports define the persistence capabilities consumers depend on.
 * implementation, `PostgresStore` (postgres-store.ts): durable against a real
 * Postgres when `DATABASE_URL` is set, and backed by an in-memory Postgres
 * (pg-mem, see pg-mem-store.ts) for dev/tests otherwise. Selected by `createStore()`
 * (store-factory.ts). This file holds the interface + shared types/helpers.
 *
 * Hard rule: the control plane never stores interactive session content, files,
 * transcripts, or tool output. Slack and generic-webhook instructions are the
 * explicit inbound-automation exception: their source submits plaintext to this
 * service and the queue retains it as title/body. Model provider credentials are
 * the separate encrypted account-vault exception so enrolled nodes can share
 * API keys/OAuth logins without the control plane decrypting them.
 */

export interface Account {
  id: string;
  email: string;
  /** Commercial entitlement projected by the billing system. Unknown stored
   * values normalize to free at the compute gate. */
  plan: "free" | "individual" | "pro" | "team";
  /** GitHub user + admin-org ids proven during the latest GitHub OAuth login.
   * Central App installation is accepted only for one of these targets. */
  githubUserId?: string;
  githubInstallTargetIds: string[];
  createdAt: string;
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
  /** Non-secret, fixed-vocabulary cloud-init progress from an ephemeral node. */
  bootstrapStatus?: { phase: string; updatedAt: string };
  /** Manually declared, owner-asserted capability tags (e.g. "gpu", "docker") —
   * pushed by the owning node from its local config.yaml, overwritten wholesale
   * on every change, same trust tier as `providers`. Never auto-detected or
   * verified; a stale/offline declaration is not re-checked. See
   * @bivy/core's capability-routing.ts. */
  capabilities?: string[];
}

export interface ResolvedClient {
  accountId: string;
  nodeId: string | null; // non-null when the token is scoped to one node
}

/** Short-lived server-side state for an OAuth redirect. Kept in the shared
 * store so the callback may land on any control-plane replica. */
export interface OAuthState {
  deviceId?: string;
  returnPath?: string;
}

// Cross-node session index. The control plane holds ONLY metadata: ids, status,
// source, branch — and the title as an E2E-ENCRYPTED blob it cannot read
// (clients decrypt with the room key).
export interface SessionIndexEntry {
  sessionId: string;
  nodeId: string;
  status: string; // "idle" | "working" | "needs-attention"
  source?: string; // e.g. "issue:#12"
  titleEnc?: string; // opaque ciphertext; never plaintext
  branch?: string;
  /** Content-free unresolved-condition descriptors. Never prompt/tool bodies. */
  attention?: Array<{
    id: string;
    kind: "approval" | "question" | "session" | "automation";
    severity: "info" | "warning" | "error" | "critical";
    createdAt: string;
    updatedAt?: string;
  }>;
  /**
   * Address of the agent service currently hosting this session's live runtime
   * (Stage 2 of docs/agent-node-decoupling.md), e.g. "unix:/run/bivy.sock" or
   * "10.0.0.4:4711". Routing metadata of the same class as `nodeId` — NOT E2E
   * payload — so it is stored/returned to NODES for re-attach routing but never
   * surfaced to clients. Absent for in-process sessions. */
  agentServiceAddress?: string;
  updatedAt: string;
}
/** Node-owned projection. `updatedAt` is the session's actual last activity,
 * not the time the control plane happened to receive an advert. Older nodes may
 * omit it, so the store still has a receive-time fallback. */
export type SessionAdvert = Omit<SessionIndexEntry, "nodeId" | "updatedAt"> & { updatedAt?: string };

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

// Account-level, reusable ephemeral node config ("a config = a selectable
// node"). Non-secret sizing only; the launching device supplies the provider
// token. Stored as a JSONB array on the account row.
export interface EphemeralNodeConfig {
  id: string;
  name: string;
  provider: string;
  region?: string;
  size?: string;
  /** Curated provider-native runner image/snapshot for fast boot. */
  image?: string;
  /** Account-owned runners kept ready for immediate claim. Initially capped at
   * one to bound idle spend while the live SLO/cost data is collected. */
  readyCapacity?: number;
  ttlMinutes?: number;
  teardownOnAgentFinish?: boolean;
  /** Which credential lane launches this config: "user" (default — the
   * account's own hosted provider token) or "managed" (the deployment
   * operator's token, see services/control-plane/src/managed-compute.ts).
   * Absent means "user", so stored configs are fully backward compatible. */
  computeSource?: "user" | "managed";
  createdAt: string;
  updatedAt: string;
}

/** Normalize a stored/inbound configs array, dropping malformed entries and
 *  clamping ttlMinutes. */
export function normalizeEphemeralConfigs(value: unknown): EphemeralNodeConfig[] {
  if (!Array.isArray(value)) return [];
  const out: EphemeralNodeConfig[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const id = typeof v.id === "string" ? v.id.trim() : "";
    const name = typeof v.name === "string" ? v.name.trim() : "";
    const provider = typeof v.provider === "string" ? v.provider.trim() : "";
    if (!id || !name || !provider) continue;
    const cfg: EphemeralNodeConfig = {
      id, name, provider,
      createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
    };
    if (typeof v.region === "string" && v.region.trim()) cfg.region = v.region.trim();
    if (typeof v.size === "string" && v.size.trim()) cfg.size = v.size.trim();
    if (typeof v.image === "string" && v.image.trim()) cfg.image = v.image.trim();
    if (typeof v.readyCapacity === "number" && Number.isFinite(v.readyCapacity)) cfg.readyCapacity = Math.max(0, Math.min(1, Math.floor(v.readyCapacity)));
    if (typeof v.ttlMinutes === "number" && Number.isFinite(v.ttlMinutes)) cfg.ttlMinutes = Math.max(5, Math.min(24 * 60, Math.floor(v.ttlMinutes)));
    if (v.teardownOnAgentFinish === true) cfg.teardownOnAgentFinish = true;
    if (v.computeSource === "managed") cfg.computeSource = "managed";
    // A five-minute runner would enter the pre-claim rotation window as soon as
    // it launched. Ready capacity needs enough useful life to accept real work.
    if ((cfg.readyCapacity ?? 0) > 0 && (cfg.ttlMinutes ?? 60) < 15) cfg.ttlMinutes = 15;
    out.push(cfg);
  }
  return out;
}

// The account's default queue routing. `primary` names the runner; only a
// persistent-node primary may carry an ephemeral-config `fallback`.
export type QueueRunnerTarget =
  | { kind: "shared" }
  | { kind: "node"; node: string }
  | { kind: "config"; configId: string };

export interface QueueRouting {
  primary: QueueRunnerTarget;
  fallback?: { kind: "config"; configId: string };
}

export const DEFAULT_QUEUE_ROUTING: QueueRouting = { primary: { kind: "shared" } };

/** Normalize a stored/inbound routing value; unknown/invalid → shared queue,
 *  and a fallback is only kept for a persistent-node primary. */
export function normalizeQueueRouting(value: unknown): QueueRouting {
  if (!value || typeof value !== "object") return { ...DEFAULT_QUEUE_ROUTING };
  const v = value as Record<string, any>;
  const p = v.primary;
  let primary: QueueRunnerTarget = { kind: "shared" };
  if (p && typeof p === "object") {
    if (p.kind === "node" && typeof p.node === "string" && p.node.trim()) primary = { kind: "node", node: p.node.trim() };
    else if (p.kind === "config" && typeof p.configId === "string" && p.configId.trim()) primary = { kind: "config", configId: p.configId.trim() };
  }
  const f = v.fallback;
  const fallback = f && typeof f === "object" && f.kind === "config" && typeof f.configId === "string" && f.configId.trim()
    ? { kind: "config" as const, configId: f.configId.trim() }
    : undefined;
  return primary.kind === "node" && fallback ? { primary, fallback } : { primary };
}

// SECURITY / TRUST-MODEL NOTE: enabling hosted provisioning stores repo-capable
// and cloud-capable credentials on the CONTROL PLANE for the first time — a
// deliberate departure from "the control plane holds no secrets". It's the price
// of unattended, device-offline provisioning (the control plane launches an
// ephemeral machine itself when a webhook arrives and nothing is online). Off by
// default, per account. Tokens are stored as JSONB here; a production deployment
// MUST encrypt them at rest (KMS/HSM) and audit every use.
/** A GitHub App the control plane can mint short-lived installation tokens from
 *  — preferred over a stored PAT (see docs/hosted-provisioning-trust-model.md). */
export interface HostedGithubApp {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

/** How the account authenticates to GitHub for hosted git operations.
 *  "central-app": the operator's ONE centrally-owned GitHub App (the user just
 *  installs it and picks repos); "own-app": the account's own BYO app stored in
 *  `githubApp`; "token": the stored fine-grained PAT. Unset = the pre-central
 *  behavior (own app, then PAT), with the central app as a final fallback.
 *  Resolution to a concrete credential source is ONE table in
 *  central-github-app.ts — adding a mode means adding a row there. */
export const GITHUB_IDENTITY_MODES = ["central-app", "own-app", "token"] as const;
export type GithubIdentityMode = (typeof GITHUB_IDENTITY_MODES)[number];

export interface HostedProvisioning {
  enabled: boolean;
  /** Which GitHub identity the mint/launch paths should use (see above). */
  githubIdentity?: GithubIdentityMode;
  /** GitHub App creds — when set, a fresh installation token is minted per
   *  launch/op instead of using a stored PAT. Strongly preferred. */
  githubApp?: HostedGithubApp;
  /** Fallback long-lived PAT, injected as BIVY_GITHUB_TOKEN. Used only when no
   *  githubApp is configured. */
  githubToken?: string;
  /** Cloud provider tokens keyed by provider id (fly/hetzner/aws), used to launch. */
  providerTokens?: Record<string, string>;
  /** SHA-256 fingerprints of credentials that passed the provider's read-only
   * validation call. A launch is allowed only while this matches the token. */
  validatedProviders?: Record<string, string>;
}

export function providerCredentialFingerprint(token: string): string {
  return createHash("sha256").update(String(token || "").trim()).digest("hex");
}

export const DEFAULT_HOSTED_PROVISIONING: HostedProvisioning = { enabled: false };

export function normalizeHostedProvisioning(value: unknown): HostedProvisioning {
  if (!value || typeof value !== "object") return { ...DEFAULT_HOSTED_PROVISIONING };
  const v = value as Record<string, unknown>;
  const out: HostedProvisioning = { enabled: Boolean(v.enabled) };
  if (typeof v.githubIdentity === "string" && (GITHUB_IDENTITY_MODES as readonly string[]).includes(v.githubIdentity)) {
    out.githubIdentity = v.githubIdentity as GithubIdentityMode;
  }
  if (typeof v.githubToken === "string" && v.githubToken.trim()) out.githubToken = v.githubToken.trim();
  const app = v.githubApp as Record<string, unknown> | undefined;
  if (app && typeof app === "object"
    && typeof app.appId === "string" && app.appId.trim()
    && typeof app.installationId === "string" && app.installationId.trim()
    && typeof app.privateKeyPem === "string" && app.privateKeyPem.trim()) {
    out.githubApp = { appId: app.appId.trim(), installationId: app.installationId.trim(), privateKeyPem: app.privateKeyPem };
  }
  if (v.providerTokens && typeof v.providerTokens === "object") {
    const tokens: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.providerTokens as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) tokens[k.trim()] = val.trim();
    }
    if (Object.keys(tokens).length) out.providerTokens = tokens;
  }
  if (v.validatedProviders && typeof v.validatedProviders === "object") {
    const validated: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.validatedProviders as Record<string, unknown>)) {
      if (typeof val === "string" && /^[a-f0-9]{64}$/.test(val)) validated[k.trim()] = val;
    }
    if (Object.keys(validated).length) out.validatedProviders = validated;
  }
  return out;
}

/** Non-secret view of hosted provisioning for GET responses — never leaks tokens. */
export interface HostedProvisioningStatus {
  enabled: boolean;
  credential: "app" | "pat" | "none";
  githubIdentity?: GithubIdentityMode;
  githubAppId?: string;
  providers: string[];
  validatedProviders: string[];
}
export function redactHostedProvisioning(h: HostedProvisioning): HostedProvisioningStatus {
  return {
    enabled: h.enabled,
    credential: h.githubApp ? "app" : h.githubToken ? "pat" : "none",
    githubIdentity: h.githubIdentity,
    githubAppId: h.githubApp?.appId,
    providers: Object.keys(h.providerTokens ?? {}),
    validatedProviders: Object.entries(h.providerTokens ?? {})
      .filter(([provider, token]) => h.validatedProviders?.[provider] === providerCredentialFingerprint(token))
      .map(([provider]) => provider),
  };
}

/** Durable control-plane intent for one paid machine creation. Written before
 * enrollment/provider calls and retained through confirmed deletion so a crash
 * cannot make a provider resource invisible to reconciliation. */
export type HostedMachineAttemptState =
  | "requested" | "enrolled" | "provider-accepted" | "tracked"
  | "ready" | "claimed" | "working" | "deleting" | "deleted" | "failed";

/** What the controller wants for this attempt, independent of `state` (what has
 * actually been observed). "deleted" is set by TTL/boot-deadline expiry, a user
 * force-destroy, or the reconciler abandoning a hopeless create — and, once set,
 * is never reverted; the reconciler's only remaining job for that attempt is to
 * drive `state` to "deleted" and stop retrying creation. */
export type HostedMachineAttemptDesiredState = "active" | "deleted";

export interface HostedMachineAttempt {
  accountId: string;
  attemptId: string;
  provider: string;
  configId?: string;
  nodeId: string;
  state: HostedMachineAttemptState;
  /** Controller intent — see `HostedMachineAttemptDesiredState`. Optional on
   * write (defaults to "active"); always present on read. */
  desiredState?: HostedMachineAttemptDesiredState;
  /** Last raw status string the provider reported for this resource (e.g.
   * Hetzner "running"/"off"), distinct from the coarse controller `state`. */
  observedState?: string;
  /** Next moment the reconciler should force a transition for this attempt
   * (boot timeout, TTL+grace, etc.) — persisted so it survives a controller
   * restart and can be shown verbatim in the UI/audit trail. */
  deadlineAt?: string;
  /** Opaque per-account tag applied to every provider resource this attempt
   * creates (see `ownershipTagFor`), so an orphan sweep can discover resources
   * belonging to this account without ever tagging providers with a raw id. */
  ownershipTag?: string;
  desired: Record<string, unknown>;
  machine?: Record<string, unknown>;
  lastError?: string;
  retryCount: number;
  /** Optimistic-concurrency counter. Incremented by the store on every write
   * (the input value is ignored — always read back from the row); callers
   * that read-modify-write under contention (the reconciler) may pass
   * `expectedVersion` to `putHostedMachineAttempt` to fence a stale write. */
  version?: number;
  createdAt: string;
  updatedAt: string;
}

/** Thrown by `putHostedMachineAttempt` when `expectedVersion` no longer matches
 * the stored row — another writer (a second reconciler pass, a concurrent
 * replica) has already moved this attempt forward. Callers should re-read and
 * decide whether their update still applies rather than blindly retrying. */
export class ConcurrentAttemptUpdateError extends Error {
  constructor(accountId: string, attemptId: string) {
    super(`hosted machine attempt ${accountId}/${attemptId} was updated concurrently`);
    this.name = "ConcurrentAttemptUpdateError";
  }
}

/** Stable, non-reversible per-account tag applied to every provider resource a
 * hosted launch creates (Hetzner label, Fly metadata, EC2 tag). Never the raw
 * account id — a provider account/API console may be shared or visible to
 * support staff, and the tag's only job is to scope an orphan-discovery scan to
 * "resources this Bivy account is responsible for", not to identify the account. */
export function ownershipTagFor(accountId: string): string {
  return createHash("sha256").update(`bivy-ownership:${accountId}`).digest("hex").slice(0, 24);
}

/** An audit event recording a use of hosted credentials (never contains a secret). */
export interface HostedAuditEvent {
  at: string;
  action: "credential_updated" | "credential_rotated" | "credential_validation_failed" | "github_app_connected" | "github_app_disconnected" | "provision_attempt" | "provision_launched" | "provision_failed" | "token_minted" | "machine_reaped" | "machine_milestone" | "reconcile_failed" | "room_key_escrowed" | "room_key_reused" | "work_routed" | "capacity_ready" | "capacity_claimed" | "orphan_reaped" | "orphan_detected" | "attempt_abandoned" | "force_destroy_requested" | "model_credential_escrowed" | "model_credential_used" | "central_install_bound" | "central_install_updated" | "central_install_unbound" | "central_install_reconciled";
  provider?: string;
  configId?: string;
  nodeId?: string;
  workItemId?: string;
  detail?: string;
}

// Cross-node model credential snapshot. Nodes push the exact provider auth
// records their local credential vault uses; other nodes on the same account can pull
// and import them so model logins/API keys are account-wide instead of per-node.
export interface ModelAuthVault {
  ciphertext: string;
  updatedAt: string;
  updatedByNodeId: string;
  /** A removed node held this vault key; a survivor must re-key before its next push. */
  needsRotation: boolean;
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

// Device→device ephemeral-provider-token vault (P2 / Gap A). Same E2E shape as
// the model-auth vault, but recipients are the account's paired DEVICES (keyed
// by X25519 public key), so a second device can wake/reach a machine the first
// launched. The control plane stores only ciphertext + per-device wrapped keys.
export interface DeviceVault {
  ciphertext: string;
  updatedByDevice: string;
  updatedAt: string;
  /** Optimistic ciphertext revision. */
  generation: number;
  /** Vault-key epoch, advanced whenever a paired device is revoked. */
  keyGeneration: number;
}

export interface DeviceVaultWrappedKeyRecord {
  devicePublicKey: string;
  wrappedKey: string;
  wrappedByPublicKey: string;
  generation: number;
  updatedAt: string;
}

export interface DeviceVaultKeyRequest {
  devicePublicKey: string;
  createdAt: string;
}

// A durable, node-independent, E2E-encrypted session snapshot (Gap B). Keyed by
// session (not node) so it survives the owning machine's teardown; the control
// plane stores only opaque ciphertext (a sealed replication frame — transcript +
// git checkpoint + runtime resume token), never plaintext. Lets a torn-down
// destroy-lane session be rebuilt onto a fresh machine.
export interface SessionSnapshotRecord {
  sessionId: string;
  ciphertext: string;
  updatedAt: string;
}

// Durable session↔machine correlation (Gap 1). Non-secret routing/identity that
// lets a torn-down destroy-lane session be rebuilt AFTER its node is unenrolled
// and drops from the node registry: it records the reusable eph-* node id plus
// the launch params needed to re-provision the same machine. Keyed by session
// and NOT FK-cascaded off nodes, so it outlives teardown (like session_snapshots).
// Same trust tier as nodeId — never holds a credential (the escrowed room key for
// hosted rebuild lives separately in node_room_keys, Gap 3).
export interface SessionCorrelation {
  sessionId: string;
  nodeId: string;
  provider: string;
  region?: string;
  ttlMinutes?: number;
  repo?: string;
  setupId?: string;
  machineId?: string;
  app?: string;
  computeSource?: "user" | "managed";
  updatedAt: string;
}
export type SessionCorrelationInput = Omit<SessionCorrelation, "updatedAt">;

// GitHub App private-key vault (issue #88). Same shape/guarantee as the model-
// auth vault above — the control plane stores ciphertext plus per-node wrapped
// keys and never a plaintext key — but keyed per APP (`appId`), not one blob per
// account: an account can hold several apps (personal + one per org, see
// src/github-apps.ts), each with its own key and its own rotation lifecycle,
// and a node opted into sync should be able to hold some without holding all.
export interface GithubAppVault {
  appId: string;
  ciphertext: string;
  updatedByNodeId: string;
  // Set when a node that held this app's wrapped key was removed from the
  // account. A surviving node that still holds the plaintext key (any node
  // that already synced it) mints a FRESH vault key and re-pushes on its next
  // sync tick, which is what actually invalidates the removed node's cached
  // copy — clearing this flag is a side effect of that push, not of reading it.
  needsRotation: boolean;
  updatedAt: string;
}

export interface GithubAppWrappedKey {
  appId: string;
  nodeId: string;
  wrappedKey: string;
  wrappedByNodeId: string;
  wrappedByPublicKey: string;
  updatedAt: string;
}

export interface GithubAppKeyRequest {
  appId: string;
  nodeId: string;
  publicKey: string;
  createdAt: string;
}

// --- Automation runs / legacy work queue adapter ------------------------------
// Inbound front doors (GitHub issue webhook, Slack command) enqueue WORK ITEMS
// on the control plane. The node — which dials outbound only (invariant #4) —
// gets a best-effort relay push hint, then PULLS/claims pending items over the
// control-plane API, runs one on its own machine with its own token (content
// never reaches the control plane), then marks it done. The
// control plane stores only routing metadata: ids, repo slug, issue number,
// title/body text of the request. Never agent output or credentials.
export type AutomationRunStatus =
  | "pending"
  | "claimed"
  | "running"
  | "waiting"
  | "needs_attention"
  | "succeeded"
  | "failed"
  | "cancelled";
/** Compatibility status accepted by clients deployed before the automation model. */
export type WorkItemStatus = AutomationRunStatus | "done";

export interface CancelAutomationRunResult {
  run: AutomationRun;
  previousStatus: AutomationRunStatus;
  transitioned: boolean;
}
export interface RetryAutomationRunResult {
  run: AutomationRun;
  transitioned: boolean;
  reason?: "not_retryable" | "attempt_limit";
}
export type AutomationTriggerKind = "github" | "slack" | "manual" | "webhook" | "schedule";

// --- Privacy-safe run evidence (issue #153) -----------------------------------
// A run's routing/status/output above already carry most of an outcome report.
// This adds exactly the two pieces that are still missing: an ordered,
// human-readable EVENT TIMELINE (trigger → routed → claimed → attempts →
// retries/fallback → approvals/policy denials → branch/PR → completion) and a
// list of declared validation CHECKS with pass/fail/exit status. Everything
// here is allowlisted and bounded by `sanitizeEvidencePatch` (run-evidence.ts)
// before it ever reaches storage — no prompt, transcript, diff, file content,
// secret, token, or raw command/tool output is ever accepted.
export type RunEvidenceEventKind =
  // Canonical causal lifecycle. Legacy names below remain readable during the
  // additive rollout; new control-plane milestones use these exact stages.
  | "trigger_received" | "trigger_matched" | "queued" | "routed"
  | "provisioning" | "claimed" | "agent_started"
  | "checks_started" | "checks_completed" | "result_delivery"
  | "notification" | "retry" | "cancel_requested" | "terminal"
  // Evidence/detail and legacy lifecycle vocabulary.
  | "triggered" | "attempt_started" | "checkpoint" | "approval"
  | "policy_denial" | "fallback" | "branch" | "pull_request"
  | "needs_attention" | "completed" | "cancelled";
export interface RunEvidenceEvent {
  at: string;
  kind: RunEvidenceEventKind;
  /** Short, bounded, human-readable description — never raw tool/command output. */
  summary: string;
  attempt?: number;
  /** A bounded identifier this event concerns (branch name, node id, check name, etc). */
  ref?: string;
  url?: string;
  status?: "passed" | "failed" | "denied" | "approved";
  /** Closed, machine-readable reason; bounded free-text stays in summary. */
  reasonCode?: string;
  /** Receipt/evidence/log identifier or URL; never log content. */
  evidenceRef?: string;
  /** Stable id makes retried reports idempotent. */
  milestoneId?: string;
}
export interface RunCheck {
  name: string;
  /** Hash of the declared validation command, never the command text itself. */
  commandHash?: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs?: number;
}
export interface RunReceiptEvidence {
  approvals: { requests: number; approved: number; denied: number };
  fileChanges: { files: Array<{ path: string; op?: string; added?: number; removed?: number }>; added: number; removed: number };
  auditHealth: { correlation: "healthy" | "missing"; readableStorage: "healthy" | "missing"; successfulWrites: "healthy" | "missing" };
  execution?: {
    profile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
    controller?: "customer" | "bivy_hosted_provisioning";
    agentVersion?: string;
    modelVersionStatus?: "available" | "unavailable" | "unknown";
  };
  protection?: {
    effective?: {
      executionProfile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
      sandboxTier?: "read-only" | "workspace-write" | "danger-full-access";
      approvalMode?: "never" | "risky" | "always" | "autonomous";
      runtimeEnforcement?: string;
      trustModes?: string[];
    };
    capabilities?: Array<{ capability: "sandbox" | "approval" | "tool" | "network" | "credential_custody" | "runtime_policy"; evidenceClass: "enforced" | "observed" | "unavailable"; mechanism?: string }>;
  };
}
/** Sanitized, allowlisted patch a node may report against its own claimed run.
 *  `checks`/`events` are treated as INCREMENTAL — appended to, never replacing,
 *  the run's existing history. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}
export interface RunNotificationDelivery {
  status: "not_requested" | "pending" | "delivered" | "failed";
  channel?: "push" | "email" | "webhook";
  updatedAt: string;
  reason?: string;
}
export interface RunReference {
  kind: "receipt" | "evidence" | "log";
  ref: string;
  url?: string;
}
export interface RunAttention {
  severity: "warning" | "error" | "critical";
  reason: string;
  since: string;
}
export interface RunEvidencePatch {
  routingReason?: string;
  output?: Partial<NonNullable<AutomationRun["output"]>>;
  checks?: RunCheck[];
  events?: RunEvidenceEvent[];
  receiptEvidence?: RunReceiptEvidence;
  usage?: RunUsage;
  notification?: RunNotificationDelivery;
  references?: RunReference[];
  attention?: RunAttention | null;
}
export interface AutomationDefinition {
  id: string;
  accountId: string;
  name: string;
  /** Stable source-control key used by `bivy automation apply`. Undefined for UI-managed definitions. */
  configKey?: string;
  /** File order for source-controlled first-match semantics. */
  configOrder?: number;
  /** End-to-end encrypted template; the control plane cannot inspect instructions. */
  templateCiphertext?: string;
  runtimeId?: string;
  model?: string;
  nodeLabel?: string;
  ephemeral?: boolean;
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Hard per-run attempt ceiling, independent of the active retry/fallback ruleset. */
  maxAttempts?: number;
  /** Capability tags a run of this automation needs. Hard block: a node/machine
   * missing any of these must not claim it. See @bivy/core's capability-routing. */
  requiredCapabilities?: string[];
  /** Capability tags a run of this automation prefers. Soft rank only — never
   * gates eligibility, and never fabricates a match that isn't there. */
  preferredCapabilities?: string[];
  enabled?: boolean;
  /** How this automation fires. Defaults to "schedule" for legacy rows (any row
   *  with a `schedule` is schedule-triggered). A "webhook" automation is fired by
   *  a signed POST to /webhooks/automation/run/:id. "github" / "linear" are source
   *  triggers: inbound events match this definition and start a session.
   *  "github_ci" is a legacy alias for a GitHub job gated on workflow_run failures
   *  — new rows should use trigger=github + `on` rules. */
  trigger?: "schedule" | "webhook" | "manual" | "github" | "linear" | "github_ci";
  /** HMAC signing secret for a webhook-triggered automation. Set/rotated
   *  server-side, returned to the client only at create/rotate time, and never
   *  echoed by list/get responses. */
  webhookSecret?: string;
  /** Explicit save-time acknowledgement of the autonomous + danger-full-access
   *  combo (mirrors config-as-code's safety.allowDangerous). Without this, the
   *  shared preflight checklist's sandbox_policy check blocks create/update —
   *  see runPreflightChecks in src/automation/preflight.ts. Has no effect on
   *  any other combo. */
  allowDangerous?: boolean;
  /** Optional GitHub repo workspace target (`owner/name`). Used when the trigger
   *  does not carry a repo of its own (schedule, many webhooks). The node clones
   *  this repo before starting the session — the agent does not pick the repo. */
  repo?: string;
  /** Label filter for github/linear source triggers. Empty/undefined → default
   *  `bivy` / `bivy/<node>` contract. Prefer per-rule labels on `on` for GitHub. */
  labels?: string[];
  /** Repo allowlist for github/linear (`owner/name`). Empty/undefined → all. */
  repos?: string[];
  /**
   * GitHub event rules ("when"). Any matching rule fires the job. Outcomes are
   * whatever the instructions say — not a special PR path. Legacy rows without
   * `on` expand via effectiveEventRules() in automation-match.ts.
   */
  on?: Array<{
    event: "issues" | "issue_comment" | "pull_request" | "pull_request_review_comment" | "workflow_run";
    actions?: string[];
    labels?: string[];
    mention?: boolean;
    conclusions?: string[];
    workflows?: string[];
  }>;
  /** Built-in template id (e.g. `issue-to-pr`) or custom. Display + node hints. */
  templateId?: string;
  /** When set, schedule/manual runs CONTINUE this existing session instead of
   *  starting a new one (scheduled chat messages). Mirrors WorkItemInput.target;
   *  only "existing_session" is stored — the default "new_session" is
   *  represented by absence. */
  target?: { kind: "existing_session"; sessionId: string };
  /** When set, schedule/manual runs are plain chat messages rather than
   *  automation jobs: the node skips the automation boilerplate, auto-push and
   *  required checks (scheduled "message me later" reminders). */
  message?: boolean;
  schedule?:
    | { kind: "once"; at: string }
    | { kind: "cron"; expression: string; timezone: string };
  nextRunAt?: string;
  lastScheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TriggerEvent {
  id: string;
  accountId: string;
  kind: AutomationTriggerKind;
  sourceKey?: string;
  sourceRef?: { repo?: string; issueNumber?: number; url?: string; externalId?: string };
  createdAt: string;
}
export interface AutomationRun {
  id: string;
  accountId: string;
  definitionId?: string;
  triggerId: string;
  triggerKind: AutomationTriggerKind;
  status: AutomationRunStatus;
  attempt: number;
  maxAttempts?: number;
  target: { kind: "new_session" } | { kind: "existing_session"; sessionId: string };
  routing: {
    nodeLabel: string;
    runtimeId?: string;
    model?: string;
    ephemeral?: boolean;
    approvalMode?: AutomationDefinition["approvalMode"];
    sandbox?: AutomationDefinition["sandbox"];
    requiredCapabilities?: string[];
    preferredCapabilities?: string[];
  };
  output?: {
    sessionId?: string;
    branch?: string;
    prUrl?: string;
    artifactUrl?: string;
    failure?: string;
    /** Per-turn git checkpoint id (rewind target), if the session's harness recorded one. */
    checkpoint?: string;
    /** Commit the run's final checkpoint/PR points at. */
    commit?: string;
  };
  /** Why this run's node/runtime/model was chosen (queue label, manual override,
   *  default agent, fallback after an error, ...). Free text, bounded. */
  routingReason?: string;
  /** Declared validation commands and their pass/fail/exit status — never the
   *  command text itself. */
  checks?: RunCheck[];
  /** Ordered, capped, privacy-safe event timeline for the run-detail/outcome report. */
  events?: RunEvidenceEvent[];
  /** Bounded governance metadata correlated from the node audit stream. */
  receiptEvidence?: RunReceiptEvidence;
  /** Optional provider-reported usage/cost, sanitized operational references,
   *  delivery state, and explicit operator attention. */
  usage?: RunUsage;
  notification?: RunNotificationDelivery;
  references?: RunReference[];
  attention?: RunAttention;
  title: string;
  body?: string;
  /** Plain chat message (no automation boilerplate/push/checks). */
  message?: boolean;
  /** Untrusted, plaintext context from a webhook trigger's event payload,
   *  appended to the (E2E-decrypted) operator template on the node as data — not
   *  instructions. Only set for webhook-triggered automation runs. */
  eventContext?: string;
  source: string;
  sourceRef?: TriggerEvent["sourceRef"];
  createdAt: string;
  claimedByNodeId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface WorkItem {
  id: string;
  accountId: string;
  label: string; // routing label; a node only pulls items whose label it serves
  source: string; // "github:issue" | "slack"
  status: WorkItemStatus;
  title: string;
  body?: string;
  /** See AutomationRun.eventContext — untrusted webhook-payload context. */
  eventContext?: string;
  repo?: string; // "owner/repo"
  issueNumber?: number;
  externalId?: string; // provider-native id (for example a Linear issue UUID)
  url?: string;
  createdAt: string;
  claimedByNodeId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
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
  approvalMode?: AutomationDefinition["approvalMode"];
  sandbox?: AutomationDefinition["sandbox"];
  maxAttempts?: number;
  /** See AutomationDefinition.requiredCapabilities/preferredCapabilities — copied
   * onto the item at enqueue time (explicit override, else the definition's). */
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
  installationId?: string; // GitHub App installation id — the node mints a token for it
  appId?: string; // which GitHub App that installation belongs to (a node may serve several)
  // True when a device dispatched this item to a freshly-provisioned ephemeral
  // server rather than an already-running node (issue #532). Display only —
  // `label` alone drives routing; an ephemeral machine serves a one-off
  // `bivy/<slug>` label no differently than a persistent node would.
  ephemeral?: boolean;
  /** Canonical automation fields; legacy clients can ignore these. */
  definitionId?: string;
  triggerId?: string;
  triggerKind?: AutomationTriggerKind;
  attempt?: number;
  targetKind?: "new_session" | "existing_session";
  targetSessionId?: string;
  startedAt?: string;
  output?: AutomationRun["output"];
  /** See AutomationRun — legacy clients can ignore these. */
  routingReason?: string;
  checks?: RunCheck[];
  events?: RunEvidenceEvent[];
  receiptEvidence?: RunReceiptEvidence;
  usage?: RunUsage;
  notification?: RunNotificationDelivery;
  references?: RunReference[];
  attention?: RunAttention;
  /** Plain chat message (no automation boilerplate/push/checks). */
  message?: boolean;
}
export type WorkItemInput = {
  label?: string;
  source: string;
  title: string;
  body?: string;
  /** See AutomationRun.eventContext — untrusted webhook-payload context. */
  eventContext?: string;
  repo?: string;
  issueNumber?: number;
  url?: string;
  externalId?: string;
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
  approvalMode?: AutomationDefinition["approvalMode"];
  sandbox?: AutomationDefinition["sandbox"];
  maxAttempts?: number;
  ephemeral?: boolean;
  installationId?: string;
  appId?: string;
  definitionId?: string;
  triggerKind?: AutomationTriggerKind;
  target?: AutomationRun["target"];
  /** Plain chat message (no automation boilerplate/push/checks). */
  message?: boolean;
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
};

export interface NodeClaim {
  id: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  nodeId?: string;
}

// One central-app installation bound to an account. `installationId` is
// GitHub-global (an installation exists exactly once, on one GitHub org/user),
// so it is the natural primary key; the binding to a Bivy account is what the
// state-signed setup callback establishes. Everything here is non-secret
// metadata — the credential is minted on demand from the operator's central
// app key (see central-github-app.ts).
export interface CentralGithubInstallation {
  installationId: string;
  accountId: string;
  /** GitHub login the app is installed on (org or user) — matches repo owners. */
  githubAccount?: string;
  githubAccountType?: string;
  /** GitHub's "all" | "selected" — which repos the installation covers. */
  repositorySelection?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CentralGithubInstallationInput {
  installationId: string;
  accountId: string;
  githubAccount?: string;
  githubAccountType?: string;
  repositorySelection?: string;
}

// Per-account inbound hook: a stable id + secret a user configures in GitHub /
// Slack so their webhooks route to THEIR account. The secret verifies the
// payload signature; it is not a third-party credential (no repo/Slack access).
export interface InboundHook {
  id: string;
  accountId: string;
  kind: string; // "github" | "github_app" | "linear" | "slack"
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
  // Who may `@`-mention-trigger a run via a GitHub issue/comment (issue #259:
  // on a public repo, anyone can otherwise comment and burn the account's
  // automation capacity). Checked against the triggering author's GitHub
  // `author_association` — see `meetsTriggerAccess` in webhooks.ts. undefined
  // (and "everyone") mean no restriction — the behavior before this setting
  // existed. Set from Settings → GitHub App in the web UI.
  triggerAccess?: "everyone" | "contributor" | "collaborator";
  // The node that currently holds this GitHub App's private key and services it
  // (set when a node registers app-meta / connects). The control plane can't run
  // the app itself — only a node with the key can — so this is how the UI tells
  // "configured" from "actually being served". Cleared when that node is removed,
  // so a reinstalled/deleted node no longer shows a false "connected".
  servingNodeId?: string;
  servingNodeSeenAt?: string; // ISO time the serving node last (re)registered
  // Generic automation configuration. The template is a fixed instruction
  // prefix selected by the account; payload data is appended as plain text and
  // can never select a runtime, model, command, or executable template engine.
  enabled?: boolean;
  templateInstruction?: string;
  routingDefault?: string;
  updatedAt?: string;
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

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000; // 15 minutes

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Aggregate counts for the operational/business dashboard. Pure metadata — row
// counts and group-bys over existing tables, never any row contents. Refreshed
// on an interval by the metrics collector (metrics.ts) and exposed as Prometheus
// gauges. See docs/ops/monitoring.md in bivysh/bivy-cloud.
export interface UsageMetrics {
  accountsTotal: number;
  nodesTotal: number;
  nodesOnline: number;
  workItemsByStatus: Record<string, number>;
  sessionsByStatus: Record<string, number>;
}

export interface SessionUsageRecord {
  accountId: string;
  /** Stable launch/attempt identity; the idempotency key for settlement. */
  usageId: string;
  sessionId?: string;
  machineId?: string;
  nodeId?: string;
  launchedAt: string;
  firstAgentEventAt?: string;
  settledAt: string;
  machineSeconds: number;
  activeAgentSeconds: number;
}

export interface StoreLifecycle {
  init(): Promise<void>;
  // Lightweight liveness check for the backing store. Resolves when the store is
  // reachable, rejects when it is not (e.g. Postgres unreachable). Used by the
  // /readyz readiness probe so an unreachable database surfaces as an unhealthy
  // container instead of a green light over an outage.
  ping(): Promise<void>;

  // Aggregate counts for the monitoring dashboard (metadata only). See
  // UsageMetrics above.
  usageMetrics(): Promise<UsageMetrics>;

}

export interface AccountAuthRepository {
  // Accounts & auth
  findOrCreateAccount(email: string): Promise<Account>;
  getAccount(accountId: string): Promise<Account | undefined>;
  setGithubIdentity(accountId: string, githubUserId: string, targetIds: string[]): Promise<void>;
  createLoginToken(email: string): Promise<string>; // magic-link, returns raw token
  consumeLoginToken(token: string): Promise<Account | undefined>;
  createSession(accountId: string): Promise<string>; // returns raw session token
  accountFromSession(token: string | null): Promise<Account | undefined>;
  revokeSession(token: string): Promise<void>;

  // Fleet-wide auth coordination. OAuth state must survive a callback landing
  // on another replica; auth throttles must not reset when traffic moves between
  // replicas. Both are atomic in the shared store.
  createOAuthState(input: OAuthState, ttlMs?: number): Promise<string>;
  consumeOAuthState(state: string): Promise<OAuthState | undefined>;
  rateLimitExceeded(bucket: string, key: string, limit: number, windowMs: number): Promise<boolean>;

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

}

export interface NodeRepository {
  // Nodes
  listNodes(accountId: string): Promise<NodeRecord[]>;
  enrollNode(
    accountId: string,
    nodeId: string,
    name: string,
  ): Promise<{ node: Omit<NodeRecord, "enrollmentTokenHash">; enrollmentToken: string; created: boolean }>;
  nodeFromEnrollmentToken(token: string | null): Promise<NodeRecord | undefined>;
  setNodeOnline(nodeId: string, online: boolean): Promise<void>;
  setNodeName(nodeId: string, name: string): Promise<NodeRecord | undefined>;
  removeNode(accountId: string, nodeId: string): Promise<boolean>;
  // Plaintext per-node provider status summary (see NodeProviderSummary) —
  // overwritten wholesale by the owning node on every credential change.
  setNodeProviders(nodeId: string, providers: NodeProviderSummary[]): Promise<void>;
  setNodeBootstrapStatus(nodeId: string, phase: string): Promise<void>;
  // Owner-declared capability tags (see NodeRecord.capabilities) — overwritten
  // wholesale by the owning node on every config change, same trust tier as
  // setNodeProviders. Never verified; a stale/offline declaration is kept as-is.
  setNodeCapabilities(nodeId: string, capabilities: string[]): Promise<void>;

}

export interface SessionIndexRepository {
  // Session index (cross-node unified view). A node replaces its full current
  // session list; clients read the merged list for the account.
  // Returns how many session ids were first observed (and therefore became new
  // run starts). This preserves idempotency while letting the control plane emit
  // an accurate run-start funnel event rather than counting every status update.
  replaceNodeSessions(accountId: string, nodeId: string, sessions: SessionAdvert[]): Promise<void>;
  // Incremental single-session advertise. A session's status flips constantly
  // (idle→working→needs_action); routing that through `replaceNodeSessions`
  // means reading and rewriting the node's ENTIRE index per flip — O(sessions)
  // work per event, O(sessions²) in aggregate. This upserts just the one row.
  // True only when this session produced a new run-start row.
  upsertNodeSession(accountId: string, nodeId: string, session: SessionAdvert): Promise<void>;
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

}

export interface NotificationRepository {
  // Web Push subscriptions for hosted PWA notifications.
  upsertPushSubscription(accountId: string, endpoint: string, subscription: unknown): Promise<void>;
  removePushSubscription(accountId: string, endpoint: string): Promise<void>;
  listPushSubscriptions(accountId: string): Promise<PushSubscriptionRecord[]>;

  // Per-account notification preferences (which push kinds are enabled). The
  // getter always returns a full, normalized map; the setter merges a partial
  // patch and returns the effective preferences.
  getNotificationPreferences(accountId: string): Promise<NotificationPreferences>;
  setNotificationPreferences(accountId: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences>;

}

export interface EphemeralConfigurationRepository {
  // Per-account ephemeral-queue-default preference (issue #532): whether/how a
  // signed-in device should auto-provision an ephemeral runner for the GitHub
  // work queue when nothing persistent is online. Same getter/setter shape as
  // notification preferences above.
  getEphemeralQueueDefault(accountId: string): Promise<EphemeralQueueDefault>;
  setEphemeralQueueDefault(accountId: string, patch: Partial<EphemeralQueueDefault>): Promise<EphemeralQueueDefault>;

  // Per-account ephemeral node configs (reusable, named runner templates) and
  // the account's default queue routing (primary runner + optional fallback).
  // Both are JSONB on the account row, same getter/full-set shape as above.
  getEphemeralConfigs(accountId: string): Promise<EphemeralNodeConfig[]>;
  setEphemeralConfigs(accountId: string, configs: EphemeralNodeConfig[]): Promise<EphemeralNodeConfig[]>;
  getQueueRouting(accountId: string): Promise<QueueRouting>;
  setQueueRouting(accountId: string, routing: QueueRouting): Promise<QueueRouting>;

}

export interface HostedMachineRepository {
  // Hosted (control-plane-orchestrated) provisioning: per-account credentials +
  // enable flag, and a tracking list of machines the control plane launched
  // itself (for dedupe/teardown). Machines are stored as opaque JSONB records.
  getHostedProvisioning(accountId: string): Promise<HostedProvisioning>;
  /** Non-decrypting presence view for the settings UI (no master key needed). */
  getHostedProvisioningStatus(accountId: string): Promise<HostedProvisioningStatus>;
  setHostedProvisioning(accountId: string, patch: Partial<HostedProvisioning>): Promise<HostedProvisioning>;
  getHostedMachines(accountId: string): Promise<Array<Record<string, unknown>>>;
  setHostedMachines(accountId: string, machines: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
  /** Upsert an attempt row. When `opts.expectedVersion` is given, the write is
   * fenced: it only applies if the stored row's `version` still matches, else
   * throws `ConcurrentAttemptUpdateError`. Omitted, this is last-write-wins
   * (the shape every pre-existing call site relies on). */
  putHostedMachineAttempt(attempt: HostedMachineAttempt, opts?: { expectedVersion?: number }): Promise<HostedMachineAttempt>;
  getHostedMachineAttempt(accountId: string, attemptId: string): Promise<HostedMachineAttempt | undefined>;
  listHostedMachineAttempts(accountId: string, activeOnly?: boolean): Promise<HostedMachineAttempt[]>;
  /** Cross-replica mutex around the read/decide/provider-launch sequence. The
   * lease expires so a crashed control-plane process cannot wedge the account. */
  acquireHostedProvisionLease(accountId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  /** Extend only a lease still owned by `holder`; false means ownership was lost. */
  renewHostedProvisionLease(accountId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseHostedProvisionLease(accountId: string, holder: string): Promise<void>;
  /** Accounts that currently track at least one control-plane-provisioned
   * machine. Used by the global lifecycle reconciler; returns ids only. */
  listHostedMachineAccountIds(): Promise<string[]>;
  /** Accounts with at least one config requesting ready capacity. */
  listReadyCapacityAccountIds(): Promise<string[]>;
  /** Accounts with hosted provisioning enabled — a superset of
   * `listHostedMachineAccountIds()` that includes accounts with NO currently
   * tracked machine/attempt. Used by the orphan-discovery sweep: the one
   * failure mode it exists to catch is exactly "tracking itself was lost", so
   * it cannot rely on tracking to know which accounts to check. */
  listHostedEnabledAccountIds(): Promise<string[]>;
  // Append-only audit trail of hosted-credential use (capped, newest-first read).
  appendHostedAudit(accountId: string, event: HostedAuditEvent): Promise<void>;
  listHostedAudit(accountId: string, limit?: number): Promise<HostedAuditEvent[]>;

}

export interface ComputeUsageRepository {
  /** Idempotently persist a settled launch. The first settlement boundary wins,
   * so repeated teardown callbacks cannot extend or double-charge the machine. */
  upsertSessionUsage(record: SessionUsageRecord): Promise<SessionUsageRecord>;
  /** Rows overlapping [startsAt, endsAt), oldest boundaries included. */
  listSessionUsage(accountId: string, startsAt: string, endsAt: string, limit?: number): Promise<SessionUsageRecord[]>;
}

export interface VaultRepository {
  // Account-wide model provider credentials, shared across enrolled nodes.
  getModelAuthVault(accountId: string): Promise<ModelAuthVault | undefined>;
  setModelAuthVault(accountId: string, nodeId: string, ciphertext: string, rotated?: boolean): Promise<ModelAuthVault>;
  setModelAuthNodePublicKey(accountId: string, nodeId: string, publicKey: string): Promise<void>;
  getModelAuthWrappedKey(accountId: string, nodeId: string): Promise<ModelAuthWrappedKey | undefined>;
  requestModelAuthWrappedKey(accountId: string, nodeId: string, publicKey: string): Promise<void>;
  listModelAuthKeyRequests(accountId: string, exceptNodeId: string): Promise<ModelAuthKeyRequest[]>;
  setModelAuthWrappedKey(accountId: string, targetNodeId: string, wrappedByNodeId: string, wrappedByPublicKey: string, wrappedKey: string): Promise<ModelAuthWrappedKey>;

  // Node-less inheritance (hosted): escrow the model-auth vault KEY, sealed at rest
  // with the per-account hosted key, so a LONE hosted ephemeral can decrypt the
  // synced vault (incl. subscription OAuth) with no peer to wrap the key. Hosted-
  // provisioning accounts ONLY (enforced at the endpoint) — CP-readable by design,
  // the same posture as provider tokens / room-key escrow. Non-hosted accounts stay
  // fully peer-wrapped (E2E, CP-blind).
  getHostedModelAuthVaultKey(accountId: string): Promise<SecretEnvelope | undefined>;
  setHostedModelAuthVaultKey(accountId: string, enc: SecretEnvelope): Promise<void>;
  /** Separately encrypted snapshot containing only explicitly granted records. */
  getHostedModelAuthVault(accountId: string): Promise<{ ciphertext: string; generation: number; revision: number } | undefined>;
  setHostedModelAuthVault(accountId: string, ciphertext: string, enc: SecretEnvelope, expectedGeneration: number, revision: number): Promise<number | undefined>;

  // Device→device provider-token vault (P2 / Gap A) — recipients are paired devices.
  getDeviceVault(accountId: string): Promise<DeviceVault | undefined>;
  /** Compare-and-set ciphertext. A stale expected generation fails with 409. */
  setDeviceVault(accountId: string, byDevicePublicKey: string, ciphertext: string, expectedGeneration?: number, keyGeneration?: number): Promise<DeviceVault>;
  getDeviceVaultWrappedKey(accountId: string, devicePublicKey: string): Promise<DeviceVaultWrappedKeyRecord | undefined>;
  requestDeviceVaultWrappedKey(accountId: string, devicePublicKey: string): Promise<void>;
  listDeviceVaultKeyRequests(accountId: string, exceptDevicePublicKey: string): Promise<DeviceVaultKeyRequest[]>;
  setDeviceVaultWrappedKey(accountId: string, targetDevicePublicKey: string, wrappedByPublicKey: string, wrappedKey: string, generation?: number): Promise<DeviceVaultWrappedKeyRecord>;

}

export interface SessionStateRepository {
  // Durable E2E session snapshots for rebuild-resume (Gap B) — opaque ciphertext.
  getSessionSnapshot(accountId: string, sessionId: string): Promise<SessionSnapshotRecord | undefined>;
  setSessionSnapshot(accountId: string, sessionId: string, ciphertext: string): Promise<SessionSnapshotRecord>;
  deleteSessionSnapshot(accountId: string, sessionId: string): Promise<void>;

  // Durable session↔machine correlation for rebuild-after-teardown (Gap 1).
  getSessionCorrelation(accountId: string, sessionId: string): Promise<SessionCorrelation | undefined>;
  listSessionCorrelations(accountId: string): Promise<SessionCorrelation[]>;
  setSessionCorrelation(accountId: string, input: SessionCorrelationInput): Promise<SessionCorrelation>;
  deleteSessionCorrelation(accountId: string, sessionId: string): Promise<void>;

  // Case B: find an indexed session for a GitHub issue so an inbound comment/issue
  // CONTINUES it instead of starting a new one. Matches session_index.source
  // ("issue:owner/repo#N"). Covers sessions on currently-enrolled nodes; a session
  // whose node was already torn down is rebuilt via the device send path (Gap 1).
  findSessionByIssue(accountId: string, repo: string, issueNumber: number): Promise<{ sessionId: string; nodeId: string } | undefined>;

  // Case B for Linear: find an indexed session for a Linear issue (by its provider-
  // native id, the same `externalId` the webhook enqueues) so a re-dispatch CONTINUES
  // it instead of starting fresh — the Linear analogue of findSessionByIssue. Matches
  // session_index.source ("linear:<externalId>"), the source the node advertises for
  // a Linear-issue session.
  findSessionByExternalId(accountId: string, externalId: string): Promise<{ sessionId: string; nodeId: string } | undefined>;

  // Gap 3: escrowed session ROOM KEY for HOSTED (device-offline) rebuild. Sealed
  // at rest with the per-account hosted-provisioning key (hosted-crypto), keyed by
  // the reusable eph-* node id, NOT FK-cascaded off nodes so it survives teardown.
  // Written ONLY for hosted-provisioning accounts (the control plane already holds
  // their provider/GitHub creds); device-launched sessions keep the room key
  // device-only and never escrow. Never exposed to any client.
  getNodeRoomKeyEnc(accountId: string, nodeId: string): Promise<SecretEnvelope | undefined>;
  setNodeRoomKeyEnc(accountId: string, nodeId: string, enc: SecretEnvelope): Promise<void>;
  /** Atomically preserve the first E2E identity created by concurrent devices. */
  setNodeRoomKeyEncIfAbsent(accountId: string, nodeId: string, enc: SecretEnvelope): Promise<SecretEnvelope>;

}

export interface GithubAppVaultRepository {
  // GitHub App private-key vault (issue #88), per-app — see GithubAppVault above.
  // A node lists every app the account has a vault for (it may not hold all of
  // them locally yet) rather than asking per-app, so a newly opted-in node
  // discovers apps it has never seen without an extra round trip per app.
  listGithubAppVaults(accountId: string): Promise<GithubAppVault[]>;
  setGithubAppVault(accountId: string, appId: string, nodeId: string, ciphertext: string): Promise<GithubAppVault>;
  // Every wrapped key currently addressed to `nodeId`, across apps.
  listGithubAppWrappedKeysForNode(accountId: string, nodeId: string): Promise<GithubAppWrappedKey[]>;
  requestGithubAppWrappedKey(accountId: string, appId: string, nodeId: string, publicKey: string): Promise<void>;
  // Every outstanding request across apps; the caller (a node that holds some
  // subset of the account's apps) filters to the ones it can actually answer.
  listGithubAppKeyRequests(accountId: string, exceptNodeId: string): Promise<GithubAppKeyRequest[]>;
  setGithubAppWrappedKey(
    accountId: string,
    appId: string,
    targetNodeId: string,
    wrappedByNodeId: string,
    wrappedByPublicKey: string,
    wrappedKey: string,
  ): Promise<GithubAppWrappedKey>;

}

export interface InboundHookRepository {
  // Inbound hooks (route a third-party webhook to an account) + work queue.
  createInboundHook(accountId: string, kind: string): Promise<InboundHook>;
  listInboundHooks(accountId: string, kind?: string): Promise<InboundHook[]>;
  getInboundHook(id: string): Promise<InboundHook | undefined>;
  // Adopt an externally-generated secret (e.g. a GitHub App manifest returns the
  // webhook secret at creation time). Scoped to the owning account.
  setInboundHookSecret(accountId: string, id: string, secret: string): Promise<InboundHook | undefined>;
  updateInboundHook(
    accountId: string,
    id: string,
    patch: { enabled?: boolean; templateInstruction?: string; routingDefault?: string },
  ): Promise<InboundHook | undefined>;
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
  // Set (or clear, with undefined) who may `@`-mention-trigger a run on this
  // hook. Settings → GitHub App in the web UI.
  setInboundHookTriggerAccess(
    accountId: string,
    id: string,
    triggerAccess: "everyone" | "contributor" | "collaborator" | undefined,
  ): Promise<InboundHook | undefined>;
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
}

export interface NodeClaimRepository {
  /** Create a short-lived enrollment-only claim. Raw code is returned once. */
  createNodeClaim(accountId: string): Promise<{ claim: NodeClaim; code: string }>;
  listNodeClaims(accountId: string): Promise<NodeClaim[]>;
  revokeNodeClaim(accountId: string, id: string): Promise<boolean>;
  /** Atomically consume a raw code. Unknown, expired, used, and revoked claims
   * all return undefined so the public endpoint does not disclose state. */
  consumeNodeClaim(code: string, nodeId: string): Promise<NodeClaim | undefined>;
}

export interface CentralGithubAppRepository {
  // The ONE centrally-owned GitHub App (managed tier): which installations
  // belong to which account, plus the single-use `state` nonces that bind an
  // install callback to the account that initiated it. The state is the ONLY
  // way a binding is created — an installation id alone is not proof of
  // ownership, so there is deliberately no "claim by id" write path.
  /** Mint a single-use install state for the account; returns the raw state. */
  createCentralInstallState(accountId: string, returnPath?: string): Promise<string>;
  /** Consume a state (single use). Returns its binding, or undefined when the
   *  state is unknown, already used, or expired. */
  consumeCentralInstallState(state: string): Promise<{ accountId: string; returnPath?: string } | undefined>;
  /** Signed installation.created webhooks attest the exact GitHub user that
   * performed an org install; setup callbacks use this to reject identity drift. */
  putCentralGithubInstallerAttestation(installationId: string, githubUserId: string): Promise<void>;
  getCentralGithubInstallerAttestation(installationId: string): Promise<string | undefined>;
  /** Upsert an installation binding (state-verified callback or app webhook). */
  putCentralGithubInstallation(input: CentralGithubInstallationInput): Promise<CentralGithubInstallation>;
  getCentralGithubInstallation(installationId: string): Promise<CentralGithubInstallation | undefined>;
  listCentralGithubInstallations(accountId: string): Promise<CentralGithubInstallation[]>;
  /** Remove a binding. With `accountId` (user-initiated unlink) the delete is
   *  account-scoped; without it (app-webhook `installation.deleted`) it is by
   *  installation id alone — the event is signed by the central app's secret. */
  deleteCentralGithubInstallation(installationId: string, accountId?: string): Promise<boolean>;
}

export interface AutomationRepository {
  createAutomationDefinition(accountId: string, input: Omit<AutomationDefinition, "id" | "accountId" | "createdAt" | "updatedAt">): Promise<AutomationDefinition>;
  updateAutomationDefinition(accountId: string, id: string, input: Partial<Omit<AutomationDefinition, "id" | "accountId" | "createdAt" | "updatedAt" | "lastScheduledAt">>): Promise<AutomationDefinition | undefined>;
  deleteAutomationDefinition(accountId: string, id: string): Promise<boolean>;
  getAutomationDefinition(accountId: string, id: string): Promise<AutomationDefinition | undefined>;
  /** Resolve a definition by id alone (no account scope) — for the public,
   *  signature-authenticated webhook endpoint, which knows only the definition
   *  id in its URL. Callers must still verify the HMAC against webhookSecret. */
  getAutomationDefinitionById(id: string): Promise<AutomationDefinition | undefined>;
  listAutomationDefinitions(accountId: string): Promise<AutomationDefinition[]>;
  listDueAutomationDefinitions(nowIso: string, limit?: number): Promise<AutomationDefinition[]>;
  enqueueScheduledOccurrence(accountId: string, definitionId: string, occurrenceIso: string, nextRunAt?: string): Promise<AutomationRun | undefined>;
  listTriggerEvents(accountId: string, limit?: number): Promise<TriggerEvent[]>;
  enqueueAutomationRun(accountId: string, input: WorkItemInput): Promise<AutomationRun>;
  enqueueAutomationRunWithResult(accountId: string, input: WorkItemInput): Promise<{ run: AutomationRun; created: boolean }>;
  getAutomationRunBySourceKey(accountId: string, sourceKey: string): Promise<AutomationRun | undefined>;
  listAutomationRuns(accountId: string, limit?: number): Promise<AutomationRun[]>;
  getAutomationRun(accountId: string, id: string): Promise<AutomationRun | undefined>;
  /** Transition a Run's durable lifecycle. Terminal targets are only reachable
   *  from non-terminal states (the state machine makes an outcome immutable once
   *  set — a stale or losing Machine cannot rewrite it). When `expectedNodeId` is
   *  given the transition ALSO requires the Run to still be claimed by that node,
   *  so a Machine that lost its lease to a reclaim cannot complete or fail the
   *  new attempt in the read-then-write window. Returns undefined when the
   *  transition was not applied (wrong source state or ownership lost). */
  transitionAutomationRun(accountId: string, id: string, status: AutomationRunStatus, output?: AutomationRun["output"], expectedNodeId?: string): Promise<AutomationRun | undefined>;
  /** Account-scoped, transactional cancellation. Already-cancelled runs are
   *  returned idempotently; callers inspect previousStatus for terminal conflicts. */
  cancelAutomationRun(accountId: string, id: string): Promise<CancelAutomationRunResult | undefined>;
  /** Start another attempt of the same customer-visible Run. Only terminal
   * failure/ambiguous outcomes are eligible; attempt ceilings are enforced
   * transactionally with the state reset. */
  retryAutomationRun(accountId: string, id: string): Promise<RetryAutomationRunResult | undefined>;
  // Record privacy-safe run evidence reported by the node that CLAIMED this run
  // (issue #153) — routing reason, output refs (branch/PR/checkpoint/commit/...),
  // declared-check results, and new timeline events. `checks`/`events` in the
  // patch are appended to the run's existing history (bounded), never replacing
  // it. Returns undefined for an unknown run.
  appendRunEvidence(accountId: string, id: string, patch: RunEvidencePatch, expectedNodeId?: string): Promise<AutomationRun | undefined>;
}

export interface WorkQueueRepository {
  enqueueWorkItem(accountId: string, input: WorkItemInput): Promise<WorkItem>;
  // Pending items a node may run: the account's items whose label the node serves
  // (a node serving "bivy" also serves "bivy/<self>"; pass the labels it accepts).
  listPendingWorkItems(accountId: string, labels: string[]): Promise<WorkItem[]>;
  // Recent work items for the account (any status) — powers the incoming-queue UI.
  listWorkItems(accountId: string, limit?: number): Promise<WorkItem[]>;
  claimWorkItem(accountId: string, nodeId: string, id: string): Promise<WorkItem | undefined>;
  /** Extend a claimed/running item's lease only when this node still owns it. */
  renewWorkItemLease(accountId: string, nodeId: string, id: string): Promise<WorkItem | undefined>;
  // Delete expired rows from every short-lived, single-use auth artifact table
  // (login_tokens, sessions, link_grants, relay_tickets, device_logins,
  // oauth_states, and expired auth_rate_limits). Each of
  // these is normally deleted on successful single-use consumption, but an
  // abandoned attempt (closed tab, retried client, a node that never completes
  // introspection) leaves its row behind with no other cleanup path — called on
  // an interval by the control plane. Returns
  // how many rows were removed in total.
  pruneExpiredAuthTokens(nowIso: string): Promise<number>;
  completeWorkItem(accountId: string, id: string, expectedNodeId?: string): Promise<AutomationRun | undefined>;
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

/**
 * Complete persistence context used only at the application composition root and
 * by the concrete Postgres adapter. Business consumers accept one or more of the
 * narrow repository ports above instead of this aggregate.
 */
export interface ControlPlaneStore
  extends StoreLifecycle,
    AccountAuthRepository,
    NodeRepository,
    SessionIndexRepository,
    NotificationRepository,
    EphemeralConfigurationRepository,
    HostedMachineRepository,
    ComputeUsageRepository,
    VaultRepository,
    SessionStateRepository,
    GithubAppVaultRepository,
    InboundHookRepository,
    NodeClaimRepository,
    CentralGithubAppRepository,
    AutomationRepository,
    WorkQueueRepository {}
