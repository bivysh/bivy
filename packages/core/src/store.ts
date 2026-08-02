// SPDX-License-Identifier: FSL-1.1-ALv2
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
// reproduced here yet — see packages/web/STATUS.md. They are refinements over
// this correct baseline, not prerequisites for it.

import type { AttachmentRef, ConnectionStatus, PromptAttachment, ServerEvent } from "./protocol.js";
import type { AccountNode } from "./account.js";
import { type SlashCommand } from "./slash.js";
import { toHtml, extractRemoteImageUrls } from "./markdown.js";
import { eventKind, normalizeEventType, toolCallId, toolInput, toolName } from "./tool-activity.js";
import { humanizeError, looksLikeAgentError } from "./store-errors.js";
import { attachmentFromRef, contentThinking, contentToText, mergeToolInto, nextId, renderHistory, toolEntriesFromContent } from "./store-render.js";
import {
  agentLabel,
  githubContext,
  githubFromSummary,
  normalizeAgentCommands,
  normalizeModels,
  normalizeNodeStats,
  normalizePrs,
  normalizeSessions,
  normalizeThinking,
  normalizeUsage,
  sameCommandList,
  sameModel,
  upsertApproval,
  validUserQuestions,
} from "./store-normalize.js";

// Re-export the helpers that moved out of this file so the package's public
// surface (index.ts `export * from "./store.js"`) is unchanged.
export { humanizeError, looksLikeAgentError } from "./store-errors.js";
export { renderHistory, stripAttachmentPlaceholders } from "./store-render.js";
export {
  githubIssueRefFromSource,
  isGithubQueueSource,
  normalizePrs,
  normalizeSandboxTier,
  primaryPr,
  repoFromSource,
} from "./store-normalize.js";

export type SessionStatus = "idle" | "working" | "needs_action" | "saved";

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
  /** Repo-backed session's worktree branch, when known (sessions.list already
   *  carries this from the node — see src/server.ts — it was previously dropped
   *  here, which is why the sidebar had no branch/PR context per row). */
  branch?: string;
  /** This session's ephemeral node was torn down (unenrolled, gone from the
   *  registry) but is REBUILDABLE from a durable correlation + the room key this
   *  device still holds — so the row stays in the sidebar as offline-but-rebuildable
   *  and a send rebuilds it (Gap 1). Client-local; the node has no concept of it. */
  rebuildable?: boolean;
  /** Per-session sandbox tier this session was created with (the override); absent
   *  = the node default. Baked in at creation and read-only for the session's life
   *  — surfaced so a running session can show its sandbox mode read-only. */
  sandbox?: SandboxTier;
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
}

export type ToolStatus = "running" | "done";

export interface ToolActivity {
  callId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: string;
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
  displayName?: string;
  name?: string;
  [k: string]: unknown;
}

export type FollowupStatus = "queued" | "sending" | "sent" | "failed";

/**
 * A follow-up prompt visible in the composer's queue for a session — see
 * AppState.followupsBySession. `id` is the same clientMessageId the prompt is
 * eventually sent with, so the node's `session.user_message` echo (the
 * protocol acknowledgement) can be matched back to it and retire it from the
 * queue. `version` is bumped on every content edit; a caller editing against a
 * stale version (e.g. a second browser tab, or a UI racing the item's own
 * delivery) is rejected rather than silently overwriting newer state — see
 * SessionStore.editFollowup.
 */
export interface PendingFollowup {
  id: string;
  text: string;
  attachments?: PromptAttachment[];
  status: FollowupStatus;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export type FollowupEditResult =
  | { ok: true; item: PendingFollowup }
  | { ok: false; reason: "not_found" | "stale" | "not_queued" };

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
}

