// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Account / sign-in glue for the hosted control-plane path.
//
// After GitHub sign-in (or a QR device-link) the control plane redirects to
// `…#<base64url-json>`; the payload carries the session token + control-plane/
// relay URLs (and, for QR, the node id + pairing material). This mirrors the
// legacy consumeLinkPayload(). Once signed in, `/nodes` lists every node on the
// account so the user can pick one — the "sign in and see all your nodes" flow.

import { linkPayloadFromText } from "./linking.js";
import type { LocalStore } from "./local-store.js";
import type { InboxAdvert } from "./inbox.js";

export interface LinkPayload {
  session?: string;
  controlPlane?: string;
  relay?: string;
  pairSecret?: string;
  node?: { id?: string; pub?: string };
  /** Account-free ("solo") relay admission: an unguessable room id + bearer token
   *  the phone presents to the relay INSTEAD of a control-plane-minted ticket.
   *  Present (with no `session`/`controlPlane`) in a solo pairing QR. */
  room?: string;
  roomToken?: string;
  /** Agent selected by the node setup wizard for its first app draft. */
  defaultAgent?: string;
}

// The kinds of Web Push notification the mesh emits, and their user-facing
// copy. Mirrors NOTIFICATION_KINDS on the control plane; the Settings UI renders
// one toggle per entry. Order here is the display order.
export const NOTIFICATION_KINDS = [
  "question_asked",
  "approval_requested",
  "agent_waiting",
  "session_done",
  "session_error",
  "terminal_bell",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationPreferences = Record<NotificationKind, boolean>;

export const NOTIFICATION_KIND_META: Array<{ id: NotificationKind; label: string; description: string }> = [
  { id: "question_asked", label: "Agent asked a question", description: "An agent is waiting on an answer from you." },
  { id: "approval_requested", label: "Approval needed", description: "A tool wants to run and needs you to approve or deny it." },
  { id: "agent_waiting", label: "Agent waiting", description: "A `bivy run` agent went quiet and may need input." },
  { id: "session_done", label: "Session finished", description: "A session completed its turn — ready to review." },
  { id: "session_error", label: "Session error", description: "The last turn failed and needs attention." },
  { id: "terminal_bell", label: "Terminal bell", description: "A terminal rang the bell while you were away." },
];

/** Fill in any missing kinds as enabled so the UI always has a full map. */
export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const out = {} as NotificationPreferences;
  for (const kind of NOTIFICATION_KINDS) {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>)[kind] : undefined;
    out[kind] = typeof v === "boolean" ? v : true;
  }
  return out;
}

/** Fold a redirect/QR link payload into the store. Returns true if it carried auth or a node. */
export function consumeLinkPayload(store: LocalStore, text: string): boolean {
  let p: LinkPayload | null;
  try {
    p = linkPayloadFromText(text) as LinkPayload | null;
  } catch {
    return false; // malformed payload — ignore
  }
  if (!p || typeof p !== "object") return false;
  if (p.session) store.s = p.session;
  if (p.controlPlane) store.cp = p.controlPlane;
  if (p.relay) store.relay = p.relay;
  if (p.node?.id) {
    store.cur = p.node.id;
    if (p.node.pub) store.addNodePub(p.node.id, p.node.pub); // X25519 handshake
    if (p.pairSecret) store.setPairSecret(p.node.id, p.pairSecret);
    // Account-free pairing: remember the room id + bearer token so the transport
    // dials `/client?room=&roomToken=` for this node instead of minting a
    // control-plane ticket. The token never leaves this device except in the
    // relay dial itself.
    if (p.room && p.roomToken) store.setSolo(p.node.id, { room: p.room, roomToken: p.roomToken });
    // Setup opens the app on a browser that may carry a last-used agent from a
    // different machine. Treat the explicit installer handoff as the newest
    // choice so the first draft matches what the user just selected.
    const defaultAgent = typeof p.defaultAgent === "string" ? p.defaultAgent.trim().toLowerCase() : "";
    if (defaultAgent) store.setLastChoice({ agentId: defaultAgent });
  }
  return Boolean(p.session || p.node?.id);
}

/**
 * An installed/standalone PWA (or iOS home-screen app) runs inside a scoped
 * window. A full-page GitHub OAuth redirect leaves that scope — it goes to
 * `github.com` and back to a control-plane URL outside the app's manifest scope
 * — so the browser hands the flow to the system browser and the finished
 * session never returns to the installed window. Detect that case so sign-in can
 * fall back to the device-poll flow, which never navigates the app away.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.bind(window);
  const displayModeStandalone =
    !!mm?.("(display-mode: standalone)").matches ||
    !!mm?.("(display-mode: fullscreen)").matches ||
    !!mm?.("(display-mode: minimal-ui)").matches;
  // iOS Safari (pre-display-mode) marks home-screen apps with navigator.standalone.
  const iosStandalone = (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true;
  // A native shell (a Capacitor iOS/Android WKWebView) reports none of the above
  // — its display-mode is "browser" — yet it is exactly the scoped-window case
  // the device-poll flow exists for: a full-page OAuth redirect escapes the
  // WebView to the system browser and the finished session never returns to the
  // app. Treat the native runtime as standalone so sign-in takes the device-poll
  // path. Pure feature-detect (no import); inert in an ordinary browser where
  // `Capacitor` is undefined.
  const capacitorNative =
    (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
  return displayModeStandalone || iosStandalone || capacitorNative;
}

export interface GithubDeviceLogin {
  deviceId: string;
  deviceSecret: string;
  /** GitHub authorize URL to open in a normal browser tab. */
  authorizeUrl: string;
  /** How often to poll, ms. */
  intervalMs: number;
  /** How long the login stays valid, ms. */
  expiresInMs: number;
}

