// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Reactive session store — a framework-agnostic reducer + subscribe/getState.
//
// This is the single source of truth the React (and later Expo) view layers
// render. The legacy remote-app.js mutated the DOM directly from handlePayload();
// here the same server events are folded into immutable state, which is what
// removes the whole class of "stale DOM / double-wired / race" glitches.
//
// Scope note: this reducer implements the well-defined event stream for a single
// focused client (transcript, approvals, models, runtimes, status, streaming
// assistant text + tool activity). The legacy multi-client focus arbitration,
// deferred-history and transcript-cache optimizations are intentionally NOT
// reproduced here. They are refinements over this correct baseline, not
// prerequisites for it.

import type { AttachmentRef, ConnectionStatus, CredentialPresetsView, CredentialRecordSummary, PromptAttachment, ServerEvent } from "./protocol.js";
import type { AccountNode, EphemeralNodeConfig } from "./account.js";
import type { MachineCapabilities } from "./capabilities.js";
import type { InboxAdvert } from "./inbox.js";
import type { SessionContract } from "./session-contract.js";
import {
  EMPTY_SESSION_DRAFT,
  reduceSessionDraft,
  type SandboxTier,
  type SessionDraft,
  type SessionDraftCommand,
} from "./session-draft.js";
import { type SlashCommand } from "./slash.js";
import { toHtml, extractRemoteImageUrls } from "./markdown.js";
import { normalizeEventType } from "./tool-activity.js";
import { SeqReassembler } from "./seq-reassembler.js";
import { foldConnectionEvent } from "./connection-event-fold.js";
import { foldSessionIndexEvent } from "./session-index-event-fold.js";
import { foldTerminalEvent } from "./terminal-event-fold.js";
import { foldCatalogSettingsEvent } from "./catalog-settings-event-fold.js";
import { foldPresentationEvent } from "./presentation-event-fold.js";
import { foldAttentionEvent } from "./attention-event-fold.js";
import { foldActiveSessionEvent } from "./active-session-event-fold.js";
import { foldTranscriptEvent, freshTranscriptDraft, type TranscriptDraftValue } from "./transcript-event-fold.js";
import type { ToolCallDetail } from "./tool-format.js";
import {
  reduceFollowupQueue,
  type FollowupEditResult,
  type FollowupQueueCommand,
  type FollowupQueueTransition,
  type PendingFollowup,
} from "./followup-queue.js";
import { nextId, renderHistory } from "./store-render.js";
import {
  agentLabel,
  githubContext,
  githubFromSummary,
  normalizeAgentCommands,
  normalizeCapabilitiesSnapshot,
  normalizeModels,
  normalizeNodeStats,
  normalizePrs,
  normalizeSessions,
  normalizeSessionState,
  normalizeThinking,
  normalizeUsage,
  sameCommandList,
  sameModel,
  sessionStatusFromState,
} from "./store-normalize.js";

// Re-export the helpers that moved out of this file so the package's public
// surface (index.ts `export * from "./store.js"`) is unchanged.
export { humanizeError, looksLikeAgentError } from "./store-errors.js";
export {
  EMPTY_SESSION_DRAFT,
  reduceSessionDraft,
  type SandboxTier,
  type SessionDraft,
  type SessionDraftCommand,
} from "./session-draft.js";
export {
  reduceFollowupQueue,
  type FollowupEditResult,
  type FollowupQueueCommand,
  type FollowupQueueTransition,
  type FollowupStatus,
  type PendingFollowup,
} from "./followup-queue.js";
export { renderHistory, stripAttachmentPlaceholders } from "./store-render.js";
export {
  githubIssueRefFromSource,
  isGithubQueueSource,
  normalizePrs,
  normalizeSandboxTier,
  primaryPr,
  repoFromSource,
} from "./store-normalize.js";

export type SessionStatus = "idle" | "working" | "needs_action" | "failed" | "saved";

/** Explicit live-session axes supplied by nodes that report them. Optional on
 * summaries for compatibility with older nodes and persisted account-index rows. */
export interface SessionState {
  transport: "reachable" | "unreachable";
  process: "alive" | "exited" | "none";
  agent: "idle" | "working" | "waiting" | "awaiting-input";
  workspace: "clean" | "dirty" | "checkpointing";
  displayStatus: "idle" | "working" | "needs_attention" | "failed";
}

/** A live native-agent PTY started by `bivy run`. These are node-owned terminal
 * sessions rather than structured chat sessions, but they belong in the same
 * session picker so a remote client can discover and attach to them. */
export interface RunTerminalSummary {
  termId: string;
  name?: string;
  label?: string;
  agent?: string;
  model?: string;
  workspace?: string;
  createdAt?: number;
  lastActivityAt?: number;
  sessionId?: string;
  pid?: number;
  /** Relay/account mode: node that owns this terminal. Tagged by the
   *  controller's eventWithNodeScope, mirroring SessionSummary.nodeId, so the
   *  sidebar can show (and merge) run terminals from every node, not just the
   *  currently connected one. */
  nodeId?: string;
}

export interface SessionSummary {
  sessionId: string;
  /** On-disk session file path — required to open a not-yet-loaded session. */
  path?: string;
  /** Repository/default workspace recorded by the node. */
  workspace?: string;
  /** Effective isolated worktree for this session, when it has one. */
  worktree?: string;
  name: string;
  source?: string;
  /** Parent session's id, when this session was materialized from a fork
   *  bundle (see src/session/fork.ts on the node). Undefined for an ordinary
   *  session. The parent may live on a different node, so this is only ever
   *  an id to display/link, not something guaranteed resolvable locally. */
  forkedFrom?: string;
  /** Relay/account mode: node that owns this session. Used by all-node lists. */
  nodeId?: string;
  runtimeId?: string;
  agentName?: string;
  updatedAt?: number;
  needsAction?: boolean;
  status?: SessionStatus;
  sessionState?: SessionState;
  /** Repo-backed session's worktree branch, when known (sessions.list already
   *  carries this from the node — see src/server.ts — it was previously dropped
   *  here, which is why the sidebar had no branch/PR context per row). */
  branch?: string;
  /** Device-local placeholder while an ephemeral runner is provisioning. It is
   *  preserved across authoritative session-list refreshes until the controller
   *  replaces it with the node's canonical session id. */
  pendingLaunch?: boolean;
  /** Intended Machine/profile while a cold start is pending or failed before a
   * real node id exists. Prevents UI fallback to an unrelated current node. */
  pendingNodeName?: string;
  /** This session's ephemeral node was torn down (unenrolled, gone from the
   *  registry) but is REBUILDABLE from a durable correlation + the room key this
   *  device still holds — so the row stays in the sidebar as offline-but-rebuildable
   *  and a send rebuilds it (Gap 1). Client-local; the node has no concept of it. */
  rebuildable?: boolean;
  /** Per-session sandbox tier this session was created with (the override); absent
   *  = the node default. Baked in at creation and read-only for the session's life
   *  — surfaced so a running session can show its sandbox mode read-only. */
  sandbox?: SandboxTier;
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  ephemeral?: boolean;
  executionProfile?: "trusted_workstation" | "isolated_customer_cloud" | "restricted";
  auditHealth?: {
    storage: "healthy" | "missing" | "corrupt" | "unreadable";
    writes: "healthy" | "unknown" | "degraded";
    failedWrites: number;
    corruptLines: number;
  };
  eventLogHealth?: { state: "healthy" | "degraded"; operation?: "read" | "parse" | "append" | "rewrite"; at?: number };
  /** The Effective Session Contract resolved once at session creation from
   *  real launch facts (not live-recomputed on every refresh — see
   *  session-contract.ts) — what this specific session actually got, as
   *  distinct from the catalog-level `RuntimeInfo` promise. Absent for a
   *  session that predates this field (an older node, or a session opened
   *  before the daemon started stamping one) or one that hasn't been
   *  reopened since. */
  contract?: SessionContract;
  /** Pull request opened for this session's branch, if any (the live open one). */
  prUrl?: string;
  /** Every PR seen for this session's branch (open, merged, closed). */
  prs?: PrRef[];
  /** Client-local: epoch ms when the user last had this session open. Never
   *  sent by the node — purely local UI state, stamped by beginOpen() and by
   *  any live update that lands while the session is the active one. Compared
   *  against `finishedAt` to derive whether a finished run is still "unseen"
   *  (see isUnseen in the web package's sessionStatus.ts). */
  lastSeenAt?: number;
  /** Client-local: epoch ms of the last time this session's turn actually
   *  finished (the `agent_end` transition to "idle" — see the session.event
   *  handler below), as distinct from "idle" meaning brand-new or
   *  never-started. Only this specific transition stamps it, so a fresh
   *  session or a cold sessions.list snapshot never reads as a finished run
   *  someone hasn't looked at yet. */
  finishedAt?: number;
  /** Client-local timestamp of the latest terminal failed turn. */
  failedAt?: number;
  /** Content-free unresolved conditions from the account session index. */
  attention?: InboxAdvert[];
}

export type ToolStatus = "running" | "done";

export interface ToolActivity {
  callId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: string;
  /** Node-computed normalized classification (see ToolCallDetail); when present,
   *  formatTool renders from it instead of re-deriving from `input`. */
  detail?: ToolCallDetail;
}

export type TranscriptRole = "user" | "assistant" | "system" | "thinking" | "error";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  /** Raw text (already plain). Rendered to HTML lazily by the view via `html`. */
  text: string;
  /** Pre-rendered markdown HTML for assistant/user prose. */
  html?: string;
  /** Present when this entry is a tool-activity card instead of prose. */
  tool?: ToolActivity;
  /** True while an assistant draft is still streaming. */
  streaming?: boolean;
  /** Files/images the user attached when sending this message (user role only).
   *  The node only persists a text placeholder for these (see
   *  attachmentsByText below), so this is populated from the client's own
   *  send-time cache, not from history data. */
  attachments?: PromptAttachment[];
  /** A slash command the node suggested for this notice (e.g. "/new"), rendered
   *  as an inline action button on a system entry so the suggestion is tappable
   *  instead of just describing a command the user would have to type. */
  action?: string;
  /** Resolved AttachmentRefs for this (assistant) entry's remote markdown images
   *  (`![alt](https://…)`), keyed by the exact URL the markdown referenced — see
   *  inlineImagesByUrl / withInlineImageRefs below. ChatView's hydrate effect
   *  looks up each `<img data-remote-src>` here to fetch its bytes and swap in a
   *  `blob:` URL (the deployed CSP blocks a literal remote `src`). Populated at
   *  render time from durable history (`foldInlineImageRefs`) and patched in
   *  live as the node resolves more (see the "inlineImage" case below) — a new
   *  object identity on that patch is what makes the hydrate effect re-run. */
  imageRefs?: Record<string, AttachmentRef>;
}

export interface ModelInfo {
  id: string;
  label?: string;
  [k: string]: unknown;
}

export interface RuntimeInfo {
  id: string;
  /** Default communication path: structured protocol/SDK, JSON pipe, plain pipe, or native terminal. */
  executionMode?: "protocol" | "structured-pipe" | "pipe" | "pty";
  displayName?: string;
  name?: string;
  supportTier?: "supported" | "beta" | "experimental" | "planned";
  protectionLevel?: "native-sandbox" | "tool-controls" | "mcp-controls" | "user-permissions";
  protectionLabel?: string;
  protectionDetail?: string;
  certification?: "release-tested" | "adapter-tested" | "unverified";
  source?:
    | { kind: "config" }
    | {
        kind: "package";
        packageId: string;
        packageVersion: string;
        publisher?: string;
        location: "distribution" | "installed";
        verified: boolean;
      };
  testedVersion?: string;
  /** Runtime-declared authentication contract used by generic onboarding. */
  credentialRequirements?: {
    owner: "bivy" | "agent" | "mixed";
    strategy: "one-of" | "all" | "agent-login";
    providers: string[];
  };
  [k: string]: unknown;
}

export interface ApprovalRequest {
  id: string;
  sessionId?: string;
  tool?: string;
  summary?: string;
  [k: string]: unknown;
}

/** One option the user can pick for a UserQuestionItem (mirrors the node's
 *  src/runtime/types.ts UserQuestionOption). */
export interface UserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

/** One clarifying question within a UserQuestionRequest's `questions` array. */
export interface UserQuestionItem {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * A blocking, multiple-choice clarifying question the agent raised mid-turn
 * (e.g. Claude's AskUserQuestion tool) — distinct from a tool-permission
 * ApprovalRequest. Kept in the global list (like approvals) so the sidebar can
 * flag which session needs a response, but the card itself only renders inline
 * in the chat of the session it belongs to (matched on `sessionId`).
 */
export interface UserQuestionRequest {
  /** Matches the runtime's own requestId — pass back to answerQuestion(). */
  id: string;
  sessionId?: string;
  questions: UserQuestionItem[];
  createdAt?: number;
}

/** A soft watchdog warning that asks the user whether to stop a possibly stuck
 * turn or keep waiting. One may be pending per session. */
export interface TurnAttentionRequest {
  sessionId: string;
  trigger: "stalled" | "wedged";
  idleMs: number;
  at: number;
  message: string;
}

/** Reasoning/thinking capability of the current model. */
export interface ThinkingState {
  supportsThinking: boolean;
  thinkingLevel: string;
  availableThinkingLevels: string[];
}

/** Why the repo listing came back empty & unauthed. `null` = connected/ok.
 *  "no-token": nothing connected — steer to `bivy github:connect`.
 *  "gh-unauthed": the `gh` CLI is installed but logged out — also offer `gh auth login`. */
export type RepoAuthReason = "no-token" | "gh-unauthed" | null;

/** The repo-picker "Connect GitHub" device flow (Tier 2). `starting` is a local
 *  optimistic state; the rest come from the node's github.connect.status event.
 *  `unconfigured` means the node has no device-flow client id — the UI falls
 *  back to the `bivy github:connect` instructions. */
export interface GithubConnectState {
  status: "idle" | "starting" | "waiting" | "connected" | "expired" | "denied" | "error" | "unconfigured";
  /** Device code the user enters at github.com/login/device (status "waiting"). */
  userCode?: string;
  /** Where to enter it. */
  verificationUri?: string;
  /** GitHub's poll interval, so the client doesn't hammer the endpoint. */
  intervalMs?: number;
  error?: string;
}

export interface RepoInfo {
  slug: string;
  description?: string;
  private?: boolean;
  /** The repo's default branch (e.g. "main"), from the repo listing — lets the
   *  branch picker label its default row instantly, before branches.list. */
  defaultBranch?: string;
  [k: string]: unknown;
}

/** A remote branch of the repo currently picked in the composer's repo pill,
 *  for the adjacent branch pill (#466). */
export interface BranchInfo {
  name: string;
  [k: string]: unknown;
}

/**
 * The provider id an *API key* for `provider` should be stored under. A few
 * providers sign in via OAuth under one id but read a pasted key from another
 * provider's env var: Codex authenticates as `openai-codex` (the ChatGPT
 * subscription) yet reads a plain key from `openai`'s OPENAI_API_KEY. Used by the
 * sign-in sheet (where to save the key) and the auto-dismiss (which provider
 * becoming configured satisfies the prompt). OAuth sign-in still uses the
 * original id.
 */
export function modelAuthApiKeyProvider(provider: string): string {
  return provider === "openai-codex" ? "openai" : provider;
}

export interface ProviderInfo {
  id: string;
  name?: string;
  configured?: boolean;
  kind?: string;
  source?: string;
  oauth?: boolean;
  /** Epoch ms the stored OAuth access token expires, when `kind === "oauth"`. */
  expiresAt?: number;
  [k: string]: unknown;
}

export interface ProviderAuth {
  provider: string;
  kind?: string;
  key?: string;
  source?: string;
  configured?: boolean;
  oauth?: boolean;
  [k: string]: unknown;
}

/** A user-provided / local model provider (Ollama, LM Studio, vLLM, Azure, …). */
export interface LocalModelProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  /** Whether a token is stored (the raw key is never sent to the client). */
  hasKey: boolean;
  modelCount: number;
  models: Array<{ id: string; name: string }>;
  scope: "machine" | "network";
  machineId?: string;
  machineName?: string;
  availableOnThisMachine: boolean;
}

export interface LocalModelEndpointResult {
  candidateId?: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions";
  status: "ready" | "offline" | "timeout" | "auth_required" | "malformed" | "unsupported";
  models: Array<{ id: string; name: string }>;
  detail?: string;
  machineId: string;
  machineName: string;
}

export interface LocalModelDiscoveryResult {
  machineId: string;
  machineName: string;
  endpoints: LocalModelEndpointResult[];
  readiness: { ready: boolean; readyEndpointCount: number; modelCount: number; state: "ready" | "auth_required" | "unavailable" | "unknown" };
}

/** A quick-add preset for a common local inference server. */
export interface LocalModelPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  note?: string;
}