/** Reasoning/thinking capability of the current model. */
export interface ThinkingState {
  supportsThinking: boolean;
  thinkingLevel: string;
  availableThinkingLevels: string[];
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

/** Agent sandbox tiers (Codex's vocabulary; see src/harness/sandbox.ts). */
export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

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

export interface AppState {
  status: ConnectionStatus;
  /** Whether the hosted client holds a control-plane session token. Mirrors
   *  `LocalStore.s` but lives in the reactive store so the auth gate (sign-in
   *  screen vs. app shell) re-renders the instant a sign-in completes in-app —
   *  the token itself is in localStorage, which React can't subscribe to. */
  signedIn: boolean;
  /** Account nodes (relay mode) for the header switcher. */
  nodes: AccountNode[];
  currentNodeId: string | null;
  sessions: SessionSummary[];
  /** Live `bivy run` PTYs on the selected node. */
  runTerminals: RunTerminalSummary[];
  activeSessionId: string | null;
  /** Runtime that actually owns the active session. Unlike selectedAgentId,
   *  this is session-scoped and comes from canonical session history. */
  activeRuntimeId: string | null;
  activeTitle: string;
  /** Sessions currently driven by their interactive TUI (single-writer): chat
   *  for these is locked until the TUI exits. Fed by `terminal.tui` broadcasts
   *  so every device shows the same locked/unlocked state. */
  tuiSessions: string[];
  github: GithubContext;
  transcript: TranscriptEntry[];
  working: boolean;
  workingLabel: string;
  /** True while an existing session is being opened and we have nothing cached
   *  to paint yet — the transcript is empty because history is still in flight,
   *  not because the session is new. Drives a loading spinner instead of the
   *  "start a new session" empty state (which made an opening session look like
   *  a fresh one during the node's resume round-trip). */
  opening: boolean;
  approvals: ApprovalRequest[];
  /** Pending clarifying questions (see UserQuestionRequest) across every session. */
  questions: UserQuestionRequest[];
  models: ModelInfo[];
  /** The runtime the current `models`/`currentModel` were resolved for (the
   *  node tags each models.list with its runtime). Null when unknown — e.g. the
   *  very first list before any agent is selected, or an older node that doesn't
   *  send it. Used to reject a list that belongs to a different agent than the
   *  one now selected, so the composer/picker never show another agent's models. */
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
  /** Repo chosen for the next new session (draft only). */
  draftRepo: string | null;
  /** Remote branches of `draftRepo` (for the adjacent branch pill), and which
   *  repo slug they belong to — so a still-loading/stale list from the
   *  PREVIOUS repo pick is never shown as if it were the new one's. */
  branches: BranchInfo[];
  branchesRepo: string | null;
  /** The repo's default branch name (e.g. "main"), so the branch picker can
   *  label its "use the default" row without a second round trip. */
  branchesDefault: string | null;
  branchesError: string | null;
  branchesLoading: boolean;
  /** Remote branch chosen for the next new session (draft only); null = clone
   *  from `draftRepo`'s default branch. Cleared whenever `draftRepo` changes —
   *  a branch pick from one repo means nothing for another. */
  draftBranch: string | null;
  /** Sandbox tier chosen for the next new session (draft only); null = node default. */
  draftSandbox: SandboxTier | null;
  /** Current node's settings (Settings → Nodes), or null until fetched. */
  nodeSettings: NodeSettings | null;
  providers: ProviderInfo[];
  providerAuth: ProviderAuth | null;
  /** User-provided / local model endpoints (Settings → Local models). */
  localModels: LocalModelProvider[];
  /** Quick-add presets for common local inference servers. */
  localModelPresets: LocalModelPreset[];
  /** User-authored run-orchestration rulesets (Settings → Rulesets). */
  rulesets: RulesetInfo[];
  /** Voice-input config (preferred provider + stored keys), or null until fetched. */
  sttConfig: SttConfig | null;
  oauth: OauthState | null;
  githubApp: GithubAppState | null;
  /** Cost/token/plan-quota for the active session (display-only), or null. */
  usage: Usage | null;
  /** Latest node-resource snapshot (memory/CPU/storage) for the header "Node
   *  stats" panel, or null until first requested. Polled while the panel is open. */
  nodeStats: NodeStats | null;
  /** Sessions currently paused (every action asks for approval until resumed). */
  pausedSessionIds: string[];
  /** Transient result of an Open-PR action, for the UI to toast. */
  prResult: { sessionId?: string; url?: string; error?: string } | null;
  /** Transient result of the global "refresh GitHub status" scan
   *  (`sessions.pr.refresh_all`), for the UI to report back to the user. */
  prRefreshAllResult: { scanned: number; changed: number; error?: string } | null;
  /** Files the active session's last turn changed (Universal Agent Harness), or
   *  null. Drives the "files changed / undo this turn" card. Cleared on session
   *  switch, when a new turn starts, and after a rewind. */
  changes: TurnChanges | null;
  /** The active session's harness checkpoints (newest first), for the rewind
   *  timeline. Populated on demand via `session.checkpoints`; [] until fetched. */
  checkpoints: Checkpoint[];
  /**
   * Agent-native slash commands advertised by each open session, keyed by
   * sessionId. Stored per session — NOT merged onto a shared runtime row — so two
   * sessions on the same runtime never overwrite each other's command set (the
   * bug the per-runtime merge had). The composer offers only the *active*
   * session's entry (`commandsBySession[activeSessionId]`), falling back to the
   * selected runtime's static catalog commands for a pre-session draft. Populated
   * from session.created / session.capabilities; dropped on session.deleted and
   * on a node switch.
   */
  commandsBySession: Record<string, SlashCommand[]>;
  /**
   * Follow-up prompts the composer queued instead of sending immediately —
   * because the session was mid-turn, or the queue already held something (so
   * a new prompt can't jump ahead of it) — keyed by sessionId. Per-session for
   * the same reason as commandsBySession: switching sessions must never blend
   * one session's queue into another's. Only ever populated for a *real*
   * session — a prompt sent before the very first session.new resolves is
   * handled by AppController's own pendingPrompt/pendingFollowups instead (a
   * narrower, invisible race that predates a session existing at all). See
   * AppController.sendPrompt/drainFollowups for the delivery lifecycle (queued
   * -> sending -> gone, folded into the transcript as a normal message once
   * the node acknowledges it).
   */
  followupsBySession: Record<string, PendingFollowup[]>;
  error: string | null;
  /** A transient, non-error confirmation banner (e.g. "You're on Pro"). Shown as
   *  a success toast and auto-dismissed by the UI. Distinct from `error` so the
   *  two can coexist and are styled differently. */
  notice: string | null;
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

export function initialState(): AppState {
  return {
    status: "offline",
    signedIn: false,
    nodes: [],
    currentNodeId: null,
    sessions: [],
    runTerminals: [],
    activeSessionId: null,
    activeRuntimeId: null,
    activeTitle: "New session",
    tuiSessions: [],
    github: { issueUrl: null, prUrl: null, branch: null, repo: null, prs: [] },
    transcript: [],
    working: false,
    workingLabel: "",
    opening: false,
    approvals: [],
    questions: [],
    models: [],
    modelsRuntimeId: null,
    currentModelId: null,
    currentModel: null,
    thinking: { supportsThinking: false, thinkingLevel: "off", availableThinkingLevels: ["off"] },
    runtimes: [],
    currentAgentName: "Agent",
    selectedAgentId: null,
    installingRuntimeId: null,
    repos: [],
    reposAuthed: true,
    reposError: null,
    reposLoading: false,
    draftRepo: null,
    branches: [],
    branchesRepo: null,
    branchesDefault: null,
    branchesError: null,
    branchesLoading: false,
    draftBranch: null,
    draftSandbox: null,
    nodeSettings: null,
    providers: [],
    providerAuth: null,
    localModels: [],
    localModelPresets: [],
    rulesets: [],
    sttConfig: null,
    oauth: null,
    githubApp: null,
    usage: null,
    nodeStats: null,
    pausedSessionIds: [],
    prResult: null,
    prRefreshAllResult: null,
    changes: null,
    checkpoints: [],
    commandsBySession: {},
    followupsBySession: {},
    error: null,
    notice: null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Draft {
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
  return { assistantId: null, thinkingId: null, finalized, thinkingText: "", sawThinking: false, pendingText: "", committedText: "", committedThinking: "" };
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
 * Live reasoning text for a streamed assistant event. Prefer the accumulated
 * `thinking` block on the message; otherwise fall back to the incremental
 * `assistantMessageEvent` deltas (some runtimes stream reasoning only that way).
 * Mirrors the legacy client's `streamThinking`. The caller accumulates deltas.
 */
function eventThinkingDelta(event: any): { kind: "full" | "delta" | "none"; text: string } {
  const ame = event?.assistantMessageEvent;
  if (ame?.type === "thinking_delta" && typeof ame.delta === "string") return { kind: "delta", text: ame.delta };
  if (ame?.type === "thinking_end" && typeof ame.content === "string") return { kind: "full", text: ame.content };
  return { kind: "none", text: "" };
}

/**
 * Fold a single server event into state. Returns the same object if unchanged,
 * or a new AppState if it changed (so `===` identity drives view re-render).
 */
export class SessionStore {
  private state: AppState = initialState();
  private listeners = new Set<() => void>();
  private draft: Draft = freshDraft();
  /** Agent-sent attachments buffered during the current turn. Flushed at the
   *  turn boundary onto the turn's final assistant bubble (see
   *  flushPendingAgentAttachments) so a chip reads as part of the reply, not as a
   *  standalone entry stranded mid-turn where `bivy attach` happened to run. */
  private pendingAgentAttachments: Array<{ attachment: PromptAttachment; caption: string }> = [];
  /** The user's last-used model, remembered across sessions and reloads. Honored
   *  by the models.list reducer *only* while no session is active (a fresh
   *  draft), so a new session opens on the same model the user last picked. The
   *  node's list stays authoritative: a model this runtime doesn't list falls
   *  back to the node default. Seeded by the controller from local storage. (The
   *  last-used *agent* is restored imperatively by the controller, since that
   *  requires a runtime.select round-trip — see maybeRestoreDraftAgent.) */
  private draftModel: { provider?: string; id: string } | null = null;
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
    this.set({ githubApp: { ...(this.state.githubApp || { phase: "idle" }), phase, ...patch } });
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
    if (this.state.activeSessionId === sessionId && this.state.transcript.length === 0) {
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
    const known = this.state.sessions.find((s) => s.sessionId === sessionId);
    this.set({
      activeSessionId: sessionId,
      activeRuntimeId: known?.runtimeId ?? null,
      // Opening a row is how the user "sees" it — stamp lastSeenAt right away
      // so a finished-but-unseen row's indicator clears the instant they look,
      // rather than waiting on a node round-trip to confirm anything.
      sessions: known
        ? this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, lastSeenAt: Date.now() } : s))
        : this.state.sessions,
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
      // Checkpoints are per-session; clear until re-fetched for the new session.
      checkpoints: [],
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
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
    const idx = this.state.runtimes.findIndex((r) => r.id === rid);
    const row = idx >= 0 ? this.state.runtimes[idx] : undefined;
    if (!row) return;
    const existing = (row.capabilities as Record<string, unknown> | undefined) || {};
    const incoming = { ...(capabilities as Record<string, unknown>) };
    delete incoming.commands;
    const merged = { ...existing, ...incoming };
    if (JSON.stringify(merged) === JSON.stringify(existing)) return;
    const nextRuntimes = this.state.runtimes.slice();
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
    const prev = this.state.commandsBySession[sid] ?? [];
    if (sameCommandList(prev, commands)) return;
    const next = { ...this.state.commandsBySession };
    if (commands.length) next[sid] = commands;
    else delete next[sid];
    this.set({ commandsBySession: next });
  }

  /** Forget a session's advertised commands (on delete). Keeps the map from
   *  growing unbounded across a long-lived client and stops a stale set lingering. */
  private dropSessionCommands(sessionId: string): void {
    if (!(sessionId in this.state.commandsBySession)) return;
    const next = { ...this.state.commandsBySession };
    delete next[sessionId];
    this.set({ commandsBySession: next });
  }

  // --- Queued follow-ups (issue #154) -------------------------------------
  // A small CRUD surface over AppState.followupsBySession. These methods only
  // touch that map's data shape and invariants (ordering, status, version);
  // AppController owns *when* to call them (busy-gating, dispatch, retry,
  // drain-on-turn-end) — see its sendPrompt/drainFollowups/dispatchFollowup.

  /** The queued follow-ups for a session, in delivery order. */
  getFollowups(sessionId: string): PendingFollowup[] {
    return this.state.followupsBySession[sessionId] ?? [];
  }

  private setFollowupsFor(sessionId: string, list: PendingFollowup[]): void {
    const next = { ...this.state.followupsBySession };
    if (list.length) next[sessionId] = list;
    else delete next[sessionId];
    this.set({ followupsBySession: next });
  }

  /** Append a new queued follow-up. `id` becomes its clientMessageId once sent.
   *  A duplicate id (e.g. a doubled dispatch racing itself) is ignored rather
   *  than creating a second entry. */
  enqueueFollowup(sessionId: string, item: { id: string; text: string; attachments?: PromptAttachment[] }, now: number): PendingFollowup {
    const list = this.getFollowups(sessionId);
    const existing = list.find((f) => f.id === item.id);
    if (existing) return existing;
    const created: PendingFollowup = {
      id: item.id,
      text: item.text,
      attachments: item.attachments,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.setFollowupsFor(sessionId, [...list, created]);
    return created;
  }

  /**
   * Edit a still-queued item's text/attachments. Rejects rather than
   * overwriting when: the item is gone (`not_found`), already dispatched
   * (`not_queued` — editing something already in flight would not change what
   * the agent receives), or `expectedVersion` no longer matches the item's
   * current version (`stale` — someone else changed it since the caller last
   * read it; at minimum, a second controller/tab editing concurrently). The
   * caller (composer edit UI) should re-read the current item and let the user
   * retry rather than silently reapplying their edit over newer state.
   */
  editFollowup(
    sessionId: string,
    id: string,
    patch: { text: string; attachments?: PromptAttachment[] },
    expectedVersion: number,
    now: number,
  ): FollowupEditResult {
    const list = this.getFollowups(sessionId);
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return { ok: false, reason: "not_found" };
    const item = list[idx]!;
    if (item.status !== "queued") return { ok: false, reason: "not_queued" };
    if (item.version !== expectedVersion) return { ok: false, reason: "stale" };
    const updated: PendingFollowup = { ...item, text: patch.text, attachments: patch.attachments, version: item.version + 1, updatedAt: now };
    const next = list.slice();
    next[idx] = updated;
    this.setFollowupsFor(sessionId, next);
    return { ok: true, item: updated };
  }

  /** Remove a still-queued item. No-op (returns false) once it's dispatched —
   *  removing something already sending/sent can't change what the agent
   *  receives, and would desync the visible queue from reality. */
  removeFollowup(sessionId: string, id: string): boolean {
    const list = this.getFollowups(sessionId);
    const item = list.find((f) => f.id === id);
    if (!item || item.status !== "queued") return false;
    this.setFollowupsFor(sessionId, list.filter((f) => f.id !== id));
    return true;
  }

  /** Move a still-queued item to `toIndex` among the queued items (clamped).
   *  No-op once it's dispatched, for the same reason removeFollowup guards it. */
  reorderFollowup(sessionId: string, id: string, toIndex: number): boolean {
    const list = this.getFollowups(sessionId);
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0 || list[idx]!.status !== "queued") return false;
    const clamped = Math.max(0, Math.min(toIndex, list.length - 1));
    if (clamped === idx) return true;
    const next = list.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(clamped, 0, moved!);
    this.setFollowupsFor(sessionId, next);
    return true;
  }

  /** Mark an item as actually being sent (about to go over the wire). Kept
   *  distinct from removal so a lost ack (e.g. the socket drops mid-send) can
   *  be told apart from "never attempted" — see revertFollowupToQueued. */
  markFollowupSending(sessionId: string, id: string, now: number): PendingFollowup | undefined {
    const list = this.getFollowups(sessionId);
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return undefined;
    const updated: PendingFollowup = { ...list[idx]!, status: "sending", updatedAt: now };
    const next = list.slice();
    next[idx] = updated;
    this.setFollowupsFor(sessionId, next);
    return updated;
  }

  /** Delivery is confirmed (the node's session.user_message echo, or a turn
   *  actually completing — see AppController) — drop it from the visible
   *  queue; it's an ordinary transcript message now, not something pending. */
  confirmFollowupSent(sessionId: string, id: string): void {
    const list = this.getFollowups(sessionId);
    if (!list.some((f) => f.id === id)) return;
    this.setFollowupsFor(sessionId, list.filter((f) => f.id !== id));
  }

  /** A dispatched send could not be confirmed (e.g. the socket dropped before
   *  any ack arrived) — put it back at the FRONT of the queue, queued again, so
   *  a retry preserves delivery order instead of racing behind newer items. */
  revertFollowupToQueued(sessionId: string, id: string, now: number): void {
    const list = this.getFollowups(sessionId);
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0 || list[idx]!.status !== "sending") return;
    const item: PendingFollowup = { ...list[idx]!, status: "queued", updatedAt: now };
    this.setFollowupsFor(sessionId, [item, ...list.filter((f) => f.id !== id)]);
  }

  /** Drop any items still marked "sending" for a session whose turn just
   *  settled (agent_end). Reaching agent_end proves the runtime received
   *  whatever prompt started that turn, so this is the "durable equivalent" to
   *  an explicit ack for the rare case the node's session.user_message echo
   *  itself never arrived (e.g. a reconnect raced it) — without this a
   *  followup could show "sending" forever even though it plainly succeeded. */
  settleSendingFollowups(sessionId: string): void {
    const list = this.getFollowups(sessionId);
    if (!list.some((f) => f.status === "sending")) return;
    this.setFollowupsFor(sessionId, list.filter((f) => f.status !== "sending"));
  }

  /** Forget a session's queue entirely (on delete). */
  dropFollowups(sessionId: string): void {
    if (!(sessionId in this.state.followupsBySession)) return;
    const next = { ...this.state.followupsBySession };
    delete next[sessionId];
    this.set({ followupsBySession: next });
  }

  setStatus(status: ConnectionStatus): void {
    if (status !== this.state.status) this.set({ status });
  }

  /** Reflect whether a control-plane session token is held. Drives the reactive
   *  auth gate so signing in (or out) swaps the sign-in screen and the app shell
   *  without a full page reload. */
  setSignedIn(signedIn: boolean): void {
    if (signedIn !== this.state.signedIn) this.set({ signedIn });
  }

  setNodes(nodes: AccountNode[]): void {
    this.set({ nodes });
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
    const sessions = normalizeSessions(list, this.state.sessions);
    const activeId = this.state.activeSessionId;
    this.set({
      sessions: activeId
        ? sessions.map((s) => (s.sessionId === activeId ? { ...s, lastSeenAt: Date.now() } : s))
        : sessions,
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
    if (this.state.sessions.length > 0) return;
    const sessions = normalizeSessions(list, this.state.sessions);
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
      // Per-session display state must not blend across nodes either.
      usage: null,
      changes: null,
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
      // Per-node settings (name, default agent/model, GitHub prompt, sync
      // config, …) must never survive a switch — otherwise a still-editable
      // form can keep showing the *previous* node's settings under the
      // newly-selected node, e.g. while the new one is offline and never
      // answers `node.settings.get` to overwrite it.
      nodeSettings: null,
    });
  }

  setError(message: string): void {
    this.set({ error: message });
  }

  /** Show (or clear, with "") a transient success/confirmation banner. */
  setNotice(message: string): void {
    this.set({ notice: message });
  }

  /** Append a local system message to the active transcript (client-only, not
   *  persisted on the node) — used for slash-command feedback like `/help`. */
  pushSystemMessage(text: string): void {
    this.pushEntry({ id: nextId(), role: "system", text });
  }

  /** Consume the transient Open-PR result once the UI has shown it. */
  clearPrResult(): void {
    if (this.state.prResult) this.set({ prResult: null });
  }

  /** Consume the transient "refresh all GitHub statuses" result once shown. */
  clearPrRefreshAllResult(): void {
    if (this.state.prRefreshAllResult) this.set({ prRefreshAllResult: null });
  }

  setReposLoading(loading: boolean): void {
    this.set({ reposLoading: loading });
  }

  /** Repo chosen for the next new session (cleared once the session is created). */
  setDraftRepo(slug: string | null): void {
    this.set({ draftRepo: slug });
  }

  setBranchesLoading(loading: boolean): void {
    this.set({ branchesLoading: loading });
  }

  /** Drop the branch list (and any picked branch) — called whenever `draftRepo`
   *  changes, so the branch pill never shows the previous repo's branches (or a
   *  picked branch that belongs to it) while the new repo's list loads. */
  clearBranches(): void {
    this.set({ branches: [], branchesRepo: null, branchesDefault: null, branchesError: null, branchesLoading: false, draftBranch: null });
  }

  /** Remote branch chosen for the next new session (null = the repo's default branch). */
  setDraftBranch(name: string | null): void {
    this.set({ draftBranch: name });
  }

  /** Sandbox tier chosen for the next new session (null = use the node default). */
  setDraftSandbox(tier: SandboxTier | null): void {
    this.set({ draftSandbox: tier });
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
    if (this.state.activeSessionId) return;
    const next: Partial<AppState> = {};
    // Agent: the remembered pick if this node offers it and it's installed/ready,
    // else the runtime the node flags as current (its default for a new session).
    const available = (r: RuntimeInfo) => String((r as any).status || "available") === "available";
    const remembered = agentId ? this.state.runtimes.find((r) => r.id === agentId && available(r)) : undefined;
    const defaultRuntime = this.state.runtimes.find((r) => (r as any).current && available(r));
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
    const listMatchesAgent = agent ? this.state.modelsRuntimeId == null || this.state.modelsRuntimeId === agent.id : true;
    if (listMatchesAgent) {
      const rememberedModel = model ? this.state.models.find((m) => sameModel(m, model as ModelInfo)) : undefined;
      const defaultModel = this.state.models.find((m) => (m as any).current);
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
      models: this.state.models.map((m) => ({ ...m, current: sameModel(m, model) })),
    });
  }

  /** Optimistically reflect an agent pick before runtime.updated arrives. */
  setSelectedAgentLocal(id: string): void {
    const rt = this.state.runtimes.find((a) => a.id === id);
    const next: Partial<AppState> = { selectedAgentId: id, currentAgentName: agentLabel(rt) || this.state.currentAgentName };
    // Drop the outgoing agent's models the instant the pick is made — otherwise
    // the model pill/picker keep showing that agent's models (e.g. Codex's GPT)
    // in the window before this agent's models.list refresh (driven by the
    // node's runtime.updated → listModels) lands. Only when we *know* the held
    // list is for a different runtime; a null (unknown) id is left for the
    // refresh to overwrite so we don't needlessly blank a still-valid pill.
    if (this.state.modelsRuntimeId != null && this.state.modelsRuntimeId !== id) {
      next.models = [];
      next.modelsRuntimeId = null;
      next.currentModel = null;
      next.currentModelId = null;
    }
    this.set(next);
  }

  setInstalling(id: string | null): void {
    this.set({ installingRuntimeId: id });
  }

  /** Optimistically move the reasoning level before the node confirms. */
  setThinkingLevel(level: string): void {
    this.set({ thinking: { ...this.state.thinking, thinkingLevel: level } });
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
      checkpoints: [],
    });
  }