/**
 * Begin a hands-free GitHub sign-in for an installed app. Returns the GitHub
 * authorize URL to open (in a normal browser tab) plus device credentials to
 * poll `/auth/device/poll` with. The app window itself never navigates, so a
 * PWA/home-screen install stays connected while the browser handles OAuth.
 */
export async function startGithubDeviceLogin(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<GithubDeviceLogin> {
  const res = await fetchImpl(`${cpBase(store)}/auth/device/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = (await res.json().catch(() => ({}))) as Partial<GithubDeviceLogin> & { error?: string };
  if (!res.ok || !data.authorizeUrl) throw new Error(data.error || "Could not start GitHub sign-in.");
  return {
    deviceId: String(data.deviceId),
    deviceSecret: String(data.deviceSecret),
    authorizeUrl: String(data.authorizeUrl),
    intervalMs: Number(data.intervalMs) || 2000,
    expiresInMs: Number(data.expiresInMs) || 10 * 60_000,
  };
}

export interface EmailDeviceLogin {
  deviceId: string;
  deviceSecret: string;
  /** How often to poll, ms. */
  intervalMs: number;
  /** How long the login stays valid, ms. */
  expiresInMs: number;
  /** Whether the email was actually sent (false in dev with no mailer). */
  sent: boolean;
  /** Dev-only: the magic link, surfaced when no mailer is configured. */
  devLink?: string;
}

/**
 * Begin a hands-free email magic-link sign-in for an installed app. The control
 * plane emails a link the user opens in whatever browser their mail client hands
 * it to; the app window itself never navigates and instead polls
 * `/auth/device/poll` for completion. This is what makes magic-link sign-in work
 * in an installed/standalone PWA: an emailed link opens in the system browser,
 * not the installed window, so the redirect-based flow would strand the finished
 * session in that browser tab — the same reason GitHub sign-in uses the device
 * flow when standalone (see startGithubDeviceLogin / isStandaloneDisplay).
 */
export async function startEmailDeviceLogin(store: LocalStore, email: string, fetchImpl: typeof fetch = fetch): Promise<EmailDeviceLogin> {
  const res = await fetchImpl(`${cpBase(store)}/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<EmailDeviceLogin> & { error?: string };
  if (!res.ok || !data.deviceId) throw new Error(data.error || "Could not send sign-in link.");
  return {
    deviceId: String(data.deviceId),
    deviceSecret: String(data.deviceSecret),
    intervalMs: Number(data.intervalMs) || 2000,
    expiresInMs: Number(data.expiresInMs) || 15 * 60_000,
    sent: Boolean(data.sent),
    ...(data.devLink ? { devLink: String(data.devLink) } : {}),
  };
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "complete"; token: string }
  | { status: "expired"; error?: string }
  | { status: "error"; error?: string };

/** Poll once for a device login's completion. Non-2xx maps to `error`. */
export async function pollDeviceLogin(store: LocalStore, deviceId: string, deviceSecret: string, fetchImpl: typeof fetch = fetch): Promise<DevicePollResult> {
  const res = await fetchImpl(`${cpBase(store)}/auth/device/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, deviceSecret }),
  });
  const data = (await res.json().catch(() => ({}))) as DevicePollResult & { error?: string };
  if (!res.ok) return { status: "error", error: data.error || `poll failed: ${res.status}` };
  return data;
}

/**
 * Plaintext (non-secret) per-provider connection status the node pushes
 * alongside its encrypted model-auth vault (see docs/credential-sync.md).
 * Never credential material or account identity — just enough for
 * `NodeSwitcher` to show a Connected/Expired/Not-connected chip per node
 * without connecting to it.
 */
export interface NodeProviderSummary {
  id: string;
  name?: string;
  configured: boolean;
  /** Epoch ms the stored OAuth access token expires, when applicable. */
  expiresAt?: number;
}

export interface AccountNode {
  id: string;
  name?: string;
  online?: boolean;
  providers?: NodeProviderSummary[];
  /** Non-secret provider identity of an ephemeral (`eph-*`) node, populated by
   *  the control-plane node registry at launch. Lets a *second* account device —
   *  which doesn't hold the launching device's local machine record — reconstruct
   *  the machine so it can wake a suspend-to-zero node (see
   *  `ephemeralMachineFromNode` and docs/ephemeral-sessions.md "Gap A"). This is
   *  identity only (a Fly machine id / E2B sandbox id), never a credential. */
  ephemeral?: {
    provider: string;
    /** The provider's machine/sandbox id (the adapter's `EphemeralMachine.id`). */
    machineId: string;
    /** The provider "app"/grouping handle, when the adapter uses one (Fly/Sprites). */
    app?: string;
    region?: string;
  };
  [k: string]: unknown;
}

export interface AccountSessionAdvert {
  sessionId: string;
  nodeId: string;
  status?: string;
  source?: string;
  titleEnc?: string;
  branch?: string;
  updatedAt?: string;
  attention?: InboxAdvert[];
  /** Hosted-trial gate: session is beyond the account's free lifetime allowance,
   *  returned content-stripped. Renders as a locked "subscribe to view" row. */
  locked?: boolean;
  [k: string]: unknown;
}

/** Lifetime hosted-session trial status (Bivy Cloud free plan). Absent on
 *  self-host and paid plans, where nothing is metered. */
export interface TrialStatus {
  limit?: number;
  used: number;
  remaining: number;
  over: number;
  exhausted: boolean;
}

function cpBase(store: LocalStore): string {
  return (store.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
}

/** List the nodes enrolled on the signed-in account (bearer = session token). */
export async function fetchAccountNodes(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<AccountNode[]> {
  const res = await fetchImpl(`${cpBase(store)}/nodes`, {
    headers: { authorization: `Bearer ${store.s}` },
  });
  if (!res.ok) throw new Error(`nodes request failed: ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as AccountNode[]) : [];
}

/** List encrypted session adverts across all nodes on the signed-in account. */
export async function fetchAccountSessions(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<AccountSessionAdvert[]> {
  const res = await fetchImpl(`${cpBase(store)}/sessions`, {
    headers: { authorization: `Bearer ${store.s}` },
  });
  if (!res.ok) throw new Error(`sessions request failed: ${res.status}`);
  const data: unknown = await res.json();
  const list = Array.isArray(data) ? data : Array.isArray((data as { sessions?: unknown })?.sessions) ? (data as { sessions: unknown[] }).sessions : [];
  return list as AccountSessionAdvert[];
}

export interface PlanPrice {
  id: string;
  currency: string;
  unitAmount: number | null;
  interval?: string;
  intervalCount?: number;
  label: string;
}

export interface AccountMe {
  account?: { email?: string; plan?: string };
  entitlements?: {
    plan?: string;
    // Undefined = unlimited (no node cap on any plan). Kept for forward-compat.
    maxNodes?: number;
    relayEnabled?: boolean;
    pushEnabled?: boolean;
    workQueueEnabled?: boolean;
    // Unattended automation jobs allowed per rolling 7-day window. Interactive
    // CLI/app sessions are unlimited. Undefined = unlimited automation (paid);
    // pairs with counts.runsThisWeek (legacy wire name) to render used / limit.
    weeklyRunLimit?: number;
    ephemeralEnabled?: boolean;
  };
  pricing?: { pro?: PlanPrice; team?: PlanPrice };
  counts?: { nodes?: number; sessions?: number; devices?: number; runsThisWeek?: number };
  /** Lifetime hosted-session trial (Bivy Cloud free plan). Absent on self-host and
   *  paid plans. Drives the usage banner and the upgrade prompt. */
  trial?: TrialStatus;
  [k: string]: unknown;
}

function authHeaders(store: LocalStore): Record<string, string> {
  return { authorization: `Bearer ${store.s}`, "content-type": "application/json" };
}

/** Account, plan entitlements and usage counts for the signed-in user. */
export async function fetchMe(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<AccountMe> {
  const res = await fetchImpl(`${cpBase(store)}/me`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`account request failed: ${res.status}`);
  return (await res.json()) as AccountMe;
}

/** Remove an enrolled node from the account. */
export async function removeAccountNode(store: LocalStore, nodeId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  if (!res.ok) throw new Error(`remove node failed: ${res.status}`);
}

export interface PairedDevice {
  id: string;
  label: string;
  updatedAt: string;
}

/**
 * One GitHub App connected to the account. A private GitHub App can only be
 * installed on the account that owns it, so covering a personal account plus
 * every org means one app per owner — hence a list, not a single app.
 */
export interface GithubAppEntry {
  connected: boolean;
  name?: string;
  slug?: string;
  mention?: string; // the `@`-handle that triggers work (the app slug)
  appId?: string; // numeric App ID — also the key every per-app call addresses
  hookId?: string; // the control-plane inbound hook backing this app
  // The GitHub account this app covers. With several apps connected, this is
  // what distinguishes "my personal app" from "the acme org app".
  owner?: string;
  ownerType?: string; // "User" | "Organization"
  editUrl?: string; // GitHub settings page to rename/configure the app
  installUrl?: string; // GitHub "install on repositories" page — the app does
  // nothing until it's installed on at least one repo, so the UI must surface this.
  installed?: boolean; // node-reported: is the app installed on ≥1 repo? undefined = not synced yet
  installCount?: number; // node-reported number of installs (undefined = not synced)
  // The node-label suffix (e.g. "macbook") that untagged/generic `bivy`-routed
  // issues/comments default to, instead of racing across every node serving the
  // shared queue. undefined = no default set.
  defaultNode?: string;
  // Who may `@`-mention-trigger a run via a GitHub issue/comment (issue #259):
  // "everyone" (undefined default — anyone, incl. a stranger on a public repo),
  // "contributor" (any prior relationship with the repo), or "collaborator"
  // (push access only).
  triggerAccess?: "everyone" | "contributor" | "collaborator";
  // The node currently holding the app's key and servicing it, or null if none.
  // `connected: true` with `servedBy: null` means the account has the app set up
  // but no live node is running it (e.g. after a node was deleted/reinstalled) —
  // the UI should prompt to (re)connect it on a node rather than say "connected".
  servedBy?: { id: string; name?: string; online: boolean; lastSeenAt?: string } | null;
  servingNodeSeenAt?: string;
  /** App key is held by the encrypted hosted executor, not a persistent node. */
  hosted?: boolean;
}

export interface GithubAppInfo extends GithubAppEntry {
  /** Every connected app; empty when nothing is set up. The flat fields above
   *  mirror `apps[0]` — the control plane keeps serving them so a client written
   *  against the single-app shape still works. */
  apps: GithubAppEntry[];
}

/**
 * Coerce a `/account/github-app` body into the multi-app shape. A control plane
 * older than multi-app support answers with the flat single-app object and no
 * `apps` array, so derive a one-element list from it — the UI then only ever
 * renders one shape.
 */
export function normalizeGithubAppInfo(data: unknown): GithubAppInfo {
  const { apps, ...flat } = (data && typeof data === "object" ? data : {}) as Partial<GithubAppInfo>;
  const list = Array.isArray(apps)
    ? apps.filter((a): a is GithubAppEntry => Boolean(a?.connected))
    : flat.connected
      ? [flat as GithubAppEntry]
      : [];
  return { ...list[0], ...flat, connected: list.length > 0, apps: list };
}

/** The account's connected GitHub Apps (name + unique mention handle each). */
export async function fetchGithubApp(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<GithubAppInfo> {
  const res = await fetchImpl(`${cpBase(store)}/account/github-app`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`github-app request failed: ${res.status}`);
  return normalizeGithubAppInfo(await res.json());
}

/**
 * Disconnect a single GitHub App, or every app on the account.
 *
 * Scope precedence: by `appId` when known, else by the app's control-plane
 * `hookId` — a stale app left by an abandoned create flow has a hook but no App
 * ID, and MUST still be removable on its own without taking the healthy apps
 * with it. Only when NEITHER id is given does the whole account's `github_app`
 * hooks go (a deliberate "remove everything", orphans included).
 *
 * Accepts a bare appId string for backwards compatibility.
 */
export async function disconnectGithubApp(
  store: LocalStore,
  target?: string | { appId?: string; hookId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const appId = typeof target === "string" ? target : target?.appId;
  const hookId = typeof target === "string" ? undefined : target?.hookId;
  const query = appId ? `?appId=${encodeURIComponent(appId)}` : hookId ? `?hookId=${encodeURIComponent(hookId)}` : "";
  const res = await fetchImpl(`${cpBase(store)}/account/github-app${query}`, { method: "DELETE", headers: authHeaders(store) });
  if (!res.ok) throw new Error(`disconnect failed: ${res.status}`);
}

/**
 * Set (or, with an empty string, clear) the account's default node — the
 * node-label suffix that untagged/generic `bivy`-routed issues and comments
 * route to instead of the shared queue. Returns the resulting value. Without an
 * `appId` it applies to every connected app, which is what the account-level
 * setting in the UI wants.
 */
export async function setGithubAppDefaultNode(store: LocalStore, node: string, appId?: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const res = await fetchImpl(`${cpBase(store)}/account/github-app/default-node`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(appId ? { node, appId } : { node }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `set default node failed: ${res.status}`);
  return data.defaultNode as string | undefined;
}

/**
 * Set the account's GitHub App trigger-access level (issue #259): who may
 * `@`-mention-trigger a run via an issue/comment. Without an `appId` it
 * applies to every connected app, matching the account-level setting in the
 * UI. Returns the resulting value ("everyone" when unset/cleared).
 */
export async function setGithubAppTriggerAccess(
  store: LocalStore,
  triggerAccess: "everyone" | "contributor" | "collaborator",
  appId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"everyone" | "contributor" | "collaborator"> {
  const res = await fetchImpl(`${cpBase(store)}/account/github-app/trigger-access`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(appId ? { triggerAccess, appId } : { triggerAccess }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `set trigger access failed: ${res.status}`);
  return (data.triggerAccess as "everyone" | "contributor" | "collaborator" | undefined) ?? "everyone";
}

// The account's saved preference for auto-provisioning an ephemeral runner
// when the GitHub work queue has pending items and no persistent node online
// (issue #532). `provider`/`region`/`size`/`ttlMinutes` are non-secret
// preferences only — the provider TOKEN itself always stays device-local
// (EphemeralKeyStore); a device that wants to act on this setting needs its
// own saved token for `provider` regardless of what the account has chosen.
export interface EphemeralQueueDefault {
  enabled: boolean;
  provider?: string;
  region?: string;
  size?: string;
  ttlMinutes?: number;
}

/** Read the account's ephemeral-queue-default preference. Disabled with no
 *  provider chosen when never set. */
export async function fetchEphemeralQueueDefault(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<EphemeralQueueDefault> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-default`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`ephemeral-default request failed: ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return { enabled: Boolean(data?.enabled), provider: data?.provider, region: data?.region, size: data?.size, ttlMinutes: data?.ttlMinutes };
}

/** Merge-update the account's ephemeral-queue-default preference; returns the effective value. */
export async function setEphemeralQueueDefault(
  store: LocalStore,
  patch: Partial<EphemeralQueueDefault>,
  fetchImpl: typeof fetch = fetch,
): Promise<EphemeralQueueDefault> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-default`, {
    method: "PUT",
    headers: authHeaders(store),
    body: JSON.stringify(patch),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `set ephemeral default failed: ${res.status}`);
  return { enabled: Boolean(data?.enabled), provider: data?.provider, region: data?.region, size: data?.size, ttlMinutes: data?.ttlMinutes };
}

// An account-level, reusable ephemeral node config — "a config = a selectable
// node" in both the queue router and the new-session picker. Non-secret sizing
// only; the launching device still supplies the provider token. Account-level
// (not device-local) so queued work can route to it from any device or,
// eventually, an unattended orchestrator.
export interface EphemeralNodeConfig {
  id: string;
  name: string;
  provider: string;
  region?: string;
  size?: string;
  image?: string;
  readyCapacity?: number;
  ttlMinutes?: number;
  teardownOnAgentFinish?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type EphemeralConfigInput = {
  name: string;
  provider: string;
  region?: string | null;
  size?: string | null;
  image?: string | null;
  readyCapacity?: number | null;
  ttlMinutes?: number | null;
  teardownOnAgentFinish?: boolean;
};

// How the account routes queued work by default. `primary` names the runner;
// only a persistent-node primary may carry an ephemeral-config `fallback` (used
// when that node is offline) — an ephemeral-config primary is provisioned on
// demand and needs none.
export type QueueRunnerTarget =
  | { kind: "shared" }
  | { kind: "node"; node: string }
  | { kind: "config"; configId: string };

export interface QueueRouting {
  primary: QueueRunnerTarget;
  fallback?: { kind: "config"; configId: string };
}

function coerceConfig(v: any): EphemeralNodeConfig {
  return {
    id: String(v?.id ?? ""),
    name: String(v?.name ?? ""),
    provider: String(v?.provider ?? ""),
    region: typeof v?.region === "string" && v.region ? v.region : undefined,
    size: typeof v?.size === "string" && v.size ? v.size : undefined,
    image: typeof v?.image === "string" && v.image ? v.image : undefined,
    readyCapacity: typeof v?.readyCapacity === "number" ? Math.max(0, Math.min(1, Math.floor(v.readyCapacity))) : undefined,
    ttlMinutes: typeof v?.ttlMinutes === "number" ? v.ttlMinutes : undefined,
    teardownOnAgentFinish: Boolean(v?.teardownOnAgentFinish) || undefined,
    createdAt: String(v?.createdAt ?? ""),
    updatedAt: String(v?.updatedAt ?? ""),
  };
}

/** The account's saved ephemeral node configs (shared across the account's devices). */
export async function fetchEphemeralConfigs(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<EphemeralNodeConfig[]> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-configs`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`ephemeral-configs request failed: ${res.status}`);
  const data: unknown = await res.json().catch(() => []);
  return Array.isArray(data) ? data.map(coerceConfig).filter((c) => c.id) : [];
}

export async function createEphemeralConfig(store: LocalStore, input: EphemeralConfigInput, fetchImpl: typeof fetch = fetch): Promise<EphemeralNodeConfig> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-configs`, { method: "POST", headers: authHeaders(store), body: JSON.stringify(input) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `create ephemeral config failed: ${res.status}`);
  return coerceConfig(data);
}

export async function updateEphemeralConfig(store: LocalStore, id: string, patch: Partial<EphemeralConfigInput>, fetchImpl: typeof fetch = fetch): Promise<EphemeralNodeConfig> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-configs/${encodeURIComponent(id)}`, { method: "PUT", headers: authHeaders(store), body: JSON.stringify(patch) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `update ephemeral config failed: ${res.status}`);
  return coerceConfig(data);
}

export async function deleteEphemeralConfig(store: LocalStore, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/ephemeral-configs/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders(store) });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error || `delete ephemeral config failed: ${res.status}`);
  }
}

function coerceRouting(v: any): QueueRouting {
  const p = v?.primary;
  let primary: QueueRunnerTarget = { kind: "shared" };
  if (p?.kind === "node" && typeof p.node === "string" && p.node.trim()) primary = { kind: "node", node: p.node.trim() };
  else if (p?.kind === "config" && typeof p.configId === "string" && p.configId) primary = { kind: "config", configId: p.configId };
  const f = v?.fallback;
  const fallback = f?.kind === "config" && typeof f.configId === "string" && f.configId ? { kind: "config" as const, configId: f.configId } : undefined;
  return primary.kind === "node" && fallback ? { primary, fallback } : { primary };
}

/** The account's default queue routing (primary runner + optional fallback). */
export async function fetchQueueRouting(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<QueueRouting> {
  const res = await fetchImpl(`${cpBase(store)}/account/queue-routing`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`queue-routing request failed: ${res.status}`);
  return coerceRouting(await res.json().catch(() => ({})));
}

export async function setQueueRouting(store: LocalStore, routing: QueueRouting, fetchImpl: typeof fetch = fetch): Promise<QueueRouting> {
  const res = await fetchImpl(`${cpBase(store)}/account/queue-routing`, { method: "PUT", headers: authHeaders(store), body: JSON.stringify(routing) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `set queue routing failed: ${res.status}`);
  return coerceRouting(data);
}

// --- Hosted (control-plane-orchestrated) provisioning -----------------------
// Status is non-secret: which credentials are present, never their values.
export interface HostedProvisioningStatus {
  enabled: boolean;
  credential: "app" | "pat" | "none";
  githubAppId?: string;
  providers: string[];
  validatedProviders: string[];
  /** Whether the server has an encryption key configured; secrets can't be saved without it. */
  encryptionReady: boolean;
  /** Active encryption key id (for rotation display). */
  keyId?: string;
}

export interface HostedProvisioningPatch {
  enabled?: boolean;
  githubToken?: string;
  githubApp?: { appId: string; installationId: string; privateKeyPem: string } | null;
  providerTokens?: Record<string, string>;
}

export interface HostedGithubAppConnection {
  ok: true;
  appId: string;
  installation: { id: string; account: string; accountType?: string };
  webhookUrl: string;
  webhookSecret: string;
}

/** Connect an existing GitHub App directly to hosted execution (no node). */
export async function connectHostedGithubApp(
  store: LocalStore,
  input: { appId: string; privateKeyPem: string; installationId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HostedGithubAppConnection> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-github-app/connect`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(input),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `hosted GitHub App connection failed: ${res.status}`);
  return data as HostedGithubAppConnection;
}

/** Repositories exposed by the hosted App installation, without a live node. */
export async function fetchHostedGithubRepositories(
  store: LocalStore,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ slug: string; description?: string; private?: boolean; defaultBranch?: string }>> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-github-repositories`, { headers: authHeaders(store) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `hosted repository request failed: ${res.status}`);
  return Array.isArray(data?.repos) ? data.repos : [];
}

export async function validateHostedProviderCredential(
  store: LocalStore,
  provider: string,
  token: string,
  region?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-provisioning/validate-provider`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify({ provider, token, region }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `provider credential validation failed: ${res.status}`);
}

export interface HostedAuditEvent {
  at: string;
  action: string;
  provider?: string;
  configId?: string;
  nodeId?: string;
  workItemId?: string;
  detail?: string;
}

export interface HostedProvisionPlan { willProvision: boolean; targetConfigId: string | null; reason: string; }

export interface HostedMachineSummary {
  id: string;
  nodeId?: string;
  name?: string;
  provider: string;
  region?: string;
  size?: string;
  status?: string;
  createdAt: string;
  ttlMinutes?: number;
  setupId?: string;
  purpose?: "queue-item" | "queue-default" | "ready-capacity";
  claimedAt?: string;
  milestones?: Record<string, string>;
}

function coerceHostedStatus(d: any): HostedProvisioningStatus {
  return {
    enabled: Boolean(d?.enabled),
    credential: d?.credential === "app" || d?.credential === "pat" ? d.credential : "none",
    githubAppId: typeof d?.githubAppId === "string" ? d.githubAppId : undefined,
    providers: Array.isArray(d?.providers) ? d.providers : [],
    validatedProviders: Array.isArray(d?.validatedProviders) ? d.validatedProviders : [],
    encryptionReady: Boolean(d?.encryptionReady),
    keyId: typeof d?.keyId === "string" ? d.keyId : undefined,
  };
}

export async function fetchHostedProvisioning(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<HostedProvisioningStatus> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-provisioning`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`hosted-provisioning request failed: ${res.status}`);
  return coerceHostedStatus(await res.json().catch(() => ({})));
}

export async function setHostedProvisioning(store: LocalStore, patch: HostedProvisioningPatch, fetchImpl: typeof fetch = fetch): Promise<HostedProvisioningStatus> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-provisioning`, { method: "PUT", headers: authHeaders(store), body: JSON.stringify(patch) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `set hosted provisioning failed: ${res.status}`);
  return coerceHostedStatus(data);
}

export async function rotateHostedProvisioning(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<HostedProvisioningStatus> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-provisioning/rotate`, { method: "POST", headers: authHeaders(store) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `rotate hosted credentials failed: ${res.status}`);
  return coerceHostedStatus(data);
}

export async function fetchHostedAudit(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<HostedAuditEvent[]> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-audit`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`hosted-audit request failed: ${res.status}`);
  const d: unknown = await res.json().catch(() => []);
  return Array.isArray(d) ? (d as HostedAuditEvent[]) : [];
}

export async function fetchHostedMachines(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<HostedMachineSummary[]> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-machines`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`hosted-machines request failed: ${res.status}`);
  const data: unknown = await res.json().catch(() => []);
  if (!Array.isArray(data)) return [];
  return data.filter((m: any) => m && typeof m.id === "string" && typeof m.provider === "string") as HostedMachineSummary[];
}

export async function destroyHostedMachine(store: LocalStore, nodeId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-machines/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error || `hosted machine teardown failed: ${res.status}`);
  }
}