// --- Rulesets (run-orchestration policy; docs/rulesets.md) --------------------
// Client-side mirror of the node's ruleset schema (src/policy/ruleset.ts). The
// node validates authoritatively with typebox on save; these shapes just let the
// Settings editor build and render a ruleset. Kept structurally identical so a
// ruleset round-trips through save/list unchanged.

/** The stable failure conditions a rule can match (never raw provider strings). */
export type RuleCondition =
  | "rate_limited"
  | "credits_exhausted"
  | "context_overflow"
  | "auth_failed"
  | "node_offline"
  | "transport_error"
  | "task_failed"
  | "unknown";

/** Where a ruleset may fire. */
export type RuleContext = "session" | "queue";

/** One ordered fallback candidate for a `reroute` action's chain. */
export interface RulesetRoutingCandidate {
  runtimeId?: string;
  model?: string;
  account?: string;
  label?: string;
}

/** Retry/reroute backoff (min(cap, base·factor^n) ± jitter). */
export interface RulesetBackoff {
  baseMs: number;
  factor: number;
  capMs: number;
  jitter: number;
}

/** A single rule: match `when` conditions → take `action` within bounds. */
export interface RulesetRule {
  when: RuleCondition[];
  action: "retry" | "reroute" | "park";
  chain?: RulesetRoutingCandidate[];
  onExhausted?: "park" | "give_up";
  maxAttempts: number;
  backoff?: RulesetBackoff;
}

/** A user-authored ruleset (the node's validated in-memory shape). */
export interface Ruleset {
  version: 1;
  name: string;
  appliesTo: RuleContext[];
  rules: RulesetRule[];
}

/** A ruleset plus whether it's the active queue policy — what the UI lists. */
export interface RulesetInfo extends Ruleset {
  active: boolean;
}

/** Speech-to-text (voice input) provider + which keys the node has stored. */
export type SttProviderId = "groq" | "openai";
export interface SttProviderStatus {
  id: SttProviderId;
  label: string;
  model: string;
  configured: boolean;
}
export interface SttConfig {
  provider: SttProviderId;
  providers: SttProviderStatus[];
}

export interface OauthState {
  id: string;
  provider?: string;
  authUrl?: string;
  instructions?: string;
  deviceCode?: { verificationUri?: string; userCode?: string } | null;
  usesCallbackServer?: boolean;
  /** This connected node reports a usable local graphical browser. */
  canOpenOnNode?: boolean;
  nodeName?: string;
  status?: string;
  error?: string;
}

/**
 * State for the GitHub App one-click (manifest) flow. `phase` drives the UI:
 * idle → starting (waiting for the node's manifest) → submitting (browser is at
 * GitHub) → completing (relaying the returned code) → done | error.
 *
 * One flow at a time, even though an account can end up with several apps (one
 * per GitHub owner): each create allocates its own hook and finishes before the
 * next starts, so this stays a single transient phase machine rather than a map.
 */
export interface GithubAppState {
  phase: "idle" | "starting" | "submitting" | "completing" | "done" | "error";
  /** GitHub URL to POST the manifest to (with the hook id as `state`). */
  action?: string;
  /** Pre-built manifest to POST as a form field. */
  manifest?: Record<string, unknown>;
  /** Hook id, echoed back by GitHub as `state`; ties the code to its hook. */
  state?: string;
  /** Where to install the freshly-created app. */
  installUrl?: string;
  error?: string;
  /** True right after a redirect back from GitHub, so the UI can re-open the panel. */
  returning?: boolean;
}

/** One rate-limit window from a metered plan (mirrors the node's UsageWindow). */
export interface UsageWindow {
  label: string;
  utilizationPct: number | null;
  resetsAt: string | null;
}

/** Display-only cost/token/plan-quota snapshot (mirrors the node's UsageSnapshot). */
export interface Usage {
  costUsd?: number;
  tokens?: { input?: number; output?: number; total?: number; [k: string]: unknown };
  plan?: { subscriptionType?: string | null; windows?: UsageWindow[] };
  [k: string]: unknown;
}

/** A per-tier resource figure: an absolute amount plus its share of the node
 *  total (0..100). CPU tiers carry `pct` only. */
export interface NodeStatsTier {
  bytes?: number;
  pct: number;
}

/** Node-resource snapshot (memory/CPU/storage) for the header "Node stats" panel.
 *  Mirrors the node's `NodeStats` (src/node-stats.ts). Each resource reports three
 *  tiers: `session` (the active session's live agent process — null when there's
 *  nothing separable to measure), `bivy` (the whole Bivy process tree), and `node`
 *  (the machine total / what's available). Byte counts are raw bytes; percentages
 *  are 0..100. Fields are tolerant so an older/partial node still renders. */
export interface NodeStats {
  nodeId?: string;
  name?: string | null;
  /** Node uptime, seconds. */
  uptime?: number;
  cores?: number;
  cpuModel?: string | null;
  load?: [number, number, number];
  /** Whether a session-scoped figure could be attributed at all. */
  sessionMeasurable?: boolean;
  memory?: {
    node: { used: number; total: number; free: number; usedPct: number };
    bivy: NodeStatsTier;
    session: NodeStatsTier | null;
  };
  cpu?: {
    node: { usedPct: number };
    bivy: NodeStatsTier;
    session: NodeStatsTier | null;
  };
  storage?: {
    node: { path: string; used: number; total: number; free: number; usedPct: number } | null;
    bivy: NodeStatsTier | null;
    session: NodeStatsTier | null;
  };
  /** Collection timestamp (ISO). */
  at?: string;
}

/** State of a pull request as GitHub reports it (mirrors the node's PrState). */
export type PrState = "open" | "merged" | "closed";

/** A pull request opened for a session's branch. */
export interface PrRef {
  url: string;
  number?: number;
  state: PrState;
  title?: string;
}

/** GitHub context for the active session (drives the header pill + action sheet). */
export interface GithubContext {
  issueUrl: string | null;
  prUrl: string | null; // the live *open* PR, if any (back-compat / primary link)
  branch: string | null;
  repo: string | null; // owner/name
  /** Every PR seen for the branch (open, merged, closed) — drives the pill state
   *  and the action sheet when a session accumulates more than one PR. */
  prs: PrRef[];
}

/** Per-node defaults, editable from Settings → Nodes (see NodeSettings on the node). */
export interface NodeSettings {
  name: string;
  defaultAgent: string;
  defaultModel: { provider: string; id: string } | null;
  defaultSandbox: SandboxTier;
  githubMaxConcurrent: number;
  /** First-message instructions for a GitHub-issue pickup, appended after the
   *  issue's own number/title/body/link. Editable; the node fills in a strong
   *  default when this hasn't been customized. */
  githubIssuePrompt: string;
  /** Warm-replicate each session's transcript to a standby node so it can be
   *  picked up elsewhere if this node goes offline (docs/session-replication.md).
   *  Off by default — replication streams data node-to-node over the E2E relay. */
  sessionSync: boolean;
  /** Also replicate the workspace: each turn's git checkpoint is shipped to the
   *  standby so the promoted session can keep *working*, not just show history.
   *  Requires sessionSync; ignored when the workspace is not a git repo. */
  worktreeSync: boolean;
  /** The account node this node replicates its sessions TO (the standby). Empty
   *  = sync configured but no standby chosen yet (nothing is replicated). */
  syncStandbyNodeId?: string;
  /** How a session whose turn was cut off by a node restart recovers: "auto"
   *  re-drives the interrupted turn on boot, "manual" waits for a one-tap Resume.
   *  Governs interactive sessions only — issue automation always auto-resumes. */
  sessionResumeMode: "auto" | "manual";
  /** Passively surface images a tool produces (e.g. a screenshot MCP tool's
   *  output) into the chat as attachments, with no explicit "attach" call
   *  (issue #292). Off by default; bounded per-turn regardless once enabled. */
  autoAttachToolImages: boolean;
}

export interface ConnectionAccountState {
  status: ConnectionStatus;
  signedIn: boolean;
  nodes: AccountNode[];
  currentNodeId: string | null;
  nodeUpdate: { current: string; latest: string } | null;
  nodeUpdating: boolean;
}

export interface SessionIndexState {
  sessions: SessionSummary[];
  runTerminals: RunTerminalSummary[];
  tuiSessions: string[];
  pausedSessionIds: string[];
  commandsBySession: Record<string, SlashCommand[]>;
  followupsBySession: Record<string, PendingFollowup[]>;
}

export interface ActiveSessionState {
  activeSessionId: string | null;
  activeRuntimeId: string | null;
  activeTitle: string;
  github: GithubContext;
  transcript: TranscriptEntry[];
  working: boolean;
  workingLabel: string;
  opening: boolean;
  approvals: ApprovalRequest[];
  questions: UserQuestionRequest[];
  turnAttentions: TurnAttentionRequest[];
  usage: Usage | null;
  changes: TurnChanges | null;
  changesHistory: SessionChangeEntry[];
  checkpoints: Checkpoint[];
}

export interface CatalogState {
  models: ModelInfo[];
  modelsRuntimeId: string | null;
  currentModelId: string | null;
  currentModel: ModelInfo | null;
  thinking: ThinkingState;
  runtimes: RuntimeInfo[];
  currentAgentName: string;
  selectedAgentId: string | null;
  installingRuntimeId: string | null;
  repos: RepoInfo[];
  reposAuthed: boolean;
  reposError: string | null;
  reposLoading: boolean;
  reposReason: RepoAuthReason;
  githubConnect: GithubConnectState;
  branches: BranchInfo[];
  branchesRepo: string | null;
  branchesDefault: string | null;
  branchesError: string | null;
  branchesLoading: boolean;
  providers: ProviderInfo[];
  activationReadiness: {
    credential: { configured: boolean; probed: boolean; ok: boolean; reason?: string };
    repository: { chosen: boolean; probed: boolean; ok: boolean; authed: boolean; reason?: string };
  } | null;
}

export interface SettingsState {
  nodeSettings: NodeSettings | null;
  providerAuth: ProviderAuth | null;
  credentialRecords: CredentialRecordSummary[];
  credentialPresets: CredentialPresetsView | null;
  localModels: LocalModelProvider[];
  localModelPresets: LocalModelPreset[];
  rulesets: RulesetInfo[];
  sttConfig: SttConfig | null;
  nodeStats: NodeStats | null;
  capabilities: MachineCapabilities | null;
}

export interface PresentationState {
  oauth: OauthState | null;
  needsModelAuth: { nodeId: string; provider: string; reason?: string } | null;
  githubApp: GithubAppState | null;
  prResult: { sessionId?: string; url?: string; error?: string } | null;
  prRefreshAllResult: { scanned: number; changed: number; error?: string } | null;
  error: string | null;
  errorActions: Array<{ id: string; label: string; kind?: "primary" | "secondary" }>;
  notice: string | null;
}

/** Reactive application state is a composition of independently meaningful
 * immutable values. Fields intentionally exist in exactly one nested value. */
export interface AppState {
  readonly connection: Readonly<ConnectionAccountState>;
  readonly sessionIndex: Readonly<SessionIndexState>;
  readonly activeSession: Readonly<ActiveSessionState>;
  readonly catalogs: Readonly<CatalogState>;
  readonly settings: Readonly<SettingsState>;
  readonly presentation: Readonly<PresentationState>;
  readonly draft: Readonly<SessionDraft>;
}

type AppStatePatch = Partial<
  ConnectionAccountState & SessionIndexState & ActiveSessionState & CatalogState &
  SettingsState & PresentationState & { draft: SessionDraft }
>;

const CONNECTION_FIELDS = ["status", "signedIn", "nodes", "currentNodeId", "nodeUpdate", "nodeUpdating"] as const;
const SESSION_INDEX_FIELDS = ["sessions", "runTerminals", "tuiSessions", "pausedSessionIds", "commandsBySession", "followupsBySession"] as const;
const ACTIVE_SESSION_FIELDS = ["activeSessionId", "activeRuntimeId", "activeTitle", "github", "transcript", "working", "workingLabel", "opening", "approvals", "questions", "turnAttentions", "usage", "changes", "changesHistory", "checkpoints"] as const;
const CATALOG_FIELDS = ["models", "modelsRuntimeId", "currentModelId", "currentModel", "thinking", "runtimes", "currentAgentName", "selectedAgentId", "installingRuntimeId", "repos", "reposAuthed", "reposError", "reposLoading", "reposReason", "githubConnect", "branches", "branchesRepo", "branchesDefault", "branchesError", "branchesLoading", "providers", "activationReadiness"] as const;
const SETTINGS_FIELDS = ["nodeSettings", "providerAuth", "credentialRecords", "credentialPresets", "localModels", "localModelPresets", "rulesets", "sttConfig", "nodeStats", "capabilities"] as const;
const PRESENTATION_FIELDS = ["oauth", "needsModelAuth", "githubApp", "prResult", "prRefreshAllResult", "error", "notice"] as const;

function pickPatch<T extends object>(current: T, patch: AppStatePatch, fields: readonly (keyof T)[]): T {
  const entries: Array<[keyof T, unknown]> = [];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) entries.push([field, patch[field as keyof AppStatePatch]]);
  }
  return entries.length ? { ...current, ...Object.fromEntries(entries as Array<[PropertyKey, unknown]>) } : current;
}

/** A harness checkpoint (rewind target) for the active session. */
export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
}

/** One changed file from a harness turn, shaped for the DiffView. */
export interface HarnessFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  oldText: string;
  newText: string;
  binary: boolean;
  /** Authoritative +/- line counts from `git diff --numstat` on the node. When
   *  present the UI shows these instead of counting its own (size-capped, and so
   *  wildly inflated for large files) client-side diff. Undefined for binaries. */
  added?: number;
  removed?: number;
}

/** The structured diff a single turn produced, plus its rewind target. */
export interface TurnChanges {
  /** Checkpoint id to rewind to (state before this turn), if any. */
  before?: string;
  /** Checkpoint id captured after this turn. */
  after: string;
  files: HarnessFileChange[];
}

/** One entry in the session's changes history (see AppState.changesHistory) —
 *  a TurnChanges plus the bookkeeping the sheet needs to list many of them. */
export interface SessionChangeEntry extends TurnChanges {
  /** Stable id for this entry — a React key and the sheet's rewind target. */
  id: string;
  /** When this turn's changes were reported, for the sheet's "X ago" label. */
  at: number;
}