  setActiveTitle(name: string): void {
    this.set({ activeTitle: name });
  }

  /** Optimistically rename a session-list row before the node confirms. */
  renameSessionLocal(sessionId: string, name: string): void {
    this.set({ sessions: this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)) });
  }

  /** Optimistically drop a session-list row before the node's fresh list arrives. */
  removeSessionLocal(sessionId: string): void {
    this.set({ sessions: this.state.sessions.filter((s) => s.sessionId !== sessionId) });
  }

  /** Insert or merge a single session-list row (from a `session.created`
   *  broadcast) so a session started anywhere shows in the sidebar immediately,
   *  ahead of the authoritative `sessions.list` reconcile. Merges onto an
   *  existing row so we never clobber a name/status the list already carried. */
  private upsertSession(summary: SessionSummary): void {
    if (!summary.sessionId) return;
    const existing = this.state.sessions.find((s) => s.sessionId === summary.sessionId);
    if (existing) {
      const merged: SessionSummary = {
        ...existing,
        ...Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined && v !== "")),
      };
      this.set({ sessions: this.state.sessions.map((s) => (s.sessionId === summary.sessionId ? merged : s)) });
    } else {
      this.set({ sessions: [summary, ...this.state.sessions] });
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
        this.usersBeforePending = this.state.transcript.reduce((n, e) => (e.role === "user" ? n + 1 : n), 0);
      }
      // Hold onto it (unconfirmed) so a session.new's empty history — or any full
      // replace that races ahead of the node persisting this prompt — can't erase
      // it, and so the node's own echo of this prompt is deduped by cmid.
      this.pending.set(clientMessageId, { entry, confirmed: false });
    }
    if (attachments && attachments.length) this.rememberAttachments(text, attachments);
    this.set({ transcript: [...this.state.transcript, entry] });
    // Sending a message is the clearest possible "this is now the most recently
    // active session" signal — bump it right away rather than waiting on the
    // round trip through session.event, so the sidebar reorders the instant you
    // hit send instead of only once the agent's turn starts streaming back.
    if (this.state.activeSessionId) this.updateSessionRow(this.state.activeSessionId, { updatedAt: Date.now() });
  }

  apply(event: ServerEvent): void {
    const type = String(event.type || "");
    switch (type) {
      case "terminal.list": {
        const terminals = Array.isArray((event as any).terminals)
          ? (event as any).terminals.filter((t: any) => t && typeof t.termId === "string")
          : [];
        this.set({ runTerminals: terminals });
        return;
      }
      case "terminal.created": {
        const terminal = (event as any).terminal as RunTerminalSummary | undefined;
        if (!terminal?.termId) return;
        const rest = this.state.runTerminals.filter((t) => t.termId !== terminal.termId);
        this.set({ runTerminals: [terminal, ...rest] });
        return;
      }
      case "terminal.activity": {
        const e = event as any;
        const termId = String(e.termId || "");
        if (termId) this.set({
          runTerminals: this.state.runTerminals.map((t) =>
            t.termId === termId ? { ...t, lastActivityAt: Number(e.at) || Date.now() } : t,
          ),
        });
        return;
      }
      case "terminal.closed":
      case "terminal.exit": {
        const termId = String((event as any).termId || "");
        if (termId) this.set({ runTerminals: this.state.runTerminals.filter((t) => t.termId !== termId) });
        return;
      }
      case "terminal.tui": {
        // A session was handed to / returned from its interactive TUI. Track the
        // locked set so the composer for that session can show the "open in the
        // terminal" banner instead of a rejected send. Idempotent add/remove.
        const sid = String((event as any).sessionId || "");
        if (!sid) return;
        const active = Boolean((event as any).active);
        const has = this.state.tuiSessions.includes(sid);
        if (active && !has) this.set({ tuiSessions: [...this.state.tuiSessions, sid] });
        else if (!active && has) this.set({ tuiSessions: this.state.tuiSessions.filter((s) => s !== sid) });
        return;
      }
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
          const known = this.state.sessions.find((s) => s.sessionId === sid);
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
            status: "idle",
            needsAction: false,
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
      case "session.renamed": {
        // The node names a session from its first message (maybeNameSession) and
        // broadcasts the new name — the sidebar row + header title only learn the
        // real name here. A repo session may also carry its renamed branch.
        const e = event as any;
        const sid = String(e.sessionId || "");
        if (e.name && sid) this.renameSessionLocal(sid, String(e.name));
        // Fold the branch onto the row regardless of focus (sidebar meta line
        // for every session), same as the status dot above — only the active
        // session's `github` pill additionally needs it.
        if (e.branch && sid) this.updateSessionRow(sid, { branch: String(e.branch) });
        if (!sid || sid === this.state.activeSessionId) {
          const patch: Partial<AppState> = {};
          if (e.name) patch.activeTitle = String(e.name);
          if (e.branch) patch.github = { ...this.state.github, branch: String(e.branch) };
          if (Object.keys(patch).length) this.set(patch);
        }
        return;
      }
      case "session.branch_renamed": {
        const e = event as any;
        const sid = String(e.sessionId || "");
        if (e.branch && sid) this.updateSessionRow(sid, { branch: String(e.branch) });
        if ((!sid || sid === this.state.activeSessionId) && e.branch) {
          this.set({ github: { ...this.state.github, branch: String(e.branch) } });
        }
        return;
      }
      case "session.closed": {
        const e = event as any;
        const sid = String(e.sessionId || "");
        if (sid) this.updateSessionRow(sid, { status: "saved", needsAction: false });
        // Closing a runtime means "saved/not live on node", not "the user chose
        // a new draft". Do not steal focus or clear a half-written composer
        // draft when the node reaps/flushes the active session (idle close,
        // restart, foreground reconcile). Keep the transcript visible and simply
        // stop live indicators; a later prompt/open will reopen the session.
        if (sid && sid === this.state.activeSessionId) this.set({ working: false, workingLabel: "", opening: false });
        return;
      }
      case "session.deleted": {
        const e = event as any;
        const sid = String(e.sessionId || "");
        const file = e.sessionFile as string | undefined;
        this.set({
          sessions: this.state.sessions.filter(
            (s) => s.sessionId !== sid && (!file || s.path !== file),
          ),
        });
        if (sid) this.dropSessionCommands(sid);
        if (sid) this.dropFollowups(sid);
        if (sid && sid === this.state.activeSessionId) this.resetActiveSession();
        return;
      }
      case "node.updated": {
        const e = event as any;
        if (e.name && this.state.currentNodeId) {
          this.set({
            nodes: this.state.nodes.map((n) =>
              n.id === this.state.currentNodeId ? { ...n, name: String(e.name) } : n,
            ),
          });
        }
        return;
      }
      case "session.notice": {
        const e = event as any;
        const sid = String(e.sessionId || "");
        if ((!sid || sid === this.state.activeSessionId) && e.message) {
          // Carry an optional `action` (a slash command like "/new") onto the
          // entry so the view can render it as a tappable button — e.g. a node
          // suggestion the user can act on with one tap.
          const action = typeof e.action === "string" ? e.action : undefined;
          this.pushEntry({ id: nextId(), role: "system", text: String(e.message), action });
        }
        return;
      }
      case "session.cloning": {
        // A repo-backed session clones its worktree before the first turn — show
        // progress so the composer doesn't look idle. Mirrors legacy setWorking.
        const e = event as any;
        const sid = String(e.sessionId || "");
        if (!sid || sid === this.state.activeSessionId) this.setWorking(`Cloning ${e.repo || "repo"}…`);
        return;
      }
      case "session.history": {
        const e = event as any;
        const sessionId = (e.sessionId as string) || this.state.activeSessionId;
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
          sessionId === this.state.activeSessionId &&
          this.state.working &&
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
        if (e.sessionId && this.state.activeSessionId && e.sessionId !== this.state.activeSessionId) return;
        if (e.sessionId && !this.state.activeSessionId && !own) return;
        // A new turn is starting for the focused session — retire the previous
        // turn's "files changed / undo" card so it can't be mistaken for this one.
        if (this.state.changes) this.set({ changes: null });
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
      case "session.error":
      case "session.errored": {
        // Broadcast to every connected client: a background/unrelated session's
        // error (e.g. a stale model.select against a session the user has since
        // navigated away from) must not blow away the *active* session's working
        // state or pop an error toast that has nothing to do with what's on
        // screen — mirrors the sessionId guard every sibling per-session case
        // below already applies.
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        const message = humanizeError(String(e.error || e.errorMessage || "error"));
        // A session-scoped error belongs *in that chat*, not in a floating toast
        // that reads as a disconnected system alert. When the error names a
        // session and it's the one on screen, drop it into the transcript as an
        // inline error bubble (and stop the working spinner). Errors with no
        // session — connection/relay/global failures — still use the toast.
        // Clear `opening` too: a failed resume must fall back to a usable view
        // rather than spinning forever on a session that will never paint.
        if (e.sessionId) {
          this.pushEntry({ id: nextId(), role: "error", text: message });
          this.set({ working: false, opening: false });
        } else {
          this.set({ error: message, working: false, opening: false });
        }
        return;
      }
      case "approval.created": {
        const approval = (event as any).approval || event;
        // Needing a response is one of the few things worth reordering the
        // sidebar for (see #479) — surface it at the top like a fresh reply.
        this.updateSessionRow(approval?.sessionId, { status: "needs_action", needsAction: true, updatedAt: Date.now() });
        this.set({ approvals: upsertApproval(this.state.approvals, approval) });
        return;
      }
      case "approval.resolved":
      case "approval.removed": {
        const e = event as any;
        const resolved = this.state.approvals.find((a) => a.id === e.id || a.id === e.approvalId);
        const approvals = this.state.approvals.filter((a) => a.id !== e.id && a.id !== e.approvalId);
        this.set({ approvals });
        // Clear the sidebar "needs response" dot once nothing else on that
        // session is still pending, instead of leaving it red until an unrelated
        // event happens to arrive.
        const sid = resolved?.sessionId as string | undefined;
        if (sid && !this.sessionStillNeedsAction(sid)) {
          this.updateSessionRow(sid, { status: "idle", needsAction: false });
        }
        return;
      }
      // A blocking clarifying question (e.g. AskUserQuestion), not a tool
      // approval — same "needs your response" treatment as approval.created
      // above (sidebar dot + a cross-session list), answered via
      // controller.answerQuestion instead of controller.resolveApproval.
      case "session.question": {
        const e = event as any;
        const id = String(e.requestId || "");
        // Validate defensively rather than trust the wire: a rendering crash in
        // QuestionCard (no ErrorBoundary above it) would otherwise take down the
        // whole chat UI, not just this card.
        const questions = validUserQuestions(e.questions);
        if (!id || !questions) return;
        // Same reasoning as approval.created above: a clarifying question is a
        // "needs your response" moment worth surfacing at the top of the list.
        this.updateSessionRow(e.sessionId, { status: "needs_action", needsAction: true, updatedAt: Date.now() });
        const request: UserQuestionRequest = { id, sessionId: e.sessionId ? String(e.sessionId) : undefined, questions };
        this.set({ questions: [...this.state.questions.filter((q) => q.id !== id), request] });
        return;
      }
      case "session.question.resolved": {
        const e = event as any;
        const id = String(e.requestId || e.id || "");
        const resolved = this.state.questions.find((q) => q.id === id);
        const questions = this.state.questions.filter((q) => q.id !== id);
        this.set({ questions });
        if (resolved?.sessionId && !this.sessionStillNeedsAction(resolved.sessionId)) {
          this.updateSessionRow(resolved.sessionId, { status: "idle", needsAction: false });
        }
        return;
      }
      case "models.list": {
        const e = event as any;
        // Broadcast to all paired clients: ignore another session's list.
        if (e.sessionId && this.state.activeSessionId && e.sessionId !== this.state.activeSessionId) return;
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
          !this.state.activeSessionId && this.draftModel
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
          const stillValid = configuredModels.find((m) => sameModel(m, this.state.currentModel));
          current = flagged ?? stillValid ?? configuredModels[0]!;
        }
        this.set({
          models,
          // The runtime this list was resolved for (undefined from an older node
          // → null "unknown", which seedDraftAgentModel treats as "trust it").
          modelsRuntimeId: e.runtimeId != null ? String(e.runtimeId) : null,
          currentModel: current,
          currentModelId: current?.id ?? null,
          ...(e.thinking ? { thinking: normalizeThinking(e.thinking) } : {}),
        });
        return;
      }
      case "model.updated": {
        const e = event as any;
        if (e.sessionId && this.state.activeSessionId && e.sessionId !== this.state.activeSessionId) return;
        const model = e.model ? normalizeModels([e.model])[0]! : this.state.currentModel;
        this.set({
          currentModel: model,
          currentModelId: model?.id ?? this.state.currentModelId,
          models: this.state.models.map((m) => ({ ...m, current: sameModel(m, model) })),
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
        const runtimes = (e.runtimes as RuntimeInfo[]) || this.state.runtimes;
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
        const cur = e.current || runtimes.find((a) => a.id === (this.state.selectedAgentId || e.activeAgent));
        const selectedAgentId = cur?.id || e.activeAgent || this.state.selectedAgentId;
        this.set({
          runtimes,
          selectedAgentId,
          currentAgentName: agentLabel(runtimes.find((a) => a.id === selectedAgentId) || cur) || this.state.currentAgentName,
          ...(e.type === "runtime.updated" ? { installingRuntimeId: null } : {}),
        });
        return;
      }
      case "runtime.install.done": {
        const e = event as any;
        this.set({
          runtimes: (e.runtimes as RuntimeInfo[]) || this.state.runtimes,
          installingRuntimeId: null,
        });
        return;
      }
      case "runtime.install.error": {
        const e = event as any;
        this.set({
          runtimes: (e.runtimes as RuntimeInfo[]) || this.state.runtimes,
          installingRuntimeId: null,
          error: String(e.error || "Install failed"),
        });
        return;
      }
      case "repos.list": {
        const e = event as any;
        this.set({
          repos: Array.isArray(e.repos) ? (e.repos as RepoInfo[]) : [],
          reposAuthed: e.authed !== false,
          reposError: e.error || null,
          reposLoading: false,
        });
        return;
      }
      case "branches.list": {
        const e = event as any;
        this.set({
          branches: Array.isArray(e.branches) ? (e.branches as BranchInfo[]) : [],
          branchesRepo: typeof e.repo === "string" && e.repo ? e.repo : null,
          branchesDefault: typeof e.defaultBranch === "string" ? e.defaultBranch : null,
          branchesError: e.error || null,
          branchesLoading: false,
        });
        return;
      }
      case "providers.list": {
        const e = event as any;
        const providers = Array.isArray(e.providers) ? (e.providers as ProviderInfo[]) : [];
        // A configured provider we were managing → refresh its auth detail too.
        this.set({ providers });
        return;
      }
      case "provider.auth": {
        this.set({ providerAuth: event as unknown as ProviderAuth });
        return;
      }
      case "models.custom.list": {
        const e = event as any;
        if (Array.isArray(e.providers)) this.set({ localModels: e.providers as LocalModelProvider[] });
        return;
      }
      case "models.custom.presets": {
        const e = event as any;
        if (Array.isArray(e.presets)) this.set({ localModelPresets: e.presets as LocalModelPreset[] });
        return;
      }
      case "rulesets.list": {
        const e = event as any;
        if (Array.isArray(e.rulesets)) this.set({ rulesets: e.rulesets as RulesetInfo[] });
        return;
      }
      case "stt.config": {
        const e = event as any;
        if (Array.isArray(e.providers) && typeof e.provider === "string") {
          this.set({ sttConfig: { provider: e.provider, providers: e.providers } as SttConfig });
        }
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
            status: e.error ? undefined : "Waiting for sign-in…",
            error: e.error,
          },
        });
        return;
      }
      case "node.settings": {
        const e = event as any;
        if (e.settings && typeof e.settings === "object") this.set({ nodeSettings: e.settings as NodeSettings });
        return;
      }
      case "auth.oauth.progress": {
        const e = event as any;
        if (this.state.oauth && this.state.oauth.id === e.id) {
          this.set({ oauth: { ...this.state.oauth, status: String(e.message || "") } });
        }
        return;
      }
      case "auth.oauth.done": {
        const e = event as any;
        if (!this.state.oauth || this.state.oauth.id === e.id) this.set({ oauth: null });
        return;
      }
      case "auth.oauth.error": {
        const e = event as any;
        if (this.state.oauth && this.state.oauth.id === e.id) {
          this.set({ oauth: { ...this.state.oauth, error: String(e.error || "sign-in failed"), status: undefined } });
        }
        return;
      }
      case "github.app.manifest.ready": {
        const e = event as any;
        this.set({
          githubApp: {
            ...(this.getState().githubApp || { phase: "idle" }),
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
            ...(this.getState().githubApp || { phase: "idle" }),
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
            ...(this.getState().githubApp || { phase: "idle" }),
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
          this.updateSessionRow(sid, {
            status: justFinished ? "idle" : "working",
            needsAction: false,
            ...(justFinished ? { updatedAt: Date.now(), finishedAt: Date.now() } : {}),
          });
        }
        if (sid && this.state.activeSessionId && sid !== this.state.activeSessionId) return;
        if (sid && !this.state.activeSessionId) return;
        if (inner && inner.type) {
          // A runtime that emits a bare session.error inside this envelope (e.g. a
          // CLI adapter's credential preflight) doesn't tag the inner event with a
          // sessionId. Carry the envelope's sid onto it so the top-level
          // session.error case attributes it to *this* chat and renders it inline
          // rather than as a disconnected global toast.
          const innerWithSid = sid && !(inner as { sessionId?: unknown }).sessionId ? { ...inner, sessionId: sid } : inner;
          this.apply(innerWithSid);
        }
        return;
      }
      case "session.usage": {
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        const usage = normalizeUsage(e.usage);
        if (usage) this.set({ usage });
        return;
      }
      case "node.stats": {
        const stats = normalizeNodeStats((event as any).stats);
        if (stats) this.set({ nodeStats: stats });
        return;
      }
      case "session.warning": {
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        if (e.warning) this.pushEntry({ id: nextId(), role: "system", text: String(e.warning) });
        return;
      }
      case "session.changes": {
        // Universal Agent Harness: the files the last turn changed, for the
        // active session. Ignore other sessions (this is chrome, not transcript).
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        const files: HarnessFileChange[] = Array.isArray(e.changes) ? e.changes : [];
        if (files.length === 0) { this.set({ changes: null }); return; }
        this.set({ changes: { before: e.before ? String(e.before) : undefined, after: String(e.after ?? ""), files } });
        return;
      }
      case "session.rewound": {
        // Files were restored to a checkpoint — clear the "changed this turn"
        // card and note it in the transcript for provenance.
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        this.set({ changes: null });
        this.pushEntry({ id: nextId(), role: "system", text: "Rewound the workspace to an earlier checkpoint." });
        return;
      }
      case "session.checkpoints": {
        // The harness checkpoint timeline for the active session (rewind targets).
        const e = event as any;
        if (this.isForeignSessionEvent(e.sessionId)) return;
        const checkpoints: Checkpoint[] = Array.isArray(e.checkpoints)
          ? e.checkpoints.map((c: any) => ({ id: String(c.id ?? ""), label: String(c.label ?? "checkpoint"), createdAt: Number(c.createdAt ?? 0) })).filter((c: Checkpoint) => c.id)
          : [];
        this.set({ checkpoints });
        return;
      }
      case "session.paused": {
        const sid = String((event as any).sessionId || "");
        if (sid && !this.state.pausedSessionIds.includes(sid)) {
          this.set({ pausedSessionIds: [...this.state.pausedSessionIds, sid] });
        }
        return;
      }
      case "session.resumed": {
        const sid = String((event as any).sessionId || "");
        if (sid) this.set({ pausedSessionIds: this.state.pausedSessionIds.filter((id) => id !== sid) });
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
      default:
        this.applyStreamEvent(event);
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
      if (sessionId && sessionId === this.state.activeSessionId) this.requestFreshHistory?.();
      return;
    }
    const full = isAppend ? prev!.messages.concat(incoming) : incoming;
    const count = typeof e.count === "number" ? e.count : full.length;
    const historyHash = typeof e.historyHash === "string" ? e.historyHash : "";
    if (sessionId) {
      this.historyRaw.set(sessionId, { messages: full, count, historyHash });
      if (historyHash) this.onHistoryPersist?.(sessionId, full, count, historyHash);
    }
    const rendered = this.withInlineImageRefs(this.withCachedAttachments(renderHistory(full)));
    if (sessionId) this.cacheTranscript(sessionId, rendered);
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
      this.state.activeSessionId === sessionId ||
      (this.state.activeSessionId === null && Boolean(e.requestId));
    if (!adopt) return;
    this.draft = freshDraft();
    this.deferredHistory = null;
    // Open-paint delivered; subsequent unsolicited mid-turn snapshots defer again.
    this.awaitingOpenHistory = false;
    // Keep optimistic prompts the node hasn't confirmed yet: a new session's
    // history is empty, so a bare replace would drop the message the user just
    // sent. They're cleared as the node echoes each one (session.user_message).
    this.set({
      activeSessionId: sessionId,
      activeRuntimeId: e.runtimeId ? String(e.runtimeId) : this.state.activeRuntimeId,
      activeTitle: e.name || this.state.activeTitle,
      currentAgentName: e.agentName || this.state.currentAgentName,
      github: githubContext(e),
      transcript: this.withPendingUserEntries(rendered),
      working: Boolean(e.isStreaming),
      opening: false,
      usage: normalizeUsage(e.usage),
    });
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
    if (this.state.opening) this.set({ opening: false });
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
    else this.applyHistory(pending, (pending.sessionId as string) || this.state.activeSessionId);
  }

  private pushEntry(entry: TranscriptEntry): void {
    this.set({ transcript: [...this.state.transcript, entry] });
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
    const transcript = this.state.transcript;
    // Turn boundary: the last user message. The final bubble must belong to THIS
    // turn, never an earlier turn's reply.
    let turnStart = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i]!.role === "user") { turnStart = i; break; }
    }
    // Final assistant prose bubble of the turn: assistant role, has text, not a
    // tool card, and not itself an attachment entry.
    let target = -1;
    for (let i = transcript.length - 1; i > turnStart; i--) {
      const e = transcript[i]!;
      if (e.role === "assistant" && !e.tool && e.text && !(e.attachments && e.attachments.length)) { target = i; break; }
    }
    const chips = buffered.map((b) => b.attachment);
    if (target >= 0) {
      this.set({
        transcript: transcript.map((e, i) => (i === target ? { ...e, attachments: [...(e.attachments ?? []), ...chips] } : e)),
      });
    } else {
      // No prose this turn — keep each attachment as its own entry (with caption),
      // preserving the pre-grouping behaviour for the caption-only case.
      this.set({ transcript: [...transcript, ...buffered.map((b) => ({ id: nextId(), role: "assistant" as const, text: b.caption, attachments: [b.attachment] }))] });
    }
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
      branch?: string;
      prUrl?: string;
      prs?: PrRef[];
      updatedAt?: number;
      finishedAt?: number;
    },
  ): void {
    if (!sessionId) return;
    let changed = false;
    const sessions = this.state.sessions.map((s) => {
      if (s.sessionId !== sessionId) return s;
      const next = { ...s, ...patch };
      // A session the user is actively viewing counts as "seen" the moment any
      // live update lands on it — otherwise the row you're already looking at
      // would flash the same "unseen" treatment as one that finished while you
      // were elsewhere (see SessionSummary.lastSeenAt / isUnseen).
      if (sessionId === this.state.activeSessionId) next.lastSeenAt = Date.now();
      if (
        next.status !== s.status ||
        next.needsAction !== s.needsAction ||
        next.branch !== s.branch ||
        next.prUrl !== s.prUrl ||
        JSON.stringify(next.prs) !== JSON.stringify(s.prs) ||
        next.updatedAt !== s.updatedAt ||
        next.lastSeenAt !== s.lastSeenAt ||
        next.finishedAt !== s.finishedAt
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
    if (!sessionId || sessionId === this.state.activeSessionId) {
      this.set({ github: { ...this.state.github, prUrl: openUrl, prs } });
    }
  }

  /** Whether a session still has anything outstanding that should keep its
   *  sidebar dot on "needs your response" — a pending approval OR a pending
   *  clarifying question. Shared by approval.resolved/removed and
   *  session.question.resolved so resolving one kind can't clear the dot out
   *  from under the other kind still pending on the same session (see the
   *  regression test covering exactly that ordering in store.test.ts). */
  private sessionStillNeedsAction(sessionId: string): boolean {
    return this.state.approvals.some((a) => a.sessionId === sessionId) || this.state.questions.some((q) => q.sessionId === sessionId);
  }

  /**
   * Whether a per-session "chrome" event (usage, changes, checkpoints, warnings,
   * errors) belongs to a session other than the one on screen — and so must not
   * be rendered into the current view.
   *
   * Crucially this treats a fresh *draft* (activeSessionId === null) as matching
   * nothing: an event that names a concrete session is foreign to a draft. The
   * older guard (`sessionId && activeSessionId && sessionId !== activeSessionId`)
   * skipped this filter entirely while activeSessionId was null, so a late
   * `session.changes`/`session.usage`/`session.checkpoints` broadcast from the
   * session the user just left would leak its "files changed this turn" card,
   * usage bar and history onto the brand-new empty draft. Global events (no
   * sessionId — connection/relay errors) still pass, since they belong nowhere in
   * particular and should surface wherever the user is.
   */
  private isForeignSessionEvent(sessionId: unknown): boolean {
    return Boolean(sessionId) && sessionId !== this.state.activeSessionId;
  }

  private replaceEntry(id: string, patch: Partial<TranscriptEntry>): void {
    this.set({ transcript: this.state.transcript.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  }

  private setWorking(label: string): void {
    this.set({ working: true, workingLabel: label });
  }

  private toolEventId(event: ServerEvent): string {
    const explicit = toolCallId(event as any);
    if (explicit) return explicit;
    const name = toolName(event as any);
    const input = toolInput(event as any) as Record<string, unknown>;
    const target = String(input?.command || input?.cmd || input?.path || input?.file || input?.filePath || input?.query || input?.stream || "");
    if (!target && name !== "agent_output" && name !== "stderr" && name !== "stdout") return nextId();
    return `${name}:${target}`;
  }

  private workingLabelForTool(event: ServerEvent): string {
    const name = toolName(event as any);
    if (name === "agent_output" || name === "stderr" || name === "stdout") return "Reading agent output…";
    return `Running ${name}…`;
  }

  /** Streaming turn events (message_start/update/end, tool start/update/result, agent_start/end). */
  private applyStreamEvent(event: ServerEvent): void {
    const kind = eventKind(event as any);
    switch (kind) {
      case "agent_start":
      case "turn_start":
        this.draft.finalized = false;
        this.setWorking(kind === "agent_start" ? "Planning…" : "Thinking…");
        return;
      case "message_start":
        if ((event as any).message?.role === "assistant") {
          this.draft = freshDraft(false);
          this.setWorking("Drafting response…");
        }
        return;
      case "attachment": {
        // An agent-sent attachment (image or file). Buffer it and render it at the
        // turn boundary under the turn's final assistant bubble, rather than as a
        // standalone entry at the moment `bivy attach` ran — which lands mid-turn,
        // between tool cards and the reply, reading as detached. Grouping matches
        // how user uploads render under their own message. Durable history
        // reproduces the same grouping (see groupAgentAttachments in renderHistory).
        const ref = (event as any).ref;
        if (!ref || typeof ref.hash !== "string" || (ref.kind !== "image" && ref.kind !== "file")) return;
        const caption = typeof (event as any).caption === "string" ? (event as any).caption : "";
        this.pendingAgentAttachments.push({ attachment: attachmentFromRef(ref), caption });
        return;
      }
      case "inlineImage": {
        // The node finished fetching a remote markdown image (#293). Cache the
        // ref, then patch it onto any already-rendered assistant entry whose raw
        // markdown references this exact URL — a new object identity for that
        // entry is what makes ChatView's hydrate effect notice and swap in a
        // blob: URL. A URL nobody's current transcript mentions yet (already
        // scrolled past the initial window, or a race with the render) still
        // ends up correct once withInlineImageRefs runs on the next full render,
        // since the cache itself was updated either way.
        const url = (event as any).url;
        const ref = (event as any).ref;
        if (typeof url !== "string" || !url || !ref || typeof ref.hash !== "string") return;
        this.inlineImagesByUrl.set(url, ref);
        let changed = false;
        const transcript = this.state.transcript.map((e) => {
          if (e.role !== "assistant" || !e.text || e.imageRefs?.[url] || !e.text.includes(url)) return e;
          changed = true;
          return { ...e, imageRefs: { ...(e.imageRefs ?? {}), [url]: ref } };
        });
        if (changed) this.set({ transcript });
        return;
      }
      case "message_update":
      case "message_end": {
        const msg = (event as any).message;
        if (msg?.role !== "assistant") return;
        const text = contentToText(msg.content).trim();
        // Remember the latest prose so a tool boundary can seal it (below). Guard
        // on `text` so a reasoning-only update (content:[{thinking}] → text:"")
        // can't wipe prose the model already produced this turn.
        if (text) this.draft.pendingText = text;
        const finalize = kind === "message_end";
        // Reasoning can arrive two ways: as an accumulated `thinking` block on
        // the message, or (for runtimes that only stream reasoning) as
        // incremental `thinking_delta` / `thinking_end` on the event itself. Keep
        // folding the deltas in on every update so the finished block is whole —
        // even though we only commit it to the transcript once the turn ends.
        const blockThinking = contentThinking(msg.content).trim();
        const thinking = this.resolveThinking(event, blockThinking);
        if (thinking && !text) this.draft.sawThinking = true;
        // Token-by-token rendering was too laggy in the web chat: every update
        // re-ran the markdown pass and re-rendered the row. Show whole messages
        // instead — commit the assistant prose / reasoning only when the message
        // finishes. Tools are still applied live below so tool cards appear as
        // they happen, and the "working" indicator keeps the turn feeling alive.
        if (finalize) {
          // Commit the trailing reasoning run (a tool boundary already sealed any
          // reasoning that preceded a tool this segment; this is what's left).
          this.commitPendingThinking();
          // Commit the trailing prose run (everything since the last tool boundary
          // sealed a run — see commitPendingProse). Classification into an error
          // bubble happens there: the runtime can only ever hand failures to us as
          // assistant prose (the claude CLI prints API/auth errors that way, not as
          // a structured error), so an error-shaped run becomes a red bubble.
          this.commitPendingProse();
          this.draft.finalized = true;
        } else {
          // Keep the working label honest, and only when it actually changes so
          // we don't notify on every update.
          const label = text ? "Drafting response…" : "Thinking…";
          if (this.state.workingLabel !== label || !this.state.working) this.setWorking(label);
          // Show the in-flight prose as a live streaming bubble so a session the
          // user just switched back to (or is watching continuously) reflects the
          // agent's current answer immediately — instead of nothing until
          // message_end, which mid-turn is several seconds away and reads as a
          // stale, frozen transcript. Rendered as plain text (no per-update
          // markdown/highlight pass — that O(n²) churn is the reason streaming
          // prose was originally deferred to boundaries); commitPendingProse
          // swaps in the rendered markdown when the run seals.
          this.previewPendingProse();
        }
        for (const tool of toolEntriesFromContent(msg.content)) this.applyTool(tool);
        return;
      }
      case "start":
        // Seal any reasoning and prose the model produced BEFORE this tool call so
        // its card lands after them, not hoisted above (matching renderHistory's
        // block-walk). Tools stream as their own events while reasoning/prose
        // commit at message_end, so without this the card jumps ahead of the text.
        // Reasoning first, then prose — the source order within a segment.
        this.commitPendingThinking();
        this.commitPendingProse();
        this.finishDrafts();
        this.applyTool({
          callId: this.toolEventId(event),
          name: toolName(event as any),
          input: toolInput(event as any),
          status: "running",
        });
        this.setWorking(this.workingLabelForTool(event));
        return;
      case "update":
        this.applyTool({
          callId: this.toolEventId(event),
          name: toolName(event as any),
          input: toolInput(event as any),
          status: "running",
        });
        this.setWorking(this.workingLabelForTool(event));
        return;
      case "result":
        this.applyTool({
          callId: this.toolEventId(event),
          name: toolName(event as any),
          input: {},
          status: "done",
          result: typeof (event as any).result === "string" ? (event as any).result : contentToText((event as any).result),
        });
        return;
      case "turn_end":
        // Land any attachments emitted this turn under its final assistant bubble.
        this.flushPendingAgentAttachments();
        this.setWorking("Planning next step…");
        return;
      case "agent_end":
        this.finishDrafts();
        // finishDrafts sealed the final prose bubble; now group this turn's
        // attachments onto it (no-op if turn_end already flushed them).
        this.flushPendingAgentAttachments();
        this.closeRunningTools();
        // Clear the prose accumulator so a next turn that opens straight into a
        // tool (no message_start first) can't re-commit this turn's prose above
        // that tool's card.
        this.draft.pendingText = "";
        this.draft.committedText = "";
        this.draft.committedThinking = "";
        this.set({ working: false, workingLabel: "" });
        this.drainDeferredHistory();
        this.onSessionSettled?.();
        return;
      default:
        return;
    }
  }

  /**
   * The reasoning text to show for a streamed assistant event. The message's
   * accumulated `thinking` block wins when present; otherwise fold the event's
   * incremental `thinking_delta` chunks into the draft accumulator (and take a
   * `thinking_end` as the final full text) so reasoning-only streams still show.
   */
  private resolveThinking(event: any, blockThinking: string): string {
    if (blockThinking) {
      this.draft.thinkingText = blockThinking;
      return blockThinking;
    }
    const delta = eventThinkingDelta(event);
    if (delta.kind === "delta") this.draft.thinkingText += delta.text;
    else if (delta.kind === "full") this.draft.thinkingText = delta.text;
    return this.draft.thinkingText.trim();
  }

  /**
   * Commit the prose accumulated since the last commit as its own finished
   * bubble. Called at each tool boundary (so a tool card can't hoist above the
   * prose that preceded it) and at message_end (the trailing run). Only the
   * not-yet-committed suffix is emitted: `pendingText` is the whole prose the
   * runtime has streamed this draft (cumulative for Codex, per-segment for
   * Claude — a fresh draft resets both fields), and `committedText` is what
   * already landed, so a runtime that keeps growing one message and one that
   * resets per segment both interleave correctly. Each run is a separate entry,
   * matching renderHistory's block-walk. An error-shaped run becomes a red
   * bubble (see the message_end note).
   */
  private commitPendingProse(): void {
    const full = this.draft.pendingText;
    const committed = this.draft.committedText;
    const tail = (full.startsWith(committed) ? full.slice(committed.length) : full).trim();
    if (!tail) return;
    this.draft.committedText = full;
    if (looksLikeAgentError(tail)) {
      // A run that turns out to be an agent error becomes a red bubble. Drop any
      // in-flight streaming preview for this run first so it isn't left dangling
      // as a plain-text bubble above the error.
      if (this.draft.assistantId) {
        this.removeEntry(this.draft.assistantId);
        this.draft.assistantId = null;
      }
      this.pushEntry({ id: nextId(), role: "error", text: humanizeError(tail) });
      return;
    }
    // Seal this run's bubble as rendered markdown. When previewPendingProse
    // already pushed a live (plain-text, streaming) preview for it, upsertDraft
    // reuses that entry via draft.assistantId and swaps in the HTML in place;
    // otherwise it pushes a fresh finished bubble. Either way upsertDraft clears
    // assistantId on finalize, so the next run (after a tool boundary) starts its
    // own bubble.
    this.upsertDraft("assistant", tail, true);
  }

  /**
   * Paint the not-yet-committed prose of the current draft as a live streaming
   * bubble (plain text, no markdown pass) so an actively-streaming turn shows its
   * progress the instant the user is looking — most visibly when they switch back
   * to a session mid-turn. The finished, markdown-rendered bubble replaces it at
   * the next tool boundary / message_end via commitPendingProse (which reuses the
   * same draft.assistantId entry). Mirrors commitPendingProse's tail arithmetic so
   * cumulative (Codex) and per-segment (Claude) runtimes both preview correctly; a
   * run that only classifies as an error once complete is handled at commit, so a
   * partial that merely looks error-shaped mid-stream isn't special-cased here.
   */
  private previewPendingProse(): void {
    const full = this.draft.pendingText;
    const committed = this.draft.committedText;
    const tail = (full.startsWith(committed) ? full.slice(committed.length) : full).trim();
    if (!tail) return;
    this.upsertDraft("assistant", tail, false);
  }

  /**
   * Commit the reasoning accumulated since the last commit as its own finished
   * thinking bubble. Mirrors commitPendingProse: called at each tool boundary (so
   * a tool card can't hoist above the reasoning that preceded it) and at
   * message_end (the trailing run). Gated on `sawThinking` so we keep the existing
   * rule — only reasoning that appeared before any answer text becomes a separate
   * bubble. Only the not-yet-committed suffix is emitted, so a runtime that streams
   * one growing thinking block and one that resets per segment both interleave.
   */
  private commitPendingThinking(): void {
    if (!this.draft.sawThinking) return;
    const full = this.draft.thinkingText;
    const committed = this.draft.committedThinking;
    const tail = (full.startsWith(committed) ? full.slice(committed.length) : full).trim();
    if (!tail) return;
    this.draft.committedThinking = full;
    // Each committed run is its own bubble; drop the reuse handle so upsertDraft
    // pushes a fresh entry rather than replacing the previous run.
    this.draft.thinkingId = null;
    this.upsertDraft("thinking", tail, true);
  }

  private upsertDraft(which: "assistant" | "thinking", text: string, finalize: boolean): void {
    const role: TranscriptRole = which === "assistant" ? "assistant" : "thinking";
    const idField = which === "assistant" ? "assistantId" : "thinkingId";
    // Only render markdown once the run is finalized. A streaming assistant
    // preview updates on every coalesced message_update, so running toHtml (plus
    // syntax highlighting) each time is the O(n²) churn we deliberately avoid —
    // the view renders the streaming entry's plain `text` and computes markdown
    // only when it seals (see EntryView in ChatView).
    const html = role === "assistant" && finalize ? toHtml(text) : undefined;
    let id = this.draft[idField];
    if (!id) {
      id = nextId();
      this.draft[idField] = id;
      this.pushEntry({ id, role, text, html, streaming: !finalize });
    } else {
      this.replaceEntry(id, { text, html, streaming: !finalize });
    }
    if (finalize) this.draft[idField] = null;
  }

  private removeEntry(id: string): void {
    this.set({ transcript: this.state.transcript.filter((e) => e.id !== id) });
  }

  private finishDrafts(): void {
    const { assistantId, thinkingId } = this.draft;
    if (assistantId) this.replaceEntry(assistantId, { streaming: false });
    if (thinkingId) this.replaceEntry(thinkingId, { streaming: false });
    this.draft.assistantId = null;
    this.draft.thinkingId = null;
  }

  private applyTool(tool: ToolActivity): void {
    const transcript = [...this.state.transcript];
    mergeToolInto(transcript, tool);
    this.set({ transcript });
  }

  /**
   * Force any tool activity card still marked "running" to "done" once the
   * turn is over. A tool only ever completes today via the runtime's own
   * tool-result echo (see src/runtime/claude-code.ts's `case "user"`) — if
   * the turn ends without one (aborted mid-tool, the process crashed, an
   * error subtype with no matching toolUseId), that echo never arrives and
   * the card would otherwise spin forever even though nothing is running
   * anymore. agent_end is the one point every turn reaches regardless of how
   * it ended, so it's the right backstop rather than special-casing abort.
   */
  private closeRunningTools(): void {
    let changed = false;
    const transcript = this.state.transcript.map((e) => {
      if (!e.tool || e.tool.status !== "running") return e;
      changed = true;
      return { ...e, tool: { ...e.tool, status: "done" as const } };
    });
    if (changed) this.set({ transcript });
  }
}