export async function triggerHostedProvision(store: LocalStore, execute = false, fetchImpl: typeof fetch = fetch): Promise<{ plan: HostedProvisionPlan; provisioned?: { id: string; nodeId?: string } | null }> {
  const res = await fetchImpl(`${cpBase(store)}/account/hosted-provision-now`, { method: "POST", headers: authHeaders(store), body: JSON.stringify({ execute }) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `hosted provision failed: ${res.status}`);
  return data;
}

export interface GithubQueueItem {
  id: string;
  source: string; // "github:issue" | "github:comment" | "linear:issue" | "slack"
  status: "pending" | "claimed" | "running" | "waiting" | "needs_attention" | "succeeded" | "failed" | "cancelled" | "done";
  label: string;
  title: string;
  repo?: string;
  issueNumber?: number;
  externalId?: string;
  url?: string;
  runtimeId?: string; // agent override set via the queue "Run…" action
  model?: string; // model override set via the queue "Run…" action
  // True when this item was dispatched to a freshly-provisioned ephemeral
  // server (issue #532) rather than an already-running node. Display only —
  // routing is entirely driven by `label`, an ephemeral machine's is just a
  // one-off `bivy/<slug>` no different from any node's.
  ephemeral?: boolean;
  createdAt: string;
  claimedAt?: string;
  claimedByNodeId?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  triggerId?: string;
  triggerKind?: "github" | "slack" | "manual" | "webhook" | "schedule";
  definitionId?: string;
  attempt?: number;
  targetKind?: "new_session" | "existing_session";
  targetSessionId?: string;
  message?: boolean;
  startedAt?: string;
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  output?: {
    sessionId?: string;
    branch?: string;
    prUrl?: string;
    artifactUrl?: string;
    failure?: string;
    checkpoint?: string;
    commit?: string;
  };
  /** Privacy-safe run evidence (issue #153) — see docs/automation-runs.md and
   *  docs/security-model.md. Never a prompt, transcript, diff, file content,
   *  secret, token, or raw command/tool output; only bounded summaries,
   *  identifiers, and URLs. */
  routingReason?: string;
  checks?: Array<{ name: string; commandHash?: string; status: "passed" | "failed" | "skipped"; exitCode?: number; durationMs?: number }>;
  events?: Array<{
    at: string;
    kind: "triggered" | "routed" | "claimed" | "attempt_started" | "checkpoint" | "approval" | "policy_denial"
      | "retry" | "fallback" | "rate_limited" | "branch" | "pull_request" | "needs_attention" | "completed" | "cancelled";
    summary: string;
    attempt?: number;
    ref?: string;
    url?: string;
    status?: "passed" | "failed" | "denied" | "approved";
  }>;
}

export type AutomationSchedule =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string; timezone: string };