export function initialState(): AppState {
  return {
    connection: {
      status: "offline", signedIn: false, nodes: [], currentNodeId: null,
      nodeUpdate: null, nodeUpdating: false,
    },
    sessionIndex: {
      sessions: [], runTerminals: [], tuiSessions: [], pausedSessionIds: [],
      commandsBySession: {}, followupsBySession: {},
    },
    activeSession: {
      activeSessionId: null, activeRuntimeId: null, activeTitle: "New session",
      github: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
      transcript: [], working: false, workingLabel: "", opening: false,
      approvals: [], questions: [], turnAttentions: [], usage: null, changes: null,
      changesHistory: [], checkpoints: [],
    },
    catalogs: {
      models: [], modelsRuntimeId: null, currentModelId: null, currentModel: null,
      thinking: { supportsThinking: false, thinkingLevel: "off", availableThinkingLevels: ["off"] },
      runtimes: [], currentAgentName: "Agent", selectedAgentId: null,
      installingRuntimeId: null, repos: [], reposAuthed: true, reposError: null,
      reposLoading: false, reposReason: null, githubConnect: { status: "idle" },
      branches: [], branchesRepo: null, branchesDefault: null, branchesError: null,
      branchesLoading: false, providers: [], activationReadiness: null,
    },
    settings: {
      nodeSettings: null, providerAuth: null, credentialRecords: [],
      credentialPresets: null, localModels: [], localModelPresets: [], rulesets: [],
      sttConfig: null, nodeStats: null, capabilities: null,
    },
    presentation: {
      oauth: null, needsModelAuth: null, githubApp: null, prResult: null,
      prRefreshAllResult: null, error: null, errorActions: [], notice: null,
    },
    draft: { ...EMPTY_SESSION_DRAFT },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Draft extends TranscriptDraftValue {
  assistantId: string | null;
  thinkingId: string | null;
  finalized: boolean;
  /** Accumulated reasoning text for runtimes that stream it only as
   *  `thinking_delta` chunks (no accumulated `thinking` block in the message). */
  thinkingText: string;
  /** Whether reasoning appeared before any answer text this turn. We only commit
   *  a separate thinking entry when it did — matching the old streaming behaviour
   *  where the reasoning block showed while text was still empty, then stayed. */
  sawThinking: boolean;
  /** Latest accumulated assistant prose seen on a message_update/_end this turn.
   *  Recorded (not yet rendered) so we can seal it at a tool boundary — see
   *  commitPendingProse. */
  pendingText: string;
  /** The slice of `pendingText` already committed to the transcript as finished
   *  bubbles. Each tool boundary (and message_end) commits only the not-yet-
   *  committed suffix, so a runtime that streams cumulative text (Codex: one
   *  growing message) and one that resets per segment (Claude: a message per
   *  tool-split segment) both interleave prose and tool cards in source order. */
  committedText: string;
  /** The slice of `thinkingText` already committed as finished thinking bubbles.
   *  Reasoning is sealed at each tool boundary (see commitPendingThinking) the
   *  same way prose is, so a `think → tool → think → tool → answer` turn keeps
   *  each reasoning run ABOVE its tool card instead of collapsing to one bubble
   *  committed after the tools at message_end. */
  committedThinking: string;
}

function freshDraft(finalized = true): Draft {
  return freshTranscriptDraft(finalized);
}

/** One optimistically-sent user prompt, tracked by clientMessageId. The single
 *  structure that replaced the old sentMessageIds/pendingUserEntries/
 *  pendingConfirmedText triad — see SessionStore.pending. */
interface PendingSend {
  /** The optimistic user bubble shown the instant Send was hit (its
   *  `attachments`, if any, ride along on the entry). */
  entry: TranscriptEntry;
  /** The node has echoed this prompt back (session.user_message) → it is now
   *  persisted server-side. Only a confirmed send may be retired by the history
   *  count fallback; an unconfirmed one is always kept so a stale/empty snapshot
   *  can't erase a just-sent, not-yet-persisted message. */
  confirmed: boolean;
  /** The node's canonical/composed text for this prompt, from its echo (caption +
   *  attachment placeholder), which is what a later history snapshot contains. */
  confirmedText?: string;
  /** A canonical history snapshot already carries this prompt's text, so its
   *  bubble must no longer be re-appended. Kept (not deleted) while still
   *  unconfirmed purely so the node's own echo is still deduped by cmid — the
   *  role the old standalone `sentMessageIds` set played. Retired outright once
   *  BOTH the echo (confirmed) and history (reconciled) agree it's landed. */
  reconciled?: boolean;
}

/**
 * Fold a single server event into state. Returns the same object if unchanged,
 * or a new AppState if it changed (so `===` identity drives view re-render).
 */
export class SessionStore {
  private state: AppState = initialState();
  private listeners = new Set<() => void>();
  /** Coalesce high-frequency streaming state notifications to one browser paint. */
  private notifyPending = false;
  private notifyHandle: number | ReturnType<typeof setTimeout> | null = null;
  private draft: Draft = freshDraft();
  /** Agent-sent attachments buffered during the current turn. Flushed at the
   *  turn boundary onto the turn's final assistant bubble (see
   *  flushPendingAgentAttachments) so a chip reads as part of the reply, not as a
   *  standalone entry stranded mid-turn where `bivy attach` happened to run. */
  private pendingAgentAttachments: Array<{ attachment: PromptAttachment; caption: string }> = [];
  /** Every agent-sent attachment ever shown for a session, keyed by content hash
   *  (append-only — an agent can't "unsend" one). A later history snapshot that
   *  omits one — a resume-race reconcile, or any transcript built from raw runtime
   *  messages without the durable outbound-attachment overlay — is therefore
   *  lossy, and must not be allowed to erase the chip. withStickyAgentAttachments
   *  re-applies any missing ones; keying by hash also de-dupes a re-broadcast of a
   *  live `attachment` event the transcript already carries. */
  private knownAgentAttachmentsBySession = new Map<string, Map<string, { attachment: PromptAttachment; caption: string }>>();
  /** The user's last-used model, remembered across sessions and reloads. Honored
   *  by the models.list reducer *only* while no session is active (a fresh
   *  draft), so a new session opens on the same model the user last picked. The
   *  node's list stays authoritative: a model this runtime doesn't list falls
   *  back to the node default. Seeded by the controller from local storage. (The
   *  last-used *agent* is restored imperatively by the controller, since that
   *  requires a runtime.select round-trip — see maybeRestoreDraftAgent.) */
  private draftModel: { provider?: string; id: string } | null = null;
  /** Last model list seen per runtime, so switching an agent back to one already
   *  viewed this session repaints its models instantly instead of blanking to a
   *  loading state while the node's fresh models.list round-trips. Populated by
   *  the models.list reducer; read by setSelectedAgentLocal. A pure client-side
   *  cache — the node's fresh list still overwrites it (stale-while-revalidate). */
  private modelsByRuntime = new Map<string, { models: ModelInfo[]; currentModel: ModelInfo | null }>();
  /**
   * The single source of truth for optimistic user sends, keyed by
   * clientMessageId (cmid). One entry per prompt the user sent from this client,
   * replacing what used to be four parallel structures (sentMessageIds,
   * pendingUserEntries, pendingConfirmedText, and the per-cmid slice of the send
   * bookkeeping). Each PendingSend carries:
   *   - `entry`      the optimistic user bubble shown the instant Send was hit
   *                  (attachments live on the entry itself);
   *   - `confirmed`  whether the node has echoed this prompt back
   *                  (session.user_message), i.e. it is now persisted server-side
   *                  and a canonical history snapshot will carry it;
   *   - `confirmedText` the node's *composed* text for it (caption + attachment
   *                  placeholder), learned from that echo — what a later history
   *                  snapshot actually contains, which withPendingUserEntries
   *                  dedups against.
   * A brand-new session answers `session.new` with an *empty* history; a plain
   * full-replace would erase the prompt the user just sent, so these are
   * re-appended after every history replace and retired only once real history
   * actually contains them (see withPendingUserEntries). Cleared on a session
   * switch / new draft. The node's own echo of our prompt is deduped by cmid
   * (an unconfirmed pending entry) so it never renders a duplicate bubble.
   */
  private pending = new Map<string, PendingSend>();
  /** The number of canonical (node-history) user messages that existed *before*
   *  the current run of optimistic sends began — captured when `pending` goes
   *  from empty to non-empty. This is the sole remaining count fallback:
   *  withPendingUserEntries uses it to retire a *confirmed* prompt whose text the
   *  runtime rewrote (env/context wrapping, whitespace normalization) so it
   *  matches neither the raw nor the composed text — recognizing it as "now in
   *  history" by count instead of re-appending it at the bottom on every snapshot
   *  while the agent works. Reset to 0 once `pending` drains. */
  private usersBeforePending = 0;
  /** Best-effort local memory of attachments sent with a user message, keyed by
   *  the message's exact text. Deliberately kept separate from `pending`: the
   *  node only ever echoes/persists a text placeholder for an attachment (e.g.
   *  "[Image attachment: foo.png (12 KB)]"), never the real bytes, and a
   *  canonical-history re-render produces fresh entries with no cmid — so this
   *  cache must outlive the pending send (which is retired once history holds it)
   *  and be looked up by text. It is also persisted across a reload (see
   *  attachmentsForHistory/restoreAttachments), where cmids are meaningless.
   *  Mirrors the legacy client's rememberAttachmentLinks/lookupAttachmentLinks.
   *  Bounded like HTML_CACHE so a long session can't grow it without limit. */
  private attachmentsByText = new Map<string, PromptAttachment[]>();
  private static readonly ATTACHMENTS_CACHE_MAX = 100;
  /** Resolved AttachmentRefs for remote markdown images, keyed by the exact
   *  `https://` URL the markdown referenced — the client-side twin of the
   *  node's inline-image event log (src/session/inline-image-fetch.ts). Filled
   *  from durable history (`foldInlineImageRefs`) and grown live as the node
   *  resolves more (the "inlineImage" case in applyStreamEvent below). Unbounded
   *  like the durable log itself is per-session already bounded by how many
   *  distinct remote images a session's messages actually reference. */
  private inlineImagesByUrl = new Map<string, AttachmentRef>();
  /** Per-session rendered transcript, so switching back paints instantly. */
  private transcriptCache = new Map<string, TranscriptEntry[]>();
  private static readonly CACHE_MAX = 30;
  /** Session ids the user just deleted, kept briefly so an authoritative
   *  full-list refresh that still predates the deletion can't resurrect the row.
   *  In hosted mode `deleteSession` optimistically drops the row but then
   *  immediately re-fetches the control-plane session index, which lags the
   *  node's debounced, best-effort advert — so without this the just-deleted
   *  session reappears and looks like the delete silently failed. Bounded by TTL
   *  so a delete that genuinely failed on the node can't hide a row forever. */
  private recentlyDeleted = new Map<string, number>();
  // Long enough to survive a PWA reload and the node's 60s control-plane
  // reconciliation. A failed delete still self-heals instead of hiding forever.
  private static readonly DELETE_TOMBSTONE_MS = 5 * 60_000;
  /** Per-session raw node messages + history cursor (count + hash), so we can
   *  apply append deltas and echo the cursor for incremental backfill. */
  private historyRaw = new Map<string, { messages: any[]; count: number; historyHash: string }>();
  /** A history snapshot buffered because it arrived mid-turn (focus guard). */
  private deferredHistory: any | null = null;
  /** True from beginOpen until the first canonical history for the just-opened
   *  session lands. The mid-turn deferral (focus guard) must NOT swallow this
   *  initial snapshot: opening an *active* session commonly races a live
   *  message_update that flips `working` true before the snapshot arrives, which
   *  would otherwise defer the open-paint until agent_end (a 5-6s stale/blank
   *  transcript). There's nothing to erase on open — beginOpen just reset the
   *  view — so the first snapshot is always safe to apply; only later
   *  unsolicited mid-turn snapshots need deferring. */
  private awaitingOpenHistory = false;
  /** Persist a session's raw transcript + cursor (wired to IndexedDB by the controller). */
  onHistoryPersist?: (sessionId: string, messages: any[], count: number, historyHash: string) => void;
  /** Ask the controller to replay the live events this client missed for a
   *  session, starting after `afterSeq` — wired to a `session.replay` request.
   *  Ordered live delivery: reassembles the active session's `session.event`
   *  stream and asks for a replay on a detected gap. */
  requestReplay?: (sessionId: string, afterSeq: number) => void;
  // Ordered-reassembly state for the ACTIVE session's live stream. Only the
  // focused session is tracked (its events are the only ones applied); switching
  // focus or crossing a stream epoch (daemon restart) resets it.
  private seqReassembler = new SeqReassembler();
  private seqSessionId?: string;
  private seqEpoch?: string;

  /** (Re)point the reassembler at a session/epoch, resetting on any change. Returns
   *  true when it now tracks (sessionId, epoch). */
  private trackSeqStream(sessionId: string, epoch: unknown): void {
    const ep = typeof epoch === "string" ? epoch : undefined;
    if (this.seqSessionId !== sessionId || this.seqEpoch !== ep) {
      this.seqReassembler.reset();
      this.seqSessionId = sessionId;
      this.seqEpoch = ep;
    }
  }
  /** Ask the controller to re-request canonical history once a live turn settles. */
  requestFreshHistory?: () => void;
  /** A live turn just finished. Wired to refresh the session list — a brand new
   *  or freshly-renamed session may not have been visible in the sidebar until
   *  the node finished naming/persisting it (see agent_end below). */
  onSessionSettled?: () => void;
  /** The node broadcast that *some* client created a session — could be this
   *  one (a `sessions.list` re-request already races the node's own
   *  persistence right after `session.new`; see controller.maybeFlushPendingPrompt)
   *  or another client entirely (the CLI/TUI started with bare `bivy`, or a
   *  second device). Legacy `remote-app.js` handles this broadcast to converge
   *  the drawer immediately instead of waiting for `agent_end`; wired to the
   *  same `refreshSessions()` the controller already uses elsewhere. */
  onSessionCreatedElsewhere?: () => void;

  getState = (): AppState => this.state;

  /** Locally advance the GitHub App flow (used by the client between events). */
  setGithubAppPhase(phase: GithubAppState["phase"], patch: Partial<GithubAppState> = {}): void {
    this.set({ githubApp: { ...(this.state.presentation.githubApp || { phase: "idle" }), phase, ...patch } });
  }

  /** Set the repo-picker Connect-GitHub flow state (optimistic "starting", reset). */
  setGithubConnect(state: GithubConnectState): void {
    this.set({ githubConnect: state });
  }

  /** The append cursor to echo for a session (empty if we have nothing cached). */
  getHistoryCursor(sessionId: string): { have?: number; haveToken?: string } {
    const raw = this.historyRaw.get(sessionId);
    if (raw && raw.count > 0 && raw.historyHash) return { have: raw.count, haveToken: raw.historyHash };
    return {};
  }

  /**
   * Preload a session's transcript from the persistent (IndexedDB) cache so it
   * paints before the node answers. Seeds the raw messages + cursor so the next
   * history request can ask for only the new tail.
   */
  seedHistory(sessionId: string, messages: any[], count: number, historyHash: string): void {
    if (!sessionId || !historyHash || !Array.isArray(messages)) return;
    this.historyRaw.set(sessionId, { messages, count, historyHash });
    const transcript = this.withInlineImageRefs(this.withCachedAttachments(renderHistory(messages)));
    this.cacheTranscript(sessionId, transcript);
    if (this.state.activeSession.activeSessionId === sessionId && this.state.activeSession.transcript.length === 0) {
      this.set({ transcript, opening: false });
    }
  }

  /** A previously-rendered transcript for this session, if cached. */
  getCachedTranscript(sessionId: string): TranscriptEntry[] | undefined {
    return this.transcriptCache.get(sessionId);
  }

  /** Append any optimistic user bubbles the node history doesn't yet represent
   *  onto a transcript built from node history. A pending bubble is suppressed
   *  when the history already contains it — matched by the exact optimistic entry
   *  id, or (once the node has echoed it) by the canonical/raw message text,
   *  count-aware so N identical prompts still reconcile one-for-one. Bubbles are
   *  kept (not dropped on the echo) so a stale or empty history snapshot racing in
   *  before canonical history carries the prompt can't erase the just-sent
   *  message — it's re-appended every replace until real history holds it. */
  private withPendingUserEntries(transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (this.pending.size === 0) return transcript;
    const byId = new Set(transcript.map((e) => e.id));
    // How many user messages of each text the canonical transcript already holds,
    // so each is claimed by at most one pending bubble.
    const available = new Map<string, number>();
    let totalUsers = 0;
    for (const e of transcript) {
      if (e.role === "user") {
        available.set(e.text, (available.get(e.text) || 0) + 1);
        totalUsers += 1;
      }
    }
    const claim = (text: string | undefined): boolean => {
      if (!text) return false;
      const n = available.get(text) || 0;
      if (n <= 0) return false;
      available.set(text, n - 1);
      return true;
    };
    // Pass 1 — exact matches. A bubble whose text the node reproduced verbatim
    // (its composed echo text, or the raw text we rendered) is already in history;
    // retire it so it's neither re-appended nor considered again.
    const unmatched: Array<{ cmid: string; entry: TranscriptEntry; confirmed: boolean }> = [];
    let matchedByText = 0;
    for (const [cmid, p] of this.pending) {
      if (byId.has(p.entry.id)) continue; // the exact optimistic entry is still present
      if (claim(p.confirmedText) || claim(p.entry.text)) {
        // History holds this prompt's text. If the node has also echoed it, it's
        // fully landed — drop it. If not echoed yet, keep it (so its echo is still
        // deduped by cmid) but stop re-appending its bubble.
        if (p.confirmed) this.retirePending(cmid);
        else p.reconciled = true;
        matchedByText += 1;
        continue;
      }
      // History no longer carries it (empty/stale/diverged snapshot) — eligible to
      // be re-appended again below.
      p.reconciled = false;
      unmatched.push({ cmid, entry: p.entry, confirmed: p.confirmed });
    }
    // Pass 2 — count fallback for a *confirmed* bubble the runtime persisted under
    // rewritten text, so no exact match exists. The snapshot holds `totalUsers`
    // user messages; `usersBeforePending` predate this run of sends and
    // `matchedByText` were just attributed, so any remaining canonical slots beyond
    // those must be our confirmed prompts now in history. Retire the oldest such
    // bubbles (send order) rather than re-appending them at the bottom forever.
    // Bubbles the node hasn't confirmed yet (no echo) are always kept — a stale or
    // empty snapshot racing ahead of persistence must never drop the just-sent
    // message (see the repo-clone regression test).
    let reflected = totalUsers - this.usersBeforePending - matchedByText;
    const missing: TranscriptEntry[] = [];
    for (const { cmid, entry, confirmed } of unmatched) {
      if (reflected > 0 && confirmed) {
        reflected -= 1;
        this.retirePending(cmid);
        continue;
      }
      missing.push(entry);
    }
    if (this.pending.size === 0) this.usersBeforePending = 0;
    return missing.length ? [...transcript, ...missing] : transcript;
  }

  /** Drop a resolved optimistic send so its bubble can no longer be re-appended. */
  private retirePending(clientMessageId: string): void {
    this.pending.delete(clientMessageId);
  }

  /** Remember attachments sent with a user message so a later history-based
   *  re-render (which only sees the node's text placeholder) can still show
   *  them. See attachmentsByText for why this is a best-effort, text-matched,
   *  session-local cache rather than something carried in the history data. */
  private rememberAttachments(text: string, attachments: PromptAttachment[]): void {
    if (!text || !attachments.length) return;
    // Re-insert to refresh recency (insertion-ordered Map → oldest evicted).
    this.attachmentsByText.delete(text);
    this.attachmentsByText.set(text, attachments);
    if (this.attachmentsByText.size > SessionStore.ATTACHMENTS_CACHE_MAX) {
      const oldest = this.attachmentsByText.keys().next().value;
      if (oldest !== undefined) this.attachmentsByText.delete(oldest);
    }
  }

  /** The subset of the in-memory attachment cache relevant to a specific
   *  session's raw history — for the controller to persist alongside that
   *  session's transcript cache entry (see packages/core/src/transcript-cache.ts).
   *  Without this, attachmentsByText is memory-only and a reload — routine on
   *  iOS, which kills a backgrounded PWA's JS context — permanently degrades
   *  every attachment sent this session to the node's plain text placeholder. */
  attachmentsForHistory(messages: unknown[]): Array<[string, PromptAttachment[]]> {
    if (this.attachmentsByText.size === 0) return [];
    const out: Array<[string, PromptAttachment[]]> = [];
    for (const entry of renderHistory(messages as any[])) {
      if (entry.role !== "user" || !entry.text) continue;
      const attachments = this.attachmentsByText.get(entry.text);
      if (attachments) out.push([entry.text, attachments]);
    }
    return out;
  }

  /** Merge previously-persisted attachment entries back into the in-memory
   *  cache — call before seedHistory so the seeded transcript re-attaches
   *  real content instead of falling back to the node's text placeholder. */
  restoreAttachments(entries: Array<[string, PromptAttachment[]]> | undefined): void {
    if (!entries || !entries.length) return;
    for (const [text, attachments] of entries) this.rememberAttachments(text, attachments);
  }

  /** Fold the durable attachment references a `session.history` event carries
   *  (text→refs, persisted by the node's event log) into the in-memory cache, so
   *  attachments rehydrate after a reload or on a device that never sent them.
   *  The refs carry no bytes — only a content `hash` the chip resolves lazily via
   *  `controller.fetchAttachment`. A text already cached with real bytes (our own
   *  send this session) is left untouched; refs only ever FILL gaps. */
  foldAttachmentRefs(entries: Array<[string, AttachmentRef[]]> | undefined): void {
    if (!entries || !entries.length) return;
    for (const [text, refs] of entries) {
      if (!text || !refs.length || this.attachmentsByText.has(text)) continue;
      const attachments: PromptAttachment[] = refs.map((r) => ({ kind: r.kind, name: r.name, size: r.size, mimeType: r.mimeType, hash: r.hash }));
      this.rememberAttachments(text, attachments);
    }
  }

  /** Re-attach cached attachments onto matching user entries rebuilt from
   *  node history (which never carries the real attachment data). */
  private withCachedAttachments(transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (this.attachmentsByText.size === 0) return transcript;
    let changed = false;
    const next = transcript.map((e) => {
      if (e.role !== "user" || e.attachments || !e.text) return e;
      const attachments = this.attachmentsByText.get(e.text);
      if (!attachments) return e;
      changed = true;
      return { ...e, attachments };
    });
    return changed ? next : transcript;
  }

  /** Fold the durable url→ref map a `session.history` event carries
   *  (`inlineImageRefs`, persisted by the node's inline-image event log — see
   *  src/session/inline-image-fetch.ts) into the in-memory cache, so a reload
   *  resolves a remote markdown image from the log instead of waiting on a fresh
   *  fetch. Mirrors foldAttachmentRefs; last entry per URL wins (matches the
   *  log's own last-write-wins replay). */
  foldInlineImageRefs(entries: Array<[string, AttachmentRef]> | undefined): void {
    if (!entries || !entries.length) return;
    for (const [url, ref] of entries) {
      if (!url || !ref) continue;
      this.inlineImagesByUrl.set(url, ref);
    }
  }

  /** Attach resolved inline-image refs onto assistant entries whose markdown
   *  references a now-cached URL — see TranscriptEntry.imageRefs. A no-op for a
   *  URL not yet resolved (the placeholder just stays unhydrated until it is). */
  private withInlineImageRefs(transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (this.inlineImagesByUrl.size === 0) return transcript;
    let changed = false;
    const next = transcript.map((e) => {
      if (e.role !== "assistant" || !e.text) return e;
      const urls = extractRemoteImageUrls(e.text);
      if (!urls.length) return e;
      let patch: Record<string, AttachmentRef> | undefined;
      for (const url of urls) {
        const ref = this.inlineImagesByUrl.get(url);
        if (!ref || e.imageRefs?.[url]) continue;
        patch ??= { ...(e.imageRefs ?? {}) };
        patch[url] = ref;
      }
      if (!patch) return e;
      changed = true;
      return { ...e, imageRefs: patch };
    });
    return changed ? next : transcript;
  }

  private cacheTranscript(sessionId: string, transcript: TranscriptEntry[]): void {
    if (!sessionId) return;
    // Re-insert to refresh recency (insertion-ordered Map → oldest evicted).
    this.transcriptCache.delete(sessionId);
    this.transcriptCache.set(sessionId, transcript);
    if (this.transcriptCache.size > SessionStore.CACHE_MAX) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest !== undefined) this.transcriptCache.delete(oldest);
    }
  }

  /**
   * Switch the active session in the UI immediately: paint cached history if we
   * have it, otherwise clear (so the previous session's messages never linger
   * while the fresh history is in flight). The subsequent session.history event
   * reconciles to the canonical transcript.
   */
  beginOpen(sessionId: string): void {
    this.draft = freshDraft();
    this.deferredHistory = null;
    // The next canonical history for this session is the open-paint; let it
    // through the mid-turn focus guard even if a live delta flips `working`
    // first (see awaitingOpenHistory).
    this.awaitingOpenHistory = true;
    this.pending.clear();
    this.usersBeforePending = 0;
    const cached = this.transcriptCache.get(sessionId);
    const known = this.state.sessionIndex.sessions.find((s) => s.sessionId === sessionId);
    this.set({
      activeSessionId: sessionId,
      activeRuntimeId: known?.runtimeId ?? null,
      // The composer is shared by drafts and live sessions. Replace the draft's
      // agent/model paint as soon as an existing row is opened; otherwise the
      // pills keep claiming that this session uses whatever was last selected
      // on the New session screen until the history/models round-trips arrive.
      // The row already has authoritative agent metadata. Model metadata is not
      // part of sessions.list, so show the neutral loading/default state until
      // the session-scoped models.list response supplies the real selection.
      currentAgentName:
        known?.agentName ||
        agentLabel(this.state.catalogs.runtimes.find((r) => r.id === known?.runtimeId)) ||
        "",
      currentModel: null,
      currentModelId: null,
      models: [],
      modelsRuntimeId: known?.runtimeId ?? null,
      // Opening a row is how the user "sees" it — stamp lastSeenAt right away
      // so a finished-but-unseen row's indicator clears the instant they look,
      // rather than waiting on a node round-trip to confirm anything.
      sessions: known
        ? this.state.sessionIndex.sessions.map((s) => (s.sessionId === sessionId ? { ...s, lastSeenAt: Date.now() } : s))
        : this.state.sessionIndex.sessions,
      // Update the header title at once from the row we already know, instead of
      // leaving the previous session's title until session.history lands.
      // applyHistory reconciles to the canonical name when it arrives.
      ...(known?.name ? { activeTitle: known.name } : {}),
      // Same for the GitHub pill: seed it from the row's persisted branch/PR so it
      // shows immediately, rather than staying blank until session.history returns
      // (the "took a little time before it showed" lag). Cleared to empty when we
      // have no row, so a previous session's pill never lingers.
      github: known ? githubFromSummary(known) : { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
      transcript: cached ?? [],
      working: false,
      workingLabel: "",
      // Show a spinner (not the empty-session prompt) until we have something to
      // paint. An in-memory cache hit paints instantly, so opening is already
      // over; otherwise we're waiting on the persistent-cache seed or the node's
      // history round-trip — seedHistory/applyHistory clear this when they land.
      opening: !cached || cached.length === 0,
      // Usage is per-session; clear it until this session's history/usage arrives.
      usage: null,
      // Changes are per-session and per-turn; clear until this session reports.
      changes: null,
      changesHistory: [],
      // Checkpoints are per-session; clear until re-fetched for the new session.
      checkpoints: [],
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: AppStatePatch): void {
    const connection = pickPatch(this.state.connection, next, CONNECTION_FIELDS);
    const sessionIndex = pickPatch(this.state.sessionIndex, next, SESSION_INDEX_FIELDS);
    const activeSession = pickPatch(this.state.activeSession, next, ACTIVE_SESSION_FIELDS);
    const catalogs = pickPatch(this.state.catalogs, next, CATALOG_FIELDS);
    const settings = pickPatch(this.state.settings, next, SETTINGS_FIELDS);
    const presentation = pickPatch(this.state.presentation, next, PRESENTATION_FIELDS);
    this.setValues({
      connection,
      sessionIndex,
      activeSession,
      catalogs,
      settings,
      presentation,
      draft: next.draft ?? this.state.draft,
    });
  }

  /** Install already-folded nested values; identity/subscription is the store's
   * only responsibility after a pure fold has returned data. */
  private setValues(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    // Streaming events can update the store several times in one transport
    // tick (draft text, tool state, working label). Delay only while a turn is
    // active so React subscribers repaint at most once per frame; lifecycle and
    // completed-turn updates remain synchronous.
    if (this.state.activeSession.working) {
      this.scheduleNotify();
      return;
    }
    this.flushNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyPending) return;
    this.notifyPending = true;
    const callback = () => {
      this.notifyPending = false;
      this.notifyHandle = null;
      for (const listener of this.listeners) listener();
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      this.notifyHandle = globalThis.requestAnimationFrame(callback);
    } else {
      this.notifyHandle = setTimeout(callback, 16);
    }
  }

  private flushNotify(): void {
    if (!this.notifyPending) {
      for (const listener of this.listeners) listener();
      return;
    }
    const handle = this.notifyHandle;
    this.notifyPending = false;
    this.notifyHandle = null;
    if (handle !== null) {
      if (typeof globalThis.cancelAnimationFrame === "function" && typeof handle === "number") globalThis.cancelAnimationFrame(handle);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
    for (const listener of this.listeners) listener();
  }

  /**
   * Spread-merge a session's live capabilities onto the matching runtime row in
   * `state.runtimes`. The composer reads runtime-level capabilities from the
   * runtimes list (/api/runtimes → runtimes.list), which never sees a session's
   * refined caps (e.g. modelSelection derived from a shim's hello), so this is
   * how those reach the composer. Live values win, but catalog-only fields
   * (interactiveTui, usageReporting, …) survive. A no-op merge keeps the same
   * array identity, so an idempotent re-broadcast triggers no re-render.
   *
   * `commands` are deliberately NOT merged here: they are workspace/session
   * specific, so folding them onto the shared runtime row let two sessions on the
   * same runtime clobber each other's set. They live in `commandsBySession`
   * instead (see setSessionCommands); the runtime row keeps only whatever static,
   * session-independent commands runtimes.list seeded.
   */
  private mergeRuntimeCapabilities(runtimeId: unknown, capabilities: unknown): void {
    const rid = runtimeId ? String(runtimeId) : "";
    if (!rid || !capabilities || typeof capabilities !== "object") return;
    const idx = this.state.catalogs.runtimes.findIndex((r) => r.id === rid);
    const row = idx >= 0 ? this.state.catalogs.runtimes[idx] : undefined;
    if (!row) return;
    const existing = (row.capabilities as Record<string, unknown> | undefined) || {};
    const incoming = { ...(capabilities as Record<string, unknown>) };
    delete incoming.commands;
    const merged = { ...existing, ...incoming };
    if (JSON.stringify(merged) === JSON.stringify(existing)) return;
    const nextRuntimes = this.state.catalogs.runtimes.slice();
    nextRuntimes[idx] = { ...row, capabilities: merged };
    this.set({ runtimes: nextRuntimes });
  }

  /**
   * Record the agent-native slash commands a specific session advertised (from
   * session.created / session.capabilities), keyed by sessionId so sessions on
   * the same runtime stay isolated. Idempotent: an unchanged set keeps the same
   * map identity so the composer doesn't re-render.
   */
  private setSessionCommands(sessionId: unknown, capabilities: unknown): void {
    const sid = sessionId ? String(sessionId) : "";
    if (!sid) return;
    const caps = capabilities && typeof capabilities === "object" ? (capabilities as Record<string, unknown>) : undefined;
    const commands = normalizeAgentCommands(caps?.commands);
    const prev = this.state.sessionIndex.commandsBySession[sid] ?? [];
    if (sameCommandList(prev, commands)) return;
    const next = { ...this.state.sessionIndex.commandsBySession };
    if (commands.length) next[sid] = commands;
    else delete next[sid];
    this.set({ commandsBySession: next });
  }

  /** Forget a session's advertised commands (on delete). Keeps the map from
   *  growing unbounded across a long-lived client and stops a stale set lingering. */
  private dropSessionCommands(sessionId: string): void {
    if (!(sessionId in this.state.sessionIndex.commandsBySession)) return;
    const next = { ...this.state.sessionIndex.commandsBySession };
    delete next[sessionId];
    this.set({ commandsBySession: next });
  }

  // --- Queued follow-ups (issue #154) -------------------------------------
  // The queue is immutable data reduced by followup-queue.ts. This store is
  // only the identity/subscription shell that installs the returned value.

  getFollowups(sessionId: string): PendingFollowup[] {
    return this.state.sessionIndex.followupsBySession[sessionId] ?? [];
  }

  private setFollowupsFor(sessionId: string, list: readonly PendingFollowup[]): void {
    const next = { ...this.state.sessionIndex.followupsBySession };
    if (list.length) next[sessionId] = [...list];
    else delete next[sessionId];
    this.set({ followupsBySession: next });
  }

  private transitionFollowups(sessionId: string, command: FollowupQueueCommand): FollowupQueueTransition {
    const transition = reduceFollowupQueue(this.getFollowups(sessionId), command);
    if (transition.changed) this.setFollowupsFor(sessionId, transition.queue);
    return transition;
  }

  enqueueFollowup(sessionId: string, item: { id: string; text: string; attachments?: PromptAttachment[]; scheduledAutomationId?: string }, now: number): PendingFollowup {
    return this.transitionFollowups(sessionId, { type: "enqueue", item, now }).item!;
  }

  enqueueScheduledFollowup(sessionId: string, item: { id: string; text: string; scheduledAt: number; scheduledAutomationId: string }, now: number): PendingFollowup {
    return this.transitionFollowups(sessionId, { type: "schedule", item, now }).item!;
  }

  attachFollowupAutomation(sessionId: string, id: string, automationId: string): boolean {
    return this.transitionFollowups(sessionId, { type: "attach-automation", id, automationId }).accepted === true;
  }

  editFollowup(
    sessionId: string,
    id: string,
    patch: { text: string; attachments?: PromptAttachment[] },
    expectedVersion: number,
    now: number,
  ): FollowupEditResult {
    return this.transitionFollowups(sessionId, { type: "edit", id, patch, expectedVersion, now }).edit!;
  }

  removeFollowup(sessionId: string, id: string): boolean {
    return this.transitionFollowups(sessionId, { type: "remove", id }).accepted === true;
  }

  pruneScheduledFollowups(sessionId: string, keepIds: ReadonlySet<string>): void {
    this.transitionFollowups(sessionId, { type: "prune-scheduled", keepIds: [...keepIds] });
  }

  rescheduleFollowup(sessionId: string, id: string, scheduledAt: number, now: number): boolean {
    return this.transitionFollowups(sessionId, { type: "reschedule", id, scheduledAt, now }).accepted === true;
  }

  reorderFollowup(sessionId: string, id: string, toIndex: number): boolean {
    return this.transitionFollowups(sessionId, { type: "reorder", id, toIndex }).accepted === true;
  }

  markFollowupSending(sessionId: string, id: string, now: number): PendingFollowup | undefined {
    return this.transitionFollowups(sessionId, { type: "mark-sending", id, now }).item;
  }

  confirmFollowupSent(sessionId: string, id: string): void {
    this.transitionFollowups(sessionId, { type: "confirm-sent", id });
  }

  revertFollowupToQueued(sessionId: string, id: string, now: number): void {
    this.transitionFollowups(sessionId, { type: "revert-to-queued", id, now });
  }

  settleSendingFollowups(sessionId: string): void {
    this.transitionFollowups(sessionId, { type: "settle-sending" });
  }

  dropFollowups(sessionId: string): void {
    if (sessionId in this.state.sessionIndex.followupsBySession) {
      this.transitionFollowups(sessionId, { type: "clear" });
    }
  }

  setStatus(status: ConnectionStatus): void {
    if (status === this.state.connection.status) return;
    const currentNodeId = this.state.connection.currentNodeId;
    // The live transport is more authoritative for the selected node than a
    // possibly-racing /nodes snapshot. In particular, first install can fetch
    // the registry while the relay's online write is still in flight; once this
    // socket reaches online, paint the node online immediately rather than
    // leaving it grey until the user manually re-selects it.
    // Only the positive signal is authoritative: `offline` can also mean this
    // browser intentionally closed its transport while switching nodes, which
    // says nothing about whether the old node daemon is still connected.
    this.set({
      status,
      ...(currentNodeId && status === "online"
        ? { nodes: this.state.connection.nodes.map((node) => node.id === currentNodeId ? { ...node, online: true } : node) }
        : {}),
    });
  }

  /** Reflect whether a control-plane session token is held. Drives the reactive
   *  auth gate so signing in (or out) swaps the sign-in screen and the app shell
   *  without a full page reload. */
  setSignedIn(signedIn: boolean): void {
    if (signedIn !== this.state.connection.signedIn) this.set({ signedIn });
  }

  setNodes(nodes: AccountNode[]): void {
    // A control-plane list can race just behind the relay connection that made
    // the current transport online. Preserve the stronger live signal so a late
    // `{ online:false }` response cannot regress the selected node's dot.
    const currentNodeId = this.state.connection.currentNodeId;
    this.set({
      nodes: currentNodeId && this.state.connection.status === "online"
        ? nodes.map((node) => node.id === currentNodeId ? { ...node, online: true } : node)
        : nodes,
    });
  }

  /**
   * Replace the session list from a raw (unknown) list payload. The single
   * writer for `state.sessions` from a full list: the `sessions.list` reducer
   * case AND the controller's account/all-node refreshes route through here
   * rather than each fabricating a synthetic `sessions.list` event to round-trip
   * through the reducer. Preserves each row's client-local lastSeenAt/finishedAt
   * across the refresh (the node has no notion of them — normalizeSessions
   * carries them over), and re-stamps the active row as seen so a periodic
   * refresh landing while the user has it open doesn't surface it as "unseen"
   * just because the row object was rebuilt from scratch.
   */
  setSessions(list: unknown): void {
    const sessions = this.withoutRecentlyDeleted(normalizeSessions(list, this.state.sessionIndex.sessions));
    const ids = new Set(sessions.map((s) => s.sessionId));
    const pending = this.state.sessionIndex.sessions.filter((s) => s.pendingLaunch && !ids.has(s.sessionId));
    const merged = [...pending, ...sessions];
    const activeId = this.state.activeSession.activeSessionId;
    this.set({
      sessions: activeId
        ? merged.map((s) => (s.sessionId === activeId ? { ...s, lastSeenAt: Date.now() } : s))
        : merged,
    });
  }

  /**
   * Paint the sidebar from a locally cached session list for an instant first
   * render, before the node's authoritative `sessions.list` round-trip lands.
   * A no-op once any live list exists (`sessions.length > 0`), so a slow/late
   * cache read can never clobber fresher data, and the normal `sessions.list`
   * reducer overwrites this the moment the node answers.
   */
  seedSessions(list: unknown): void {
    if (this.state.sessionIndex.sessions.length > 0) return;
    const sessions = this.withoutRecentlyDeleted(normalizeSessions(list, this.state.sessionIndex.sessions));
    if (sessions.length === 0) return;
    this.set({ sessions });
  }

  setCurrentNode(nodeId: string | null): void {
    this.set({ currentNodeId: nodeId });
  }

  /** Clear per-node/session state when switching nodes so transcripts never blend.
   *  Deliberately leaves `sessions` and `runTerminals` untouched — both are
   *  unified, all-node sidebar lists (see controller.switchNode's
   *  eventWithNodeScope merge), not the previous node's local state, so wiping
   *  them here would make the sidebar flash/narrow to whichever node answers
   *  first instead of always showing every node's sessions (issue #99). */
  resetSession(): void {
    this.draft = freshDraft();
    this.pending.clear();
    this.usersBeforePending = 0;
    this.set({
      activeSessionId: null,
      activeRuntimeId: null,
      activeTitle: "New session",
      github: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
      transcript: [],
      working: false,
      workingLabel: "",
      opening: false,
      approvals: [],
      questions: [],
      turnAttentions: [],
      // Per-session display state must not blend across nodes either.
      usage: null,
      changes: null,
      changesHistory: [],
      checkpoints: [],
      // Advertised commands are per session on the previous node; never carry
      // them across a node switch.
      commandsBySession: {},
      // Queued follow-ups are per session on the previous node too — a session
      // id could even collide across nodes, so carrying this over risks
      // "delivering" a queued prompt into an unrelated session on the new node.
      followupsBySession: {},
      error: null,
      notice: null,
      // First-run model-auth prompt is scoped to a specific runner; a node
      // switch means it no longer applies to whatever we're now looking at.
      needsModelAuth: null,
      // A node switch (incl. binding a freshly-launched ephemeral runner) means
      // the "launch this runner on first send" intent is spent/irrelevant.
      draft: reduceSessionDraft(this.state.draft, { type: "select-ephemeral-config", config: null }),
      // Per-node settings (name, default agent/model, GitHub prompt, sync
      // config, …) must never survive a switch — otherwise a still-editable
      // form can keep showing the *previous* node's settings under the
      // newly-selected node, e.g. while the new one is offline and never
      // answers `node.settings.get` to overwrite it.
      nodeSettings: null,
    });
  }

  setError(message: string, actions: Array<{ id: string; label: string; kind?: "primary" | "secondary" }> = []): void {
    this.set({ error: message, errorActions: message ? actions : [] });
  }

  /** Show (or clear, with "") a transient success/confirmation banner. */
  setNotice(message: string): void {
    this.set({ notice: message });
  }

  /** Optimistically mark the node as updating the moment the user taps the
   *  banner button, so it can't be tapped twice while the request is in flight. */
  setNodeUpdating(value: boolean): void {
    this.set({ nodeUpdating: value });
  }

  /** Set (or clear, with null) the first-run "sign in to your model" prompt for a
   *  freshly-launched ephemeral runner. See `AppState.needsModelAuth`. */
  setNeedsModelAuth(v: { nodeId: string; provider: string; reason?: string } | null): void {
    this.set({ needsModelAuth: v });
  }

  /** Append a local system message to the active transcript (client-only, not
   *  persisted on the node) — used for slash-command feedback like `/help`. */
  pushSystemMessage(text: string): void {
    this.pushEntry({ id: nextId(), role: "system", text });
  }

  /** Consume the transient Open-PR result once the UI has shown it. */
  clearPrResult(): void {
    if (this.state.presentation.prResult) this.set({ prResult: null });
  }

  /** Consume the transient "refresh all GitHub statuses" result once shown. */
  clearPrRefreshAllResult(): void {
    if (this.state.presentation.prRefreshAllResult) this.set({ prRefreshAllResult: null });
  }

  setReposLoading(loading: boolean): void {
    this.set({ reposLoading: loading });
  }

  private updateSessionDraft(command: SessionDraftCommand): SessionDraft {
    const draft = reduceSessionDraft(this.state.draft, command);
    this.set({ draft });
    return draft;
  }

  /** Pick (or clear) the ephemeral runner the next session launches on. */
  setDraftEphemeralConfig(config: EphemeralNodeConfig | null): void {
    this.updateSessionDraft({ type: "select-ephemeral-config", config });
  }

  setDraftRepo(slug: string | null): void {
    this.updateSessionDraft({ type: "select-repository", repo: slug });
  }

  setBranchesLoading(loading: boolean): void {
    this.set({ branchesLoading: loading });
  }

  /** Drop the branch list (and any picked branch) — called whenever `draft.repo`
   *  changes, so the branch pill never shows the previous repo's branches (or a
   *  picked branch that belongs to it) while the new repo's list loads. */
  clearBranches(): void {
    this.set({
      branches: [],
      branchesRepo: null,
      branchesDefault: null,
      branchesError: null,
      branchesLoading: false,
      draft: reduceSessionDraft(this.state.draft, { type: "select-branch", branch: null }),
    });
  }

  /** Remote branch chosen for the next new session (null = the repo's default branch). */
  setDraftBranch(name: string | null): void {
    this.updateSessionDraft({ type: "select-branch", branch: name });
  }

  /** Sandbox tier chosen for the next new session (null = use the node default). */
  setDraftSandbox(tier: SandboxTier | null): void {
    this.updateSessionDraft({ type: "select-sandbox", sandbox: tier });
  }

  setDraftAcknowledgeReducedProtections(value: boolean): void {
    this.updateSessionDraft({ type: "acknowledge-reduced-protections", acknowledged: value });
  }

  /** Remember the user's last-used model so the next fresh draft defaults to it
   *  (see the draftModel field). Purely a preference — the models.list reducer
   *  resolves it against what the runtime actually supports before it ever
   *  reaches the composer. */
  setDraftModel(model: { provider?: string; id: string } | null): void {
    this.draftModel = model;
  }

  /**
   * Eagerly reflect a fresh draft's agent + model into the composer pills from
   * the runtime/model lists we already hold (from the connect-time burst), so a
   * new session shows the *actual* agent and model straight away instead of the
   * bare "Agent"/"Default" placeholders while the runtimes.list/models.list
   * round-trips this draft kicks off are still in flight. resetActiveSession
   * deliberately blanks the agent pill (it must not linger on the previously
   * viewed session's agent); without this the pill sat on "Agent"/"Default" until
   * the network answered — long enough to notice on a slow link, and the whole
   * point of the round-trip below is only to *refine* these, not to originate
   * them. No-op once a session is live (its own agent/model are authoritative)
   * or when the lists aren't loaded yet (the burst reducers populate them then).
   */
  seedDraftAgentModel(agentId: string | null | undefined, model: { provider?: string; id: string } | null): void {
    if (this.state.activeSession.activeSessionId) return;
    const next: AppStatePatch = {};
    // Agent: the remembered pick if this node offers it and it's installed/ready,
    // else the runtime the node flags as current (its default for a new session).
    const available = (r: RuntimeInfo) => String((r as any).status || "available") === "available";
    const remembered = agentId ? this.state.catalogs.runtimes.find((r) => r.id === agentId && available(r)) : undefined;
    const defaultRuntime = this.state.catalogs.runtimes.find((r) => (r as any).current && available(r));
    const agent = remembered || defaultRuntime;
    if (agent) {
      const label = agentLabel(agent);
      next.selectedAgentId = agent.id;
      if (label) next.currentAgentName = label;
    }
    // Model: only paint from the held models list if it was resolved for the
    // agent we're seeding. A list belonging to a *different* agent (e.g. Codex's
    // GPT models still in state right after switching to Claude) must not seed
    // the new agent's model pill — that's the "Claude shows a Codex/GPT model"
    // bug. When the list is for another runtime, blank the model to a loading
    // state; the models.list refresh this draft kicks off for the new agent
    // (via runtime.select → runtime.updated → listModels) repopulates it. A null
    // modelsRuntimeId means "unknown" (older node, or the very first list before
    // any agent was selected) — trust it, preserving the pre-scoping behavior.
    const listMatchesAgent = agent ? this.state.catalogs.modelsRuntimeId == null || this.state.catalogs.modelsRuntimeId === agent.id : true;
    if (listMatchesAgent) {
      const rememberedModel = model ? this.state.catalogs.models.find((m) => sameModel(m, model as ModelInfo)) : undefined;
      const defaultModel = this.state.catalogs.models.find((m) => (m as any).current);
      const chosen = rememberedModel || defaultModel;
      if (chosen) {
        next.currentModel = chosen;
        next.currentModelId = chosen.id;
      }
    } else {
      next.models = [];
      next.modelsRuntimeId = null;
      next.currentModel = null;
      next.currentModelId = null;
    }
    if (Object.keys(next).length) this.set(next);
  }

  /** Optimistically reflect a model pick before the node confirms. */
  setCurrentModelLocal(model: ModelInfo): void {
    this.set({
      currentModel: model,
      currentModelId: model.id,
      models: this.state.catalogs.models.map((m) => ({ ...m, current: sameModel(m, model) })),
    });
  }

  /** Optimistically reflect an agent pick before runtime.updated arrives. */
  setSelectedAgentLocal(id: string): void {
    const rt = this.state.catalogs.runtimes.find((a) => a.id === id);
    // A prior agent's reduced-protections acknowledgement must never silently
    // carry over to a different one — always re-confirm on switch.
    const next: AppStatePatch = {
      selectedAgentId: id,
      currentAgentName: agentLabel(rt) || this.state.catalogs.currentAgentName,
      draft: reduceSessionDraft(this.state.draft, { type: "acknowledge-reduced-protections", acknowledged: false }),
    };
    // Only touch the model list when the held one belongs to a *different*
    // runtime; a null (unknown) id is left for the refresh to overwrite so we
    // don't needlessly blank a still-valid pill.
    if (this.state.catalogs.modelsRuntimeId != null && this.state.catalogs.modelsRuntimeId !== id) {
      const cached = this.modelsByRuntime.get(id);
      if (cached) {
        // Switching back to an agent already viewed this session: repaint its
        // last-known models instantly so the pill/picker never flash empty. The
        // node's fresh models.list still refines this (stale-while-revalidate).
        next.models = cached.models;
        next.modelsRuntimeId = id;
        next.currentModel = cached.currentModel;
        next.currentModelId = cached.currentModel?.id ?? null;
      } else {
        // First switch to this agent — drop the outgoing agent's models so the
        // pill/picker don't keep showing them (e.g. Codex's GPT under Claude) in
        // the window before this agent's models.list refresh lands.
        next.models = [];
        next.modelsRuntimeId = null;
        next.currentModel = null;
        next.currentModelId = null;
      }
    }
    this.set(next);
  }

  setInstalling(id: string | null): void {
    this.set({ installingRuntimeId: id });
  }

  /** Optimistically move the reasoning level before the node confirms. */
  setThinkingLevel(level: string): void {
    this.set({ thinking: { ...this.state.catalogs.thinking, thinkingLevel: level } });
  }

  /** Drop the active session/transcript (e.g. starting a new draft), keeping
   *  the session list, nodes, models and runtimes intact. */
  resetActiveSession(): void {
    this.draft = freshDraft();
    this.pending.clear();
    this.usersBeforePending = 0;
    this.set({
      activeSessionId: null,
      activeRuntimeId: null,
      activeTitle: "New session",
      github: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
      transcript: [],
      working: false,
      workingLabel: "",
      opening: false,
      approvals: [],
      questions: [],
      turnAttentions: [],
      // A fresh draft must not keep showing whichever agent the *previously
      // viewed* session happened to be running — currentAgentName/selectedAgentId
      // otherwise just carry over from that session's applyHistory (or a stale
      // runtimes.list push) and the composer's agent pill lies about what a new
      // session will actually start with. Clear them; the controller re-fetches
      // runtimes.list right after this to repopulate the node's real default.
      selectedAgentId: null,
      currentAgentName: "",
      // Usage/changes/checkpoints are per-session. Clear them like beginOpen()
      // does, else a fresh draft keeps showing the previously viewed session's
      // cost/token usage bar (and stale changes/checkpoints) before the new
      // session has done anything at all.
      usage: null,
      changes: null,
      changesHistory: [],
      checkpoints: [],
      // A brand-new draft hasn't picked an ephemeral runner yet.
      draft: reduceSessionDraft(this.state.draft, { type: "select-ephemeral-config", config: null }),
    });
  }

  /** Materialize a first-message draft in the sidebar before its node is ready.
   *  Ephemeral cold starts can take minutes; giving the draft a stable local id
   *  lets the user leave it running and start another session without discarding
   *  the launch. The controller replaces this row with the node's canonical id
   *  as soon as session.new completes. */
  persistPendingSession(sessionId: string, name: string, activate = true, pendingNodeName?: string): void {
    const existing = this.state.sessionIndex.sessions.find((s) => s.sessionId === sessionId);
    const row: SessionSummary = {
      ...existing,
      sessionId,
      name: name.trim() || existing?.name || "New session",
      status: existing?.status === "failed" ? "failed" : "working",
      pendingLaunch: true,
      pendingNodeName: pendingNodeName || existing?.pendingNodeName,
      updatedAt: existing?.updatedAt || Date.now(),
    };
    this.set({
      ...(activate ? { activeSessionId: sessionId, activeTitle: row.name } : {}),
      sessions: [row, ...this.state.sessionIndex.sessions.filter((s) => s.sessionId !== sessionId)],
    });
  }

  retryPendingSession(sessionId: string): void {
    this.set({ sessions: this.state.sessionIndex.sessions.map((s) => s.sessionId === sessionId ? { ...s, status: "working", updatedAt: Date.now() } : s) });
  }

  dismissPendingSession(sessionId: string): void {
    this.set({
      activeSessionId: this.state.activeSession.activeSessionId === sessionId ? null : this.state.activeSession.activeSessionId,
      sessions: this.state.sessionIndex.sessions.filter((s) => s.sessionId !== sessionId),
    });
  }

  /** Add provider routing to a pending row once provisioning returns a node id. */
  bindPendingSessionNode(sessionId: string, nodeId: string): void {
    this.set({ sessions: this.state.sessionIndex.sessions.map((s) => s.sessionId === sessionId ? { ...s, nodeId } : s) });
  }

  /** Replace a cold-start placeholder with the node's canonical session. */
  completePendingSession(pendingId: string, sessionId: string, nodeId: string): void {
    const pending = this.state.sessionIndex.sessions.find((s) => s.sessionId === pendingId);
    const row: SessionSummary = {
      ...pending,
      sessionId,
      nodeId,
      name: pending?.name || "New session",
      status: "working",
      pendingLaunch: false,
      pendingNodeName: undefined,
      updatedAt: Date.now(),
    };
    this.set({
      activeSessionId: this.state.activeSession.activeSessionId === pendingId ? sessionId : this.state.activeSession.activeSessionId,
      sessions: [row, ...this.state.sessionIndex.sessions.filter((s) => s.sessionId !== pendingId && s.sessionId !== sessionId)],
    });
  }

  /** Keep a failed cold start visible and clearly settled so its setup log can
   *  still be opened, instead of leaving an endless working spinner. */
  failPendingSession(sessionId: string): void {
    this.set({ sessions: this.state.sessionIndex.sessions.map((s) => s.sessionId === sessionId ? { ...s, status: "failed" } : s) });
  }

  setActiveTitle(name: string): void {
    this.set({ activeTitle: name });
  }

  /** Optimistically rename a session-list row before the node confirms. */
  renameSessionLocal(sessionId: string, name: string): void {
    this.set({ sessions: this.state.sessionIndex.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)) });
  }

  /** Restore deletion guards persisted by a view layer across a PWA reload. */
  seedDeletedSessionTombstones(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [id, rawAt] of Object.entries(value as Record<string, unknown>)) {
      const at = Number(rawAt);
      if (id && Number.isFinite(at)) this.recentlyDeleted.set(id, at);
    }
    this.pruneDeletedSessionTombstones();
  }

  /** Serializable deletion guards for the view layer's local durable cache. */
  deletedSessionTombstones(): Record<string, number> {
    this.pruneDeletedSessionTombstones();
    return Object.fromEntries(this.recentlyDeleted);
  }

  /** Optimistically drop a session-list row before the node's fresh list arrives. */
  removeSessionLocal(sessionId: string): void {
    // Tombstone the id so a full-list refresh that still predates the deletion
    // (the control-plane index lags the node's debounced advert) can't add it
    // back — see setSessions / recentlyDeleted.
    this.recentlyDeleted.set(sessionId, Date.now());
    this.set({ sessions: this.state.sessionIndex.sessions.filter((s) => s.sessionId !== sessionId) });
  }

  private pruneDeletedSessionTombstones(): void {
    const now = Date.now();
    for (const [id, at] of this.recentlyDeleted) {
      if (now - at > SessionStore.DELETE_TOMBSTONE_MS) this.recentlyDeleted.delete(id);
    }
  }

  /** Drop rows the user just deleted, pruning expired tombstones as we go, so a
   *  stale authoritative list can't resurrect a just-deleted session. */
  private withoutRecentlyDeleted(sessions: SessionSummary[]): SessionSummary[] {
    if (this.recentlyDeleted.size === 0) return sessions;
    this.pruneDeletedSessionTombstones();
    if (this.recentlyDeleted.size === 0) return sessions;
    return sessions.filter((s) => !this.recentlyDeleted.has(s.sessionId));
  }

  /** Insert or merge a single session-list row (from a `session.created`
   *  broadcast) so a session started anywhere shows in the sidebar immediately,
   *  ahead of the authoritative `sessions.list` reconcile. Merges onto an
   *  existing row so we never clobber a name/status the list already carried. */
  private upsertSession(summary: SessionSummary): void {
    if (!summary.sessionId) return;
    const existing = this.state.sessionIndex.sessions.find((s) => s.sessionId === summary.sessionId);
    if (existing) {
      const merged: SessionSummary = {
        ...existing,
        ...Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined && v !== "")),
      };
      this.set({ sessions: this.state.sessionIndex.sessions.map((s) => (s.sessionId === summary.sessionId ? merged : s)) });
    } else {
      this.set({ sessions: [summary, ...this.state.sessionIndex.sessions] });
    }
  }

  /** Local optimistic echo of a user prompt. Remember its clientMessageId so the
   *  node's session.user_message echo for the same prompt is deduplicated, and
   *  remember any attachments (by text) so they survive a later history-based
   *  re-render — see attachmentsByText. */
  addUserMessage(text: string, clientMessageId?: string, attachments?: PromptAttachment[]): void {
    const entry: TranscriptEntry = {
      id: nextId(),
      role: "user",
      text,
      html: toHtml(text),
      ...(attachments && attachments.length ? { attachments } : {}),
    };
    if (clientMessageId) {
      // Starting a fresh run of optimistic sends — snapshot how many canonical
      // user messages exist right now (the queue is empty, so every user bubble on
      // screen is already node-confirmed history). withPendingUserEntries measures
      // history's catch-up against this baseline. Captured before the entry is
      // queued so it counts only prior, settled messages.
      if (this.pending.size === 0) {
        this.usersBeforePending = this.state.activeSession.transcript.reduce((n, e) => (e.role === "user" ? n + 1 : n), 0);
      }
      // Hold onto it (unconfirmed) so a session.new's empty history — or any full
      // replace that races ahead of the node persisting this prompt — can't erase
      // it, and so the node's own echo of this prompt is deduped by cmid.
      this.pending.set(clientMessageId, { entry, confirmed: false });
    }
    if (attachments && attachments.length) this.rememberAttachments(text, attachments);
    this.set({ transcript: [...this.state.activeSession.transcript, entry] });
    // Sending a message is the clearest possible "this is now the most recently
    // active session" signal — bump it right away rather than waiting on the
    // round trip through session.event, so the sidebar reorders the instant you
    // hit send instead of only once the agent's turn starts streaming back.
    if (this.state.activeSession.activeSessionId) this.updateSessionRow(this.state.activeSession.activeSessionId, { updatedAt: Date.now() });
  }

  apply(event: ServerEvent): void {
    const type = String(event.type || "");

    const connectionFold = foldConnectionEvent(this.state.connection, event);
    if (connectionFold.handled) {
      this.setValues({
        connection: connectionFold.value,
        ...(connectionFold.error ? { presentation: { ...this.state.presentation, error: connectionFold.error } } : {}),
      });
      return;
    }
    const indexFold = foldSessionIndexEvent(this.state.sessionIndex, event);
    if (indexFold.handled) {
      if (indexFold.value !== this.state.sessionIndex) {
        this.setValues({ sessionIndex: { ...this.state.sessionIndex, pausedSessionIds: [...indexFold.value.pausedSessionIds] } });
      }
      return;
    }
    const terminalFold = foldTerminalEvent({
      runTerminals: this.state.sessionIndex.runTerminals,
      tuiSessions: this.state.sessionIndex.tuiSessions,
    }, event, Date.now());
    if (terminalFold.handled) {
      this.set({
        runTerminals: [...terminalFold.value.runTerminals],
        tuiSessions: [...terminalFold.value.tuiSessions],
      });
      return;
    }
    const catalogSettingsFold = foldCatalogSettingsEvent(event);
    if (catalogSettingsFold.handled) {
      if (catalogSettingsFold.catalogs || catalogSettingsFold.settings) {
        this.setValues({
          ...(catalogSettingsFold.catalogs ? { catalogs: { ...this.state.catalogs, ...catalogSettingsFold.catalogs } as CatalogState } : {}),
          ...(catalogSettingsFold.settings ? { settings: { ...this.state.settings, ...catalogSettingsFold.settings } as SettingsState } : {}),
        });
      }
      return;
    }
    const presentationFold = foldPresentationEvent(this.state.presentation, event);
    if (presentationFold.handled) {
      this.setValues({ presentation: presentationFold.value as PresentationState });
      return;
    }
    const attentionFold = foldAttentionEvent({
      approvals: this.state.activeSession.approvals,
      questions: this.state.activeSession.questions,
      turnAttentions: this.state.activeSession.turnAttentions,
    }, event, Date.now());
    if (attentionFold.handled) {
      this.set({
        approvals: attentionFold.value.approvals as ApprovalRequest[],
        questions: attentionFold.value.questions as UserQuestionRequest[],
        turnAttentions: attentionFold.value.turnAttentions as TurnAttentionRequest[],
      });
      if (attentionFold.row) this.updateSessionRow(attentionFold.row.sessionId, attentionFold.row);
      return;
    }
    const activeFold = foldActiveSessionEvent({
      activeSessionId: this.state.activeSession.activeSessionId,
      working: this.state.activeSession.working,
      workingLabel: this.state.activeSession.workingLabel,
      opening: this.state.activeSession.opening,
      usage: this.state.activeSession.usage,
      changes: this.state.activeSession.changes,
      changesHistory: this.state.activeSession.changesHistory,
      checkpoints: this.state.activeSession.checkpoints,
      activeTitle: this.state.activeSession.activeTitle,
      github: this.state.activeSession.github as unknown as Record<string, unknown>,
      ...(type === "session.changes" ? { newChangeId: nextId() } : {}),
    }, event, Date.now());
    if (activeFold.handled) {
      if (activeFold.patch) this.set(activeFold.patch as AppStatePatch);
      for (const command of activeFold.commands) {
        if (command.kind === "row") this.updateSessionRow(command.sessionId, command.patch);
        else if (command.kind === "entry") this.pushEntry({ id: nextId(), role: command.role, text: command.text, ...(command.action ? { action: command.action } : {}) });
        else if (command.kind === "model-auth" && this.state.connection.currentNodeId) this.setNeedsModelAuth({ nodeId: this.state.connection.currentNodeId, provider: command.provider, reason: command.reason });
        else if (command.kind === "rename") this.renameSessionLocal(command.sessionId, command.name);
        else if (command.kind === "global-error") this.set({ error: command.message });
        else if (command.kind === "reset-active") this.resetActiveSession();
      }
      return;
    }

    this.applyStatefulEvent(event, type);
  }

  /** Stateful transcript/cache fold kept behind the pure value-fold pipeline.
   * These events need shell-owned optimistic-send and history identities. */
  private applyStatefulEvent(event: ServerEvent, type: string): void {
    switch (type) {
      case "sessions.list": {
        this.setSessions((event as any).sessions);
        return;
      }
      case "session.created": {
        // A session can be created by any client on this node — the terminal TUI
        // started with bare `bivy`, another device, or this client's own
        // session.new racing the node's persistence of it. Upsert the row so the
        // sidebar converges immediately (without stealing the current focus), and
        // fire onSessionCreatedElsewhere so the controller re-pulls the
        // authoritative list. Mirrors the legacy client's session.created handler.
        const e = event as any;
        const sid = String(e.sessionId || e.id || "");
        if (sid) {
          const known = this.state.sessionIndex.sessions.find((s) => s.sessionId === sid);
          const sessionState = normalizeSessionState(e.sessionState ?? e.bivySession?.state);
          this.upsertSession({
            sessionId: sid,
            path: e.sessionFile || e.path,
            workspace: e.workspace || e.bivySession?.workspace,
            worktree: e.worktree || e.bivySession?.worktree || e.bivySession?.workspaceContext?.worktree,
            branch: e.branch || e.bivySession?.branch,
            // Default the name/last-active only for a genuinely NEW row. A
            // session merely being (re)opened re-broadcasts session.created with
            // no fresh timestamp; falling back to "Untitled session"/Date.now()
            // for a row we already know would wipe its real title and reorder it
            // to the top as if it were just active (the reported "opens as
            // Untitled and jumps to recently-active" bug). upsertSession drops
            // undefined values, so an existing row keeps what it already had.
            name: e.name || (known ? undefined : "Untitled session"),
            source: e.source,
            nodeId: e.nodeId,
            runtimeId: e.runtimeId,
            agentName: e.agentName,
            // A brand-new session has no node-side modified time yet — default to
            // now rather than leaving this undefined, which sorted the row to the
            // very bottom of the sidebar (0 < every real timestamp) until the next
            // full sessions.list refresh caught up (see SessionList's toMs/sort).
            updatedAt: e.updatedAt || e.modified || (known ? undefined : Date.now()),
            status: sessionStatusFromState(sessionState) ?? "idle",
            sessionState,
            needsAction: sessionState?.displayStatus === "needs_attention" ? true : false,
          });
        }
        // Fold the live runtime's refined capabilities (e.g. modelSelection from
        // the agent's handshake) onto the matching catalog runtime row. The
        // session's own slash commands are stored per session (below) rather than
        // on the shared row, so two sessions on one runtime stay isolated.
        this.mergeRuntimeCapabilities(e.runtimeId, e.capabilities);
        if (sid) this.setSessionCommands(sid, e.capabilities);
        this.onSessionCreatedElsewhere?.();
        return;
      }
      case "session.capabilities": {
        // A session's capabilities changed after it opened — e.g. Claude Code's
        // slash commands, which the SDK only reports once the first turn's
        // system/init lands (after session.created has already gone out). Store
        // the commands against this session so the composer's autocomplete catches
        // up for the active session only; fold any other refined caps onto the row.
        const e = event as any;
        this.mergeRuntimeCapabilities(e.runtimeId, e.capabilities);
        this.setSessionCommands(e.sessionId, e.capabilities);
        return;
      }
      case "session.deleted": {
        const e = event as any;
        const sid = String(e.sessionId || "");
        const file = e.sessionFile as string | undefined;
        // Deletions initiated by another client/prune need the same stale-list
        // protection as this client's optimistic delete.
        if (sid) this.recentlyDeleted.set(sid, Date.now());
        this.set({
          sessions: this.state.sessionIndex.sessions.filter(
            (s) => s.sessionId !== sid && (!file || s.path !== file),
          ),
        });
        if (sid) this.dropSessionCommands(sid);
        if (sid) this.dropFollowups(sid);
        if (sid) this.knownAgentAttachmentsBySession.delete(sid);
        if (sid && sid === this.state.activeSession.activeSessionId) this.resetActiveSession();
        return;
      }
      case "session.history": {
        const e = event as any;
        const sessionId = (e.sessionId as string) || this.state.activeSession.activeSessionId;
        // Focus arbitration: applying a snapshot captured mid-turn erases the
        // output the live stream just rendered. While a turn is streaming into
        // the focused session, buffer the snapshot; agent_end drops it and
        // re-requests fresh canonical history (self-healing via the cursor).
        // Exception: the FIRST snapshot after beginOpen is the open-paint — there
        // is no live output to erase yet (beginOpen just reset the view), and an
        // active session's open commonly races a message_update that flips
        // `working` true before this lands. Deferring it there would blank the
        // transcript until agent_end, so let the open snapshot through.
        if (
          sessionId &&
          sessionId === this.state.activeSession.activeSessionId &&
          this.state.activeSession.working &&
          !this.draft.finalized &&
          !this.awaitingOpenHistory
        ) {
          this.deferredHistory = e;
          return;
        }
        this.applyHistory(e, sessionId);
        return;
      }
      case "session.user_message": {
        // The node echoes every prompt as a user_message so multi-client views
        // stay in sync. Dedup our own (already shown optimistically) via the
        // clientMessageId, and ignore echoes for a non-focused session.
        const e = event as any;
        // Our own prompt = an optimistic send for this cmid we haven't confirmed
        // yet. Deduping on the unconfirmed pending entry is the one-shot signal
        // the old `sentMessageIds` set gave (deleted on first echo); a second echo
        // of the same cmid falls through and renders like any other client's.
        const ownSend = e.clientMessageId ? this.pending.get(e.clientMessageId) : undefined;
        const own = Boolean(ownSend && !ownSend.confirmed);
        if (e.sessionId && this.state.activeSession.activeSessionId && e.sessionId !== this.state.activeSession.activeSessionId) return;
        if (e.sessionId && !this.state.activeSession.activeSessionId && !own) return;
        // A new turn is starting for the focused session — retire the previous
        // turn's "files changed / undo" card so it can't be mistaken for this one.
        if (this.state.activeSession.changes) this.set({ changes: null });
        if (own && ownSend) {
          // The node echoes back the *composed* text it actually persisted —
          // our own caption plus an appended attachment placeholder line (see
          // src/server.ts's attachmentsFrom), which does not match the raw
          // typed text rememberAttachments was keyed on at send time. Re-key
          // the cache under this canonical text now so a later history-based
          // re-render (withCachedAttachments/applyHistory) — which only ever
          // sees this same composed text, never the raw caption — still finds
          // it and renders the real thumbnail instead of the bare placeholder.
          // This also covers attachments sent with no caption at all, where the
          // raw text was empty and rememberAttachments skipped caching it.
          if (ownSend.entry.attachments?.length && e.text) this.rememberAttachments(String(e.text), ownSend.entry.attachments);
          // The node has now persisted this prompt, so a *canonical* history
          // snapshot will carry it. Mark it confirmed and record the node's
          // composed text so withPendingUserEntries can dedup this optimistic
          // bubble against that snapshot — but keep the bubble itself. Dropping it
          // here is what let a stale/empty history racing in before canonical
          // history (routine while a repo session clones its worktree) erase the
          // just-sent message; the bubble is now suppressed only once real history
          // actually contains it.
          ownSend.confirmed = true;
          if (e.text) ownSend.confirmedText = String(e.text);
          // If a canonical history snapshot already carries this prompt, the send
          // is fully resolved now that the node has confirmed it too — drop it.
          // Otherwise keep the bubble so a stale/empty history racing in before
          // canonical history can't erase the just-sent message.
          if (ownSend.reconciled) this.retirePending(e.clientMessageId);
          return;
        }
        const text = String(e.text || "");
        this.pushEntry({ id: nextId(), role: "user", text, html: toHtml(text) });
        // A message from another client on this session is exactly as much
        // "the user wrote a message" as our own optimistic send already bumps
        // in addUserMessage — keep the sidebar ordering in sync for it too.
        if (e.sessionId) this.updateSessionRow(e.sessionId, { updatedAt: Date.now() });
        return;
      }
      case "models.list": {
        const e = event as any;
        // Broadcast to all paired clients: ignore another session's list.
        if (e.sessionId && this.state.activeSession.activeSessionId && e.sessionId !== this.state.activeSession.activeSessionId) return;
        const models = normalizeModels(e.models);
        const explicit = e.current ? normalizeModels([e.current])[0]! : null;
        // `models` may include an unconnected tail the node can't select yet
        // (#390's "other models" section — each flagged `configured: false`;
        // absent/true means connected, same as every model before #390). Only
        // ever auto-pick a connected one so a provider with no auth configured
        // can't silently become "the" current model.
        const configuredModels = models.filter((m) => (m as any).configured !== false);
        // On a fresh draft (no active session), prefer the user's last-used model
        // when this runtime lists it — a new session should open on the model the
        // user last picked, ahead of the node's own default `current`. A live
        // session always honors its own `current`, so this is draft-only.
        const remembered =
          !this.state.activeSession.activeSessionId && this.draftModel
            ? configuredModels.find((m) => sameModel(m, this.draftModel as ModelInfo))
            : undefined;
        // A runtime that doesn't support model selection reports an empty list
        // and no current model — clear any stale selection so we never send an
        // unsupported model in the next session.new (which the node rejects with
        // "Model selection is not supported by this runtime").
        let current: ModelInfo | null;
        if (remembered) {
          current = remembered;
        } else if (explicit) {
          current = explicit;
        } else if (configuredModels.length === 0) {
          current = null;
        } else {
          // The node named no current model: keep the existing selection only if
          // this runtime still lists it, otherwise fall back to its first
          // (default) model. This is the fix for switching agents — a model the
          // new runtime doesn't support is dropped instead of lingering as a
          // mismatch the composer would show and session.new would reject.
          const flagged = configuredModels.find((m) => (m as any).current);
          const stillValid = configuredModels.find((m) => sameModel(m, this.state.catalogs.currentModel));
          current = flagged ?? stillValid ?? configuredModels[0]!;
        }
        const listRuntimeId = e.runtimeId != null ? String(e.runtimeId) : null;
        // Remember this runtime's list so a later switch back to it repaints
        // instantly (see setSelectedAgentLocal). Keyed by the runtime the node
        // resolved the list for, never the app's currently-selected agent.
        if (listRuntimeId) this.modelsByRuntime.set(listRuntimeId, { models, currentModel: current });
        this.set({
          models,
          // The runtime this list was resolved for (undefined from an older node
          // → null "unknown", which seedDraftAgentModel treats as "trust it").
          modelsRuntimeId: listRuntimeId,
          currentModel: current,
          currentModelId: current?.id ?? null,
          ...(e.thinking ? { thinking: normalizeThinking(e.thinking) } : {}),
        });
        return;
      }
      case "model.updated": {
        const e = event as any;
        if (e.sessionId && this.state.activeSession.activeSessionId && e.sessionId !== this.state.activeSession.activeSessionId) return;
        const model = e.model ? normalizeModels([e.model])[0]! : this.state.catalogs.currentModel;
        this.set({
          currentModel: model,
          currentModelId: model?.id ?? this.state.catalogs.currentModelId,
          models: this.state.catalogs.models.map((m) => ({ ...m, current: sameModel(m, model) })),
        });
        return;
      }
      case "thinking.updated": {
        const e = event as any;
        if (e.thinking) this.set({ thinking: normalizeThinking(e.thinking) });
        return;
      }
      case "runtimes.list":
      case "runtime.updated": {
        const e = event as any;
        const runtimes = (e.runtimes as RuntimeInfo[]) || this.state.catalogs.runtimes;
        // `activeAgent` mirrors the node-global `active` session's runtime — a
        // legacy, single-session concept any client (including the local CLI)
        // may have set, unrelated to "what agent will a new session start with".
        // Trusting it here is the reported bug: opening the agent picker (or any
        // runtimes.list refresh) for a fresh draft could pin the composer's pill
        // to whatever session happened to be node-global-active, then flip to
        // the real agent once session.new/applyHistory reports it. `current` is
        // the node's actual default runtime for a new session — prefer it. The
        // user's last-used agent is restored imperatively by the controller
        // (which must runtime.select it so the node previews that agent's models),
        // not here — see AppController.maybeRestoreDraftAgent.
        const cur = e.current || runtimes.find((a) => a.id === (this.state.catalogs.selectedAgentId || e.activeAgent));
        const selectedAgentId = cur?.id || e.activeAgent || this.state.catalogs.selectedAgentId;
        // runtimes.list is also requested whenever the agent sheet opens. Its
        // `current` runtime is the default for the *next* session, not the owner
        // of the session on screen. Keep the pill tied to activeRuntimeId just
        // like the sheet checkmark; on a draft both use selectedAgentId instead.
        const displayedRuntime = this.state.activeSession.activeSessionId
          ? runtimes.find((a) => a.id === this.state.activeSession.activeRuntimeId)
          : runtimes.find((a) => a.id === selectedAgentId) || cur;
        this.set({
          runtimes,
          selectedAgentId,
          currentAgentName: agentLabel(displayedRuntime) || this.state.catalogs.currentAgentName,
          ...(e.type === "runtime.updated" ? { installingRuntimeId: null } : {}),
        });
        return;
      }
      case "runtime.install.done": {
        const e = event as any;
        this.set({
          runtimes: (e.runtimes as RuntimeInfo[]) || this.state.catalogs.runtimes,
          installingRuntimeId: null,
        });
        return;
      }
      case "runtime.install.error": {
        const e = event as any;
        this.set({
          runtimes: (e.runtimes as RuntimeInfo[]) || this.state.catalogs.runtimes,
          installingRuntimeId: null,
          error: String(e.error || "Install failed"),
        });
        return;
      }
      case "activation.readiness": {
        const e = event as any;
        if (e.credential && e.repository) this.set({ activationReadiness: { credential: e.credential, repository: e.repository } });
        return;
      }
      case "github.connect.status": {
        const e = event as any;
        const known = ["waiting", "connected", "expired", "denied", "error", "unconfigured", "idle"] as const;
        const status = (known as readonly string[]).includes(e.status) ? (e.status as GithubConnectState["status"]) : "idle";
        this.set({
          githubConnect: {
            status,
            userCode: typeof e.userCode === "string" ? e.userCode : undefined,
            verificationUri: typeof e.verificationUri === "string" ? e.verificationUri : undefined,
            intervalMs: typeof e.intervalMs === "number" ? e.intervalMs : undefined,
            error: typeof e.error === "string" ? e.error : undefined,
          },
        });
        return;
      }
      case "providers.list": {
        const e = event as any;
        const providers = Array.isArray(e.providers) ? (e.providers as ProviderInfo[]) : [];
        // A configured provider we were managing → refresh its auth detail too.
        this.set({ providers });
        // The prompt is satisfied once the *targeted* provider becomes configured
        // (login completed here, or a peer/hosted-escrow sync landed the vault).
        // Check the specific provider, not just "any provider configured": a
        // mid-session prompt for e.g. openai-codex must not be dismissed just
        // because anthropic is already connected.
        const pendingAuth = this.state.presentation.needsModelAuth;
        if (pendingAuth) {
          const alias = modelAuthApiKeyProvider(pendingAuth.provider);
          if (providers.some((p) => (p.id === pendingAuth.provider || p.id === alias) && p.configured)) {
            this.set({ needsModelAuth: null });
          }
        }
        return;
      }
      case "provider.auth": {
        this.set({ providerAuth: event as unknown as ProviderAuth });
        return;
      }
      case "provider.oauth.reset": {
        const e = event as any;
        if (Array.isArray(e.providers)) this.set({ providers: e.providers as ProviderInfo[] });
        this.set({ oauth: null });
        return;
      }
      case "provider.oauth.started": {
        const e = event as any;
        this.set({
          oauth: {
            id: String(e.id || ""),
            provider: e.provider,
            authUrl: e.authUrl,
            instructions: e.instructions,
            deviceCode: e.deviceCode || null,
            usesCallbackServer: e.usesCallbackServer,
            canOpenOnNode: e.canOpenOnNode === true,
            nodeName: typeof e.nodeName === "string" ? e.nodeName : undefined,
            status: e.error ? undefined : "Waiting for sign-in…",
            error: e.error,
          },
        });
        return;
      }
      case "auth.oauth.progress": {
        const e = event as any;
        if (this.state.presentation.oauth && this.state.presentation.oauth.id === e.id) {
          this.set({ oauth: { ...this.state.presentation.oauth, status: String(e.message || "") } });
        }
        return;
      }
      case "auth.oauth.done": {
        const e = event as any;
        if (!this.state.presentation.oauth || this.state.presentation.oauth.id === e.id) this.set({ oauth: null });
        return;
      }
      case "auth.oauth.error": {
        const e = event as any;
        if (this.state.presentation.oauth && this.state.presentation.oauth.id === e.id) {
          this.set({ oauth: { ...this.state.presentation.oauth, error: String(e.error || "sign-in failed"), status: undefined } });
        }
        return;
      }
      case "github.app.manifest.ready": {
        const e = event as any;
        this.set({
          githubApp: {
            ...(this.getState().presentation.githubApp || { phase: "idle" }),
            phase: "submitting",
            action: typeof e.action === "string" ? e.action : undefined,
            manifest: (e.manifest && typeof e.manifest === "object" ? e.manifest : undefined) as Record<string, unknown> | undefined,
            state: typeof e.state === "string" ? e.state : undefined,
            error: undefined,
          },
        });
        return;
      }
      case "github.app.manifest.done": {
        const e = event as any;
        this.set({
          githubApp: {
            ...(this.getState().presentation.githubApp || { phase: "idle" }),
            phase: "done",
            installUrl: typeof e.installUrl === "string" ? e.installUrl : undefined,
            error: undefined,
            returning: false,
          },
        });
        return;
      }
      case "github.app.manifest.error": {
        const e = event as any;
        this.set({
          githubApp: {
            ...(this.getState().presentation.githubApp || { phase: "idle" }),
            phase: "error",
            error: typeof e.error === "string" ? e.error : "GitHub App setup failed.",
            returning: false,
          },
        });
        return;
      }
      case "session.event": {
        // The node wraps every runtime turn event (agent/message/tool) in a
        // `session.event` envelope tagged with its sessionId. Unwrap it, ignore
        // events for a session that isn't the focused one (mirrors the legacy
        // client's focus guard), then dispatch the inner event through the same
        // reducer so stream events reach applyStreamEvent and inner
        // session.error is handled by its top-level case.
        const e = event as any;
        const sid = e.sessionId as string | undefined;
        const inner = (e.event || {}) as ServerEvent;
        const innerKind = normalizeEventType(inner?.type);
        // Keep the session-list dot live for every session, focused or not —
        // except a user_question(_resolved): the node broadcasts those twice,
        // once as the dedicated session.question(.resolved) (which sets the
        // real needs_action/idle status) and again here via this generic
        // forward-everything wrap. Folding this blanket "something happened,
        // must be working" update over that would clobber the needs_action
        // status right back to working the instant it was set.
        if (sid && innerKind !== "user_question" && innerKind !== "user_question_resolved") {
          // Keep the dot live for every event — tool calls and streaming
          // deltas are real signs the session is "working", worth showing.
          // But *ordering* the sidebar on every one of them (#479) meant a
          // session doing a long string of tool calls kept leaping to the top
          // and bumping whatever the user was about to click — with several
          // agents running at once, the whole list never sat still. Only a
          // turn actually finishing (agent_end) is worth reordering for; that's
          // also the one point every turn reaches regardless of how it ended
          // (see closeRunningTools' comment), so it doubles as "posed its final
          // message" even for a turn that ended in an error with no reply.
          const justFinished = innerKind === "agent_end";
          const sessionState = normalizeSessionState(e.state ?? e.sessionState);
          this.updateSessionRow(sid, {
            // Nodes that send explicit axes own this projection. Fall back to the
            // inner-event heuristic only for older nodes that don't.
            status: sessionStatusFromState(sessionState) ?? (justFinished ? "idle" : "working"),
            sessionState,
            needsAction: sessionState ? sessionState.agent === "awaiting-input" : false,
            ...(justFinished ? { updatedAt: Date.now(), finishedAt: Date.now() } : {}),
          });
        }
        if (sid && this.state.activeSession.activeSessionId && sid !== this.state.activeSession.activeSessionId) return;
        if (sid && !this.state.activeSession.activeSessionId) return;
        if (inner && inner.type) {
          // A runtime that emits a bare session.error inside this envelope (e.g. a
          // CLI adapter's credential preflight) doesn't tag the inner event with a
          // sessionId. Carry the envelope's sid onto it so the top-level
          // session.error case attributes it to *this* chat and renders it inline
          // rather than as a disconnected global toast.
          const innerWithSid = sid && !(inner as { sessionId?: unknown }).sessionId ? { ...inner, sessionId: sid } : inner;
          const seq = (e as { seq?: unknown }).seq;
          // Sequenced stream: reassemble in order for the active session
          // so a frame lost on an uplink blip is detected (a seq gap) and replayed
          // instead of silently dropped. An unsequenced event (older node) has no
          // `seq` and passes straight through.
          if (typeof seq === "number" && sid) {
            this.trackSeqStream(sid, (e as { epoch?: unknown }).epoch);
            const res = this.seqReassembler.accept(seq, innerWithSid);
            for (const ready of res.ready) this.apply(ready as ServerEvent);
            if (res.overflow) this.requestFreshHistory?.();
            else if (res.gapFrom !== undefined) this.requestReplay?.(sid, res.gapFrom);
          } else {
            this.apply(innerWithSid);
          }
        }
        return;
      }
      case "session.replay": {
        // The node's answer to requestReplay: the missed session.event envelopes
        // (re-fed through this reducer so the reassembler orders + dedups them), or
        // mode:"reset" when the ring evicted past our cursor → full history resync.
        const e = event as any;
        const sid = e.sessionId as string | undefined;
        if (sid && this.state.activeSession.activeSessionId && sid !== this.state.activeSession.activeSessionId) return;
        if (e.mode === "reset") {
          this.requestFreshHistory?.();
          return;
        }
        const events: any[] = Array.isArray(e.events) ? e.events : [];
        for (const ev of events) this.apply(ev as ServerEvent);
        return;
      }
      case "node.stats": {
        const stats = normalizeNodeStats((event as any).stats);
        if (stats) this.set({ nodeStats: stats });
        return;
      }
      case "capabilities": {
        const capabilities = normalizeCapabilitiesSnapshot((event as any).capabilities);
        if (capabilities) this.set({ capabilities });
        return;
      }
      case "session.pr_result": {
        const e = event as any;
        const url = e.prUrl || e.url || null;
        this.set({ prResult: { sessionId: e.sessionId, url: url || undefined, error: e.ok === false ? String(e.error || "Could not open pull request") : undefined } });
        // Fold in the fresh PR list whenever the round trip succeeded and there's
        // something to fold — not just when there's still an *open* URL. A
        // force-refresh (/github-status) that finds a PR merged has `url` fall to
        // null (no open PR left), but the row still needs `prs` to flip its badge
        // to Merged, so also apply when a `prs` list came back without a URL.
        if (e.ok !== false && (url || Array.isArray(e.prs))) this.applyPrUpdate(String(e.sessionId || ""), url, e.prs);
        return;
      }
      case "session.pr_opened": {
        const e = event as any;
        this.applyPrUpdate(String(e.sessionId || ""), e.prUrl || null, e.prs);
        return;
      }
      case "sessions.pr_refresh_result": {
        const e = event as any;
        this.set({
          prRefreshAllResult: {
            scanned: Number(e.scanned) || 0,
            changed: Number(e.changed) || 0,
            error: e.ok === false ? String(e.error || "Could not refresh GitHub status") : undefined,
          },
        });
        return;
      }
      default: {
        const folded = foldTranscriptEvent({
          transcript: this.state.activeSession.transcript,
          draft: this.draft,
          pendingAgentAttachments: this.pendingAgentAttachments,
          working: this.state.activeSession.working,
          workingLabel: this.state.activeSession.workingLabel,
        }, event, Date.now());
        if (!folded.handled) return;
        this.draft = folded.value.draft;
        this.pendingAgentAttachments = folded.value.pendingAgentAttachments;
        this.set({ transcript: folded.value.transcript as TranscriptEntry[], working: folded.value.working, workingLabel: folded.value.workingLabel });
        for (const command of folded.commands) {
          if (command.kind === "cache-inline-image") this.inlineImagesByUrl.set(command.url, command.ref as AttachmentRef);
          else if (command.kind === "remember-agent-attachments") this.rememberAgentAttachments(this.state.activeSession.activeSessionId, this.state.activeSession.transcript);
          else if (command.kind === "turn-settled") {
            this.drainDeferredHistory();
            this.onSessionSettled?.();
          }
        }
      }
    }
  }

  /**
   * Apply a session.history snapshot. Handles both a full transcript and an
   * "append" delta (mode/baseCount/count/historyHash from history-sync): an
   * append is concatenated onto the cached raw messages, everything else is a
   * full replace. Re-renders, refreshes both caches, and persists the cursor.
   */
  private applyHistory(e: any, sessionId: string | null): void {
    // Durable attachment refs (text→refs) fill the in-memory cache before render,
    // so a reload / another device rehydrates thumbnails by hash instead of a bare
    // "[Image attachment: …]" placeholder. Must precede withCachedAttachments.
    if (Array.isArray(e.attachmentRefs)) this.foldAttachmentRefs(e.attachmentRefs as Array<[string, AttachmentRef[]]>);
    // Durable url→ref map for remote markdown images the node has already
    // resolved (see resolveInlineImages on the node) — must also precede the
    // render below so a reload shows resolved images immediately.
    if (Array.isArray(e.inlineImageRefs)) this.foldInlineImageRefs(e.inlineImageRefs as Array<[string, AttachmentRef]>);
    const incoming: any[] = Array.isArray(e.messages) ? e.messages : [];
    const prev = sessionId ? this.historyRaw.get(sessionId) : undefined;
    const isAppend = e.mode === "append" && prev && (e.baseCount === undefined || e.baseCount === prev.count);
    // An append delta whose base no longer matches what we hold (a slow seed or a
    // second in-flight history request bumped historyRaw between our cursor going
    // out and this delta arriving) is just a TAIL, not a full transcript. The old
    // code fell back to `incoming` and treated that tail as the whole history —
    // dropping every earlier message, after which withPendingUserEntries
    // re-appended the missing optimistic bubbles at the end and the chat reordered
    // (the first prompt jumped to newest). Discard the unusable delta, forget the
    // diverged cursor so the retry asks for a FULL snapshot, and keep the current
    // view until it lands.
    if (e.mode === "append" && !isAppend) {
      if (sessionId) this.historyRaw.delete(sessionId);
      // Only the focused session needs an immediate refetch; a background
      // session re-requests full history whenever it's next opened.
      if (sessionId && sessionId === this.state.activeSession.activeSessionId) this.requestFreshHistory?.();
      return;
    }
    const full = isAppend ? prev!.messages.concat(incoming) : incoming;
    const count = typeof e.count === "number" ? e.count : full.length;
    const historyHash = typeof e.historyHash === "string" ? e.historyHash : "";
    if (sessionId) {
      this.historyRaw.set(sessionId, { messages: full, count, historyHash });
      if (historyHash) this.onHistoryPersist?.(sessionId, full, count, historyHash);
    }
    const rendered = this.withCachedAttachments(renderHistory(full));
    // Record the agent attachments this snapshot carries, then re-apply any it
    // dropped: agent attachments are append-only, so a snapshot missing one the
    // session already showed (a resume-race reconcile, or a transcript built from
    // raw runtime messages without the outbound-attachment overlay) is lossy and
    // must not erase the chip.
    this.rememberAgentAttachments(sessionId, rendered);
    const withAttachments = this.withInlineImageRefs(this.withStickyAgentAttachments(sessionId, rendered));
    if (sessionId) this.cacheTranscript(sessionId, withAttachments);
    // A history snapshot can arrive for a session the user has already switched
    // away from (slow radio + fast taps): its request was in flight when they
    // opened another. Refresh that session's caches above, but never let it
    // repaint the view or reset the *active* session's live draft — otherwise the
    // screen jumps back to the wrong conversation. Adopt only when it's for the
    // open session, or when nothing is open yet (cold open / a freshly created
    // session being taken up by its first prompt).
    // Adopt when it's for the already-open session, or — during the null-active
    // window of a fresh draft — ONLY when this snapshot is the direct response to
    // a request we made. The node echoes our requestId on the session.new reply
    // (see server.ts, buildHistoryEvent spread + requestId), and it reaches only
    // the requesting client (unicast). An unsolicited history — another session's
    // post-reconnect/TUI-refresh broadcast, or a stale open the user has already
    // navigated away from — carries no requestId and must never hijack the draft
    // and repoint activeSessionId at a foreign id. That mis-binding was the
    // "intermingled sessions" bug (and, downstream, "no messages": once
    // activeSessionId is wrong, the session.event filter drops the real stream).
    const adopt =
      this.state.activeSession.activeSessionId === sessionId ||
      (this.state.activeSession.activeSessionId === null && Boolean(e.requestId));
    if (!adopt) return;
    this.draft = freshDraft();
    this.deferredHistory = null;
    const sessionState = normalizeSessionState(e.sessionState ?? e.bivySession?.state);
    if (sessionId && sessionState) {
      this.updateSessionRow(sessionId, {
        sessionState,
        status: sessionStatusFromState(sessionState),
        needsAction: sessionState.agent === "awaiting-input",
      });
    }
    // Open-paint delivered; subsequent unsolicited mid-turn snapshots defer again.
    this.awaitingOpenHistory = false;
    // Keep optimistic prompts the node hasn't confirmed yet: a new session's
    // history is empty, so a bare replace would drop the message the user just
    // sent. They're cleared as the node echoes each one (session.user_message).
    this.set({
      activeSessionId: sessionId,
      activeRuntimeId: e.runtimeId ? String(e.runtimeId) : this.state.activeSession.activeRuntimeId,
      activeTitle: e.name || this.state.activeSession.activeTitle,
      currentAgentName: e.agentName || this.state.catalogs.currentAgentName,
      github: githubContext(e),
      transcript: this.withPendingUserEntries(withAttachments),
      working: sessionState ? sessionState.agent === "working" : Boolean(e.isStreaming),
      opening: false,
      usage: normalizeUsage(e.usage),
    });
    // Baseline the live-stream reassembler now that this session is focused: the
    // transcript reflects everything through `headSeq`, so the next live event we
    // expect is headSeq+1. Reset first when the stream epoch changed (a daemon
    // restart) so its seq counter starting over doesn't read as a flood of
    // duplicates.
    if (sessionId && typeof e.headSeq === "number") {
      this.trackSeqStream(sessionId, e.streamEpoch);
      this.seqReassembler.baseline(e.headSeq);
    }
  }

  /**
   * The connection dropped: the event stream is broken, so stop treating the
   * current turn as live. Otherwise the reconcile-on-reconnect history snapshot
   * trips the mid-turn deferral guard (working && !finalized) forever, and the
   * transcript + stuck "working" spinner never recover.
   */
  markStreamInterrupted(): void {
    this.deferredHistory = null;
    // A connection drop mid-open will never deliver the history it was waiting
    // on, so stop the spinner rather than leaving the pane blank indefinitely.
    if (this.state.activeSession.opening) this.set({ opening: false });
    // A turn cut short still shows any attachments it managed to emit.
    this.flushPendingAgentAttachments();
    if (this.draft.finalized) return;
    this.finishDrafts();
    this.draft.finalized = true;
  }

  /** Once a live turn settles: reconcile with fresh canonical history. */
  private drainDeferredHistory(): void {
    const pending = this.deferredHistory;
    if (!pending) return;
    this.deferredHistory = null;
    // The buffered snapshot predates the final turn output, so don't apply it —
    // ask for fresh history now that the tail is idle. Fall back to applying the
    // buffered payload when no controller hook is wired (e.g. unit tests).
    if (this.requestFreshHistory) this.requestFreshHistory();
    else this.applyHistory(pending, (pending.sessionId as string) || this.state.activeSession.activeSessionId);
  }

  private pushEntry(entry: TranscriptEntry): void {
    this.set({ transcript: [...this.state.activeSession.transcript, entry] });
  }

  /**
   * Flush this turn's buffered agent attachments (see pendingAgentAttachments)
   * onto the turn's FINAL assistant prose bubble — the last assistant text entry
   * since the most recent user message — so the chips read as part of the reply.
   * Falls back to a standalone entry (carrying the caption) when the turn has no
   * prose bubble to hang them on. Idempotent: a no-op once the buffer is drained,
   * so it's safe to call at both turn_end and agent_end. Mirrors the durable
   * grouping renderHistory applies on reload (groupAgentAttachments).
   */
  private flushPendingAgentAttachments(): void {
    const buffered = this.pendingAgentAttachments;
    if (!buffered.length) return;
    this.pendingAgentAttachments = [];
    const transcript = this.state.activeSession.transcript;
    // Skip any whose bytes the transcript already carries (a reconnect/resume that
    // re-broadcasts a live `attachment` event history already grouped in) so a
    // replay never doubles the chip.
    const present = this.attachmentHashesIn(transcript);
    const fresh = buffered.filter((b) => !b.attachment.hash || !present.has(b.attachment.hash));
    const next = this.placeAgentAttachments(transcript, fresh);
    if (next !== transcript) this.set({ transcript: next });
    this.rememberAgentAttachments(this.state.activeSession.activeSessionId, this.state.activeSession.transcript);
  }

  /** The set of attachment content hashes present anywhere in a transcript. */
  private attachmentHashesIn(transcript: TranscriptEntry[]): Set<string> {
    const hashes = new Set<string>();
    for (const e of transcript) for (const a of e.attachments ?? []) if (a.hash) hashes.add(a.hash);
    return hashes;
  }

  /** Index of the assistant prose bubble agent attachments hang on: the last
   *  attachment-free assistant text entry since the most recent user message (the
   *  turn's final reply). -1 when the turn has no such bubble. */
  private agentAttachmentTarget(transcript: TranscriptEntry[]): number {
    let turnStart = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i]!.role === "user") { turnStart = i; break; }
    }
    for (let i = transcript.length - 1; i > turnStart; i--) {
      const e = transcript[i]!;
      if (e.role === "assistant" && !e.tool && e.text && !(e.attachments && e.attachments.length)) return i;
    }
    return -1;
  }

  /** Group `items` onto the turn's final assistant bubble, or append them as their
   *  own caption-carrying entries when the turn has no prose bubble. Returns the
   *  same array reference unchanged when there is nothing to place. */
  private placeAgentAttachments(
    transcript: TranscriptEntry[],
    items: Array<{ attachment: PromptAttachment; caption: string }>,
  ): TranscriptEntry[] {
    if (!items.length) return transcript;
    const chips = items.map((b) => b.attachment);
    const target = this.agentAttachmentTarget(transcript);
    if (target >= 0) {
      return transcript.map((e, i) => (i === target ? { ...e, attachments: [...(e.attachments ?? []), ...chips] } : e));
    }
    // No prose this turn — keep each attachment as its own entry (with caption),
    // preserving the pre-grouping behaviour for the caption-only case.
    return [...transcript, ...items.map((b) => ({ id: nextId(), role: "assistant" as const, text: b.caption, attachments: [b.attachment] }))];
  }

  /** Record every agent-sent attachment in a rendered transcript into the durable
   *  per-session map, keyed by hash (append-only). Only assistant entries carry
   *  agent attachments; user uploads live on user entries and are ignored. */
  private rememberAgentAttachments(sessionId: string | null, transcript: TranscriptEntry[]): void {
    if (!sessionId) return;
    let map = this.knownAgentAttachmentsBySession.get(sessionId);
    for (const e of transcript) {
      if (e.role !== "assistant" || !e.attachments) continue;
      for (const a of e.attachments) {
        if (!a.hash) continue;
        if (!map) { map = new Map(); this.knownAgentAttachmentsBySession.set(sessionId, map); }
        // Caption only matters for the standalone (no-prose-in-turn) fallback; a
        // grouped chip's entry text is the reply prose, not a caption, so default
        // to empty rather than risk re-adding prose as a caption.
        if (!map.has(a.hash)) map.set(a.hash, { attachment: a, caption: "" });
      }
    }
  }

  /** Re-apply any known agent attachment a (possibly lossy) snapshot dropped, so a
   *  reconcile that lacks the outbound-attachment overlay can't erase a chip the
   *  session already showed. No-op once every known hash is present. */
  private withStickyAgentAttachments(sessionId: string | null, transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (!sessionId) return transcript;
    const known = this.knownAgentAttachmentsBySession.get(sessionId);
    if (!known || known.size === 0) return transcript;
    const present = this.attachmentHashesIn(transcript);
    const missing = [...known.values()].filter((k) => k.attachment.hash && !present.has(k.attachment.hash));
    return this.placeAgentAttachments(transcript, missing);
  }

  /** Fold a live field update (status, branch, PR link, …) onto a session-list
   *  row — drives the drawer status dot and its node/branch/PR meta line for
   *  *every* session, not just the focused one (see call sites below: status
   *  from approvals/session.event, branch from renames, prUrl from PR events). */
  private updateSessionRow(
    sessionId: string | undefined,
    patch: {
      status?: SessionStatus;
      needsAction?: boolean;
      sessionState?: SessionState;
      branch?: string;
      prUrl?: string;
      prs?: PrRef[];
      updatedAt?: number;
      finishedAt?: number;
      failedAt?: number;
    },
  ): void {
    if (!sessionId) return;
    let changed = false;
    const sessions = this.state.sessionIndex.sessions.map((s) => {
      if (s.sessionId !== sessionId) return s;
      const next = { ...s, ...patch };
      // A session the user is actively viewing counts as "seen" the moment any
      // live update lands on it — otherwise the row you're already looking at
      // would flash the same "unseen" treatment as one that finished while you
      // were elsewhere (see SessionSummary.lastSeenAt / isUnseen).
      if (sessionId === this.state.activeSession.activeSessionId) next.lastSeenAt = Date.now();
      if (
        next.status !== s.status ||
        next.needsAction !== s.needsAction ||
        JSON.stringify(next.sessionState) !== JSON.stringify(s.sessionState) ||
        next.branch !== s.branch ||
        next.prUrl !== s.prUrl ||
        JSON.stringify(next.prs) !== JSON.stringify(s.prs) ||
        next.updatedAt !== s.updatedAt ||
        next.lastSeenAt !== s.lastSeenAt ||
        next.finishedAt !== s.finishedAt
        || next.failedAt !== s.failedAt
      ) changed = true;
      return next;
    });
    if (changed) this.set({ sessions });
  }

  /** Fold a PR update (from session.pr_opened / session.pr_result) onto the
   *  session's sidebar row and, when it's the focused session, its header pill.
   *  `openPrUrl` is the live open PR (or null once it merges/closes); `prsRaw`
   *  is the full list from the node, or absent from an older node — in which
   *  case normalizePrs synthesizes a single open PR from `openPrUrl`. */
  private applyPrUpdate(sessionId: string, openPrUrl: string | null, prsRaw: unknown): void {
    const prs = normalizePrs(prsRaw, openPrUrl);
    if (prs.length === 0) return;
    const openUrl = prs.find((p) => p.state === "open")?.url ?? null;
    if (sessionId) this.updateSessionRow(sessionId, { prUrl: openUrl ?? undefined, prs });
    if (!sessionId || sessionId === this.state.activeSession.activeSessionId) {
      this.set({ github: { ...this.state.activeSession.github, prUrl: openUrl, prs } });
    }
  }

  /** Interpreter-only interruption cleanup; normal turn decisions live in the transcript fold. */
  private finishDrafts(): void {
    const ids = new Set([this.draft.assistantId, this.draft.thinkingId].filter(Boolean));
    if (ids.size) this.set({ transcript: this.state.activeSession.transcript.map((entry) => ids.has(entry.id) ? { ...entry, streaming: false } : entry) });
    this.draft.assistantId = null;
    this.draft.thinkingId = null;
  }
}