export interface AccountAutomation {
  id: string;
  name: string;
  /** Stable key for definitions managed from `.bivy/automations.yaml`. */
  configKey?: string;
  configOrder?: number;
  templateCiphertext?: string;
  runtimeId?: string;
  model?: string;
  nodeLabel?: string;
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  maxAttempts?: number;
  enabled: boolean;
  /** How this automation fires. Absent on legacy rows means "schedule".
   *  `github_ci` is legacy; prefer `github` + `on` rules. */
  trigger?: "schedule" | "webhook" | "manual" | "github" | "linear" | "github_ci";
  /** Optional GitHub workspace (`owner/name`) for triggers that do not carry a repo. */
  repo?: string;
  /** Label filter for github/linear source triggers. */
  labels?: string[];
  /** Repo allowlist for github/linear. */
  repos?: string[];
  /**
   * GitHub event rules ("when any of these fire"). Outcomes are whatever the
   * instructions say — not a special-cased PR path.
   */
  on?: Array<{
    event: "issues" | "issue_comment" | "pull_request" | "pull_request_review_comment" | "workflow_run";
    actions?: string[];
    labels?: string[];
    mention?: boolean;
    conclusions?: string[];
    workflows?: string[];
  }>;
  /** Built-in template id (e.g. issue-to-pr). */
  templateId?: string;
  schedule: AutomationSchedule;
  /** When set, schedule-triggered runs CONTINUE this existing session instead of
   *  starting a new one (a scheduled chat message). */
  targetKind?: "new_session" | "existing_session";
  targetSessionId?: string;
  /** When set, schedule-triggered runs are plain chat messages rather than
   *  automation jobs (no boilerplate/push/checks). */
  message?: boolean;
  nextRunAt?: string;
  lastScheduledAt?: string;
  /** Present for a webhook-triggered automation: the signed endpoint to POST
   *  events to. The signing secret is returned only once (create/rotate). */
  webhookUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateAutomationInput = Omit<
  AccountAutomation,
  "id" | "createdAt" | "updatedAt" | "lastScheduledAt" | "schedule" | "webhookUrl"
> & { schedule?: AutomationSchedule };

export interface AccountAutomationRun {
  id: string;
  definitionId?: string;
  triggerKind: string;
  status: "pending" | "claimed" | "running" | "waiting" | "needs_attention" | "succeeded" | "failed" | "cancelled";
  title: string;
  message?: boolean;
  targetKind?: "new_session" | "existing_session";
  targetSessionId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  leaseExpiresAt?: string;
  output?: { sessionId?: string; branch?: string; prUrl?: string; artifactUrl?: string; failure?: string };
}

async function automationRequest<T>(
  store: LocalStore,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${cpBase(store)}${path}`, {
    ...init,
    headers: authHeaders(store),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `automation request failed: ${res.status}`);
  return data as T;
}

export function fetchAutomations(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<AccountAutomation[]> {
  return automationRequest(store, "/account/automations", {}, fetchImpl);
}

export function createAutomation(
  store: LocalStore,
  input: CreateAutomationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountAutomation & { webhookSecret?: string }> {
  return automationRequest(store, "/account/automations", { method: "POST", body: JSON.stringify(input) }, fetchImpl);
}

/** Rotate a webhook automation's signing secret. The new secret is returned
 *  once; the old one stops working immediately. */
export function rotateAutomationWebhook(
  store: LocalStore,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountAutomation & { webhookSecret: string }> {
  return automationRequest(store, `/account/automations/${encodeURIComponent(id)}/webhook/rotate`, { method: "POST" }, fetchImpl);
}

export function updateAutomation(
  store: LocalStore,
  id: string,
  patch: Partial<AccountAutomation>,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountAutomation> {
  return automationRequest(store, `/account/automations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) }, fetchImpl);
}

export async function deleteAutomation(store: LocalStore, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/automations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  if (!res.ok) throw new Error(`delete automation failed: ${res.status}`);
}

export function runAutomationNow(store: LocalStore, id: string, fetchImpl: typeof fetch = fetch): Promise<AccountAutomationRun> {
  return automationRequest(store, `/account/automations/${encodeURIComponent(id)}/run`, { method: "POST" }, fetchImpl);
}

export function fetchAutomationRuns(
  store: LocalStore,
  limit = 50,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountAutomationRun[]> {
  return automationRequest(store, `/account/automation-runs?limit=${encodeURIComponent(String(limit))}`, {}, fetchImpl);
}

/** Recent incoming work items for the account, newest first (queue UI). */
export async function fetchGithubQueue(store: LocalStore, limit = 30, fetchImpl: typeof fetch = fetch): Promise<GithubQueueItem[]> {
  const res = await fetchImpl(`${cpBase(store)}/account/work-items?limit=${encodeURIComponent(String(limit))}`, {
    headers: authHeaders(store),
  });
  if (!res.ok) throw new Error(`work-items request failed: ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as GithubQueueItem[]) : [];
}

/**
 * Manually dispatch a pending queue item to a specific node (`node` = the node's
 * label suffix, e.g. "macbook"; empty = shared queue) and optional agent/model.
 * Re-routes the existing item and nudges the target node to pick it up now.
 *
 * `ephemeral: true` marks the item as routed to a just-provisioned ephemeral
 * server (issue #532) rather than an already-running node — display only, the
 * routing itself is the same `node` label an ephemeral machine's assign-time
 * `ephemeralNodeLabel(machine.nodeId)` produces.
 */
export async function assignWorkItem(
  store: LocalStore,
  id: string,
  input: { node?: string; runtimeId?: string; model?: string; ephemeral?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/work-items/${encodeURIComponent(id)}/assign`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify({
      node: input.node?.trim() || "",
      runtimeId: input.runtimeId?.trim() || "",
      model: input.model?.trim() || "",
      ephemeral: Boolean(input.ephemeral),
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `assign work item failed: ${res.status}`);
}

/** Remove a single item from the account's GitHub queue. */
export async function deleteWorkItem(store: LocalStore, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/work-items/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error || `delete work item failed: ${res.status}`);
  }
}

/** Clear every pending (waiting) item from the account's GitHub queue. Returns how many were removed. */
export async function clearWorkQueue(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${cpBase(store)}/account/work-items`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `clear queue failed: ${res.status}`);
  return Number(data?.removed) || 0;
}

export interface SlackHook {
  id: string;
  endpoint: string;
  enabled: boolean;
  defaultNode?: string;
  createdAt: string;
  updatedAt?: string;
}

export async function fetchSlackHook(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<SlackHook | null> {
  const res = await fetchImpl(`${cpBase(store)}/account/slack-hook`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`Slack integration request failed: ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return data?.hook ?? null;
}

export async function connectSlackHook(
  store: LocalStore,
  input: { signingSecret: string; defaultNode?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SlackHook> {
  const res = await fetchImpl(`${cpBase(store)}/account/slack-hook`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(input),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Connect Slack failed: ${res.status}`);
  return data.hook;
}

export async function disconnectSlackHook(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/slack-hook`, { method: "DELETE", headers: authHeaders(store) });
  if (!res.ok) throw new Error(`Disconnect Slack failed: ${res.status}`);
}

export interface LinearHook {
  id: string;
  endpoint: string;
  enabled: boolean;
  defaultNode?: string;
  createdAt: string;
  updatedAt?: string;
}

export async function fetchLinearHook(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<LinearHook | null> {
  const res = await fetchImpl(`${cpBase(store)}/account/linear-hook`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`Linear integration request failed: ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return data?.hook ?? null;
}

/** Create the endpoint (no secret), or finish/update it with Linear's signing secret. */
export async function connectLinearHook(
  store: LocalStore,
  input: { signingSecret?: string; defaultNode?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<LinearHook> {
  const res = await fetchImpl(`${cpBase(store)}/account/linear-hook`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(input),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Connect Linear failed: ${res.status}`);
  return data.hook;
}

export async function disconnectLinearHook(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/account/linear-hook`, { method: "DELETE", headers: authHeaders(store) });
  if (!res.ok) throw new Error(`Disconnect Linear failed: ${res.status}`);
}

/** List the account's paired devices (for the device manager). */
export async function fetchPairedDevices(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<PairedDevice[]> {
  const res = await fetchImpl(`${cpBase(store)}/devices`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`devices request failed: ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as PairedDevice[]) : [];
}

/** Remove (sign out) a paired device, freeing a device slot. */
export async function removePairedDevice(store: LocalStore, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${cpBase(store)}/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(store),
  });
  if (!res.ok) throw new Error(`remove device failed: ${res.status}`);
}

/**
 * Sign out server-side: revoke this session and, when a device public key is
 * given, drop its paired-device record so the account's device slot is freed.
 * Best effort — callers still clear local state regardless of the result.
 */
export async function logout(store: LocalStore, devicePublicKeyB64?: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${cpBase(store)}/auth/logout`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify(devicePublicKeyB64 ? { devicePublicKeyB64 } : {}),
  });
}

/** Start a Stripe checkout; returns the URL to redirect to. */
export async function billingCheckout(store: LocalStore, plan = "pro", fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${cpBase(store)}/billing/checkout`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify({ plan }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.checkoutUrl) throw new Error(data?.error || "checkout failed");
  return data.checkoutUrl as string;
}

/** Open the Stripe billing portal; returns the URL to redirect to. */
export async function billingPortal(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${cpBase(store)}/billing/portal`, { method: "POST", headers: authHeaders(store) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.portalUrl) throw new Error(data?.error || "portal failed");
  return data.portalUrl as string;
}

function b64ToBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register this device for Web Push. Fetches the VAPID key, asks permission,
 * subscribes via the active service worker and posts the subscription to the
 * control plane. Ported from public/app/push.js. Returns a status string.
 */
export async function enablePushNotifications(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<string> {
  const nav = globalThis.navigator as any;
  if (!nav?.serviceWorker || !("PushManager" in globalThis) || !("Notification" in globalThis)) {
    throw new Error("Push notifications are not supported on this device.");
  }
  const keyRes = await fetchImpl(`${cpBase(store)}/api/push/vapid-public-key`, { headers: authHeaders(store) });
  const keyData: any = await keyRes.json().catch(() => ({}));
  if (!keyRes.ok || keyData?.enabled === false || !keyData?.publicKey) {
    throw new Error("Push notifications are not enabled for this account.");
  }
  const permission = await (globalThis as any).Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was declined.");
  const registration = await nav.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToBytes(String(keyData.publicKey)),
  });
  const subRes = await fetchImpl(`${cpBase(store)}/api/push/subscribe`, {
    method: "POST",
    headers: authHeaders(store),
    body: JSON.stringify({ subscription }),
  });
  if (!subRes.ok) throw new Error("Could not register for push notifications.");
  return "Push notifications enabled.";
}

/**
 * Turn push OFF for THIS device: unsubscribe from the browser push manager and
 * drop the subscription on the control plane so it stops receiving. Other
 * devices on the account are unaffected. Safe to call when not subscribed.
 */
export async function disablePushNotifications(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<string> {
  const nav = globalThis.navigator as any;
  const registration = await nav?.serviceWorker?.ready?.catch?.(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  const endpoint: string = subscription?.endpoint || "";
  if (subscription) await subscription.unsubscribe().catch(() => {});
  if (endpoint) {
    await fetchImpl(`${cpBase(store)}/api/push/subscribe`, {
      method: "DELETE",
      headers: authHeaders(store),
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
  return "Push notifications disabled on this device.";
}

/** Whether THIS device currently has an active push subscription + browser permission. */
export async function getPushSubscriptionStatus(): Promise<{ supported: boolean; subscribed: boolean; permission: string }> {
  const nav = globalThis.navigator as any;
  const supported = Boolean(nav?.serviceWorker && "PushManager" in globalThis && "Notification" in globalThis);
  if (!supported) return { supported: false, subscribed: false, permission: "default" };
  const permission = String((globalThis as any).Notification?.permission ?? "default");
  const registration = await nav.serviceWorker.ready.catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  return { supported: true, subscribed: Boolean(subscription), permission };
}

/** Read account-wide notification preferences (which push kinds are enabled). */
export async function getNotificationPreferences(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<NotificationPreferences> {
  const res = await fetchImpl(`${cpBase(store)}/api/push/preferences`, { headers: authHeaders(store) });
  if (!res.ok) throw new Error(`notification preferences request failed: ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return normalizeNotificationPreferences(data?.preferences);
}

/** Update (merge) account-wide notification preferences; returns the effective map. */
export async function setNotificationPreferences(store: LocalStore, patch: Partial<NotificationPreferences>, fetchImpl: typeof fetch = fetch): Promise<NotificationPreferences> {
  const res = await fetchImpl(`${cpBase(store)}/api/push/preferences`, {
    method: "PUT",
    headers: authHeaders(store),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`could not save notification preferences: ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return normalizeNotificationPreferences(data?.preferences);
}
