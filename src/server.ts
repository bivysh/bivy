// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { listRuntimes, catalogRuntimes, cliInstallSpec, invalidateCliProbeCache, isCliAgentId, type AgentCommand, type AgentRuntime, type DiscoveredNativeSession, type OpenSessionOptions, type OpenSessionResult, type RuntimeCapabilities, type RuntimeEvent, type RuntimeMessage, type RuntimeSession, type SessionSummary, type ToolInterceptor, type UsageSnapshot } from "./runtime/index.js";
import { createRunPolicy, type RunPolicy } from "./policy/run-policy.js";
import { DEFAULT_BACKOFF, type Ruleset } from "./policy/ruleset.js";
import { SessionRerouteController, type ResumePlan } from "./policy/session-reroute.js";
import { listRulesetInfos, upsertRuleset, removeRuleset, activeRulesetFor } from "./runtime/ruleset-store.js";
import { collectDiscoveredSessions, planNativeAdoption, type NativeAdoptionPlan } from "./runtime/native-session-discovery.js";
import { aggregateModelCatalog, mergeProviderCatalog } from "./runtime/model-catalog.js";
import { RuntimeHost, enforcementLevelFor, remoteRuntimeEnabled } from "./runtime/host.js";
import { RemoteRuntime, RemoteRuntimeSession } from "./runtime/remote.js";
import { InMemorySessionLocationRegistry, type SessionLocation, type SessionLocationRegistry } from "./runtime/session-location.js";
import { InMemoryLocationRegistry } from "./runtime/location-registry.js";
import { ControlPlaneSessionLocationRegistry, LayeredSessionLocationRegistry, type NodeSessionRow } from "./runtime/control-plane-location.js";
import { attachAdoptedSessions, classifyAttachFailure } from "./runtime/adoption.js";
import { createCredentialStore } from "./runtime/credentials.js";
import { isModelAuthError, authProviderForSession } from "./runtime/auth-errors.js";
import { createCredentialVault, migrateVaultDir } from "./runtime/credential-store.js";
import { provisionAgentRun } from "./runtime/credential-provisioning.js";
import { ingestAgentCredentials } from "./runtime/credential-ingest.js";
import { suggestNameFromSelectedModel } from "./runtime/model-namer.js";
import { isNativeOAuthProvider, loginModelOAuth, type AuthEvent, type AuthPrompt } from "./runtime/oauth/model-oauth.js";
import { decideOAuthLoginSweep } from "./runtime/oauth/oauth-login-sweep.js";
import { listCodexSessions, loadCodexTranscript, discoverCodexSessionForCwd } from "./runtime/codex-sessions.js";
import { dedupeSessionSummaries } from "./session-identity.js";
import { discoverPiSessionForCwd } from "./runtime/pi-session-discovery.js";
import type { BivySessionRecord, BivySessionSource, BivySessionStatus } from "./session/bivy-session.js";
import { exportProviderAuth, exportProviderAuthTombstones, importProviderAuth, listProviders, removeProvider, setProviderApiKey, setProviderCredential } from "./runtime/pi-auth.js";
import {
  loadLocalModels,
  upsertLocalProvider,
  removeLocalProviderEntry,
  listLocalProviderSummaries,
  exportLocalModels,
  importLocalModels,
  toPiModelsConfig,
  normalizeProviderId,
  type LocalModelsConfig,
} from "./runtime/local-model-store.js";
import { execEphemeralRequest, type EphemeralExecRequest } from "./ephemeral-exec.js";
import { ApprovalManager, type ApprovalRequest } from "./approval.js";
import { QuestionManager, validQuestions, isAskUserQuestionTool, formatQuestionResult } from "./question.js";
import { NodeIdentity } from "./identity.js";
import { collectNodeStats } from "./node-stats.js";
import { SessionEventCoalescer } from "./session-event-coalescer.js";
import { authMiddleware, resolveAuth, isAuthorized, requestOriginAllowed } from "./auth.js";
import { RelayConnector, loadRelayConfig, type ClientMessage } from "./relay-client.js";
import { readEphemeralTeardownConfig, shouldSelfTeardown, performSelfTeardown } from "./ephemeral-teardown.js";
import { buildSessionSnapshot, applySessionSnapshot } from "./session/snapshot.js";
import { createCheckpointBundle, applyCheckpointBundle, materializeCheckpoint } from "./session/checkpoint-pack.js";
import { configuredTurnTimeoutMs } from "./session/turn-watchdog.js";
import { forceAbortTurn } from "./session/abort-recovery.js";
import { runRequiredAutomationChecks } from "./automation-checks.js";
import type { ApprovalMode } from "./guard.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { TerminalManager } from "./terminal.js";
import { commandLaunch } from "./command-launch.js";
import { listMultiplexerSessions, attachCommand, type MultiplexerKind } from "./multiplexer.js";
import { createWorktree, removeWorktree, branchSlug, gitRepoRoot, type Worktree } from "./worktree.js";
import { HarnessManager } from "./harness/manager.js";
import { startEgressProxyIfEnabled, applySessionSandboxEgress, stopSessionEgress } from "./harness/egress.js";
import { initSharedDepCache, sharedDepCacheRoot } from "./harness/dep-cache.js";
import { evictToCap, dirSizeBytes } from "./harness/cache-evict.js";
import { checkDiskAdmission } from "./harness/disk-admission.js";
import { sandboxTier, setConfiguredSandboxTier, normalizeSandboxTier, type SandboxTier } from "./harness/sandbox.js";
import { setConfiguredAutoAttachToolImages } from "./harness/tool-image-attachments.js";
import { injectMcpProxyForSession, injectBivyToolsForSession } from "./harness/mcp-inject.js";
import { parseRepo, inferGitHubRepoFromWorkspace, isSharedCloneRoot, resolveGitHubToken, ghCliInstalled, cloneOrUpdateRepo, resolveDefaultBaseRef, resolveBranchBaseRef, resolveAdoptBaseRef, fetchOrigin, type ParsedRepo } from "./repo-workspace.js";
import { configureGitAuth, writeGitCredentialEndpoint } from "./git-auth.js";
import {
  GitHubTaskPoller,
  resolveGitHubTaskConfig,
  buildTaskPrompt,
  buildResumePrompt,
  buildInteractiveResumePrompt,
  DEFAULT_ISSUE_INSTRUCTIONS,
  parseBivyDirectives,
  commitAll,
  pushBranch,
  mergeBaseIntoBranch,
  completeMerge,
  abortMerge,
  openPullRequest,
  findOpenPullRequestForBranch,
  findPullRequestsForBranch,
  findMergedPullRequestForBranch,
  issueBranchName,
  getPullRequest,
  commentIssue,
  listOpenLabelledIssues,
  selectActionableIssues,
  getIssue,
  getIssueCommentBody,
  addLabel,
  removeLabel,
  announcePickup,
  type GitHubTaskConfig,
  type GitHubIssue,
} from "./github-tasks.js";
import { buildLinearTaskPrompt, getLinearIssue, linearBranchName } from "./linear-tasks.js";
import { PairingStore } from "./device-registry.js";
import { IntegrationManager, type SessionIdRef } from "./integrations/index.js";
import { historyDelta, type HistoryCursor } from "./history-sync.js";
import { MetadataStore, type MetadataSession, type PrRef } from "./metadata.js";
import { resolveResumeRef, resumeRefFor } from "./session-ref.js";
import { buildForkBundle, materializeFork, type ForkBundle, type ForkRecord, type ForkPlan } from "./session/fork.js";
import { captureDirtyPatch, applyDirtyPatch } from "./session/fork-dirty.js";
import { thinkingTextFromContent } from "./session/transcript-merge.js";
import { normalizeMessages } from "./session/transcript-normal.js";
import { buildNativeImportSeedPrompt } from "./session/native-import.js";
import { EventLog } from "./session/event-log.js";
import { revertFile } from "./session/revert-file.js";
import { buildDiagnosticsReport, activationRecord } from "./diagnostics.js";
import { AttachmentStore, isValidAttachmentHash, type AttachmentRef } from "./session/attachment-store.js";
import { planAttachment, isAttachPlanError, MAX_AGENT_ATTACHMENT_BYTES } from "./session/attach-to-chat.js";
import {
  extractInlineImageUrls,
  assistantTextForImageScan,
  fetchInlineImage,
  isFetchImageError,
  inlineImageDisplayName,
} from "./session/inline-image-fetch.js";
import { ReplicationService } from "./session/replication-service.js";
import type { ReplWireFrame } from "./session/replicator.js";
import { createSessionNewDedupe } from "./session/session-new-dedupe.js";
import { evaluateForkPrereqs, blockingForkPrereqs, missingForkPrereqs, type ForkPrereqInput, type ForkPrereq } from "./session/fork-prereqs.js";
import { SecretVault, resolveSecret } from "./secrets.js";
import { deviceFlowClientId, requestDeviceCode, pollAccessTokenOnce, REPO_CONNECT_SCOPE, type DeviceCode } from "./github-device-auth.js";
import { InstallationTokenCache, createAppJwt, resolveInstallationId, type GitHubAppConfig } from "./github-app-auth.js";
import {
  loadGitHubAppConfigs,
  orderAppsForOwner,
  listGitHubApps,
  removeGitHubApp,
  upsertGitHubApp,
  privateKeyIdFor,
  type GitHubAppRecord,
} from "./github-apps.js";
import { buildAppManifest, convertManifest, renderManifestForm } from "./github-app-manifest.js";
import {
  encryptGithubAppEnvelope,
  decryptGithubAppEnvelope,
  readLocalGithubAppVaultKey,
  writeLocalGithubAppVaultKey,
  forgetLocalGithubAppVaultKey,
  mintLocalGithubAppVaultKey,
} from "./github-app-vault.js";
import { redactSecrets } from "./redact.js";
import {
  getSttConfig,
  isSttProvider,
  removeSttKey,
  setSttKey,
  setSttProvider,
  transcribeAudio,
  MAX_AUDIO_BYTES,
  type SttProvider,
} from "./stt.js";
import { seal, open } from "./e2e.js";
import {
  ControlPlaneTaskPoller,
  resolveControlPlaneTaskConfig,
  type WorkItem as ControlPlaneWorkItem,
  type EvidencePatch,
} from "./control-plane-tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// Asset root holds read-only bundled files (public/, helper scripts); data dir
// holds writable per-install state (.bivy). Both default to the repo when
// running from source. Packaged/release builds may override them (BIVY_ASSET_ROOT,
// BIVY_DATA_DIR) so it can write outside the read-only app bundle.
const assetRoot = process.env.BIVY_ASSET_ROOT ?? repoRoot;
const appDir = path.resolve(process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy"));
// Load persisted env from cli.json into process.env so config written there —
// e.g. connecting a GitHub App (BIVY_GITHUB_APP_ID / BIVY_GITHUB_HOSTED_TASKS /
// BIVY_NODE_LABEL) — takes effect on the NEXT restart even if the service
// manager's baked-in Environment is stale (the systemd/launchd unit is generated
// from cli.json at install time, so a later config change written to cli.json
// wouldn't otherwise survive a restart, silently stopping queue polling). Only
// fills keys not already set, so an explicit systemd/shell override still wins.
try {
  const cliRaw = JSON.parse(fs.readFileSync(path.join(appDir, "cli.json"), "utf8")) as { env?: Record<string, unknown> };
  if (cliRaw?.env && typeof cliRaw.env === "object") {
    for (const [k, v] of Object.entries(cliRaw.env)) {
      if (typeof v === "string" && process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch {
  // No cli.json / unreadable — fall back to the process env as provided.
}
// Point every agent/terminal subprocess's package managers at one shared
// download cache (npm/yarn/pip/cargo/go) when BIVY_SHARED_DEP_CACHE is set, so N
// session worktrees dedup downloads instead of each re-fetching. Cache-only —
// never changes a project's lockfile or install location. Read after cli.json so
// the flag can be persisted there. See src/harness/dep-cache.ts.
initSharedDepCache(appDir);
// Materialize the git credential helper under the data dir so repo clones can
// authenticate without ever writing a token into their remote URL / .git/config.
configureGitAuth(appDir);
// Never leave the daemon parked in its installed package directory. A global
// npm update atomically replaces that directory while the old process drains;
// any later child process (notably git's remote/credential helpers) then aborts
// before running with "Unable to read current working directory". appDir is the
// durable state root and every workspace/asset path below is already absolute.
// Anchoring the process itself fixes all subprocess paths, not just `git clone`.
process.chdir(appDir);
// Make `bivy update` and user-scoped npm globals available to agents/tools
// launched by the daemon even when the node runs under systemd/launchd with a
// minimal PATH. The installer also symlinks ~/.local/bin/bivy, but adding these
// dirs here makes commands work from agent shells without requiring a user shell
// profile.
const userLocalPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || path.join(process.env.HOME ?? os.homedir(), ".local");
process.env.PATH = [path.join(repoRoot, "bin"), path.join(userLocalPrefix, "bin"), process.env.PATH || ""].filter(Boolean).join(path.delimiter);
const piDir = path.join(appDir, "pi");
// The node's shared, agent-neutral credential vault (auth.enc/auth.key). NOT
// inside any one agent's dir — every runtime (Pi, Codex, Claude, …) reads the
// same vault. Pi's own dir (piDir) keeps only Pi-specific files: models.json,
// the plaintext auth.json its native TUI reads, and its sessions.
const credsDir = path.join(appDir, "credentials");
const sessionsDir = path.join(piDir, "sessions");
const intermediateMessagesDir = path.join(appDir, "intermediate-messages");
const toolActivitiesDir = path.join(appDir, "tool-activities");
// Slice 2 (docs/dramatic-simplification-plan.md): one append-only per-session log.
// It began by superseding the two overlay sidecars above; the base transcript
// (transcripts/, below) is now folded in too, so it is the SOLE store for a
// session's history — overlay detail (reasoning/tool) AND the base conversation.
const eventLogDir = path.join(appDir, "event-log");
// The legacy base-transcript dir (user prompts + assistant text). Superseded by the
// base records in the event log; existing files are migrated in at boot
// (migrateBaseToLog) and then only read as a migration source. Kept on disk as a
// one-cycle recovery net; `transcriptPath` is still used to unlink a deleted
// session's stale file.
const transcriptsDir = path.join(appDir, "transcripts");
const settingsPath = path.join(appDir, "settings.json");
// Bivy owns the local/custom model registry (local-model-store.ts, PI-FREE).
// `<appDir>/local-models.json` is the source of truth; Pi's own `models.json`
// is a regenerated *projection* Pi reads as a downstream consumer — never the
// source. Any mutation to the registry re-emits that projection.
const localModelsDir = appDir;
const piModelsProjectionPath = path.join(piDir, "models.json");

// Keys the projection treats as "no real key" — local servers accept anything,
// so these never enter the encrypted vault as a real key.
const DUMMY_LOCAL_KEYS = new Set(["local", "ollama", "lm-studio", "vllm", "sglang", "none", ""]);

/** The env var a generic (non-Pi) agent reads to reach this endpoint's base URL,
 *  chosen by API family. Injected only for the active provider (see credentials.ts). */
function agentEnvForEndpoint(api: string, baseUrl: string): Record<string, string> {
  const url = String(baseUrl ?? "").trim();
  if (!url) return {};
  const a = String(api ?? "").toLowerCase();
  if (a.startsWith("azure")) return { AZURE_OPENAI_BASE_URL: url };
  if (a.startsWith("anthropic")) return { ANTHROPIC_BASE_URL: url };
  return { OPENAI_BASE_URL: url };
}

type StoredKeyMap = Record<string, { type?: string; key?: string }>;

/** Snapshot of vault credentials, keyed by provider id (best-effort). */
async function currentProviderKeys(): Promise<StoredKeyMap> {
  try {
    return (await exportProviderAuth(credsDir)) as StoredKeyMap;
  } catch {
    return {};
  }
}

/** Regenerate Pi's models.json from Bivy's registry, stitching in vault keys.
 *  The registry holds no secrets — the API key is resolved from the encrypted
 *  vault here, so it only ever lands in this local 0600 derived file. */
async function writePiModelsProjection(cfg?: LocalModelsConfig): Promise<void> {
  const registry = cfg ?? loadLocalModels(localModelsDir);
  const keys = await currentProviderKeys();
  const resolveKey = (id: string) => {
    const c = keys[id];
    return c && c.type === "api_key" ? c.key : undefined;
  };
  try {
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(piModelsProjectionPath, `${JSON.stringify(toPiModelsConfig(registry, resolveKey), null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(piModelsProjectionPath, 0o600); } catch {}
  } catch (error) {
    console.warn("[local-models] could not write Pi projection:", (error as Error).message);
  }
}

/** Redacted summaries for the UI, with `hasKey` derived from the vault. */
async function localModelSummaries() {
  const keys = await currentProviderKeys();
  return listLocalProviderSummaries(localModelsDir, (id) => {
    const c = keys[id];
    return !!c && c.type === "api_key" && !!c.key;
  });
}

/** One-time migration: adopt any pre-existing pi/models.json into Bivy's store,
 *  moving inline API keys into the encrypted vault. */
async function migrateLegacyPiModelsIntoRegistry(): Promise<void> {
  try {
    if (fs.existsSync(path.join(localModelsDir, "local-models.json"))) return; // already own it
    if (!fs.existsSync(piModelsProjectionPath)) return;
    const legacy = JSON.parse(fs.readFileSync(piModelsProjectionPath, "utf8"));
    const providers = legacy?.providers;
    if (!providers || typeof providers !== "object" || !Object.keys(providers).length) return;
    for (const [id, spec] of Object.entries<any>(providers)) {
      const nid = normalizeProviderId(id);
      const key = spec?.apiKey;
      const realKey = key && !DUMMY_LOCAL_KEYS.has(String(key).toLowerCase()) ? String(key) : undefined;
      await setProviderCredential(credsDir, nid, {
        key: realKey,
        env: agentEnvForEndpoint(String(spec?.api ?? ""), String(spec?.baseUrl ?? "")),
      }).catch(() => {});
    }
    importLocalModels(localModelsDir, providers); // normalizeProvider drops apiKey
    console.log("[local-models] migrated legacy pi/models.json into Bivy registry (keys → vault)");
  } catch (error) {
    console.warn("[local-models] legacy migration skipped:", (error as Error).message);
  }
}

// Adopt any legacy Pi-owned config (keys → vault), then ensure the projection
// reflects the Bivy registry from the very first boot.
async function initLocalModelRegistry(): Promise<void> {
  await migrateLegacyPiModelsIntoRegistry();
  await writePiModelsProjection();
}
void initLocalModelRegistry();

/** Normalize save input into a provider id, non-secret spec, and separate key. */
function localModelSpecFromInput(input: any): { providerId: string; spec: any; apiKey?: string } {
  const { providerId, baseUrl, api, apiKey, models, compat, name } = input || {};
  if (!baseUrl) throw new Error("baseUrl is required");
  const spec: any = { baseUrl: String(baseUrl).trim(), api: api || "openai-completions" };
  if (name) spec.name = String(name);
  if (compat && typeof compat === "object") spec.compat = compat;
  spec.models = Array.isArray(models) ? models : [];
  const key = apiKey === undefined || apiKey === null ? undefined : String(apiKey);
  return { providerId: providerId || "ollama", spec, apiKey: key };
}

/** Re-emit the local-model list to every connected client (relay + direct). */
async function broadcastLocalModels(): Promise<void> {
  broadcast({ type: "models.custom.list", providers: await localModelSummaries() });
  broadcast({ type: "models.custom.updated" });
}

/** Save a provider: non-secret config → registry, secret key → encrypted vault,
 *  then re-project Pi + refresh + sync + notify clients. */
async function persistLocalModelSave(input: any): Promise<{ id: string }> {
  const { providerId, spec, apiKey } = localModelSpecFromInput(input);
  const { id } = upsertLocalProvider(localModelsDir, providerId, spec);
  // Store the endpoint's base URL alongside the (encrypted) key so non-Pi agents
  // can reach it when it's the active provider. Only a real key is kept — blank
  // on edit preserves the existing key; local dummies ("ollama"/…) are dropped
  // so they don't read as a configured key (projection falls back to "local").
  const trimmedKey = apiKey?.trim();
  const realKey = trimmedKey && !DUMMY_LOCAL_KEYS.has(trimmedKey.toLowerCase()) ? trimmedKey : undefined;
  await setProviderCredential(credsDir, id, { key: realKey, env: agentEnvForEndpoint(spec.api, spec.baseUrl) });
  await writePiModelsProjection();
  await refreshSessionAfterAuth();
  void pushModelAuthToControlPlane().catch(() => {});
  await broadcastLocalModels();
  return { id };
}

/** Remove a provider: drop its registry config AND forget its stored key. */
async function persistLocalModelRemove(id: string): Promise<void> {
  const pid = normalizeProviderId(String(id ?? ""));
  if (!pid) throw new Error("provider id required");
  removeLocalProviderEntry(localModelsDir, pid);
  await removeProvider(credsDir, pid).catch(() => {}); // forget the vault key too
  await writePiModelsProjection();
  await refreshSessionAfterAuth();
  void pushModelAuthToControlPlane().catch(() => {});
  await broadcastLocalModels();
}

// --- Rulesets (run-orchestration policy; docs/rulesets.md). --------------------
// Bivy owns the ruleset registry (ruleset-store.ts); it is node-local, not
// synced through the credential envelope, because policy is per-machine. One
// ruleset may be ACTIVE — the work-queue effector consults it (activeQueueRuleset
// below), falling back to the built-in DEFAULT_RULESET when none is active.
const rulesetsDir = appDir;

function rulesetInfos() {
  return listRulesetInfos(rulesetsDir);
}

/** Re-emit the ruleset list to every connected client (relay + direct). */
function broadcastRulesets(): void {
  broadcast({ type: "rulesets.list", rulesets: rulesetInfos() });
}

/** Save (validate + store) a ruleset; `active` optionally (de)selects it as the
 *  queue's active ruleset. Returns the stored name. */
function persistRulesetSave(input: unknown, active?: boolean): { name: string } {
  const result = upsertRuleset(rulesetsDir, input, active);
  broadcastRulesets();
  return result;
}

function persistRulesetRemove(name: string): void {
  removeRuleset(rulesetsDir, name);
  broadcastRulesets();
}

/** The ruleset the work queue should run under right now: the user's active
 *  ruleset if it applies to the queue, else undefined (→ DEFAULT_RULESET). Read
 *  lazily on each decision so edits in the UI take effect without a restart. */
function activeQueueRuleset(): Ruleset | undefined {
  return activeRulesetFor(rulesetsDir, "queue");
}

// The queue effector's policy. Thin wrapper so a freshly-saved active ruleset is
// picked up on the next failed attempt — createRunPolicy is stateless/cheap and
// failures are rare, so rebuilding per decision costs nothing meaningful.
const queueRunPolicy: RunPolicy = {
  decide: (ctx) => createRunPolicy({ context: "queue", ruleset: activeQueueRuleset() }).decide(ctx),
};
// Bivy is distributed on npm, so "is there a newer version?" is a registry
// question. Overridable for self-hosted or mirrored registries.
const updateRegistryUrl = process.env.BIVY_UPDATE_REGISTRY_URL ?? "https://registry.npmjs.org/%40bivy%2Fbivy/latest";
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
// One-time migration for installs created before the shared vault was split out
// of Pi's dir: move `<piDir>/auth.{enc,key}` → `<credsDir>` so existing logins
// survive the upgrade. Idempotent no-op once the vault lives in credsDir.
if (migrateVaultDir(piDir, credsDir)) {
  console.log(`Migrated credential vault: ${piDir} -> ${credsDir}`);
}
const identity = NodeIdentity.load(appDir);
const metadata = MetadataStore.load(appDir);
// A fresh process has no live runtimes, so any persisted "working" status is
// stale from a prior crash/kill. Clear it at boot; otherwise those sessions'
// worktrees are permanently exempted from cleanup (an unbounded disk leak).
// The ids it returns are exactly the sessions cut off mid-turn by the death —
// the resume reconciler (reconcileInterruptedSessions) picks them up.
const interruptedSessionIds = metadata.resetStaleWorking();
const defaultWorkspace = process.env.BIVY_WORKSPACE ?? repoRoot;
// Where repo-backed sessions clone GitHub repos (one checkout per repo, reused).
const reposRoot = process.env.BIVY_REPOS_DIR ?? path.join(appDir, "repos");
const port = Number(process.env.PORT ?? 4317);
// Bind to loopback by default. This port's HTTP/WS API grants full control of
// the node (sessions, terminals, git credentials) to any caller that can
// reach it — remote access is expected to arrive via the relay, which this
// node dials *outbound*, not by connecting to this port directly. Exposing it
// on all interfaces has historically meant it's reachable from the public
// internet with no TLS. Override with BIVY_HOST for LAN/direct-mode access
// on a network you trust.
const host = process.env.BIVY_HOST ?? process.env.HOST ?? "127.0.0.1";
const idleCloseMs = Number(process.env.BIVY_SESSION_IDLE_CLOSE_MS ?? 30 * 60 * 1000);
const idleCloseSweepMs = Math.max(60_000, Math.min(idleCloseMs || 60_000, 5 * 60_000));
// Resource caps so a burst of opens can't grow live runtime processes/PTYs
// without bound. Generous defaults; 0 disables. Sessions over the cap evict the
// least-recently-used idle one (a close just detaches + persists it); run
// terminals over the cap are rejected (never killed — they may hold live work).
const maxOpenSessions = Number(process.env.BIVY_MAX_OPEN_SESSIONS ?? 100);
const maxRunTerminals = Number(process.env.BIVY_MAX_RUN_TERMINALS ?? 50);
const worktreeRetentionMs = Number(process.env.BIVY_WORKTREE_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000);
const worktreeCleanupSweepMs = Math.max(60 * 60 * 1000, Math.min(worktreeRetentionMs || 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000));
// Native ("/login", "/model", …) PTY commands run the agent wrapper. From source
// that means `tsx native-pi.ts`; a packaged app sets BIVY_TSX="" and points
// BIVY_NATIVE_PI at the precompiled native-pi.js, so no tsx/.ts is needed.
const tsxCli = process.env.BIVY_TSX ?? path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const nativePiScript = process.env.BIVY_NATIVE_PI ?? path.join(assetRoot, "src", "native-pi.ts");
const ptyRunnerScript = process.env.BIVY_PTY_RUNNER ?? (
  fs.existsSync(path.join(assetRoot, "src", "pty-runner.py"))
    ? path.join(assetRoot, "src", "pty-runner.py")
    : path.join(assetRoot, "dist", "pty-runner.py")
);
const agentPrefix = tsxCli ? [tsxCli, nativePiScript] : [nativePiScript];
const pythonCommand = process.env.PYTHON ?? "python3";

type MeshCommand = {
  name: string;
  description: string;
  kind: "server" | "native";
  run?: () => Promise<unknown> | unknown;
  spawn?: { command: string; args: string[]; requiresTty?: boolean };
};

type OAuthLoginState = {
  id: string;
  provider: string;
  status: "starting" | "waiting" | "done" | "error";
  authUrl?: string;
  instructions?: string;
  deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
  usesCallbackServer?: boolean;
  progress?: string[];
  error?: string;
  cancelled?: boolean;
  abort: AbortController;
  createdAt: number;
  manualCodeResolve?: (code: string) => void;
};

// Per-process secret gating the loopback bootstrap endpoint. Published to a
// 0600 file (and stdout) so only the launching user can read it.
const bootstrapSecret = randomBytes(32).toString("base64url");

function publishBootstrapSecret() {
  try {
    const file = path.join(appDir, "bootstrap.json");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ secret: bootstrapSecret, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(file, 0o600);
  } catch (error) {
    console.warn("Failed to write bootstrap secret file", error);
  }
}

const approvals = new ApprovalManager();

// Bivy owns the AskUserQuestion → question-card feature at the guardian layer,
// runtime-agnostically (see src/question.ts). The manager holds every pending
// clarifying question across sessions; the guardian interceptor below raises
// them, and session.question(.resolved) is broadcast from its listeners.
const questionManager = new QuestionManager();
questionManager.onRequest((request) => {
  scheduleAdvertise();
  broadcast({ type: "session.question", sessionId: request.sessionId, requestId: request.id, questions: request.questions, createdAt: request.createdAt });
  // Notify unconditionally: a clarifying question always fires mid-turn (the
  // session is "working"), and it's a hard blocker the user must see to unblock
  // — matching the pre-refactor behavior.
  void sendNotificationHint({
    kind: "question_asked",
    sessionId: request.sessionId,
    attentionId: request.id,
    title: "Bivy needs your input",
    body: `${sessionNotifyLabel(resolveSession(request.sessionId))} is asking a question — tap to answer.`,
  });
});
questionManager.onResolved((request) => {
  // Fires exactly once per settle (answer, skip, timeout, or abort) — the one
  // always-correct place to tell clients the card is done. The client store's
  // session.question.resolved handler removes it.
  scheduleAdvertise();
  broadcast({ type: "session.question.resolved", sessionId: request.sessionId, requestId: request.id });
});

/**
 * Re-emit any still-pending interactive cards — clarifying questions and tool
 * approvals — for a session. Both are raised with a single one-shot broadcast,
 * which is lost to any client that wasn't connected at that instant. On mobile
 * that's the common case, not the edge: the socket drops on backgrounding / a
 * flaky link, and the PWA re-opens the session on reconnect (see the client's
 * onReconnected → openSession → session.open/history). Without a replay the
 * card never comes back, so a blocking AskUserQuestion sits invisible — the
 * sidebar shows "needs response" but the chat has no card to answer — until it
 * silently times out (QUESTION_TIMEOUT_MS) and the agent proceeds on a
 * "dismissed" result the user never saw. Replaying alongside every history
 * (re)send closes that gap. Idempotent: the client upserts questions by
 * requestId and approvals by id, so re-emitting an already-shown card is a
 * no-op rather than a duplicate.
 */
function replayPendingInteractions(sessionId: string) {
  if (!sessionId) return;
  for (const q of questionManager.list()) {
    if (q.sessionId === sessionId && q.status === "pending") {
      broadcast({ type: "session.question", sessionId: q.sessionId, requestId: q.id, questions: q.questions });
    }
  }
  for (const a of approvals.list()) {
    if (a.sessionId === sessionId && a.status === "pending") {
      broadcast({ type: "approval.created", approval: a });
    }
  }
}

function persistApprovalRequest(request: ApprovalRequest, resolvedAt?: number) {
  metadata.recordApproval({
    id: request.id,
    sessionId: request.sessionId,
    toolName: request.toolName,
    reason: request.reason,
    risk: request.risk,
    status: request.status,
    createdAt: request.createdAt,
    resolvedAt,
    workspace: request.workspace,
    repo: request.repo,
    branch: request.branch,
  });
}
// Resolve a live approval request. "Remembered decisions" (persistent per-tool
// allow/deny rules) were removed — governance is left to the agents themselves;
// Bivy only keeps the transient prompt for its catastrophic/backstop floor. We
// still persist the resolved request to the audit history.
function resolveApproval(id: string, approved: boolean) {
  const ok = approvals.resolve(id, approved);
  if (ok) {
    const resolved = approvals.list().find((a) => a.id === id);
    if (resolved) persistApprovalRequest(resolved, Date.now());
  }
  return ok;
}
const integrations = new IntegrationManager(appDir, undefined, attachToChatForSession);
const terminals = new TerminalManager();
// Per-session agents: a node holds one AgentRuntime instance *per agent id*,
// built lazily and cached, instead of a single global runtime. `defaultRuntimeId`
// is the agent used for sessions that don't name one (env-seeded). A runtime can't
// be swapped under a live conversation, so the agent is chosen at session creation
// and fixed for that session's life; switching agents in the UI starts a new one.
let defaultRuntimeId = (process.env.BIVY_RUNTIME ?? "pi").toLowerCase();
const runtimeHost = new RuntimeHost({ credsDir, piDir, sessionsDir, attachToChat: attachToChatForSession });

// A built-in in-session model-fallback ruleset from BIVY_SESSION_MODEL_FALLBACK
// (docs/rulesets.md). Opt-in: set it to a comma-separated model list and a
// session that hits an exhausted-credits / rate-limit turn error swaps down the
// list (via the runtime's live setModel) and retries. Used only when the user
// hasn't authored their own session-scoped ruleset in the UI.
function sessionModelFallbackRuleset(): Ruleset | undefined {
  const models = (process.env.BIVY_SESSION_MODEL_FALLBACK ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!models.length) return undefined;
  return {
    version: 1,
    name: "session-model-fallback",
    appliesTo: ["session"],
    rules: [
      {
        when: ["credits_exhausted", "rate_limited"],
        action: "reroute",
        maxAttempts: models.length + 1,
        chain: models.map((model) => ({ model })),
        onExhausted: "give_up",
        backoff: DEFAULT_BACKOFF,
      },
    ],
  };
}

/** The ruleset in-session recovery runs under right now: the user's active
 *  ruleset if it applies to sessions, else the env model-fallback ruleset, else
 *  undefined (→ built-in DEFAULT_RULESET). Read lazily on each turn error so UI
 *  edits take effect without a restart, mirroring activeQueueRuleset. */
function activeSessionRuleset(): Ruleset | undefined {
  return activeRulesetFor(rulesetsDir, "session") ?? sessionModelFallbackRuleset();
}

// The in-session recovery effector's policy. Always available: an interactive
// session can wait out a provider usage/rate limit and resume when it resets
// (planResume), or swap models down a fallback chain (planReroute). Thin wrapper
// so a freshly-saved active ruleset is picked up on the next turn error.
const sessionRunPolicy: RunPolicy = {
  decide: (ctx) => createRunPolicy({ context: "session", ruleset: activeSessionRuleset() }).decide(ctx),
};
if (process.env.BIVY_SESSION_MODEL_FALLBACK) {
  console.log(`[policy] in-session model reroute enabled: ${process.env.BIVY_SESSION_MODEL_FALLBACK}`);
}

let lastUpdateCheckAt = 0;
// The most recent "this node is behind" finding, so a client that connects after
// the check already ran still gets the banner (replayed on connect below).
let pendingBivyUpdate: { current: string; latest: string } | null = null;

function runtimeSummary(rt: AgentRuntime) {
  return runtimeHost.summary(rt);
}

function runtimeList(currentId?: string) {
  return listRuntimes(currentId).map((runtime) => ({
    ...runtime,
    enforcementLevel: enforcementLevelFor({ toolInterception: runtime.capabilities.toolInterception === true }, runtime.id),
  }));
}

// Validate + normalize an agent's advertised slash commands before they go on the
// wire, so malformed handshake data (a shim advertising junk, a broken getCommands)
// can never inject bad entries into the composer menu. Each must carry a "/name"
// string; only the two known invocation modes survive (unknown → prompt, the
// universal default). A protocol-mode command is only kept honest when the session
// can actually invoke it (RuntimeSession.invokeCommand) — otherwise it's demoted to
// prompt so we never advertise transport that isn't there.
function sanitizeAgentCommands(commands: unknown, session: RuntimeSession): AgentCommand[] {
  if (!Array.isArray(commands)) return [];
  const canProtocol = typeof session.invokeCommand === "function";
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  for (const entry of commands) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name.startsWith("/") || name.length < 2 || seen.has(name)) continue;
    seen.add(name);
    const description = typeof e.description === "string" && e.description.trim() ? e.description.trim() : undefined;
    const mode = e.mode === "protocol" && canProtocol ? "protocol" : e.mode === "prompt" ? "prompt" : undefined;
    const command: AgentCommand = { name };
    if (description) command.description = description;
    if (mode) command.mode = mode;
    out.push(command);
  }
  return out;
}

// Fold a live session's own slash commands (RuntimeSession.getCommands — Pi's
// extension commands / prompt templates / skills, Claude's slash_commands) into
// its runtime's advertised capabilities, so the session.created / session.capabilities
// broadcast carries them and the client can offer them in the *active session's*
// composer autocomplete (keyed per session — see AppStore.commandsBySession). The
// catalog caps object is never mutated; display-only, so any failure or an empty
// set falls back to the base capabilities.
function capabilitiesWithCommands(runtimeId: string, session: RuntimeSession): RuntimeCapabilities {
  const base = getRuntime(runtimeId).capabilities;
  try {
    const commands = sanitizeAgentCommands(session.getCommands?.(), session);
    if (commands.length) return { ...base, commands };
  } catch {
    // Best-effort enrichment; the composer simply shows no agent commands.
  }
  return base;
}

type ReleaseInfo = { version?: string };

/** The version of the running package, read once from its own package.json. */
function currentVersion(): string | undefined {
  try {
    const pkgPath = path.join(repoRoot, "package.json");
    return (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Compare dotted numeric versions. Returns true when `latest` is newer. */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// Poll npm for a newer release (throttled to every 6h). On finding one, remember
// it and push a dedicated `node.update` event so every connected app can show a
// banner with a one-tap "Update this node" button (see runBivyUpdate). Safe to
// call from anywhere — never throws, never interrupts a session.
async function checkBivyUpdate(): Promise<void> {
  const now = Date.now();
  if (now - lastUpdateCheckAt < 6 * 60 * 60 * 1000) return;
  lastUpdateCheckAt = now;
  const current = currentVersion();
  if (!current) return;
  try {
    const res = await fetch(updateRegistryUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const latest = ((await res.json()) as ReleaseInfo).version;
    if (!latest || !isNewerVersion(latest, current)) return;
    pendingBivyUpdate = { current, latest };
    broadcast({ type: "node.update", current, latest });
  } catch {
    // Best-effort update checks should never interrupt a session.
  }
}

async function maybeNotifyBivyUpdate() {
  // The daemon creates an initial session during startup before any UI is
  // connected. Don't spend a check until someone can see the banner.
  if (clients.size === 0 && !relay) return;
  await checkBivyUpdate();
}

// Run `bivy update` on this node, the same command a user would type. The CLI
// re-spawns itself detached, waits for any in-flight turn, updates, and restarts
// the service (logging to update.log), so we just fire-and-forget it here. The
// bin ships next to this server bundle in both the git checkout (src/server.ts)
// and the published package (dist/server.js), so repoRoot/bin/bivy.mjs resolves
// in both. Returns a friendly error instead of throwing when it can't be found
// (e.g. an unusual layout), so the banner can fall back to the manual command.
function runBivyUpdate(): { ok: boolean; error?: string } {
  const script = path.join(repoRoot, "bin", "bivy.mjs");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "Could not locate the bivy CLI on this node — run `bivy update` in a terminal." };
  }
  try {
    const child = spawn(process.execPath, [script, "update"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type RuntimeInstallSpec = { id: string; command: string; args: string[]; cwd: string; displayCommand?: string };

function runtimeInstallSpec(requested?: string): RuntimeInstallSpec | undefined {
  let id = String(requested ?? "").trim().toLowerCase();
  // Normalize a few historical aliases to their canonical runtime id.
  const alias: Record<string, string> = {
    "open-code": "opencode",
    "gemini-cli": "gemini",
    "qwen-code": "qwen",
    "open-claw": "openclaw",
    claude: "claude-code-sdk",
    "claude-code": "claude-code-sdk",
  };
  id = alias[id] ?? id;

  // Claude Code SDK is a node dependency installed into the repo (not a global
  // CLI), and OpenClaw is a phase-1 adapter that isn't a CLI_AGENT_SPECS entry —
  // both stay bespoke. Everything else derives from the agent's structured
  // `install` descriptor via cliInstallSpec (the SAME source the catalog "Install"
  // button reads), so there's a single install definition per agent, not two.
  if (id === "claude-code-sdk") {
    return { id: "claude-code-sdk", command: "npm", args: ["install", "@anthropic-ai/claude-agent-sdk"], cwd: repoRoot };
  }
  if (id === "openclaw") {
    return { id: "openclaw", command: "npm", args: ["install", "--global", "--prefix", userLocalPrefix, "openclaw"], cwd: repoRoot, displayCommand: `npm install --global --prefix ${userLocalPrefix} openclaw` };
  }
  if (isCliAgentId(id)) {
    const spec = cliInstallSpec(id, userLocalPrefix);
    // No `install` descriptor (e.g. Rovo Dev's `acli`, installed out of band) →
    // no allowlisted auto-install; the catalog shows the agent as external.
    return spec ? { id, command: spec.command, args: spec.args, cwd: repoRoot, displayCommand: spec.display } : undefined;
  }
  return undefined;
}

function installCommandText(spec: RuntimeInstallSpec): string {
  return spec.displayCommand || [spec.command, ...spec.args].join(" ");
}

function runInstallCommand(spec: RuntimeInstallSpec): Promise<{ output: string }> {
  return new Promise((resolve, reject) => {
    if (spec.command === "npm" && spec.args.includes("--prefix")) fs.mkdirSync(path.join(userLocalPrefix, "bin"), { recursive: true });
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ output });
      else reject(new Error(`${installCommandText(spec)} failed with exit code ${code ?? "unknown"}${output ? `\n${output}` : ""}`));
    });
  });
}

/**
 * Return an available runtime, auto-installing allowlisted optional adapters when
 * a normal session/select path asks for them. The explicit /api/runtimes/install
 * endpoint remains useful for manual install buttons, but users should not have
 * to press it before starting a regular managed session.
 */
async function ensureRuntimeAvailable(requested?: string, sandbox?: SandboxTier): Promise<AgentRuntime> {
  try {
    return getRuntime(requested, sandbox);
  } catch (error) {
    const spec = runtimeInstallSpec(requested ?? defaultRuntimeId);
    if (!spec) throw error;

    const before = runtimeHost.list().find((runtime) => runtime.id === spec.id);
    if (before?.status !== "available") {
      broadcast({ type: "runtime.install.start", id: spec.id, command: installCommandText(spec) });
      await runInstallCommand(spec);
    }

    const rt = getRuntime(spec.id, sandbox);
    const runtimes = runtimeList(spec.id);
    broadcast({ type: "runtime.install.done", id: spec.id, runtimes });
    return rt;
  }
}

/** Resolve a requested agent id to a canonical id that is available on this node. */
function resolveRuntimeId(requested?: string): string {
  return runtimeHost.resolveRuntimeId(requested, defaultRuntimeId);
}

/** Lazily build and cache the AgentRuntime for an agent id (defaults to the node
 *  default). A per-session sandbox override yields a separately-cached instance
 *  whose launch flags bake in that tier. */
function getRuntime(requested?: string, sandbox?: SandboxTier): AgentRuntime {
  return runtimeHost.get(requested, defaultRuntimeId, sandbox);
}
// Holds the node's X25519 identity key, the rotating room key, and the linked
// device registry. The room key is generated fresh on first load and delivered
// to devices via the X25519 pairing handshake — there is no static seed, EXCEPT
// on an ephemeral rebuild: relay.json carries the reused session's room key
// (`e2eKey`) so a brand-new pairing state adopts it and can decrypt the restored
// snapshot. Only seeds a first-run node; an existing pairing.json always wins.
const pairingStore = PairingStore.load(appDir, loadRelayConfig(appDir)?.e2eKey);
function syncPairingMetadata() {
  for (const device of pairingStore.listDevices()) {
    metadata.upsertDevice({ id: device.id, label: device.label, publicKeyB64: device.publicKeyB64, firstSeenAt: device.createdAt, lastSeenAt: device.lastSeenAt ?? undefined });
  }
}
syncPairingMetadata();
let relay: RelayConnector | undefined;
const clients = new Set<WebSocket>();
const commandProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const oauthLogins = new Map<string, OAuthLoginState>();
// A browser-initiated subscription login parks the node on `manualCodePromise`
// until the remote device pastes the code (`provider.oauth.code`). If the user
// abandons it, the entry — AND its local callback http.Server — would otherwise
// linger until the process exits. That matters especially on a short-lived
// ephemeral node. Sweep periodically: abort (which closes the callback server,
// see startCallbackServer) + drop any in-flight login past its TTL, and drop a
// finished one after a short grace so clients can still read the final status.
const OAUTH_LOGIN_TTL_MS = 10 * 60_000;
const OAUTH_LOGIN_DONE_GRACE_MS = 2 * 60_000;
function sweepOauthLogins(now = Date.now()): void {
  for (const [id, login] of oauthLogins.entries()) {
    const { drop, abort } = decideOAuthLoginSweep(login.status, now - login.createdAt, {
      ttlMs: OAUTH_LOGIN_TTL_MS,
      graceMs: OAUTH_LOGIN_DONE_GRACE_MS,
    });
    if (!drop) continue;
    if (abort) {
      login.cancelled = true;
      try { login.abort.abort(); } catch { /* already settled */ }
    }
    oauthLogins.delete(id);
  }
}
let oauthLoginSweepTimer: ReturnType<typeof setInterval> | undefined;
function startOAuthLoginSweeper(): void {
  if (oauthLoginSweepTimer) return;
  oauthLoginSweepTimer = setInterval(() => sweepOauthLogins(), 60_000);
  oauthLoginSweepTimer.unref?.();
}
type SessionRecord = { id: string; session: RuntimeSession; runtimeId: string; sandbox?: SandboxTier; approvalMode?: ApprovalMode; workspace: string; sessionFile?: string; agentServiceAddress?: string; lastActivity?: unknown; lastTouchedAt?: number; isWorking?: boolean; workingStartedAt?: number; lastFailureAt?: number; turnWatchdog?: NodeJS.Timeout; turnTimeoutSignal?: Promise<void>; turnTimeoutResolve?: () => void; turnTimedOut?: boolean; abortRecovery?: Promise<void>; authRequiredSignaled?: boolean; naming?: boolean; namedFromFirstPrompt?: boolean; namingAttempts?: number; firstNamingPrompt?: string; worktree?: Worktree; source?: BivySessionSource; forkedFrom?: string; branchPushed?: boolean; branchPushing?: boolean; prUrl?: string; prs?: PrRef[]; prSuggested?: boolean; prOpening?: boolean; prDetecting?: boolean; tuiTermId?: string; tuiRefreshing?: boolean; remoteActive?: boolean; ephemeral?: boolean; unsubscribe?: () => void; paused?: boolean; warning?: string; costUsd?: number; usage?: UsageSnapshot; githubIssueUrl?: string; mcpRestore?: () => void; harnessTurnReady?: Promise<void>; lastPrompt?: string; lastPromptOptions?: ReturnType<typeof promptOptionsFor>; reroute?: SessionRerouteController; seenAttachmentHashes?: Set<string> };

// Options for createSession. `worktree` runs the session in an isolated git
// worktree/branch (optional for manual sessions, forced for issue pickup);
// `makeActive: false` keeps a background (e.g. issue-triggered) session from
// stealing the user's focused session; `source` tags where it came from.
type CreateSessionOptions = {
  worktree?: boolean | { branch?: string; base?: string };
  makeActive?: boolean;
  source?: string;
  /** Agent id to run this session on; defaults to the node default runtime. */
  runtimeId?: string;
  /** Per-session sandbox tier override; defaults to the node's configured tier. */
  sandbox?: SandboxTier;
  /** Per-session approval-mode override (e.g. a scheduled automation's default);
   *  defaults to the node's configured approval mode. */
  approvalMode?: ApprovalMode;
  /** Throwaway session (e.g. the model-picker scratch): kept in memory for reuse
   *  but never persisted to metadata while it stays empty, so it can't leave an
   *  "untitled"/empty row behind. */
  ephemeral?: boolean;
  /** Stage 3 startup adoption: attach to a still-live remote session ONLY — never
   *  fall back to spawning it fresh from disk. When the attach fails, createSession
   *  rejects (so adoption can classify gone-vs-transient) instead of re-opening. */
  attachOnly?: boolean;
};
const openSessions = new Map<string, SessionRecord>();
// Stage 2 (docs/agent-node-decoupling.md): sessionId -> agent-service address for
// live REMOTE sessions the agent service keeps running across an eviction/
// disconnect. Lets an openSessions miss re-attach to the still-live session
// instead of re-opening a fresh copy from disk — making openSessions a cache.
// Node-local primary; Stage 3 layers a control-plane-backed registry UNDER it
// (see startRelayIfConfigured) so a lookup that misses this daemon's own memory
// still resolves from durable state after a restart. Empty (and inert) whenever
// the remote flag is off.
const inMemorySessionLocations = new InMemorySessionLocationRegistry();
// The registry the daemon reads/writes. Starts as the bare in-memory map (today's
// behavior, and the only thing used when the remote flag is off); Stage 3 swaps in
// a LayeredSessionLocationRegistry(inMemory, controlPlane) once the relay/control-
// plane target is known, so re-attach survives a daemon restart. `record`/`forget`
// still land on the in-memory layer; `lookup` falls through to the control plane.
let sessionLocations: SessionLocationRegistry = inMemorySessionLocations;
// The control-plane location registry, built lazily when remote is enabled. Held
// separately from `sessionLocations` because startup adoption needs its
// node-scoped enumeration (`listNode`), which the SessionLocationRegistry
// interface doesn't expose.
let cpLocationRegistry: ControlPlaneSessionLocationRegistry | undefined;
// Stage 2 slice 4: sessionId -> its live TUI terminal id, tracked OUTSIDE the
// openSessions record so it survives a detach/re-attach (slice 3). The PTY keeps
// running when a remote session is evicted, so a re-attached session recovers its
// terminal link from here instead of losing it. Node-local (PTYs are node-local),
// same registry primitive as sessionLocations.
const sessionTerminals = new InMemoryLocationRegistry<{ termId: string }>();
let active: SessionRecord | undefined;

// Universal Agent Harness — filesystem effect boundary. Owns per-session git
// checkpoints so any agent (Pi, Claude Code, or a dumb-pipe CLI) gets per-turn
// snapshots, a structured diff of what each turn changed, and one-click rewind —
// with zero cooperation from the agent. Disables itself for non-repo workspaces.
const harness = new HarnessManager();

/** Working directory the agent actually writes into for this session. */
function harnessDirFor(record: SessionRecord): string {
  return record.worktree?.path || record.session.cwd || record.workspace;
}

/** Snapshot the workspace before a turn. Best-effort and NON-BLOCKING: the
 *  harness contract is to "never block the agent", but the snapshot ran
 *  `git add -A` over the whole worktree on the prompt's critical path — awaited
 *  before the first token — adding seconds to every turn (worst on the first
 *  message of a repo session, atop the worktree checkout). We now kick it off
 *  and let it settle in the background; harnessEndTurn awaits `harnessTurnReady`
 *  so the structured diff / rewind baseline is still computed against this
 *  snapshot. Tradeoff: the base now races the agent's earliest writes, so a turn
 *  that writes within the first few ms may under-report those files in the
 *  changes card — acceptable for a best-effort diff, and the prompt no longer
 *  waits on git. Never throws into the prompt path. */
function harnessBeginTurn(record: SessionRecord): void {
  const dir = harnessDirFor(record);
  record.harnessTurnReady = undefined;
  if (!dir) return;
  record.harnessTurnReady = (async () => {
    try {
      if (!(await harness.attach(record.id, dir))) return;
      await harness.beginTurn(record.id, `before turn @ ${new Date().toISOString()}`);
    } catch {
      // Harness is best-effort; ignore.
    }
  })();
}

/** After a turn, snapshot again and broadcast the structured diff it produced. */
async function harnessEndTurn(record: SessionRecord): Promise<void> {
  try {
    // Ensure the pre-turn snapshot finished before diffing against it (it was
    // started non-blocking in harnessBeginTurn so the prompt didn't wait on git).
    await record.harnessTurnReady;
    const result = await harness.endTurn(record.id, `after turn @ ${new Date().toISOString()}`);
    if (!result || result.changes.length === 0) return;
    broadcast({
      type: "session.changes",
      sessionId: record.id,
      before: result.before?.id,
      after: result.after.id,
      changes: result.changes,
    });
  } catch {
    // Harness is best-effort; ignore.
  }
}


// Set the default agent used for NEW sessions. Unlike the old global switch this
// does not tear down existing sessions — each session keeps the agent it was
// created with. To actually run a different agent the UI starts a fresh session
// (createSession with a runtimeId), so switching is non-destructive.
async function setDefaultRuntime(id: string) {
  const rt = await ensureRuntimeAvailable(id);
  defaultRuntimeId = rt.id;
  broadcast({ type: "runtime.updated", current: runtimeSummary(rt), runtimes: runtimeList(rt.id) });
  return rt;
}

type StreamingBehavior = "steer" | "followUp";
type PromptImage = { type: "image"; data: string; mimeType: string };
type PromptAttachment =
  | { kind: "image"; name?: unknown; size?: unknown; mimeType?: unknown; data?: unknown }
  | { kind: "file"; name?: unknown; size?: unknown; mimeType?: unknown; data?: unknown; text?: unknown; truncated?: unknown; omitted?: unknown };

function streamingBehaviorFrom(value: unknown): StreamingBehavior | undefined {
  return value === "steer" || value === "followUp" ? value : undefined;
}

function promptOptionsFor(record: SessionRecord, requested?: unknown, images?: PromptImage[]) {
  const streamingBehavior = streamingBehaviorFrom(requested) ?? (record.session.isStreaming ? "steer" : undefined);
  return { ...(streamingBehavior ? { streamingBehavior } : {}), ...(images?.length ? { images } : {}) };
}

function promptForAgent(_record: SessionRecord, promptText: string): string {
  // Do not splice AGENTS.md/CLAUDE.md into the user turn. Pi loads those
  // context files into its system prompt from the session cwd; injecting them
  // here makes the persisted transcript look like the instruction file was the
  // user's message and can overwrite the optimistic first-message bubble in the
  // remote PWA when history arrives.
  return promptText;
}

function safeAttachmentName(value: unknown) {
  return String(value || "attachment").replace(/[\r\n]/g, " ").slice(0, 180);
}

/** A decoded file attachment ready to be written into a session's workdir. */
interface DecodedAttachment {
  name: string;
  mimeType: string;
  size: number;
  bytes?: Buffer;
  text?: string;
  truncated?: boolean;
}

/**
 * Split composer attachments into channels:
 *   - `images`     — base64 blobs passed to the model as vision.
 *   - `imageNotes` — one prose line per image for the persisted transcript.
 *   - `imageRefs`  — durable AttachmentStore references for the images, persisted
 *                    in the event log so they rehydrate after a reload / on
 *                    another device (images used to be vision-only, then lost).
 *   - `files`      — decoded file attachments (bytes or text) to be written to
 *                    disk by materializeAttachments so the agent can open them
 *                    with its normal file tools. Any file type is supported;
 *                    binary files arrive as base64 `data`.
 */
const MAX_PROMPT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_ATTACHMENTS_BYTES = 40 * 1024 * 1024;

function attachmentsFrom(value: unknown): { images: PromptImage[]; imageNotes: string[]; imageRefs: AttachmentRef[]; files: DecodedAttachment[] } {
  if (!Array.isArray(value)) return { images: [], imageNotes: [], imageRefs: [], files: [] };
  const images: PromptImage[] = [];
  const imageNotes: string[] = [];
  const imageRefs: AttachmentRef[] = [];
  const files: DecodedAttachment[] = [];
  let totalBytes = 0;
  if (value.length > 12) throw new Error("A message can include at most 12 attachments");
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const attachment = raw as PromptAttachment;
    const name = safeAttachmentName(attachment.name);
    const size = Number(attachment.size || 0);
    const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType ? attachment.mimeType : undefined;
    const encodedBytes = typeof attachment.data === "string" ? Math.floor(attachment.data.length * 3 / 4) : 0;
    const textBytes = attachment.kind === "file" && typeof attachment.text === "string" ? Buffer.byteLength(attachment.text) : 0;
    const actualBytes = encodedBytes || textBytes;
    if (actualBytes > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`${name} exceeds the 10 MiB attachment limit`);
    totalBytes += actualBytes;
    if (totalBytes > MAX_PROMPT_ATTACHMENTS_BYTES) throw new Error("Attachments exceed the 40 MiB per-message limit");
    if (attachment.kind === "image" && typeof attachment.data === "string") {
      const imgMime = mimeType ?? "image/png";
      images.push({ type: "image", data: attachment.data, mimeType: imgMime });
      imageNotes.push(`[Image attachment: ${name}${size ? ` (${size} bytes)` : ""}]`);
      // Persist the image bytes durably (dedup by hash). Best-effort: a store
      // failure must not break vision for the turn, so it only costs the ref.
      try {
        imageRefs.push(attachmentStore.put(Buffer.from(attachment.data, "base64"), { name, mimeType: imgMime, kind: "image" }));
      } catch (error) {
        console.warn("[attachments] failed to store image:", error instanceof Error ? error.message : String(error));
      }
    } else if (attachment.kind === "file") {
      if (typeof attachment.data === "string" && attachment.data) {
        files.push({ name, mimeType: mimeType ?? "application/octet-stream", size, bytes: Buffer.from(attachment.data, "base64"), truncated: !!attachment.truncated });
      } else if (typeof attachment.text === "string" && attachment.text) {
        files.push({ name, mimeType: mimeType ?? "text/plain", size, text: attachment.text, truncated: !!attachment.truncated });
      }
      // A file with neither bytes nor text (e.g. omitted/unreadable) carries
      // nothing to write, so there is nothing to hand the agent — skip it.
    }
  }
  return { images, imageNotes, imageRefs, files };
}

/** Strip a user-supplied filename to a safe basename — no path traversal, no
 * characters that would break the placeholder note or the filesystem. */
function sanitizeAttachmentFilename(name: string): string {
  const base = path
    .basename(String(name || ""))
    .replace(/[/\\\r\n\t[\]]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return base || "attachment";
}

/**
 * Write decoded file attachments into `<workdir>/.bivy-attachments/` and return
 * one prose note per file (carrying the relative path) to append to the prompt.
 * This is what makes an uploaded file of ANY type — binary included — readable
 * by the agent's file tools. Filenames are sanitized and de-duplicated so two
 * `report.pdf`s don't clobber. Best-effort: a failure degrades to a note rather
 * than throwing, so a bad attachment never sinks the whole turn.
 */
function materializeAttachments(record: SessionRecord, files: DecodedAttachment[]): { note: string; refs: AttachmentRef[] } {
  if (!files.length) return { note: "", refs: [] };
  const refs: AttachmentRef[] = [];
  // Store every file durably in the global content-addressed store first (for
  // re-findability), independent of the per-workdir copy below. Best-effort per
  // file so one bad blob doesn't lose the others.
  for (const file of files) {
    const bytes = file.bytes ?? (typeof file.text === "string" ? Buffer.from(file.text, "utf8") : undefined);
    if (!bytes) continue;
    try {
      refs.push(attachmentStore.put(bytes, { name: sanitizeAttachmentFilename(file.name), mimeType: file.mimeType, kind: "file" }));
    } catch (error) {
      console.warn("[attachments] failed to store file:", error instanceof Error ? error.message : String(error));
    }
  }
  const workdir = harnessDirFor(record);
  const dir = path.join(workdir, ".bivy-attachments");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { note: files.map((f) => `[File attachment: ${sanitizeAttachmentFilename(f.name)} could not be saved: ${why}]`).join("\n"), refs };
  }
  const notes: string[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const safeBase = sanitizeAttachmentFilename(file.name);
    const ext = path.extname(safeBase);
    const stem = safeBase.slice(0, safeBase.length - ext.length) || safeBase;
    let safe = safeBase;
    let n = 1;
    while (used.has(safe) || fs.existsSync(path.join(dir, safe))) {
      safe = `${stem}-${n}${ext}`;
      n += 1;
    }
    used.add(safe);
    const dest = path.join(dir, safe);
    const label = `${safe} (${file.size ? `${file.size} bytes, ` : ""}${file.mimeType}${file.truncated ? ", truncated" : ""})`;
    try {
      if (file.bytes) fs.writeFileSync(dest, file.bytes);
      else if (typeof file.text === "string") fs.writeFileSync(dest, file.text, "utf8");
      else continue;
      const rel = path.relative(workdir, dest) || safe;
      notes.push(`[File attachment: ${label} saved to ${rel} - read it with your file tools]`);
    } catch (error) {
      notes.push(`[File attachment: ${label} could not be saved: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return { note: notes.join("\n"), refs };
}

/**
 * Store attachment bytes, persist a durable outbound reference anchored at the
 * current transcript position (so a reload or another device shows it), and
 * emit the live `attachment` event so attached devices render the chip/
 * thumbnail immediately. The common tail of both `attachToChat` (an explicit
 * `bivy attach`) and `handlePassiveToolImage` (an image a tool produced,
 * surfaced with no explicit attach call — see issue #292); the only difference
 * between the two callers is how the bytes were obtained. Records the stored
 * hash onto `record.seenAttachmentHashes` so a later passive image with
 * identical bytes de-dupes against this one for free.
 */
function recordAttachment(
  record: SessionRecord,
  bytes: Buffer,
  opts: { name: string; mimeType: string; kind: "image" | "file"; caption?: string },
): { ref: AttachmentRef } | { error: string } {
  let ref: AttachmentRef;
  try {
    ref = attachmentStore.put(bytes, { name: opts.name, mimeType: opts.mimeType, kind: opts.kind });
  } catch (error) {
    return { error: `Could not store the attachment: ${error instanceof Error ? error.message : String(error)}` };
  }
  (record.seenAttachmentHashes ??= new Set()).add(ref.hash);
  const entryId = `att-${randomBytes(8).toString("hex")}`;
  const caption = opts.caption ? String(opts.caption).slice(0, 2000) : undefined;
  // Anchor at the current base length so history replay interleaves the
  // attachment where it was emitted (see event-log outbound projection).
  const afterMessageCount = record.session.getMessages().length;
  eventLog.appendOutboundAttachment(record.id, { afterMessageCount, id: entryId, ref, caption });
  broadcast({ type: "session.event", sessionId: record.id, event: { type: "attachment", id: entryId, ref, caption } });
  return { ref };
}

/**
 * Surface an AGENT-produced file into the chat as an attachment (image or file)
 * — the reverse of the composer paperclip. Confines to the session workspace,
 * then hands off to recordAttachment for the store+persist+broadcast. Shared by
 * the HTTP endpoint and the `bivy attach` CLI. Returns the stored ref, or a
 * human-readable error.
 */
function attachToChat(
  record: SessionRecord,
  opts: { filePath: string; caption?: string; mimeType?: string; name?: string },
): { ref: AttachmentRef } | { error: string } {
  const plan = planAttachment({
    workspaceDir: harnessDirFor(record),
    filePath: opts.filePath,
    mimeType: opts.mimeType,
    name: opts.name,
  });
  if (isAttachPlanError(plan)) return { error: plan.error };
  return recordAttachment(record, plan.bytes, { name: plan.name, mimeType: plan.mimeType, kind: plan.kind, caption: opts.caption });
}

/** Extension guess for a passively-surfaced tool image, from its mime type. */
function extFromImageMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  return "png";
}

/**
 * Handle a `tool_image` RuntimeEvent — a runtime adapter (see
 * src/runtime/claude-code.ts's emitPassiveToolImages) noticed an image inside a
 * tool_result and, gated on autoAttachToolImagesEnabled() and bounded by its own
 * per-turn budget, forwarded the raw bytes here. Stores it exactly like an
 * explicit `bivy attach` (see recordAttachment), except de-duplicated against
 * anything already surfaced in this session — explicit or passive — by content
 * hash, so identical bytes (a tool that returns the same screenshot twice, or a
 * tool result that duplicates bytes the agent already attached) never produce a
 * second chip. Best-effort: a malformed or oversized payload is dropped with a
 * warning rather than erroring the turn.
 */
function handlePassiveToolImage(record: SessionRecord, event: Record<string, unknown>): void {
  const dataB64 = typeof event.data === "string" ? event.data : "";
  if (!dataB64) return;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(dataB64, "base64");
  } catch {
    return;
  }
  if (!bytes.length || bytes.length > MAX_AGENT_ATTACHMENT_BYTES) return;
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (record.seenAttachmentHashes?.has(hash)) return;
  const mimeType = typeof event.mimeType === "string" && event.mimeType ? event.mimeType : "image/png";
  const toolName = typeof event.toolName === "string" && event.toolName.trim() ? event.toolName.trim() : "tool";
  const name = sanitizeAttachmentFilename(`${toolName}-${hash.slice(0, 8)}.${extFromImageMime(mimeType)}`);
  const result = recordAttachment(record, bytes, { name, mimeType, kind: "image", caption: `From ${toolName}` });
  if ("error" in result) {
    console.warn("[attachments] failed to store a passively-surfaced tool image:", result.error);
  }
}

/**
 * Session-id-keyed wrapper around attachToChat, handed to runtime adapters as
 * the `attachToChat` callback that backs each agent's native "attach to chat"
 * tool surface (Claude's SDK tool, Pi's ToolProvider tool — issue #291). Those
 * tools are wired at runtime/tool-provider construction time, before the
 * specific session that will run them exists — a per-session circular
 * dependency (build the tools -> need the session -> need the tools) — so the
 * callback takes a session id and resolves the live record from openSessions
 * when it actually fires, exactly like the HTTP endpoint below does by path.
 */
function attachToChatForSession(
  sessionId: string,
  opts: { filePath: string; caption?: string; mimeType?: string; name?: string },
): { ref: AttachmentRef } | { error: string } {
  const record = openSessions.get(sessionId);
  if (!record) return { error: "Session not found" };
  return attachToChat(record, opts);
}

function approvalModeFrom(value: unknown): ApprovalMode | undefined {
  return value === "never" || value === "risky" || value === "always" || value === "autonomous" ? value : undefined;
}

function loadApprovalMode(): ApprovalMode {
  const envMode = approvalModeFrom(process.env.BIVY_APPROVAL_MODE);
  if (envMode) return envMode;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return approvalModeFrom(settings.approvalMode) ?? "autonomous";
  } catch {
    // Default: run without per-action approval ("autonomous"). Safety comes from
    // the boundary — catastrophic commands and writes outside the workspace are
    // blocked outright in every mode, and a small backstop set (force-push,
    // publish, deploy, sudo) still pauses for a human. "risky"/"always" keep the
    // old prompt-heavy behaviour for users who want it.
    return "autonomous";
  }
}

let approvalMode = loadApprovalMode();

function readSettings(): Record<string, unknown> {
  try {
    return fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function resolveWorkspacePath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Workspace path is required");
  const expanded = raw.startsWith("~")
    ? path.join(process.env.HOME ?? "", raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

function validateWorkspace(value: unknown): string {
  const resolved = resolveWorkspacePath(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Workspace does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
  return resolved;
}

function loadSavedWorkspaces(): string[] {
  const settings = readSettings();
  const list = [...metadata.listWorkspaces(), ...(Array.isArray(settings.workspaces) ? settings.workspaces : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function saveWorkspaces(list: string[]) {
  const settings = readSettings();
  settings.workspaces = list;
  writeSettings(settings);
  for (const workspace of list) metadata.rememberWorkspace(workspace);
}

/** Record a workspace as most-recently-used. Best-effort; never throws. */
function rememberWorkspace(workspace: string) {
  try {
    const resolved = path.resolve(workspace);
    const list = loadSavedWorkspaces().filter((item) => item !== resolved);
    list.unshift(resolved);
    saveWorkspaces(list);
  } catch {
    // ignore persistence errors
  }
}

function addSavedWorkspace(value: unknown): string[] {
  const resolved = validateWorkspace(value);
  const list = loadSavedWorkspaces().filter((item) => item !== resolved);
  list.unshift(resolved);
  saveWorkspaces(list);
  return loadSavedWorkspaces();
}

function removeSavedWorkspace(value: unknown): string[] {
  const resolved = resolveWorkspacePath(value);
  const list = loadSavedWorkspaces().filter((item) => item !== resolved);
  metadata.removeWorkspace(resolved);
  saveWorkspaces(list);
  return loadSavedWorkspaces();
}

function saveApprovalMode(mode: ApprovalMode) {
  const settings = readSettings();
  settings.approvalMode = mode;
  writeSettings(settings);
  approvalMode = mode;
  if (mode === "never") {
    for (const request of approvals.resolveAll(true)) {
      persistApprovalRequest(request, Date.now());
      broadcast({ type: "approval.resolved", id: request.id, approved: true });
    }
  }
  return mode;
}

// --- Node settings (per-node defaults, settings.json) -----------------------
// Editable from the web Settings → Nodes section. These are the node's defaults
// for new sessions plus its GitHub-queue concurrency cap. The node NAME lives in
// node.json (identity), the rest in settings.json.

type NodeSettings = {
  name: string;
  defaultAgent: string;
  defaultModel: { provider: string; id: string } | null;
  defaultSandbox: SandboxTier;
  githubMaxConcurrent: number;
  githubIssuePrompt: string;
  sessionSync: boolean;
  worktreeSync: boolean;
  syncStandbyNodeId?: string;
  /** How an interactive session whose turn was cut off by a restart recovers:
   *  "auto" re-drives the interrupted turn on boot; "manual" leaves it for the
   *  user to resume with one tap. Issue automation always auto-resumes regardless. */
  sessionResumeMode: "auto" | "manual";
  /** Passively surface images a tool produces (e.g. a screenshot MCP tool's
   *  output) into the chat as attachments, with no explicit `bivy attach` call
   *  (issue #292). Off by default — bounded per-turn regardless (see
   *  src/harness/tool-image-attachments.ts) so a chatty tool can't flood the
   *  transcript even once enabled. */
  autoAttachToolImages: boolean;
};

/** The node's default model for new sessions, or null (= use the runtime default). */
function nodeDefaultModel(): { provider: string; id: string } | null {
  const m = readSettings().defaultModel as { provider?: unknown; id?: unknown } | undefined;
  const provider = String(m?.provider ?? "").trim();
  const id = String(m?.id ?? "").trim();
  return provider && id ? { provider, id } : null;
}

/** The agent GitHub-issue pickups should default to when the issue body carries
 *  no `bivy-agent:` directive and no manual "Run…" override — i.e. the persisted
 *  Settings → Nodes → "Default agent" value. Falls back to the boot-time
 *  `defaultRuntimeId` when never configured. Crucially this reads the persisted
 *  `settings.defaultAgent` rather than the mutable `defaultRuntimeId` global,
 *  which the web UI overwrites with the *last used* agent on every
 *  `runtime.select`. Mirrors `nodeSettingsSnapshot().defaultAgent`. */
function nodeConfiguredDefaultAgent(): string {
  const s = readSettings();
  return typeof s.defaultAgent === "string" && s.defaultAgent.trim() ? s.defaultAgent.trim() : defaultRuntimeId;
}

/** How interactive sessions recover after a restart interrupted them mid-turn.
 *  Defaults to "auto" (re-drive the turn); "manual" waits for a user tap. */
function nodeSessionResumeMode(): "auto" | "manual" {
  return readSettings().sessionResumeMode === "manual" ? "manual" : "auto";
}

/** Max concurrent GitHub-queue sessions this node runs at once (0 = unlimited). */
function nodeGithubMaxConcurrent(): number {
  const n = Number(readSettings().githubMaxConcurrent);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The instructions appended to every issue-pickup's first message — the
 *  user-editable part of `buildTaskPrompt` (Settings → Nodes → GitHub issue
 *  prompt). Falls back to the shipped default when unset/blank. */
function nodeGithubIssuePrompt(): string {
  const raw = readSettings().githubIssuePrompt;
  return typeof raw === "string" && raw.trim() ? raw : DEFAULT_ISSUE_INSTRUCTIONS;
}

function nodeSettingsSnapshot(): NodeSettings {
  const s = readSettings();
  return {
    name: identity.name,
    defaultAgent: typeof s.defaultAgent === "string" && s.defaultAgent.trim() ? s.defaultAgent.trim() : defaultRuntimeId,
    defaultModel: nodeDefaultModel(),
    defaultSandbox: normalizeSandboxTier(s.defaultSandbox) ?? sandboxTier(),
    githubMaxConcurrent: nodeGithubMaxConcurrent(),
    githubIssuePrompt: nodeGithubIssuePrompt(),
    sessionSync: readSettings().sessionSync === true,
    // Worktree sync only has meaning when session sync is on.
    worktreeSync: readSettings().sessionSync === true && readSettings().worktreeSync === true,
    syncStandbyNodeId: (() => {
      const v = readSettings().syncStandbyNodeId;
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    })(),
    sessionResumeMode: nodeSessionResumeMode(),
    autoAttachToolImages: readSettings().autoAttachToolImages === true,
  };
}

async function applyNodeSettings(patch: Record<string, unknown>): Promise<NodeSettings> {
  const settings = readSettings();
  if (typeof patch.name === "string" && patch.name.trim()) {
    const prev = identity.name;
    const name = identity.setName(patch.name);
    void advertiseNodeName(name, prev);
    broadcast({ type: "node.updated", name });
  }
  if (typeof patch.defaultAgent === "string" && patch.defaultAgent.trim()) {
    settings.defaultAgent = patch.defaultAgent.trim().toLowerCase();
    try { await setDefaultRuntime(settings.defaultAgent as string); } catch { /* keep the setting even if not installed yet */ }
  }
  if ("defaultModel" in patch) {
    const m = patch.defaultModel as { provider?: unknown; id?: unknown } | null | undefined;
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    settings.defaultModel = provider && id ? { provider, id } : null;
  }
  if ("defaultSandbox" in patch) {
    const tier = normalizeSandboxTier(patch.defaultSandbox);
    if (tier) {
      settings.defaultSandbox = tier;
      setConfiguredSandboxTier(tier);
    }
  }
  if ("githubMaxConcurrent" in patch) {
    const n = Number(patch.githubMaxConcurrent);
    settings.githubMaxConcurrent = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  if ("githubIssuePrompt" in patch) {
    const text = String(patch.githubIssuePrompt ?? "").trim();
    // Blank (or exactly the shipped default) clears the override, so a future
    // change to the built-in default is picked up automatically.
    settings.githubIssuePrompt = text && text !== DEFAULT_ISSUE_INSTRUCTIONS ? text : undefined;
  }
  if ("sessionSync" in patch) {
    settings.sessionSync = patch.sessionSync === true;
    // Worktree sync is meaningless without session sync — clear it when sync is off.
    if (!settings.sessionSync) settings.worktreeSync = false;
  }
  if ("worktreeSync" in patch) {
    settings.worktreeSync = patch.worktreeSync === true && settings.sessionSync === true;
  }
  if ("syncStandbyNodeId" in patch) {
    const v = typeof patch.syncStandbyNodeId === "string" ? patch.syncStandbyNodeId.trim() : "";
    settings.syncStandbyNodeId = v || undefined;
  }
  if ("sessionResumeMode" in patch) {
    settings.sessionResumeMode = patch.sessionResumeMode === "manual" ? "manual" : "auto";
  }
  if ("autoAttachToolImages" in patch) {
    settings.autoAttachToolImages = patch.autoAttachToolImages === true;
    setConfiguredAutoAttachToolImages(settings.autoAttachToolImages);
  }
  writeSettings(settings);
  const snapshot = nodeSettingsSnapshot();
  broadcast({ type: "node.settings", settings: snapshot });
  return snapshot;
}

// Apply persisted node settings at boot: seed the effective sandbox tier and the
// default runtime from settings.json (env still wins for the sandbox), plus the
// passive tool-image-attachment gate (issue #292; BIVY_AUTO_ATTACH_TOOL_IMAGES
// still wins — see src/harness/tool-image-attachments.ts).
setConfiguredSandboxTier(readSettings().defaultSandbox);
setConfiguredAutoAttachToolImages(readSettings().autoAttachToolImages);
{
  const savedAgent = readSettings().defaultAgent;
  if (typeof savedAgent === "string" && savedAgent.trim()) {
    try { defaultRuntimeId = runtimeHost.resolveRuntimeId(savedAgent.trim(), defaultRuntimeId); } catch { /* not available; keep current default */ }
  }
}

const commands: MeshCommand[] = [
  { name: "/commands", description: "Open the searchable command list.", kind: "server" },
  { name: "/clear", description: "Clear the local chat.", kind: "server" },
  { name: "/sessions", description: "Refresh and show saved sessions.", kind: "server" },
  { name: "/issue", description: "Pick up a configured GitHub issue on this computer.", kind: "server" },
  { name: "/github-status", description: "Force a fresh GitHub PR status check for this session.", kind: "server", run: async () => {
    if (!active) return { ok: false, error: "No active session" };
    const changed = await refreshPullRequests(active);
    return { ok: true, changed, prUrl: active.prUrl, prs: active.prs };
  } },
  { name: "/new", description: "Start a new agent session in the current workspace.", kind: "server", run: () => createSession(active?.workspace ?? defaultWorkspace).then(({ id, workspace, sessionFile }) => ({ id, workspace, sessionFile })) },
  { name: "/abort", description: "Abort the active agent session.", kind: "server", run: async () => {
    if (!active) return { ok: false, error: "No active session" };
    await active.session.abort();
    return { ok: true };
  } },
  { name: "/help", description: "Show quick chat help.", kind: "server", run: () => ({
    text: "Use /commands to open the command list. Press Cmd/Ctrl+Enter to send a prompt. Attach files/images with the + button or by dragging them into the message box.",
  }) },
  { name: "/login", description: "Connect a model provider in Terminal.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix, "/login"], requiresTty: true } },
  { name: "/model", description: "Open the searchable model selector.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix, "/model"], requiresTty: true } },
  { name: "/terminal", description: "Start the terminal agent in this workspace and stream its output.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix], requiresTty: true } },
  { name: "/config", description: "Show agent configuration.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix, "config"], requiresTty: true } },
  { name: "/list", description: "List installed agent packages.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix, "list"], requiresTty: true } },
  { name: "/update", description: "Update agent packages.", kind: "native", spawn: { command: process.execPath, args: [...agentPrefix, "update"], requiresTty: true } },
];

// A local client whose send buffer has grown past this is behind on reads (slow
// network, background tab); used by both broadcast paths below.
const CLIENT_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // These events are not self-superseding, so unlike broadcastCoalesced we
    // can't silently skip a backed-up client. But a socket this far behind is
    // wedged (dead TCP behind NAT, a frozen background tab) and would otherwise
    // make `ws` buffer unbounded memory on the daemon's heap over a multi-day
    // run. Terminate it — it reconnects and re-syncs from the event log — rather
    // than leak. A healthy client never approaches this high-water mark.
    if (client.bufferedAmount > CLIENT_BACKPRESSURE_BYTES) {
      try { client.terminate(); } catch {}
      continue;
    }
    client.send(data);
  }
  // Mirror events to remote clients through the relay (encrypted), if enabled.
  relay?.sendEvent(payload);
}

// For *superseding* updates it is safe to skip a backed-up client — the next
// full-content update (or the turn's message_end) makes it whole — rather than
// letting `ws` queue unbounded memory on its behalf.
//
// Broadcast a coalesced, self-superseding (full-content) session event. Same fan
// out as broadcast(), but skips any local client that is backed up: dropping a
// superseded update is lossless because a newer one always follows.
function broadcastCoalesced(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > CLIENT_BACKPRESSURE_BYTES) continue;
    client.send(data);
  }
  relay?.sendEvent(payload);
}

// Collapse the burst of assistant `message_update`s (one per agent stdout line,
// each carrying the FULL text so far) into ~1 fan-out per tick. See
// session-event-coalescer.ts for the rationale (kills the O(n^2) re-serialize).
const SESSION_UPDATE_COALESCE_MS = 16;
const sessionEvents = new SessionEventCoalescer({
  coalesceMs: SESSION_UPDATE_COALESCE_MS,
  emit: broadcastCoalesced,
});

// Tell every client whether a session is currently driven by its interactive
// TUI, so they lock/unlock the chat composer for it (single writer).
function broadcastTuiState(sessionId: string, active: boolean) {
  broadcast({ type: "terminal.tui", sessionId, active });
}

// Terminals opened by relay clients (phone/web over the relay). Output is emitted
// via the relay tagged with termId; clients filter by it. (Per-client unicast is
// a hardening step before remote GA — see docs/DEVELOPMENT_PLAN.md B4.)
const relayTerminals = new Set<string>();

// Run-terminals: native agent sessions started by `bivy run` (and reattachable by
// `bivy resume` / the app). Unlike socket-owned terminals, these live in the
// daemon independent of the client that started them — closing your laptop
// terminal leaves the session running so you can reattach from a phone or
// another terminal. Their output is broadcast to every client (tagged by termId,
// each client filters) so the launching terminal and the phone share one live
// TUI.
const runTerminals = new Set<string>();

async function runTerminalList() {
  const runs = terminals
    .list((meta) => meta.kind === "run")
    .filter((t) => runTerminals.has(t.id));

  // Native agents write their useful title only after the first prompt. Reconcile
  // auto-named terminals with the agent durable session; explicit --name wins.
  let saved: Awaited<ReturnType<typeof listAllSessions>> = [];
  if (runs.some((t) => t.meta.autoName)) {
    try { saved = await listAllSessions(); } catch { /* best-effort listing */ }
  }
  const out = [];
  for (const t of runs) {
    let sessionRef = t.meta.sessionId;
    // Discover the on-disk session for agents that assign their id lazily (Pi,
    // Codex). Runs whenever there's no pinned id — not just for auto-named
    // terminals — so the takeover-readiness flag below is accurate even for a
    // run launched with an explicit --name.
    if (!sessionRef) {
      try { sessionRef = await SESSION_DISCOVERY_BY_AGENT[t.meta.agent ?? ""]?.(t.workspace, t.createdAt); }
      catch { /* agent may still be starting */ }
    }
    const native = sessionRef ? saved.find((s) => s.id === sessionRef || s.path === sessionRef) : undefined;
    const nativeName = native?.name?.trim();
    if (t.meta.autoName && nativeName && !isEmptyUntitledTitle(nativeName)) t.meta.name = nativeName;
    const { autoName: _autoName, ...publicMeta } = t.meta;
    // "Continue as chat" can only adopt a session that exists: a pinned id, or a
    // session discovered on disk. Surface that so the client can disable the
    // affordance (with guidance) until the agent has actually started its
    // session, instead of letting the user tap it and hit a 409.
    out.push({ termId: t.id, workspace: t.workspace, createdAt: t.createdAt, lastActivityAt: t.lastActivityAt, pid: terminals.pid(t.id), ...publicMeta, takeoverReady: Boolean(sessionRef) });
  }
  return out;
}

function broadcastRunTerminalList(): void {
  void runTerminalList().then((listed) => broadcast({ type: "terminal.list", terminals: listed })).catch(() => {});
}

// Throttle `terminal.activity` pings so a chatty agent can't flood every client
// with a frame per PTY chunk. One ping per this interval per run-terminal is
// enough for the cockpit to show an "active" indicator; clients decay to idle
// locally when the pings stop. Keyed by termId, cleared when the PTY exits.
const ACTIVITY_PING_INTERVAL = 2000;
const lastActivityPing = new Map<string, number>();

// A `bivy run` agent that produces output and then stays quiet this long has
// very likely parked at a prompt waiting for you. On that working→quiet edge we
// fire one push hint (reusing the account's existing web-push path) so you get
// buzzed when an agent needs you after stepping away, plus a `terminal.idle`
// broadcast. Re-arms on new output — one notification per quiet period. Kept
// well above the UI's active window (which flips the drawer to "waiting" fast)
// so it doesn't buzz on every conversational turn. Tunable for tests.
const IDLE_NOTIFY_INTERVAL = Number(process.env.BIVY_RUN_IDLE_NOTIFY_MS) || 30_000;
const runIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// (Re)arm the quiet-agent timer for a run-terminal; fires once when it stays
// silent for IDLE_NOTIFY_INTERVAL, unless new output re-arms it first.
function armRunIdleNotify(id: string, displayName: string | undefined) {
  const existing = runIdleTimers.get(id);
  if (existing) clearTimeout(existing);
  runIdleTimers.set(id, setTimeout(() => {
    runIdleTimers.delete(id);
    if (!runTerminals.has(id)) return;
    broadcast({ type: "terminal.idle", termId: id, at: Date.now() });
    broadcastRunTerminalList();
    const who = displayName || "An agent";
    // No sessionId: a run-terminal's pinned session is still owned by its live
    // native TUI, so deep-linking it into a governed chat would resume it as a
    // second writer (the hazard `takeoverRunTerminal` avoids by killing the PTY
    // first). The hint stays informative but opens the app root.
    void sendNotificationHint({
      kind: "agent_waiting",
      title: `${who} is waiting`,
      body: `${who} has been quiet for a bit — it may be waiting for your input.`,
    });
  }, IDLE_NOTIFY_INTERVAL));
}

function clearRunIdleNotify(id: string) {
  const t = runIdleTimers.get(id);
  if (t) { clearTimeout(t); runIdleTimers.delete(id); }
}

// Bell → push ("call me back"). A program ringing the terminal bell while you're
// away from the mobile/PWA shell is exactly the moment to buzz you — a long build
// that ends in `\a`, a job that wants confirmation. But an interactive shell also
// bells constantly for benign reasons (a readline error, an ambiguous
// tab-completion) *while you're actively typing*, so an unconditional push would
// be pure noise. We fire only when BOTH hold: (1) you haven't typed into that
// terminal for BELL_QUIET_INPUT_MS — you've stepped away, this isn't a keystroke
// echo; and (2) we haven't already buzzed for this terminal within
// BELL_NOTIFY_COOLDOWN_MS — a bell-storm collapses to one call. Reuses the
// account's existing web-push path (sendNotificationHint), so on a purely local
// node with no control plane it's a harmless no-op.
const BELL_QUIET_INPUT_MS = Number(process.env.BIVY_TERM_BELL_QUIET_MS) || 8_000;
const BELL_NOTIFY_COOLDOWN_MS = Number(process.env.BIVY_TERM_BELL_COOLDOWN_MS) || 45_000;
const lastBellNotify = new Map<string, number>();

// Decide whether a bell from terminal `id` should raise a call-me-back push, and
// if so fire it. Gated by recent-input and cooldown (see the consts above).
function maybeNotifyBell(id: string) {
  const now = Date.now();
  const lastInput = terminals.lastInput(id);
  if (lastInput != null && now - lastInput < BELL_QUIET_INPUT_MS) return; // actively typing
  const lastNotify = lastBellNotify.get(id) ?? 0;
  if (now - lastNotify < BELL_NOTIFY_COOLDOWN_MS) return; // already buzzed recently
  lastBellNotify.set(id, now);
  const meta = terminals.meta(id);
  const who = meta?.name?.trim() || meta?.label?.trim() || "A terminal";
  // No sessionId — see armRunIdleNotify: a live run-terminal's pinned session
  // must not be resumed as a chat behind its native TUI's back.
  void sendNotificationHint({
    kind: "terminal_bell",
    title: "Terminal bell",
    body: `${who} rang the terminal bell — it may be waiting for you.`,
  });
}

function clearBellNotify(id: string) {
  lastBellNotify.delete(id);
}

// Local WS sockets currently viewing each run-terminal (attached via
// terminal.open.run / terminal.attach). Run-terminal OUTPUT is unicast to just
// these sockets instead of every client, so a device only watching chat doesn't
// receive a chatty agent's raw bytes. Discovery/state events (created / closed /
// activity / idle / exit) still broadcast to everyone — they drive the drawer
// list for all clients. The relay path is intentionally unchanged: remote
// clients still receive termId-tagged output frames and filter locally, because
// the relay can't address an individual device (true per-remote-client unicast
// is a later relay-protocol change).
const runViewers = new Map<string, Set<WebSocket>>();

function addRunViewer(termId: string, socket: WebSocket) {
  let set = runViewers.get(termId);
  if (!set) { set = new Set(); runViewers.set(termId, set); }
  set.add(socket);
}

// Remove a socket from every run-terminal's viewer set (on disconnect). Cheap:
// there are only a handful of run-terminals.
function dropRunViewer(socket: WebSocket) {
  for (const [id, set] of runViewers) {
    set.delete(socket);
    if (set.size === 0) runViewers.delete(id);
  }
}

// Deliver a run-terminal's output to the local sockets attached to it, plus the
// relay (still a room broadcast). Only OUTPUT is scoped this way; everything
// else about run-terminals still uses broadcast().
function emitRunOutput(termId: string, data: string) {
  const viewers = runViewers.get(termId);
  if (viewers && viewers.size) {
    const payload = JSON.stringify({ type: "terminal.output", termId, data });
    for (const s of viewers) { if (s.readyState === WebSocket.OPEN) s.send(payload); }
  }
  relay?.sendEvent({ type: "terminal.output", termId, data });
}

// Find a live run-terminal already attached to a given external multiplexer
// target (e.g. "tmux:work"), so a second attach to that target (from the app)
// reuses the one PTY instead of spawning another `tmux attach`.
function runTerminalForMux(target: string): string | undefined {
  if (!target) return undefined;
  for (const id of runTerminals) {
    if (terminals.meta(id)?.mux === target) return id;
  }
  return undefined;
}

interface RunTerminalSpec {
  command: string;
  args: string[];
  agent?: string;
  label?: string;
  name?: string;
  model?: string;
  mux?: string;
  workspace?: string;
  cols?: number;
  rows?: number;
  /** Stable id of the client launching/attaching, for per-client PTY sizing. */
  clientId?: string;
  /** Session id pinned at launch (e.g. `claude --session-id <uuid>`), if any. */
  sessionId?: string;
}

// A readable default session name when the user didn't pass `bivy run --name`.
// Combines the agent (or command basename) with the workspace's basename so
// several live sessions of the same agent in different repos stay distinct in
// `bivy sessions` and the app's "Running agents" drawer.
function defaultRunName(agent: string | undefined, command: string, workspace: string): string {
  const base = agent || command.split(/\s+/)[0]?.split(/[\\/]/).pop() || "session";
  const dir = workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return dir ? `${base} · ${dir}` : base;
}

// Open (or reuse) a persistent run-terminal — the daemon-owned PTY behind `bivy
// run` (and `bivy resume`). Output is broadcast to every client so the launching
// terminal and any phone/other-terminal share one live session, and the id is
// NOT added to any socket's owned-set, so it outlives the socket that started it.
async function openRunTerminal(spec: RunTerminalSpec, emit: (event: unknown) => void): Promise<string | undefined> {
  const label = spec.label ?? spec.agent;
  // Reuse a live attach terminal for the same multiplexer target — bind the
  // caller to it and replay scrollback, exactly like terminal.attach.
  if (spec.mux) {
    const existing = runTerminalForMux(spec.mux);
    if (existing) {
      if (spec.clientId && (spec.cols !== undefined || spec.rows !== undefined)) terminals.setClientSize(existing, spec.clientId, spec.cols || 80, spec.rows || 24);
      emit({ type: "terminal.attached", termId: existing, data: terminals.snapshot(existing) ?? "" });
      return existing;
    }
  }
  // Cap concurrent run terminals. Unlike sessions these are daemon-owned and may
  // hold live work a user detached from, so we never auto-kill one — reject the
  // new open with a clear message instead. (The mux-reuse path above already
  // returned for an existing target, so this only gates genuinely-new PTYs.)
  if (Number.isFinite(maxRunTerminals) && maxRunTerminals > 0 && runTerminals.size >= maxRunTerminals) {
    emit({ type: "terminal.error", error: `Too many run terminals open (${runTerminals.size}/${maxRunTerminals}). Close one (e.g. 'bivy kill') or raise BIVY_MAX_RUN_TERMINALS.` });
    return undefined;
  }
  const workspace = spec.workspace || active?.session.cwd || active?.worktree?.path || active?.workspace || defaultWorkspace;
  // Unify keys: project Bivy's logins onto this native agent (env vars, and a
  // native store for Pi/Codex). A mux attach reuses an existing session and gets
  // no injection. Best-effort — a provisioning failure must not block the launch.
  const credentialEnv = spec.mux ? {} : await provisionAgentRun(credsDir, piDir, spec.agent, workspace).catch((error) => {
    console.warn(`[provision] credential projection for "${spec.agent}" failed:`, (error as Error).message);
    return {};
  });
  const commandLine = [spec.command, ...spec.args].join(" ");
  // A mux attach terminal is already named by its target; only synthesize a
  // default name for plain `bivy run` sessions.
  const explicitName = spec.name?.trim();
  const name = explicitName || (spec.mux ? undefined : defaultRunName(spec.agent, commandLine, workspace));
  // Only genuine `bivy run` agents get quiet-agent push hints; an adopted
  // tmux/zellij/screen attach isn't "your agent waiting".
  const notifiable = !spec.mux;
  try {
    const id = terminals.open({
      workspace,
      command: spec.command,
      args: spec.args,
      // native-pi.ts normally reads the daemon's default BIVY_WORKSPACE. A
      // run-terminal may override that with --workspace/--clone; pass the
      // resolved PTY workspace through so Pi records the same cwd we later use
      // to correlate its session for takeover.
      env: { ...credentialEnv, ...(spec.agent === "pi" ? { BIVY_WORKSPACE: workspace } : {}) },
      cols: spec.cols,
      rows: spec.rows,
      clientId: spec.clientId,
      meta: { kind: "run", agent: spec.agent, model: spec.model, label, name, autoName: !explicitName && !spec.mux, command: commandLine, mux: spec.mux, sessionId: spec.sessionId },
      onData: (data) => {
        // Raw bytes go only to the sockets attached to this run-terminal (+ the
        // relay), not every connected client.
        emitRunOutput(id, data);
        // Edge-throttled liveness ping so the cockpit can show active vs idle
        // without a frame per chunk.
        const at = Date.now();
        if (at - (lastActivityPing.get(id) ?? 0) >= ACTIVITY_PING_INTERVAL) {
          lastActivityPing.set(id, at);
          broadcast({ type: "terminal.activity", termId: id, at });
        }
        // Fresh output means the agent is working again — (re)start the quiet
        // countdown so a push only fires once it actually goes silent.
        if (notifiable) armRunIdleNotify(id, name);
      },
      onExit: (code) => {
        runTerminals.delete(id);
        runViewers.delete(id);
        lastActivityPing.delete(id);
        clearRunIdleNotify(id);
        broadcast({ type: "terminal.exit", termId: id, code });
        broadcast({ type: "terminal.closed", termId: id });
        // Unify keys, reverse direction: a login done inside the agent's own CLI
        // (e.g. `codex login`) is folded back into Bivy's vault, then synced.
        if (!spec.mux) {
          void ingestAgentCredentials(spec.agent, credsDir, piDir)
            .then(async (imported) => {
              if (imported > 0) {
                broadcast({ type: "providers.list", providers: await listProvidersUnified() });
                await pushModelAuthToControlPlane();
              }
            })
            .catch(() => {});
        }
      },
    });
    runTerminals.add(id);
    const createdAt = Date.now();
    emit({ type: "terminal.opened", termId: id, workspace, mode: "run", agent: spec.agent, label, name });
    broadcast({ type: "terminal.created", terminal: { termId: id, workspace, createdAt, lastActivityAt: createdAt, kind: "run", agent: spec.agent, model: spec.model, label, name, command: commandLine, mux: spec.mux, sessionId: spec.sessionId, pid: terminals.pid(id) } });
    return id;
  } catch (error) {
    emit({ type: "terminal.error", workspace, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

// Agents whose pinned run-terminal session can be reopened as a governed chat.
// Keyed by agent id → the runtime that resumes it. Extended as more agents gain
// a resumable, tool-intercepting runtime (see docs/agent-runtimes.md).
const TAKEOVER_RUNTIME_BY_AGENT: Record<string, string> = {
  claude: "claude-code-sdk",
  pi: "pi",
  // Reopen a taken-over Codex terminal as the governed + resumable app-server
  // shim: it resumes the discovered rollout id via thread/resume (validated — an
  // exec-created session resumes through the app-server with full context), so
  // the adopted chat gets per-tool approvals, not just the exec jail.
  codex: "codex-approvals",
};

// The CLI command to continue an adopted session back in a terminal.
const RESUME_CLI_BY_AGENT: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};

// Same commands, keyed by runtime id instead of the short takeover agent alias
// above — for native session discovery (issue #156), where a session with a
// live external process can't be safely imported (no channel to take over a
// process Bivy doesn't own) but is still "offered follow/read-only... per
// provider capability": the exact command to attach to it themselves, in
// their own terminal, without Bivy touching it.
const NATIVE_RESUME_CLI_BY_RUNTIME: Record<string, (id: string) => string> = {
  "claude-code-sdk": (id) => `claude --resume ${id}`,
  "codex-approvals": (id) => `codex resume ${id}`,
};

// When no resumable session id can be found, why — and what to do about it.
// These agents assign their id lazily (Codex/Pi write a session only once a turn
// starts), so an idle run-terminal simply has nothing to adopt yet.
const TAKEOVER_EMPTY_HINT_BY_AGENT: Record<string, string> = {
  codex:
    "Codex writes its session only after the first message. Send one message in the terminal, then continue as chat.",
  pi: "Pi assigns its session once the conversation starts. Send one message in the terminal, then continue as chat.",
};

// For agents with no launch-time session-id pin, locate the on-disk session a run
// produced (by cwd + start time) so a takeover can still resume the right one.
const SESSION_DISCOVERY_BY_AGENT: Record<string, (cwd: string, since: number) => string | undefined | Promise<string | undefined>> = {
  codex: (cwd, since) => discoverCodexSessionForCwd(cwd, since)?.id,
  // Pi assigns its session id inside the native TUI, after the PTY is launched,
  // so there is no launch-time flag to pin. Its durable index does carry cwd +
  // creation time; correlate those with the run-terminal and resume by path.
  pi: async (cwd, since) => {
    const match = discoverPiSessionForCwd(await runtimeHost.listSessions(getRuntime("pi")), cwd, since);
    return match?.path || match?.id;
  },
};

// "Continue as chat": stop the native TUI running in a pinned run-terminal and
// reopen its session as a governed, structured chat on the owning runtime. The
// pinned session id is the resume target; closing the terminal SIGTERMs the PTY
// (the kill target), so there is never a second live writer on the session.
async function takeoverRunTerminal(
  opts: { termId?: string; sessionId?: string },
): Promise<{ ok: true; sessionId: string; runtimeId: string; resumeCommand?: string } | { ok: false; status: number; error: string }> {
  const runs = terminals.list((m) => m.kind === "run").filter((t) => runTerminals.has(t.id));
  const entry = opts.termId
    ? runs.find((t) => t.id === opts.termId)
    : opts.sessionId
      ? runs.find((t) => t.meta.sessionId === opts.sessionId)
      : undefined;
  if (!entry) return { ok: false, status: 404, error: "No matching live run-terminal." };
  const agent = entry.meta.agent ?? "";
  const runtimeId = TAKEOVER_RUNTIME_BY_AGENT[agent];
  if (!runtimeId) {
    return { ok: false, status: 409, error: `"Continue as chat" isn't supported for "${agent || "this agent"}" yet.` };
  }
  // The session to resume: pinned at launch (Claude), else discovered from the
  // agent's durable session index by cwd + terminal start time (Codex/Pi).
  const discovered = entry.meta.sessionId
    ? undefined
    : await SESSION_DISCOVERY_BY_AGENT[agent]?.(entry.workspace, entry.createdAt);
  const pinned = entry.meta.sessionId ?? discovered;
  if (!pinned) {
    const hint = TAKEOVER_EMPTY_HINT_BY_AGENT[agent]
      ?? `Start it via the shim (or \`bivy run\`), or continue it in a terminal.`;
    return { ok: false, status: 409, error: `Couldn't find a ${agent || "session"} session to continue yet. ${hint}` };
  }
  const workspace = entry.workspace;
  // 1. Stop the native TUI (the PTY this run-terminal owns is the kill target).
  terminals.close(entry.id);
  runTerminals.delete(entry.id);
  runViewers.delete(entry.id);
  broadcast({ type: "terminal.closed", termId: entry.id });
  // 2. Reopen the session as a chat on its runtime (governed for claude/pi/codex).
  const record = await createSession(workspace, pinned, { runtimeId, makeActive: true, source: "takeover" });
  const resumeCommand = RESUME_CLI_BY_AGENT[agent]?.(pinned);
  return { ok: true, sessionId: record.id, runtimeId, resumeCommand };
}

/**
 * Route a `terminal.*` client message to the terminal manager. Transport-agnostic:
 * `emit` delivers events back to the requesting client (a local socket, or all
 * relay clients tagged by termId), and `owned` tracks ids for cleanup on
 * disconnect. `viewRun`, present only for a local socket, registers that socket
 * as a viewer of a run-terminal so its output is unicast (and so it is NOT
 * reaped when the socket closes — run-terminals are daemon-owned and must
 * outlive an attaching client). Returns true if the message was a terminal
 * message.
 */
function handleTerminalMessage(
  msg: { kind?: string; termId?: unknown; data?: unknown; cols?: unknown; rows?: unknown; workspace?: unknown; sessionId?: unknown; agent?: unknown; label?: unknown; name?: unknown; model?: unknown; command?: unknown; args?: unknown; mux?: unknown; standalone?: unknown },
  emit: (event: unknown) => void,
  owned: Set<string>,
  // Stable id for the transport (socket/relay) this message arrived on. A shared
  // PTY is sized to the min over all attached clients, keyed by this id, so a
  // second client attaching at a different window size can't reflow the first
  // client's TUI. See TerminalManager.setClientSize.
  clientId: string,
  viewRun?: (termId: string) => void,
): boolean {
  switch (msg.kind) {
    case "terminal.list":
      void runTerminalList().then((listed) => emit({ type: "terminal.list", terminals: listed }));
      return true;
    case "terminal.takeover": {
      // "Continue as chat": stop the pinned run-terminal's native TUI and reopen
      // its session as a governed chat. Async; the ack rides back to this client,
      // and the createSession inside broadcasts session.created to switch the UI.
      const takeoverTermId = typeof msg.termId === "string" && msg.termId ? msg.termId : undefined;
      const takeoverSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
      void takeoverRunTerminal({ termId: takeoverTermId, sessionId: takeoverSessionId })
        .then((r) =>
          r.ok
            ? emit({ type: "terminal.takeover.result", ok: true, termId: takeoverTermId, sessionId: r.sessionId, runtimeId: r.runtimeId, resumeCommand: r.resumeCommand })
            : emit({ type: "terminal.takeover.result", ok: false, termId: takeoverTermId, error: r.error }),
        )
        .catch((error) => emit({ type: "terminal.takeover.result", ok: false, termId: takeoverTermId, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    case "terminal.multiplexers":
      // Named under the terminal.* namespace so it rides the same client→node
      // routing as other terminal messages (the node only dispatches terminal.*).
      void listMultiplexerSessions().then((sessions) => emit({ type: "multiplexer.list", sessions })).catch(() => emit({ type: "multiplexer.list", sessions: [] }));
      return true;
    case "terminal.open.run": {
      // Launch a native agent (real CLI/TUI) in a persistent PTY the daemon owns.
      // The command is resolved by the caller (the `bivy run` CLI, which already
      // knows how to find each agent's binary); the node just spawns it in the
      // workspace.
      const command = typeof msg.command === "string" ? msg.command.trim() : "";
      if (!command) { emit({ type: "terminal.error", error: "terminal.open.run requires a command." }); return true; }
      void openRunTerminal({
        command,
        args: Array.isArray(msg.args) ? msg.args.map(String) : [],
        agent: typeof msg.agent === "string" ? msg.agent : undefined,
        label: typeof msg.label === "string" ? msg.label : undefined,
        name: typeof msg.name === "string" ? msg.name : undefined,
        model: typeof msg.model === "string" ? msg.model : undefined,
        mux: typeof msg.mux === "string" && msg.mux ? msg.mux : undefined,
        workspace: typeof msg.workspace === "string" && msg.workspace ? msg.workspace : undefined,
        cols: Number(msg.cols) || undefined,
        rows: Number(msg.rows) || undefined,
        clientId,
        sessionId: typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined,
      }, emit).then((runId) => { if (runId) viewRun?.(runId); });
      return true;
    }
    case "terminal.open.mux": {
      // Attach to an existing tmux/zellij/screen session (Stage 2 of `bivy
      // attach`). The node resolves the attach command so clients don't need to
      // know each multiplexer's syntax, tags it with the target for dedupe, and
      // reuses a live attach terminal for the same target when one exists.
      const kind = String(msg.agent || "") as MultiplexerKind;
      const name = typeof msg.label === "string" ? msg.label : "";
      if (!["tmux", "zellij", "screen"].includes(kind) || !name) { emit({ type: "terminal.error", error: "terminal.open.mux requires a multiplexer and session name." }); return true; }
      const spec = attachCommand(kind, name);
      void openRunTerminal({
        command: spec.command,
        args: spec.args,
        agent: kind,
        label: `${kind}:${name}`,
        mux: `${kind}:${name}`,
        cols: Number(msg.cols) || undefined,
        rows: Number(msg.rows) || undefined,
        clientId,
      }, emit).then((muxId) => { if (muxId) viewRun?.(muxId); });
      return true;
    }
    case "terminal.open": {
      // The standalone (session-less) terminal — opened from the app's sidebar
      // terminal button, not attached to any chat — always roots at the node's
      // default workspace folder, never a session's cwd. It must not fall back
      // to `active` (the node-global active *chat* session) the way an ordinary
      // terminal does, or it would silently become session-scoped again. See
      // #460.
      const standalone = Boolean(msg.standalone);
      const record = standalone ? undefined : resolveSession(msg.sessionId);
      const workspace = record
        ? (record.session.cwd || record.worktree?.path || record.workspace)
        : standalone
          ? defaultWorkspace
          : (typeof msg.workspace === "string" && msg.workspace ? msg.workspace : (active?.session.cwd || active?.worktree?.path || active?.workspace || defaultWorkspace));
      try {
        const id = terminals.open({
          workspace,
          cols: Number(msg.cols) || undefined,
          rows: Number(msg.rows) || undefined,
          clientId,
          onData: (data) => emit({ type: "terminal.output", termId: id, data }),
          onBell: () => maybeNotifyBell(id),
          onExit: (code) => {
            owned.delete(id);
            clearBellNotify(id);
            emit({ type: "terminal.exit", termId: id, code });
          },
        });
        owned.add(id);
        emit({ type: "terminal.opened", termId: id, workspace, sessionId: record?.id });
      } catch (error) {
        emit({ type: "terminal.error", workspace, sessionId: record?.id, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    case "terminal.open.tui": {
      // Hand this session off to the runtime's interactive TUI in a PTY, resuming
      // the same conversation. While the TUI owns the session, chat prompts for it
      // are refused (single writer) until the TUI exits.
      void (async () => {
        const record = resolveSession(msg.sessionId);
        if (!record) { emit({ type: "terminal.error", error: "Session not found for TUI." }); return; }
        // Idempotent "go to terminal": a TUI is already live for this session
        // (opened here, on another device, or before a reload). Re-attach the
        // caller to that same PTY — replaying its scrollback — instead of
        // spawning a second CLI that would fight over the one session file and
        // orphan the first. A stale id (PTY already gone) falls through to a
        // fresh launch below.
        if (record.tuiTermId) {
          const snapshot = terminals.snapshot(record.tuiTermId);
          if (snapshot != null) {
            owned.add(record.tuiTermId);
            if (typeof msg.cols !== "undefined" || typeof msg.rows !== "undefined") {
              terminals.setClientSize(record.tuiTermId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
            }
            emit({ type: "terminal.attached", termId: record.tuiTermId, data: snapshot });
            return;
          }
        }
        if (sessionBusy(record)) { emit({ type: "terminal.error", sessionId: record.id, error: "Finish or stop the current turn before opening the TUI." }); return; }
        let spec;
        try { spec = record.session.interactiveTuiCommand ? await record.session.interactiveTuiCommand() : null; }
        catch (error) { emit({ type: "terminal.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) }); return; }
        if (!spec) { emit({ type: "terminal.error", sessionId: record.id, error: "This runtime has no interactive TUI available on this node." }); return; }
        const workspace = record.session.cwd || record.worktree?.path || record.workspace;
        try {
          const id = terminals.open({
            workspace,
            command: spec.command,
            args: spec.args,
            env: spec.env,
            cols: Number(msg.cols) || undefined,
            rows: Number(msg.rows) || undefined,
            clientId,
            onData: (data) => emit({ type: "terminal.output", termId: id, data }),
            onExit: (code) => {
              owned.delete(id);
              if (record.tuiTermId === id) {
                record.tuiTermId = undefined;
                void sessionTerminals.forget(record.id).catch(() => {});
                record.tuiRefreshing = true;
                broadcastTuiState(record.id, false);
                void refreshRecordAfterTui(record);
              }
              emit({ type: "terminal.exit", termId: id, code });
            },
          });
          owned.add(id);
          record.tuiTermId = id;
          void sessionTerminals.record(record.id, { termId: id }).catch(() => {});
          emit({ type: "terminal.opened", termId: id, workspace, sessionId: record.id, mode: "tui" });
          broadcastTuiState(record.id, true);
        } catch (error) {
          emit({ type: "terminal.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "terminal.close.tui": {
      // "Take over in chat": stop the interactive TUI that owns this session and
      // hand it back to governed chat. Closing the PTY runs the same onExit path
      // as the user quitting the CLI — it clears tuiTermId, flips tuiRefreshing,
      // rebuilds the in-process session from disk (refreshRecordAfterTui), and
      // broadcasts `terminal.tui {active:false}` — so the composer unlocks with
      // whatever the TUI wrote. Resolve the PTY server-side from the session so a
      // client that never held the termId (another device, post-reload) can do it.
      const record = resolveSession(msg.sessionId);
      const termId = record?.tuiTermId;
      if (termId) {
        terminals.close(termId);
        owned.delete(termId);
        clearBellNotify(termId);
      } else if (record) {
        // No live TUI to close — make sure the client isn't left locked on a
        // stale flag by re-asserting the unlocked state for this session.
        broadcastTuiState(record.id, false);
      }
      return true;
    }
    case "terminal.attach": {
      // Reconnect path: a client that already holds a termId (survived a reload
      // or a dropped socket) re-binds to the still-live shell and gets the
      // retained scrollback replayed so it doesn't resume on a blank screen.
      if (typeof msg.termId === "string") {
        const snapshot = terminals.snapshot(msg.termId);
        if (snapshot != null) {
          // A run-terminal is daemon-owned: register the local socket as a viewer
          // (for unicast output) but DON'T add it to `owned`, or detaching this
          // client would reap a session meant to outlive it. A plain shell/TUI
          // terminal stays socket-owned as before. The relay path (viewRun
          // undefined) keeps its existing behavior.
          if (viewRun && runTerminals.has(msg.termId)) viewRun(msg.termId);
          else owned.add(msg.termId);
          if (typeof msg.cols !== "undefined" || typeof msg.rows !== "undefined") {
            terminals.setClientSize(msg.termId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
          }
          emit({ type: "terminal.attached", termId: msg.termId, data: snapshot });
        } else {
          // The shell is gone (exited or reaped). Tell the client so it can drop
          // the stale id and open a fresh terminal instead of hanging.
          emit({ type: "terminal.gone", termId: msg.termId });
        }
      }
      return true;
    }
    case "terminal.input":
      if (typeof msg.termId === "string" && typeof msg.data === "string") terminals.write(msg.termId, msg.data);
      return true;
    case "terminal.resize":
      if (typeof msg.termId === "string") terminals.setClientSize(msg.termId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
      return true;
    case "terminal.detach":
      // A client stopped viewing this terminal but kept its transport open (e.g.
      // navigated away from a shared run-terminal). Forget its size so the PTY
      // grows back to the min of whoever is still attached.
      if (typeof msg.termId === "string") terminals.dropClientSize(msg.termId, clientId);
      return true;
    case "terminal.close":
      if (typeof msg.termId === "string") {
        terminals.close(msg.termId);
        owned.delete(msg.termId);
        clearBellNotify(msg.termId);
      }
      return true;
    default:
      return false;
  }
}

// Pull an incremental-history cursor (count + opaque token) off a client
// command, if present. Clients send these to backfill only what they don't
// already have cached locally.
function historyCursorFrom(msg: ClientMessage): HistoryCursor {
  return {
    have: typeof msg.have === "number" ? msg.have : undefined,
    haveToken: typeof msg.haveToken === "string" ? msg.haveToken : undefined,
  };
}

type IntermediateMessage = RuntimeMessage & {
  bivyKind: "intermediate";
  afterMessageCount: number;
  createdAt: number;
};

type ToolActivityMessage = RuntimeMessage & {
  bivyKind: "tool";
  afterMessageCount: number;
  createdAt: number;
};

const liveIntermediateBySession = new Map<string, IntermediateMessage>();

// Append the intermediate entry to the append-only log — the sole store (slice 2).
// De-duplication (same-text/same-anchor merge, id-replace) that the old intermediate
// sidecar did up front is now applied by `foldIntermediate` on replay, so appending
// the raw entry is equivalent.
function upsertIntermediateMessage(sessionId: string, entry: IntermediateMessage) {
  eventLog.append(sessionId, entry);
}

function transcriptPath(sessionId: string): string {
  return path.join(transcriptsDir, `${encodeURIComponent(sessionId)}.json`);
}

function eventLogPath(sessionId: string): string {
  return path.join(eventLogDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

// The append-only per-session log (slice 2) — now the SOLE store for a session's
// whole history: overlay detail (reasoning + tool activity) AND the base transcript,
// the latter as bounded delta/reset records. Written on every event; read via
// eventLog.deriveHistory. `redactSecrets` scrubs credentials at the single flush
// choke point before anything lands on the synced-to-PWA disk. I/O/corruption
// failures are never silently converted into empty history: keep a diagnostic,
// log loudly, and notify the owning live session while pending appends remain
// queued for retry.
const eventLogIssues = new Map<string, { operation: string; message: string; at: number }>();
const eventLog = new EventLog(eventLogDir, eventLogPath, redactSecrets, 500, (issue) => {
  eventLogIssues.set(issue.sessionId, { operation: issue.operation, message: issue.message, at: issue.at });
  console.error(`[event-log] ${issue.operation} failed for ${issue.sessionId}: ${issue.message}`);
  const record = openSessions.get(issue.sessionId);
  if (!record) return;
  const warning = `Session history storage problem (${issue.operation}): ${issue.message}`;
  if (record.warning === warning) return;
  record.warning = warning;
  broadcast({ type: "session.notice", sessionId: record.id, level: "error", message: warning });
});

// Global content-addressed store for message attachments (images + files). Unlike
// the per-session `.bivy-attachments/` worktree copy (kept so the agent can open
// files with its tools), this is durable, session-independent, and re-findable:
// the transcript references blobs by hash, and clients rehydrate thumbnails by
// hash after a reload or on another device. See src/session/attachment-store.ts.
const positiveEnvNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const attachmentStore = new AttachmentStore(path.join(appDir, "attachments"), {
  maxFileBytes: positiveEnvNumber("BIVY_ATTACHMENT_MAX_FILE_BYTES", 25 * 1024 * 1024),
  maxStoreBytes: positiveEnvNumber("BIVY_ATTACHMENT_STORE_MAX_BYTES", 2 * 1024 * 1024 * 1024),
  retentionMs: positiveEnvNumber("BIVY_ATTACHMENT_RETENTION_MS", 30 * 24 * 60 * 60 * 1000),
});
let attachmentGcStats = attachmentStore.stats();

function referencedAttachmentHashes(): Set<string> | null {
  // If transcript history is unreadable, collecting nothing would make its
  // still-referenced blobs look orphaned. Fail closed and skip destructive GC.
  if (!eventLog.health().ok) return null;
  const hashes = new Set<string>();
  const ids = new Set(metadata.listSessions().map((session) => session.id));
  for (const record of new Set(openSessions.values())) ids.add(record.id);
  for (const id of ids) {
    for (const entry of eventLog.entries(id)) {
      if (entry.bivyKind === "attachment") for (const ref of entry.refs) hashes.add(ref.hash);
      else if (entry.bivyKind === "outbound-attachment" || entry.bivyKind === "inline-image") hashes.add(entry.ref.hash);
    }
  }
  return eventLog.health().ok ? hashes : null;
}

// --- Warm session replication (docs/session-replication.md) -----------------
// A standby's replica repo lives under appDir/replicas/<id>: a self-contained git
// repo that receives checkpoint bundles and is checked out on promotion. Created
// lazily on the first frame that carries a bundle.
const replicasDir = path.join(appDir, "replicas");
async function ensureReplicaRepo(sessionId: string): Promise<string> {
  const dir = path.join(replicasDir, encodeURIComponent(sessionId));
  await fs.promises.mkdir(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    spawnSync("git", ["-C", dir, "init", "-q"], { timeout: 5000 });
  }
  return dir;
}
// Assembled from daemon accessors; entirely inert unless sessionSync + a standby
// are configured (both default off), so it cannot affect the default daemon path.
const replication = new ReplicationService({
  controlPlaneUrl: () => sessionAdvertiseTarget?.controlPlaneUrl,
  enrollmentToken: () => sessionAdvertiseTarget?.enrollmentToken,
  relayUrl: () => undefined, // the control plane returns the sharded relay URL
  settings: () => {
    const snap = nodeSettingsSnapshot();
    return { sessionSync: snap.sessionSync, worktreeSync: snap.worktreeSync, standbyNodeId: snap.syncStandbyNodeId };
  },
  readRecords: (id) => eventLog.entries(id),
  checkpointHead: async (id) => {
    try {
      return (await harness.checkpoints(id))[0]?.id;
    } catch {
      return undefined;
    }
  },
  repoDirFor: (id) => {
    const rec = openSessions.get(id);
    return rec ? harnessDirFor(rec) : undefined;
  },
  runtimeSessionRef: (id) => openSessions.get(id)?.sessionFile,
  replicaRepoDir: (id) => ensureReplicaRepo(id),
  persistReplicaRecords: (id, records) => eventLog.rewrite(id, records),
  upsertReplicaMeta: (id, info) => {
    try {
      metadata.upsertSession({ id, source: `replica${info.ownerNodeId ? `:${info.ownerNodeId}` : ""}`, status: "saved" });
    } catch {
      /* best-effort replica listing */
    }
  },
  log: (m) => console.error(`[replication] ${m}`),
});

// Retire the legacy overlay sidecars. The append-only log is the sole overlay
// store now and every session was migrated into it by the prior release's boot
// migration (.migrated-overlays-v1), verified complete on-disk before this landed.
// Delete the frozen intermediate-messages/ + tool-activities/ dirs so they stop
// accumulating; idempotent (a fresh install never had them, a re-run finds them
// gone). Best-effort — a failure just leaves the now-unread dirs in place.
function retireLegacyOverlayDirs(): void {
  for (const dir of [intermediateMessagesDir, toolActivitiesDir]) {
    try {
      if (!fs.existsSync(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[event-log] removed retired legacy overlay dir: ${path.basename(dir)}`);
    } catch { /* leave it; it is no longer read */ }
  }
}
retireLegacyOverlayDirs();

// One-time migration: seed each pre-existing session's base transcript into the log
// as a single reset record, so a session that predates the base fold reads its full
// conversation from the log (not just the tail it would accumulate afterwards).
// Idempotent + marker-guarded (mirrors the prior migrateOverlaysToLog): re-runs skip
// via the marker, and a per-session `hasBase` guard makes a marker-less re-run safe
// too. `retireTranscriptsDir` (below) runs AFTER this, so migration still reads the
// legacy files before they are swept.
const baseMigrationMarker = path.join(eventLogDir, ".migrated-base-v1");
function migrateBaseToLog(): void {
  if (fs.existsSync(baseMigrationMarker)) return;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
  } catch { /* dir may not exist yet */ }
  let migrated = 0;
  for (const id of ids) {
    try {
      if (eventLog.hasBase(id)) continue; // already seeded
      const parsed = JSON.parse(fs.readFileSync(transcriptPath(id), "utf8"));
      if (!Array.isArray(parsed)) continue;
      const messages = parsed.filter((m) => m != null && typeof m === "object" && typeof (m as { role?: unknown }).role === "string") as RuntimeMessage[];
      if (!messages.length) continue;
      eventLog.appendBaseSnapshot(id, messages); // empty prev → a single full reset
      eventLog.flush(id);
      migrated++;
    } catch { /* skip a corrupt session, keep going */ }
  }
  try {
    fs.mkdirSync(eventLogDir, { recursive: true });
    fs.writeFileSync(baseMigrationMarker, `migrated ${migrated} session(s) base transcript into the log at ${new Date().toISOString()}\n`);
    console.log(`[event-log] migrated ${migrated} session(s) base transcript into the append-only log`);
  } catch { /* marker write failed — idempotent, retries next boot */ }
}
migrateBaseToLog();

// Retire the legacy base-transcript dir now that the append-only log is the sole
// store and every session's base was folded in (migrateBaseToLog, verified live).
// Delete transcripts/ so it stops shadowing the one-file-per-session model; runs
// AFTER the migration so the seed still reads it. Idempotent + best-effort (a fresh
// install never had it; a re-run finds it gone). A tar backup of the pre-sweep dir
// is kept off-tree per the rollout's safety net.
function retireTranscriptsDir(): void {
  try {
    if (!fs.existsSync(transcriptsDir)) return;
    fs.rmSync(transcriptsDir, { recursive: true, force: true });
    console.log(`[event-log] removed retired legacy base-transcript dir: ${path.basename(transcriptsDir)}`);
  } catch { /* leave it; it is no longer read */ }
}
retireTranscriptsDir();

/**
 * Record the runtime's live base transcript (user prompts + assistant text) into
 * the event log so a reopened session can rebuild the conversation even for runtimes
 * with no build-free `readMessages` and no external rollout. Skips the write when the
 * runtime has nothing yet, so a transient empty read can never clobber a good base
 * with `[]`. The log stores it as a bounded delta (see EventLog.appendBaseSnapshot).
 */
function persistTranscriptSnapshot(record: SessionRecord): void {
  const base = record.session.getMessages();
  if (!base.length) return;
  eventLog.appendBaseSnapshot(record.id, base);
}

// In-flight dedupe so two sessions (or two turns) referencing the same remote
// image URL only ever trigger one outbound fetch. Process-lifetime only — a
// restart just means the first re-encounter fetches again, which is fine.
const inlineImageFetchInFlight = new Map<string, Promise<void>>();
// A URL that failed (bad host, timeout, not-an-image, …) is not retried for a
// cooldown window, so a persistently broken URL in a long-lived session can't
// turn every subsequent message_end into a wasted fetch attempt.
const inlineImageFailedAt = new Map<string, number>();
const INLINE_IMAGE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Scan a session's just-finalized assistant messages for remote markdown images
 * (`![alt](https://…)`) and, for any URL not already resolved or in flight,
 * fetch it (SSRF-guarded, size-capped — see inline-image-fetch.ts), store the
 * bytes in the content-addressed AttachmentStore, persist the durable url→ref
 * mapping, and broadcast it live so an already-open chat hydrates the image
 * without waiting for a reload. Fire-and-forget: called from the session event
 * listener, which must not block on a network fetch.
 */
function resolveInlineImages(record: SessionRecord): void {
  const messages = record.session.getMessages();
  const urls = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const url of extractInlineImageUrls(assistantTextForImageScan(m.content))) urls.add(url);
  }
  if (!urls.size) return;
  const alreadyResolved = new Set(eventLog.readInlineImages(record.id).map(([url]) => url));
  for (const url of urls) {
    if (alreadyResolved.has(url) || inlineImageFetchInFlight.has(url)) continue;
    const failedAt = inlineImageFailedAt.get(url);
    if (failedAt !== undefined && Date.now() - failedAt < INLINE_IMAGE_RETRY_COOLDOWN_MS) continue;
    const task = (async () => {
      try {
        const result = await fetchInlineImage(url);
        if (isFetchImageError(result)) {
          console.warn(`[inline-image] ${url}: ${result.error}`);
          inlineImageFailedAt.set(url, Date.now());
          return;
        }
        const ref = attachmentStore.put(result.bytes, {
          name: inlineImageDisplayName(url, result.mimeType),
          mimeType: result.mimeType,
          kind: "image",
        });
        eventLog.appendInlineImage(record.id, { url, ref });
        eventLog.flush(record.id);
        broadcast({ type: "session.event", sessionId: record.id, event: { type: "inlineImage", url, ref } });
      } catch (error) {
        console.warn(`[inline-image] ${url}:`, error instanceof Error ? error.message : String(error));
        inlineImageFailedAt.set(url, Date.now());
      } finally {
        inlineImageFetchInFlight.delete(url);
      }
    })();
    inlineImageFetchInFlight.set(url, task);
  }
}

// Append the tool-activity entry to the log. The id-merge and last-500 cap the old
// store applied are now applied by `foldTool` on replay.
function upsertToolActivityMessage(sessionId: string, entry: ToolActivityMessage) {
  eventLog.append(sessionId, entry);
}

function toolEventId(event: Record<string, unknown>): string {
  const toolCall = event.toolCall as Record<string, unknown> | undefined;
  const input = (event.input || event.toolInput || event.args || toolCall?.input || {}) as Record<string, unknown>;
  const explicit = event.toolUseId || event.tool_use_id || event.toolCallId || event.callId || event.id || toolCall?.id;
  if (explicit) return String(explicit);
  return `${String(event.toolName || event.name || toolCall?.name || "tool")}:${String(input.path || input.file || input.filePath || input.command || input.cmd || input.query || "")}`;
}

function persistToolActivityFromEvent(record: SessionRecord, runtimeEvent: RuntimeEvent) {
  const event = runtimeEvent as Record<string, unknown>;
  const type = String(event.type || "");
  if (!["tool_call", "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result", "function_call", "function_result"].includes(type)) return;
  const callId = toolEventId(event);
  const toolCall = event.toolCall as Record<string, unknown> | undefined;
  const input = (event.input || event.toolInput || event.args || toolCall?.input || {}) as Record<string, unknown>;
  const name = String(event.toolName || event.name || toolCall?.name || "tool");
  const now = Date.now();
  const base = { role: "assistant" as const, bivyKind: "tool" as const, afterMessageCount: record.session.getMessages().length, createdAt: now };
  if (type === "tool_result" || type === "tool_execution_end" || type === "function_result") {
    upsertToolActivityMessage(record.id, {
      ...base,
      id: `bivy-tool-result-${callId}`,
      content: [{ type: "tool_result", toolUseId: callId, tool_use_id: callId, content: event.message ?? event.result ?? event.output ?? input.output ?? "", isError: Boolean(event.error || event.errorMessage) }],
    });
  } else {
    upsertToolActivityMessage(record.id, {
      ...base,
      id: `bivy-tool-call-${callId}`,
      content: [{ type: "tool_use", id: callId, name, input }],
    });
  }
}

function thinkingTextFromEvent(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined;
  const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown; content?: unknown } | undefined;
  const fromMessage = thinkingTextFromContent(message?.content);
  if (fromMessage) return fromMessage;
  if (delta?.type === "thinking_delta" && typeof delta.delta === "string") return delta.delta;
  if (delta?.type === "thinking_end" && typeof delta.content === "string") return delta.content;
  return "";
}

function hasAssistantText(event: Record<string, unknown>): boolean {
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((part) => part && typeof part === "object" && String((part as Record<string, unknown>).type || "").toLowerCase() === "text" && typeof (part as Record<string, unknown>).text === "string" && String((part as Record<string, unknown>).text).trim());
}

function persistIntermediateFromEvent(record: SessionRecord, event: Record<string, unknown>, final = false) {
  const text = thinkingTextFromEvent(event).trim();
  if (!text) return;
  const existing = liveIntermediateBySession.get(record.id);
  const entry: IntermediateMessage = existing ?? {
    id: `bivy-intermediate-${Date.now()}-${randomBytes(3).toString("hex")}`,
    role: "assistant",
    content: [{ type: "thinking", thinking: text }],
    bivyKind: "intermediate",
    afterMessageCount: record.session.getMessages().length,
    createdAt: Date.now(),
  };
  const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
  const previousText = thinkingTextFromContent(entry.content);
  const nextText = existing && delta?.type === "thinking_delta" && typeof delta.delta === "string" && !thinkingTextFromContent((event.message as { content?: unknown } | undefined)?.content)
    ? `${previousText}${delta.delta}`
    : text;
  entry.content = [{ type: "thinking", thinking: nextText }];
  upsertIntermediateMessage(record.id, entry);
  if (final) liveIntermediateBySession.delete(record.id);
  else liveIntermediateBySession.set(record.id, entry);
}

function conversationMessages(record: SessionRecord): RuntimeMessage[] {
  // Prefer the runtime's own transcript; when it's empty (a reopened session on a
  // runtime that can't rebuild it — every non-Codex CLI agent, or a Codex rollout
  // that failed to parse), deriveHistory falls back to the base persisted in the log
  // so the prompts/replies come back instead of just the tool cards. Overlay detail
  // is anchored by time, not absolute index, so a compacted (shorter) base no longer
  // clumps recent tool cards after the final message (see transcript-merge.ts).
  return eventLog.deriveHistory(record.id, record.session.getMessages());
}

// Build a session.history event, sending either the full transcript or just the
// tail the client is missing (see history-sync.ts).
function buildHistoryEvent(opts: {
  sessionId: string | null;
  workspace: string;
  source?: string;
  runtimeId: string;
  isStreaming: boolean;
  messages: unknown[];
  cursor?: HistoryCursor;
  // Metadata fallbacks for the fast, build-free open path (no open record yet):
  // the persisted name/branch/prUrl so the title and github pill fill in with
  // the transcript instead of waiting on the runtime resume.
  name?: string;
  branch?: string;
  prUrl?: string;
  prs?: PrRef[];
}) {
  const delta = historyDelta(opts.messages, opts.cursor);
  const record = opts.sessionId ? openSessions.get(opts.sessionId) : undefined;
  const bSess = record ? bivySessionEnvelope(record) : undefined;
  return {
    type: "session.history" as const,
    sessionId: opts.sessionId,
    sessionFile: record?.sessionFile,
    workspace: opts.workspace,
    source: opts.source,
    branch: record?.worktree?.branch ?? opts.branch,
    runtimeId: opts.runtimeId,
    agentName: getRuntime(opts.runtimeId).displayName,
    name: record?.session.getName() ?? opts.name,
    isStreaming: opts.isStreaming,
    mode: delta.mode,
    baseCount: delta.baseCount,
    count: delta.count,
    historyHash: delta.historyHash,
    messages: delta.messages,
    warning: record?.warning,
    costUsd: record?.costUsd,
    usage: record?.usage,
    prUrl: record?.prUrl ?? opts.prUrl,
    prs: record?.prs ?? opts.prs,
    bivySession: bSess,
    // Durable attachment references (text→refs), so a client that never sent the
    // attachment (a reload, or a different device) rehydrates thumbnails by hash.
    attachmentRefs: opts.sessionId ? eventLog.readAttachments(opts.sessionId) : [],
    // Durable url→ref map for remote markdown images the node has already
    // fetched (see resolveInlineImages) — lets a reload resolve a
    // `data-remote-src` placeholder straight to its attachment hash instead of
    // waiting on a fresh (redundant) fetch.
    inlineImageRefs: opts.sessionId ? eventLog.readInlineImages(opts.sessionId) : [],
  };
}

// Handle a message arriving from a remote client via the relay. Mirrors the
// local HTTP API surface so remote control matches local control.
// --- Unified command dispatch (docs/dramatic-simplification-plan.md, slice 1) --
// One home per operation. `handleRelayMessage` looks a kind up here first; kinds
// not yet migrated fall through to the inline switch below. `reply()` answers the
// calling client; `broadcast()` reaches every client (local sockets + relay).
// This retires the "add it to REST, forget the WS case" class of drift bugs by
// giving each operation a single named handler both transports can share.
interface CommandCtx {
  reply(event: unknown): void;
  broadcast(event: unknown): void;
}
type Command = (msg: ClientMessage, ctx: CommandCtx) => void | Promise<void>;

// Idempotency for `session.new` keyed by requestId: a client's post-reconnect
// retry adopts the session the first request created instead of spawning a
// duplicate. See ./session/session-new-dedupe for the full rationale.
const sessionNewDedupe = createSessionNewDedupe<SessionRecord>();
const dedupeSessionNew = (requestId: string | undefined, create: () => Promise<SessionRecord>) =>
  sessionNewDedupe.run(requestId, create);

// Idempotency for `prompt`, keyed by the client's clientMessageId (the same
// generic key->promise cache as above, reused for a different key) — see
// issue #154's queued follow-ups. A client that isn't sure whether a queued
// item's send actually reached the node before the socket dropped (see
// AppController.retryStuckFollowups) resends it verbatim after reconnecting;
// this makes that safe by collapsing a retried clientMessageId onto the
// original broadcast + turn instead of double-prompting the runtime.
const promptDedupe = createSessionNewDedupe<void>();
const dedupePrompt = (clientMessageId: string | undefined, run: () => Promise<void>) =>
  promptDedupe.run(clientMessageId, run);

const RELAY_COMMANDS: Record<string, Command> = {
  ping(msg, ctx) {
    ctx.reply({ type: "pong", requestId: typeof msg.requestId === "string" ? msg.requestId : undefined });
  },
  // Kick off `bivy update` on this node from the app's version-mismatch banner
  // (see runBivyUpdate). The node restarts itself when the update lands, so the
  // client just sees the socket reconnect on the new build; a failure to even
  // start reports back so the banner can show the manual command.
  "node.update"(_msg, ctx) {
    const result = runBivyUpdate();
    ctx.reply({ type: "node.update.result", ok: result.ok, error: result.error });
  },
  // Fetch a stored attachment's bytes by content hash. The relay client (a phone
  // not on the LAN) can't reach the GET /api/attachment endpoint, so it fetches
  // over the encrypted tunnel instead; the relay framing chunks the base64 payload
  // (the same mechanism that carries large image uploads). Direct/LAN clients use
  // the HTTP endpoint. Both are authenticated — the relay tunnel by enrollment,
  // the HTTP route by /api's authMiddleware.
  "attachment.fetch"(msg, ctx) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const hash = typeof (msg as { hash?: unknown }).hash === "string" ? String((msg as { hash?: unknown }).hash) : "";
    if (!isValidAttachmentHash(hash)) {
      ctx.reply({ type: "attachment.error", requestId, hash, error: "Invalid attachment id" });
      return;
    }
    const bytes = attachmentStore.read(hash);
    if (!bytes) {
      ctx.reply({ type: "attachment.error", requestId, hash, error: "Attachment not found" });
      return;
    }
    const meta = attachmentStore.readMeta(hash);
    ctx.reply({ type: "attachment.data", requestId, hash, mimeType: meta?.mimeType ?? "application/octet-stream", name: meta?.name, data: bytes.toString("base64") });
  },
  "session.pause"(msg) {
    const record = resolveSession(msg.sessionId);
    if (record) pauseSession(record);
  },
  "session.resume"(msg) {
    const record = resolveSession(msg.sessionId);
    if (record) resumeSession(record);
  },
  "session.question.answer"(msg) {
    const record = resolveSession(msg.sessionId);
    const requestId = String(msg.requestId ?? "");
    if (record && requestId) answerSessionQuestion(record, requestId, msg);
  },
  async "session.checkpoints"(msg, ctx) {
    const record = resolveSession(msg.sessionId);
    if (!record) return;
    const checkpoints = await harness.checkpoints(record.id);
    const event = { type: "session.checkpoints", sessionId: record.id, checkpoints };
    ctx.reply(event);
    ctx.broadcast(event);
  },
  async "session.rewind"(msg, ctx) {
    const record = resolveSession(msg.sessionId);
    const checkpointId = String(msg.checkpointId ?? "").trim();
    if (!record || !checkpointId) return;
    if (sessionBusy(record)) {
      ctx.reply({ type: "session.error", sessionId: record.id, error: "Stop the current turn before rewinding." });
      return;
    }
    try {
      await harness.rewind(record.id, checkpointId);
      const event = { type: "session.rewound", sessionId: record.id, checkpointId };
      ctx.reply(event);
      ctx.broadcast(event);
    } catch (error) {
      ctx.reply({ type: "session.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.revert_file"(msg, ctx) {
    // C3d — revert ONE changed file to its pre-turn content without rewinding the
    // whole turn. `content` is the file's pre-turn text (or null when the turn
    // added it). Path-confined to the session's worktree by revertFile.
    const record = resolveSession(msg.sessionId);
    const relPath = String(msg.path ?? "").trim();
    if (!record || !relPath) return;
    if (sessionBusy(record)) {
      ctx.reply({ type: "session.error", sessionId: record.id, error: "Stop the current turn before reverting a file." });
      return;
    }
    const content = typeof msg.content === "string" ? msg.content : null;
    const result = revertFile(harnessDirFor(record), relPath, content);
    if (!result.ok) {
      ctx.reply({ type: "session.error", sessionId: record.id, error: `Could not revert ${relPath}: ${result.error ?? "unknown error"}` });
      return;
    }
    // Recompute the turn's diff against the (unchanged) baseline so the review
    // surface drops the reverted file immediately.
    const event = { type: "session.file_reverted", sessionId: record.id, path: relPath, status: result.status };
    ctx.reply(event);
    ctx.broadcast(event);
  },
  async "session.pr.refresh"(msg, ctx) {
    // Force a refresh regardless of live/attached state — resume the session if
    // the node dropped it from memory, so a finished/detached session can still
    // be reconciled on demand.
    let rec: SessionRecord | undefined;
    try {
      rec = await resolveOrResumeSession(msg.sessionId, msg.path);
    } catch (error) {
      ctx.reply({ type: "session.pr_result", sessionId: msg.sessionId, ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!rec) {
      ctx.reply({ type: "session.pr_result", sessionId: msg.sessionId, ok: false, error: "Session not found" });
      return;
    }
    await refreshPullRequests(rec);
    ctx.reply({ type: "session.pr_result", sessionId: rec.id, ok: true, prUrl: rec.prUrl, prs: rec.prs });
  },
  async "sessions.pr.refresh_all"(_msg, ctx) {
    const result = await refreshAllPullRequestStatuses();
    ctx.reply({ type: "sessions.pr_refresh_result", ok: true, ...result });
  },
  "node.rename"(msg, ctx) {
    const prev = identity.name;
    const name = identity.setName(String(msg.name ?? ""));
    // Queue routing follows the node name (`bivy/<name>`). Update the live
    // poller now instead of leaving it on its startup-time label until restart.
    refreshControlPlaneTaskLabels();
    void advertiseNodeName(name, prev);
    ctx.broadcast({ type: "node.updated", name });
    ctx.reply({ type: "node.updated", name });
  },
  "node.settings.get"(msg, ctx) {
    ctx.reply({ type: "node.settings", requestId: msg.requestId, settings: nodeSettingsSnapshot() });
  },
  async "node.settings.set"(msg, ctx) {
    try {
      const settings = await applyNodeSettings((msg.settings as Record<string, unknown>) ?? msg);
      // requestId round-trips so the caller (setNodeSettings) can tell its own
      // save landed apart from an unrelated node.settings.get reply — see #140.
      ctx.reply({ type: "node.settings", requestId: msg.requestId, settings });
    } catch (error) {
      ctx.reply({ type: "node.settings.error", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "node.stats"(msg, ctx) {
    // Node-resource snapshot for the header "Node stats" panel. Reply only to the
    // requesting client — a polled request, not a state change every client needs.
    const stats = await collectNodeStats(nodeStatsOptsFor(msg.sessionId));
    ctx.reply({ type: "node.stats", stats });
  },
  "session.rename"(msg, ctx) {
    const sid = String(msg.sessionId ?? "");
    const newName = String(msg.name ?? "").trim();
    if (!sid || !newName) return;
    const rec = resolveSession(sid);
    if (!rec) return;
    rec.session.setName(newName);
    persistSessionMetadata(rec);
    ctx.broadcast({ type: "session.renamed", sessionId: rec.id, sessionFile: rec.sessionFile, name: newName });
    scheduleAdvertise();
  },
  abort(msg, ctx) {
    const record = resolveSession(msg.sessionId);
    if (!record || !sessionBusy(record)) return;
    // A wedged runtime may never resolve abort() or emit agent_end. Settle the
    // daemon and client first, then make the SDK abort best-effort. The synthetic
    // agent_end also closes running tool cards and drains visible follow-ups.
    forceAbortTurn({
      settle: () => {
        questionManager.cancelForSession(record.id);
        approvals.cancelForSession(record.id);
        clearSessionWorking(record, "idle");
      },
      notifySettled: () => ctx.broadcast({
        type: "session.event",
        sessionId: record.id,
        event: { type: "agent_end", aborted: true },
      }),
      abort: () => record.session.abort(),
      onAbortError: (error) => console.warn(`[session-abort] runtime abort failed for ${record.id}:`, error),
    });
    record.abortRecovery = recoverRecordAfterAbort(record);
  },
  async "session.command.invoke"(msg, ctx) {
    // Invoke a protocol-mode agent command (AgentCommand.mode === "protocol")
    // out-of-band via the session's invokeCommand → the runtime's
    // `command.invoke`. Prompt-mode commands never reach here — the client
    // forwards those as an ordinary prompt. Any output the command produces
    // arrives over the normal event stream.
    const record = resolveSession(msg.sessionId);
    const name = String(msg.name ?? "").trim();
    if (!record || !name) return;
    if (typeof record.session.invokeCommand !== "function") {
      ctx.broadcast({ type: "session.error", sessionId: record.id, error: `This agent can't run ${name}.` });
      return;
    }
    try {
      await record.session.invokeCommand(name, String(msg.args ?? ""));
    } catch (error) {
      ctx.broadcast({ type: "session.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "repos.list"() {
    relay?.sendEvent({ type: "repos.list", ...(await listAccessibleRepos()) });
  },
  // Web-driven "Connect GitHub" for the repo picker: start the node's device
  // flow, then poll it on GitHub's interval. Both answer with the same
  // `github.connect.status` event so the client has one shape to handle.
  async "github.connect.start"() {
    relay?.sendEvent({ type: "github.connect.status", ...(await startGithubConnect()) });
  },
  async "github.connect.poll"() {
    relay?.sendEvent({ type: "github.connect.status", ...(await pollGithubConnect()) });
  },
  // Branches for the repo the composer's repo pill just picked, so the branch
  // pill next to it can offer a specific remote branch to clone/base a new
  // session from instead of always the repo's default. See listRepoBranches.
  async "branches.list"(msg) {
    const repo = typeof msg.repo === "string" ? msg.repo.trim() : "";
    relay?.sendEvent({ type: "branches.list", ...(await listRepoBranches(repo)) });
  },
  // GitHub App one-click, over the relay so it works on a headless/remote
  // node: the browser passes its own origin as the redirect base, submits
  // the manifest to GitHub itself, then relays the returned code back here —
  // the node alone exchanges it, so the private key never leaves it.
  async "github.app.manifest.start"(msg) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    try {
      const out = await startAppManifest({
        redirectBase: String(msg.origin ?? ""),
        org: typeof msg.org === "string" ? msg.org : undefined,
      });
      relay?.sendEvent({ type: "github.app.manifest.ready", requestId, ...out });
    } catch (error) {
      relay?.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "github.app.manifest.code"(msg) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    try {
      const out = await completeAppManifest({ code: String(msg.code ?? ""), state: String(msg.state ?? "") });
      relay?.sendEvent({ type: "github.app.manifest.done", requestId, ...out });
    } catch (error) {
      relay?.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "github.app.connect-existing"(msg) {
    // Reuse the manifest flow's done/error events so the existing GithubApp
    // phase machine + settings UI handle success/failure with no new plumbing.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    try {
      const out = await connectExistingApp({
        appId: String(msg.appId ?? ""),
        privateKeyPem: String(msg.privateKeyPem ?? ""),
        nodeLabel: typeof msg.nodeLabel === "string" ? msg.nodeLabel : undefined,
      });
      relay?.sendEvent({ type: "github.app.manifest.done", requestId, ...out });
    } catch (error) {
      relay?.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  "github.app.disconnect"(msg) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    // appId (or hookId, for a stale app with no App ID) scopes the disconnect to
    // one app; both omitted = disconnect them all.
    const appId = typeof msg.appId === "string" && msg.appId.trim() ? msg.appId.trim() : undefined;
    const hookId = typeof msg.hookId === "string" && msg.hookId.trim() ? msg.hookId.trim() : undefined;
    disconnectGithubApp({ appId, hookId });
    relay?.sendEvent({ type: "github.app.disconnected", requestId, ok: true, appId, hookId });
  },
  "workspaces.list"() {
    relay?.sendEvent({
      type: "workspaces.list",
      workspaces: loadSavedWorkspaces(),
      defaultWorkspace,
      active: active?.workspace,
    });
  },
  async history(msg) {
    // Backfill the client's focused session when it names one; otherwise keep
    // the old node-global active fallback for legacy/local clients.
    const requestedSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
    const record = resolveSession(msg.sessionId);
    // The client re-requests history right after session.open, which can race
    // the (slow) resume: the session isn't live yet, so resolveSession misses
    // and the old path would answer with an empty snapshot — blanking the
    // transcript the fast open just painted. Serve it from disk instead.
    if (!record) {
      const early = fastHistoryEvent(msg);
      if (early) {
        relay?.sendEvent(early);
        return;
      }
      // A named session that's still resuming (fastHistoryEvent had nothing to
      // fast-serve either) is NOT a confirmed-empty session — sending one here
      // lies about that and flips the client from its loading spinner straight
      // to the "start a new session" empty state for what may be a long
      // pre-existing conversation (issue #382). session.open's own history
      // event, sent once resolveOrResumeSession finishes, carries the real
      // transcript, so just stay quiet and let that land instead. A legacy/local
      // client polling with no sessionId (the node-global "active" fallback)
      // still gets an immediate answer below — there genuinely is no session.
      if (requestedSessionId) return;
    }
    const agent = record?.runtimeId ?? defaultRuntimeId;
    relay?.sendEvent(buildHistoryEvent({
      sessionId: record?.id ?? null,
      workspace: record?.workspace ?? defaultWorkspace,
      source: record?.source,
      runtimeId: agent,
      isStreaming: record ? sessionBusy(record) : false,
      messages: record ? conversationMessages(record) : [],
      cursor: historyCursorFrom(msg),
    }));
    // Reconnect recovery (onReconnected re-requests history): re-emit any
    // pending question/approval card the client missed while disconnected.
    if (record) replayPendingInteractions(record.id);
  },
  async "sessions.list"() {
    const sessions = await listAllSessions();
    const list = sessions.map((s) => {
      const rec = openSessions.get(s.id) || (s.path ? openSessions.get(path.resolve(s.path)) : undefined);
      const meta = metadata.getSession(s.id) ?? metadata.getSession(s.path);
      // sessionHasPendingApproval also covers a pending clarifying question
      // (see its own comment) — without it, a session blocked on one would
      // show as merely "working" here, including on this exact refresh path
      // (SessionList.tsx's periodic safety-net poll) clobbering the correct
      // needs_action the live session.question broadcast had just set.
      const pendingApproval = rec ? sessionHasPendingApproval(rec) : approvals.list().some((a) => a.sessionId === s.id && a.status === "pending");
      return {
        path: s.path,
        id: s.id,
        name: s.name,
        modified: s.modified,
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
        agent: meta?.runtimeId ?? s.agent,
        agentName: meta?.agentName ?? s.agentName,
        source: rec?.source ?? meta?.source,
        forkedFrom: rec?.forkedFrom ?? meta?.forkedFrom,
        branch: rec?.worktree?.branch ?? meta?.branch,
        sandbox: rec?.sandbox ?? normalizeSandboxTier(meta?.sandbox),
        prUrl: rec?.prUrl ?? meta?.prUrl,
        prs: rec?.prs ?? meta?.prs,
        status: pendingApproval ? "needs_action" : (rec ? (sessionBusy(rec) ? "working" : "idle") : "saved"),
        open: Boolean(rec),
        needsAction: pendingApproval,
        bivySession: bivySessionEnvelopeFromSummary(s, rec, meta),
      };
    });
    relay?.sendEvent({ type: "sessions.list", sessions: list });
  },
  "session.close"(msg) {
    const sid = String(msg.sessionId ?? "").trim();
    const p = String(msg.path ?? "").trim();
    const record = sid ? openSessions.get(sid) : p ? openSessions.get(path.resolve(p)) : undefined;
    if (!record) {
      relay?.sendEvent({ type: "session.closed", sessionId: sid || undefined, sessionFile: p || undefined });
    } else if (sessionBusy(record)) {
      relay?.sendEvent({ type: "session.error", sessionId: record.id, error: "Session is busy; stop it before closing." });
    } else {
      closeSessionRecord(record, "client-close");
      relay?.sendEvent({ type: "session.closed", sessionId: record.id, sessionFile: record.sessionFile });
    }
  },
  async "session.delete"(msg) {
    const sid = String(msg.sessionId ?? "").trim();
    const p = String(msg.path ?? "").trim();
    try {
      const deleted = await deleteSessionFile({ id: sid, path: p });
      relay?.sendEvent({ type: "session.deleted", sessionId: deleted.sessionId || sid || undefined, sessionFile: deleted.sessionFile });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: sid || undefined, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.open"(msg) {
    const sid = String(msg.sessionId ?? "").trim();
    const p = String(msg.path ?? "").trim();
    // The PWA always names the session by id; a legacy/local client may know
    // only the path. Need at least one to open anything.
    if (!sid && !p) return;
    // Paint the transcript from disk immediately, before the slow runtime
    // resume below, so the pane fills in near-instantly. Best-effort; the
    // canonical history event still follows once the session is open.
    const early = fastHistoryEvent(msg);
    if (early) relay?.sendEvent(early);
    let record: SessionRecord | undefined;
    try {
      // Opening a session from the remote/PWA changes that client's focus,
      // not the node-global fallback session used by legacy/local clients.
      // Resume by id (via durable metadata) so a session this process has
      // never opened — or dropped from memory — still comes back, and so a
      // first prompt racing this open shares the same resume (see
      // resolveOrResumeSession) instead of double-opening or missing it.
      record = sid
        ? await resolveOrResumeSession(sid, p)
        : await createSession(defaultWorkspace, p, { runtimeId: agentFrom(msg), makeActive: false });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: sid || undefined, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!record) {
      relay?.sendEvent({ type: "session.error", sessionId: sid || undefined, error: "Session not found" });
      return;
    }
    relay?.sendEvent(buildHistoryEvent({
      sessionId: record.id,
      workspace: record.workspace,
      source: record.source,
      runtimeId: record.runtimeId,
      isStreaming: sessionBusy(record),
      messages: conversationMessages(record),
      cursor: historyCursorFrom(msg),
    }));
    // A client opening this session after the TUI was already live (a deep link
    // or reload on another device) missed the original terminal.tui broadcast,
    // so its composer would render unlocked and every send would be refused
    // server-side. Re-assert the single-writer lock here so it shows the
    // "running in the terminal" window instead of an unusable chat.
    if (record.tuiTermId || record.tuiRefreshing) broadcastTuiState(record.id, Boolean(record.tuiTermId));
    // A reconnecting/opening client missed the one-shot card broadcast; put
    // any still-pending question/approval back so it can be answered.
    replayPendingInteractions(record.id);
    // Manual resume mode: a turn this session was running when the node restarted
    // was left for the user to continue. Offer a one-tap Resume next to the
    // restored transcript (the marker is cleared once any turn completes).
    if (metadata.getSession(record.id)?.resumePending) {
      relay?.sendEvent({
        type: "session.notice",
        sessionId: record.id,
        level: "info",
        message: "This session was interrupted by a restart before its last turn finished.",
        action: "/resume",
      });
    }
  },
  // Provider-native session discovery/adoption (issue #156) — the relay-mode
  // twin of GET /api/sessions/discover / POST /api/sessions/import, so the
  // hosted app (app.bivy.sh) gets the same capability-driven flow as a
  // directly-connected node. Bounded metadata only — no transcript content
  // rides either message.
  async "session.discover"(msg, ctx) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    try {
      const sessions = await listDiscoverableSessions();
      ctx.reply({ type: "session.discover.result", requestId, sessions });
    } catch (error) {
      ctx.reply({ type: "session.discover.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.import"(msg, ctx) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const runtimeId = String(msg.runtimeId ?? "").trim();
    const ref = String(msg.ref ?? "").trim();
    if (!runtimeId || !ref) {
      ctx.reply({ type: "session.import.error", requestId, error: "runtimeId and ref are required" });
      return;
    }
    try {
      const result = await importNativeSession(runtimeId, ref, { acceptDisclosure: Boolean(msg.acceptDisclosure) });
      if (!result.ok) {
        ctx.reply({ type: "session.import.error", requestId, error: result.error, needsDisclosure: result.needsDisclosure, disclosure: result.disclosure });
        return;
      }
      ctx.reply({ type: "session.import.result", requestId, sessionId: result.record.id, runtimeId: result.record.runtimeId, mode: result.plan.mode, seedPrompt: result.seedPrompt });
    } catch (error) {
      ctx.reply({ type: "session.import.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  approval(msg, ctx) {
    const id = String(msg.id ?? "");
    const approved = Boolean(msg.approved);
    if (resolveApproval(id, approved)) {
      ctx.broadcast({ type: "approval.resolved", id, approved });
      scheduleAdvertise();
    }
  },
  async "models.list"(msg) {
    const requestedSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
    const wantedRuntimeId = typeof msg.runtimeId === "string" && msg.runtimeId ? msg.runtimeId : undefined;
    let record: SessionRecord | null | undefined;
    try {
      record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, msg.path) : active;
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (requestedSessionId && !record) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: "Session not found" });
      return;
    }
    // On a draft (no session id), a runtime hint from the composer takes
    // precedence so an agent switch previews *that* agent's models even if a
    // stale `active` on another runtime lingers on the node.
    if (!requestedSessionId && wantedRuntimeId && record?.runtimeId !== wantedRuntimeId) record = null;
    record ??= await sessionForModelQuery(wantedRuntimeId);
    const session = record.session;
    const current = session.getCurrentModel();
    const models = await publicModelsList(session, current);
    const thinking = publicThinkingInfo(session);
    // Tag the list with the runtime it was resolved for so the client can
    // tell whether it belongs to the agent it currently has selected. Without
    // this a models.list answered for one agent (e.g. Codex's models) could
    // linger on the composer/picker after the user switched to another agent
    // (e.g. Claude) — the "Claude shows Codex models" bug.
    relay?.sendEvent({ type: "models.list", sessionId: record.id, runtimeId: record.runtimeId, current: current ? publicModel(current, current) : null, models, thinking });
  },
  "models.prefetch"(msg) {
    // The composer's agent picker opened: warm the scratch session for each
    // offered agent in the background so the first switch to any of them answers
    // instantly. Fire-and-forget — no reply; the follow-up models.list carries
    // the result. Ignore anything but a bounded string[] of runtime ids.
    const ids = Array.isArray(msg.runtimeIds)
      ? msg.runtimeIds.filter((id: unknown): id is string => typeof id === "string" && !!id).slice(0, 16)
      : [];
    if (ids.length) prefetchModels(ids);
  },
  async "model.select"(msg) {
    const requestedSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
    let record: SessionRecord | null | undefined;
    try {
      record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, msg.path) : active;
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (requestedSessionId && !record) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: "Session not found" });
      return;
    }
    record ??= await sessionForModelQuery();
    const provider = String(msg.provider ?? "").trim();
    const id = String(msg.id ?? "").trim();
    if (!provider || !id) return;
    const session = record.session;
    try {
      await session.setModel(provider, id);
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: record.id, error: error instanceof Error ? error.message : "Model is not available on this node." });
      return;
    }
    broadcast({ type: "model.updated", sessionId: record.id, model: publicModel(session.getCurrentModel(), session.getCurrentModel()) });
  },
  async "thinking.set_level"(msg) {
    const requestedSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
    let record: SessionRecord | null | undefined;
    try {
      record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, msg.path) : active;
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (requestedSessionId && !record) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: "Session not found" });
      return;
    }
    record ??= await sessionForModelQuery();
    const level = String(msg.level ?? "").trim();
    const session = record.session;
    if (typeof session.setThinkingLevel === "function" && level) {
      try {
        session.setThinkingLevel(level);
        const thinking = publicThinkingInfo(session);
        broadcast({ type: "thinking.updated", sessionId: record.id, thinking });
      } catch (error) {
        relay?.sendEvent({ type: "session.error", sessionId: record.id, error: error instanceof Error ? error.message : "Failed to set thinking level" });
      }
    }
  },
  "runtimes.list"() {
    const activeAgent = active?.runtimeId ?? defaultRuntimeId;
    relay?.sendEvent({ type: "runtimes.list", current: runtimeSummary(getRuntime(defaultRuntimeId)), activeAgent, runtimes: runtimeList(activeAgent) });
  },
  async "runtime.select"(msg) {
    try {
      await setDefaultRuntime(String(msg.id ?? ""));
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "runtime.install"(msg) {
    const id = String(msg.id ?? "").trim().toLowerCase();
    const spec = runtimeInstallSpec(id);
    if (!spec) {
      relay?.sendEvent({ type: "runtime.install.error", id, error: "This agent does not have an automatic installer on this node.", runtimes: runtimeList(active?.runtimeId ?? defaultRuntimeId) });
      return;
    }
    try {
      const before = runtimeList().find((runtime) => runtime.id === spec.id);
      if (before?.status !== "available") await runInstallCommand(spec);
      // The just-installed binary changes what the CLI probes would report, so drop
      // their (process-lifetime) cache and let the catalog below re-probe it.
      invalidateCliProbeCache();
      const activeAgent = active?.runtimeId ?? defaultRuntimeId;
      const runtimes = runtimeList(activeAgent);
      relay?.sendEvent({ type: "runtime.install.done", id: spec.id, runtimes });
      broadcast({ type: "runtime.updated", current: runtimeSummary(getRuntime(defaultRuntimeId)), runtimes });
    } catch (error) {
      relay?.sendEvent({ type: "runtime.install.error", id: spec.id, error: error instanceof Error ? error.message : String(error), runtimes: runtimeList(active?.runtimeId ?? defaultRuntimeId) });
    }
  },
  async "providers.list"() {
    relay?.sendEvent({ type: "providers.list", providers: await listProvidersUnified() });
  },
  async "provider.auth.get"(msg) {
    try {
      const id = String(msg.provider ?? msg.id ?? "").trim().toLowerCase();
      const provider = (await listProviders(credsDir, piDir)).find((p) => p.id === id);
      const auth = id ? ((await exportProviderAuth(credsDir))[id] as any) : undefined;
      relay?.sendEvent({
        type: "provider.auth",
        provider: id,
        configured: Boolean(provider?.configured),
        source: provider?.source,
        kind: provider?.kind || auth?.type,
        key: auth?.type === "api_key" ? auth.key : undefined,
        oauth: auth?.type === "oauth" ? { present: true } : undefined,
      });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "provider.apiKey"(msg, ctx) {
    try {
      await setProviderApiKey(credsDir, String(msg.provider ?? msg.id ?? ""), String(msg.key ?? ""));
      await pushModelAuthToControlPlane();
      await refreshSessionAfterAuth();
      broadcast({ type: "providers.list", providers: await listProvidersUnified() });
      // Dedicated per-request ack (separate from the list broadcast above, which
      // every client gets) so the saving client can tell its own save landed
      // instead of assuming success the moment the command was sent — see #140.
      ctx.reply({ type: "provider.apiKey.ok", requestId: msg.requestId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      relay?.sendEvent({ type: "session.error", error: message });
      ctx.reply({ type: "provider.apiKey.error", requestId: msg.requestId, error: message });
    }
  },
  async "provider.oauth.reset"(msg) {
    try {
      const id = String(msg.provider ?? msg.id ?? "").trim().toLowerCase();
      if (!id) throw new Error("Provider is required");
      for (const [loginId, login] of oauthLogins.entries()) {
        if (login.provider === id) {
          login.cancelled = true;
          login.error = "OAuth login was reset.";
          try { login.abort.abort(); } catch {}
          oauthLogins.delete(loginId);
        }
      }
      await removeProvider(credsDir, id);
      await pushModelAuthToControlPlane();
      await refreshSessionAfterAuth();
      broadcast({ type: "provider.oauth.reset", provider: id, ok: true, providers: await listProvidersUnified() });
      broadcast({ type: "providers.list", providers: await listProvidersUnified() });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "provider.remove"(msg) {
    try {
      await removeProvider(credsDir, String(msg.provider ?? msg.id ?? ""));
      await pushModelAuthToControlPlane();
      await refreshSessionAfterAuth();
      broadcast({ type: "providers.list", providers: await listProvidersUnified() });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  // --- Local / custom models (Bivy-owned registry; Pi is a projection). ---
  async "models.custom.list"() {
    relay?.sendEvent({ type: "models.custom.list", providers: await localModelSummaries() });
  },
  async "models.custom.presets"() {
    relay?.sendEvent({ type: "models.custom.presets", presets: await localModelPresets() });
  },
  async "models.custom.save"(msg, ctx) {
    try {
      // The client sends the same field set as the REST body (baseUrl, api,
      // apiKey, models[], compat, name, providerId). persistLocalModelSave
      // broadcasts the refreshed list to every client, requester included.
      await persistLocalModelSave((msg as any)?.spec ?? msg);
      // Dedicated per-request ack — see the provider.apiKey comment above (#140).
      ctx.reply({ type: "models.custom.save.ok", requestId: msg.requestId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      relay?.sendEvent({ type: "session.error", error: message });
      ctx.reply({ type: "models.custom.save.error", requestId: msg.requestId, error: message });
    }
  },
  async "models.custom.remove"(msg) {
    try {
      await persistLocalModelRemove(String((msg as any).id ?? (msg as any).provider ?? ""));
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  // --- Rulesets (run-orchestration policy; Bivy-owned, node-local). ---
  "rulesets.list"(_msg, ctx) {
    ctx.reply({ type: "rulesets.list", rulesets: rulesetInfos() });
  },
  "rulesets.save"(msg, ctx) {
    try {
      const active = typeof (msg as any).active === "boolean" ? (msg as any).active : undefined;
      persistRulesetSave((msg as any)?.ruleset ?? msg, active);
      // Dedicated per-request ack — see the provider.apiKey/models.custom.save comments (#140).
      ctx.reply({ type: "rulesets.save.ok", requestId: msg.requestId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.reply({ type: "rulesets.save.error", requestId: msg.requestId, error: message });
    }
  },
  "rulesets.remove"(msg) {
    try {
      persistRulesetRemove(String((msg as any).name ?? ""));
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "stt.config.get"() {
    try {
      relay?.sendEvent({ type: "stt.config", ...(await getSttConfig(appDir)) });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "stt.config.set"(msg, ctx) {
    try {
      const config = await applySttConfigChange(msg as Record<string, unknown>);
      broadcast({ type: "stt.config", ...config });
      // Dedicated per-request ack — see the provider.apiKey comment above (#140).
      ctx.reply({ type: "stt.config.set.ok", requestId: msg.requestId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      relay?.sendEvent({ type: "session.error", error: message });
      ctx.reply({ type: "stt.config.set.error", requestId: msg.requestId, error: message });
    }
  },
  async transcribe(msg) {
    const requestId = String(msg.requestId ?? "");
    try {
      const text = await runTranscription(msg as Record<string, unknown>);
      relay?.sendEvent({ type: "transcription", requestId, text });
    } catch (error) {
      relay?.sendEvent({ type: "transcription", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  // Session replication (docs/session-replication.md): the STANDBY receives a
  // replication frame from the owner (which is connected as a relay CLIENT in
  // this node's room) and applies it into the replica transcript + worktree,
  // replying with the cursor so the owner can advance. Inert unless the owner
  // opted in — a frame only arrives when a sibling chose this node as its standby.
  async "session.replica.frame"(msg, ctx) {
    const requestId = String(msg.requestId ?? "");
    const frame = msg.frame as ReplWireFrame | undefined;
    if (!frame) return;
    const ack = await replication.handleReplicaFrame(frame, typeof msg.ownerNodeId === "string" ? msg.ownerNodeId : undefined);
    ctx.reply({ type: "session.replica.ack", requestId, ack });
  },
  // Promote a replicated session onto THIS node (relay counterpart of
  // POST /api/session/promote): a client switched to the standby and asked it to
  // take over an offline owner. Epoch CAS + materialize the replica worktree.
  async "session.promote"(msg, ctx) {
    const requestId = String(msg.requestId ?? "");
    const sessionId = String(msg.sessionId ?? "").trim();
    if (!sessionId) return ctx.reply({ type: "session.promote.result", requestId, ok: false, error: "Missing sessionId" });
    const epoch = await replication.promote(sessionId, identity.nodeId);
    if (epoch === undefined) return ctx.reply({ type: "session.promote.result", requestId, ok: false, error: "Promotion lost the epoch race" });
    scheduleAdvertise();
    ctx.reply({ type: "session.promote.result", requestId, ok: true, sessionId, epoch });
  },
  // Ephemeral provisioning transport (node-broker path). A remote device that
  // holds the user's cloud credentials asks this node to make ONE allowlisted
  // HTTPS request to a provider (Fly/Hetzner/AWS/...) on its behalf. The
  // token/credentials ride in the request headers and are used transiently —
  // never persisted here — so the provisioning stays end-to-end (the control
  // plane never sees it). The host allowlist is the SSRF guard.
  async "ephemeral.exec"(msg) {
    const requestId = String(msg.requestId ?? "");
    try {
      const result = await execEphemeralRequest(msg.request as EphemeralExecRequest);
      relay?.sendEvent({ type: "ephemeral.exec.result", requestId, ...result });
    } catch (error) {
      relay?.sendEvent({ type: "ephemeral.exec.result", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  // Subscription / OAuth login driven from a remote device. The node runs the
  // provider's device-code (or paste-back) flow and reports the verification
  // link + code over the relay; the phone never needs the node's localhost.
  // `auth.oauth.progress|done|error` already mirror to the relay via broadcast.
  async "provider.oauth.start"(msg) {
    try {
      const state = await startOAuthLogin(String(msg.provider ?? msg.id ?? ""));
      relay?.sendEvent({
        type: "provider.oauth.started",
        id: state.id,
        provider: state.provider,
        status: state.status,
        authUrl: state.authUrl,
        instructions: state.instructions,
        deviceCode: state.deviceCode,
        usesCallbackServer: state.usesCallbackServer,
        error: state.error,
      });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  // Paste-back step for providers that return a redirect URL/code instead of a
  // pollable device code.
  "provider.oauth.code"(msg) {
    const state = oauthLogins.get(String(msg.id ?? ""));
    if (!state?.manualCodeResolve) {
      relay?.sendEvent({ type: "session.error", error: "That login session is no longer waiting for a code." });
      return;
    }
    state.manualCodeResolve(String(msg.code ?? "").trim());
    state.manualCodeResolve = undefined;
    state.progress?.push("Received pasted redirect URL from a remote device.");
  },
  "integrations.list"() {
    relay?.sendEvent({ type: "integrations.list", integrations: integrations.list() });
  },
  async "integration.apiKey"(msg) {
    try {
      await integrations.connectApiKey(String(msg.id ?? ""), String(msg.key ?? ""));
      broadcast({ type: "integrations.updated", integrations: integrations.list() });
      await refreshSessionAfterAuth();
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "integration.oauth.start"(msg) {
    try {
      const { authUrl } = integrations.startOAuth(String(msg.id ?? ""), `${process.env.BIVY_PUBLIC_URL ?? `http://localhost:${port}`}`.replace(/\/$/, "") + "/api/integrations/oauth/callback");
      relay?.sendEvent({ type: "integration.oauth", id: String(msg.id ?? ""), authUrl });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "integration.disconnect"(msg) {
    const removed = integrations.disconnect(String(msg.id ?? ""));
    if (removed) {
      broadcast({ type: "integrations.updated", integrations: integrations.list() });
      await refreshSessionAfterAuth();
    } else {
      relay?.sendEvent({ type: "integrations.updated", integrations: integrations.list() });
    }
  },
  async prompt(msg) {
    const text = String(msg.text ?? "").trim();
    const { images, imageNotes, imageRefs, files } = attachmentsFrom(msg.attachments);
    if (!text && !images.length && !files.length) return;
    // Title/naming can only see what we have before the session exists; the file
    // notes (with on-disk paths) are added once the workdir is known, below.
    const titleText = [text, imageNotes.join("\n")].filter(Boolean).join("\n\n") || (images.length ? "Please review the attached image(s)." : "attachment");
    const requestedSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
    let record: SessionRecord | null | undefined;
    try {
      record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, msg.path) : active;
    } catch (error) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (requestedSessionId && !record) {
      relay?.sendEvent({ type: "session.error", sessionId: requestedSessionId, error: "Session not found" });
      return;
    }
    try {
      record ??= await createWorkspaceSession(defaultWorkspace, { title: titleText, runtimeId: agentFrom(msg) });
    } catch (error) {
      // Session/worktree creation (e.g. `git worktree add` in createWorktree)
      // can throw. Without this the only handler is the console.warn-only outer
      // catch, so the relay client gets no terminal frame and the optimistic
      // "Working…" it painted on send never resolves. Surface it instead.
      broadcast({ type: "session.error", sessionId: requestedSessionId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    await record.abortRecovery;
    record.remoteActive = true;
    if (record.tuiTermId || record.tuiRefreshing) {
      broadcast({ type: "session.error", sessionId: record.id, error: record.tuiRefreshing ? "This session is returning from the terminal. Try again in a moment." : "This session is open in the terminal (TUI). Close the TUI to chat here." });
      return;
    }
    touchSession(record);
    // Now that the session (and its workdir) exists, write file attachments to
    // disk and fold their path notes into the prompt the agent actually sees.
    const { note: fileNote, refs: fileRefs } = materializeAttachments(record, files);
    const promptText =
      [text, imageNotes.join("\n"), fileNote].filter(Boolean).join("\n\n") ||
      (images.length ? "Please review the attached image(s)." : files.length ? "Please review the attached file(s)." : "");
    // Persist durable attachment refs keyed by the exact text the transcript
    // stores for this user message, so history rehydrates thumbnails by hash.
    eventLog.appendAttachments(record.id, promptText, [...imageRefs, ...fileRefs]);
    const agentPrompt = promptForAgent(record, promptText);
    const cmid = typeof msg.clientMessageId === "string" && msg.clientMessageId ? msg.clientMessageId : undefined;
    void dedupePrompt(cmid, async () => {
      broadcast({ type: "session.user_message", sessionId: record.id, text: promptText, clientMessageId: msg.clientMessageId });
      void maybeNameSession(record, promptText);
      harnessBeginTurn(record);
      // Capture the turn's prompt so an in-session model reroute can re-drive it
      // on a fallback model, and reset the per-turn reroute budget.
      record.lastPrompt = agentPrompt;
      record.lastPromptOptions = promptOptionsFor(record, msg.streamingBehavior, images);
      record.reroute?.beginTurn();
      // The user is driving this turn manually — supersede any pending auto-resume
      // that was scheduled after a prior limit so it can't re-fire on top of them.
      clearSessionResume(record.id);
      await promptWithWatchdog(record, agentPrompt, record.lastPromptOptions);
    }).catch((error) => {
      // Mirror the HTTP path (see the /prompt route): a rejected turn after
      // the runtime marked the session working emits no agent_end, so without
      // this the relay client (PWA) is stranded on "Working…" forever with
      // only a session.error toast. Clear working so a terminal state reaches it.
      clearSessionWorking(record);
      broadcast({ type: "session.error", sessionId: record.id, error: actionableAgentError(record.runtimeId, error) });
    });
  },
  async "session.fork.export"(msg) {
    // Source side of a session fork (docs/session-fork-plan.md): package the
    // session's transcript + portable metadata + any uncommitted worktree
    // changes into an E2E bundle the client carries to the destination node.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const rec = resolveSession(msg.sessionId);
    if (!rec || !rec.sessionFile) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: "Session not found or not resumable on this node." });
      return;
    }
    try {
      const src = rec.source ?? "";
      const repoSlug = src.startsWith("repo:") ? src.slice(5) : src.startsWith("issue:") ? src.slice(6).replace(/#\d+$/, "") : undefined;
      const forkRecord: ForkRecord = {
        sourceSessionId: rec.id,
        runtimeId: rec.runtimeId,
        workspace: rec.workspace,
        cwd: rec.session.cwd || rec.worktree?.path || rec.workspace,
        worktree: rec.worktree?.path,
        branch: rec.worktree?.branch,
        repoSlug,
        prUrl: rec.prUrl,
        source: rec.source,
        title: rec.session.getName(),
        model: rec.session.getCurrentModel()?.name,
        sandbox: rec.sandbox,
      };
      let dirtyPatch;
      if (rec.worktree) {
        try { dirtyPatch = captureDirtyPatch(rec.worktree.path); } catch { /* best effort — omit dirty state */ }
      }
      // Publish the source branch so a cross-node fork's COMMITTED work travels
      // via origin (the destination adopts `origin/<branch>`; see
      // resolveAdoptBaseRef). Uncommitted work rides the dirtyPatch above. Only
      // for a genuine cross-node fork — a same-node cross-agent fork adopts the
      // LOCAL branch and needs no push. Best-effort: a no-token/offline node just
      // falls back to the default base downstream.
      if (msg.crossNode === true) await pushForkSourceBranch(rec);
      // Refresh the account model-auth vault so the destination node can pull
      // this session's model credentials during import (fork credential-move,
      // docs/session-fork-plan.md). Best-effort: local-only nodes just skip it.
      await pushModelAuthToControlPlane().catch(() => {});
      // When the client has already picked a target agent, pass it so the
      // bundle omits the native payload for a cross-runtime fork (it could
      // never be replayed there — see buildForkBundle). Unset => keep it.
      const bundle = buildForkBundle({ runtime: getRuntime(rec.runtimeId), sessionFile: rec.sessionFile, record: forkRecord, dirtyPatch, targetRuntimeId: agentFrom(msg), liveMessages: rec.session.getMessages() });
      relay?.sendEvent({ type: "session.fork.bundle", requestId, bundle });
    } catch (error) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.fork.import"(msg) {
    // Destination side of a fork: rebuild the repo/worktree, materialise the
    // transcript into the (possibly different) target runtime — full fidelity
    // for a same-runtime fork, a seeded continuation prompt otherwise — and
    // stand up the new session. The client retires the source (for a "move")
    // only after this succeeds, so a failed fork never loses the session.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const bundle = msg.bundle as ForkBundle | undefined;
    if (!bundle?.record || !bundle.normalized) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: "Malformed fork bundle." });
      return;
    }
    try {
      // Cross-node fork: adopt the source's branch on this node and run full
      // prerequisite detection. See standUpFork / fork-prereqs.ts.
      const outcome = await standUpFork({
        bundle,
        targetRuntimeId: agentFrom(msg) ?? bundle.record.runtimeId,
        model: modelFrom(msg),
        transcriptUrl: typeof msg.transcriptUrl === "string" ? msg.transcriptUrl : undefined,
        // Cross-agent forks can use this import handler without changing
        // nodes. In that case the source branch is already checked out here,
        // so cut an independent fork branch instead of trying to adopt it.
        worktree: msg.sameNode === true ? "fresh" : "adopt",
        detectPrereqs: true,
      });
      if (!outcome.ok) {
        relay?.sendEvent({ type: "session.fork.error", requestId, error: outcome.error, missing: outcome.missing });
        return;
      }
      relay?.sendEvent(forkDoneEvent(requestId, outcome.record, outcome.plan, outcome.missing));
    } catch (error) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.fork.local"(msg) {
    // Fast path (docs/session-fork-plan.md): fork a session on the SAME node
    // and SAME runtime WITHOUT round-tripping the transcript out to the client
    // and back. We build the fork bundle in-process and stand the new session
    // up locally (via the shared standUpFork), so a large transcript never
    // leaves the node. Full fidelity by construction (same runtime → native
    // replay). The client uses this whenever the fork keeps the node and agent
    // (model may still change); any node/agent change goes through import above.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const rec = resolveSession(msg.sessionId);
    if (!rec || !rec.sessionFile) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: "Session not found or not resumable on this node." });
      return;
    }
    try {
      const runtime = getRuntime(rec.runtimeId);
      const src = rec.source ?? "";
      const repoSlug = src.startsWith("repo:") ? src.slice(5) : src.startsWith("issue:") ? src.slice(6).replace(/#\d+$/, "") : undefined;
      const forkRecord: ForkRecord = {
        sourceSessionId: rec.id,
        runtimeId: rec.runtimeId,
        workspace: rec.workspace,
        cwd: rec.session.cwd || rec.worktree?.path || rec.workspace,
        worktree: rec.worktree?.path,
        branch: rec.worktree?.branch,
        repoSlug,
        prUrl: rec.prUrl,
        source: rec.source,
        title: rec.session.getName(),
        model: rec.session.getCurrentModel()?.name,
        sandbox: rec.sandbox,
      };
      // Carry uncommitted work: capture from the SOURCE worktree; standUpFork
      // re-applies it into the fork's fresh worktree. Local git ops only.
      let dirtyPatch;
      if (rec.worktree) {
        try { dirtyPatch = captureDirtyPatch(rec.worktree.path); } catch { /* best effort */ }
      }
      // Same runtime → the bundle carries the native payload → full fidelity.
      const bundle = buildForkBundle({ runtime, sessionFile: rec.sessionFile, record: forkRecord, dirtyPatch, targetRuntimeId: rec.runtimeId, liveMessages: rec.session.getMessages() });
      // Cut a fresh fork branch (the source still holds its own); skip prereq
      // detection (same node + same runtime ⇒ agent and repo are present).
      const outcome = await standUpFork({
        bundle,
        targetRuntimeId: rec.runtimeId,
        model: modelFrom(msg),
        worktree: "fresh",
        detectPrereqs: false,
        fallback: { workspace: rec.workspace, cwd: rec.session.cwd || rec.worktree?.path || rec.workspace },
      });
      if (!outcome.ok) {
        relay?.sendEvent({ type: "session.fork.error", requestId, error: outcome.error, missing: outcome.missing });
        return;
      }
      relay?.sendEvent(forkDoneEvent(requestId, outcome.record, outcome.plan, outcome.missing));
    } catch (error) {
      relay?.sendEvent({ type: "session.fork.error", requestId, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async "session.new"(msg) {
    // Start a fresh session. With `repo` ("owner/repo"), clone it and branch
    // off origin/main (or, with `branch`, the requested remote branch) into a
    // new git worktree named from `title` (the user's first message). With an
    // explicit `workspace` path, start in that folder. Otherwise use the
    // default Bivy workspace.
    const repoInput = typeof msg.repo === "string" ? msg.repo.trim() : "";
    const workspaceInput = typeof msg.workspace === "string" ? msg.workspace.trim() : "";
    const title = typeof msg.title === "string" ? msg.title : undefined;
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    let record: SessionRecord;
    try {
      // Deduped by requestId so a client's post-reconnect retry adopts the
      // session this request already created rather than spawning a duplicate.
      record = await dedupeSessionNew(requestId, async () => {
        if (repoInput) {
          const parsed = parseRepo(repoInput);
          if (!parsed) throw new Error(`Invalid repository "${repoInput}" — use owner/repo.`);
          relay?.sendEvent({ type: "session.cloning", repo: parsed.slug });
          const rec = await createRepoSession(parsed, { title, runtimeId: agentFrom(msg), sandbox: sandboxFrom(msg), branch: branchFrom(msg), makeActive: false });
          // Bind the composer's chosen model before the first turn; fall back to
          // the node default when the client didn't pick one.
          await applyRequestedModel(rec, modelFrom(msg) ?? nodeDefaultModel() ?? undefined);
          return rec;
        }
        // Remote/PWA focus is client-owned. Creating a new remote session must
        // not steal or depend on the node-global `active` session; otherwise a
        // running chat can change what “new” means for another click/device.
        const workspace = workspaceInput ? validateWorkspace(workspaceInput) : defaultWorkspace;
        const rec = await createWorkspaceSession(workspace, { title, runtimeId: agentFrom(msg), sandbox: sandboxFrom(msg), branch: branchFrom(msg), makeActive: false });
        await applyRequestedModel(rec, modelFrom(msg) ?? nodeDefaultModel() ?? undefined);
        return rec;
      });
    } catch (error) {
      relay?.sendEvent({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    relay?.sendEvent({
      ...buildHistoryEvent({
        sessionId: record.id,
        workspace: record.workspace,
        source: record.source,
        runtimeId: record.runtimeId,
        isStreaming: sessionBusy(record),
        messages: conversationMessages(record),
      }),
      requestId,
    });
  },
};

// Relay transport binding: `reply` answers the requesting remote client over the
// encrypted relay channel; `broadcast` reaches all clients (local + relay).
const relayCtx: CommandCtx = { reply: (event) => relay?.sendEvent(event), broadcast };

// Shared per-client size slot for all relay-tunneled clients (see below).
const RELAY_CLIENT_ID = "relay";

async function handleRelayMessage(msg: ClientMessage) {
  try {
    const command = RELAY_COMMANDS[msg.kind];
    if (command) {
      await command(msg, relayCtx);
      return;
    }
    // Fallthrough for kinds not in RELAY_COMMANDS: terminal.* frames go to the
    // PTY manager; anything else is an unknown client message.
    if (typeof msg.kind === "string" && msg.kind.startsWith("terminal.")) {
      // The relay is a single tunnel with no per-remote-client identity at this
      // layer, so every relay-tunneled client shares one size slot. That still
      // keeps them distinct from each local socket, so a PTY shared between a
      // local terminal and a relay-attached app is sized to their min.
      handleTerminalMessage(msg, (event) => relay?.sendEvent(event), relayTerminals, RELAY_CLIENT_ID);
      return;
    }
    console.warn("[relay] unknown client message kind:", msg.kind);
  } catch (error) {
    console.warn("[relay] failed to handle client message:", error);
  }
}

function startRelayIfConfigured() {
  const config = loadRelayConfig(appDir);
  if (!config) return false;
  relay?.stop();
  // Reconnecting drops any remote clients the old tunnel carried; release the
  // shared relay size slot so local PTYs it may have shrunk grow back.
  terminals.dropClient(RELAY_CLIENT_ID);
  relay = new RelayConnector(config, (msg) => void handleRelayMessage(msg), {
    pairing: pairingStore,
    onWorkAvailable: () => {
      controlPlanePoller?.poke();
      // A relay wake also means "something changed for this account" — kick a
      // (debounced) model-auth sync so a peer node answers any pending vault-key
      // request from a freshly-launched ephemeral runner without waiting for its
      // 30s poll. Cheap and idempotent; coalesced to at most one sync per burst.
      triggerModelAuthSyncSoon();
    },
  });
  relay.start();
  if (config.controlPlaneUrl && config.enrollmentToken) {
    sessionAdvertiseTarget = { controlPlaneUrl: config.controlPlaneUrl, enrollmentToken: config.enrollmentToken };
    void syncModelAuthFromControlPlane();
    if (remoteRuntimeEnabled()) {
      // Stage 3: layer a control-plane-backed location registry UNDER the in-memory
      // one (so a lookup surviving a restart resolves from durable state), then
      // adopt still-live sessions BEFORE the first advert — the pre-record inside
      // adoption ensures the replace-all POST preserves their addresses.
      if (!cpLocationRegistry) {
        cpLocationRegistry = new ControlPlaneSessionLocationRegistry({
          fetchNodeSessions: fetchNodeSessionRows,
          resolveRuntimeId: (id) => metadata.getSession(id)?.runtimeId,
          nodeId: identity.nodeId,
        });
        sessionLocations = new LayeredSessionLocationRegistry(inMemorySessionLocations, cpLocationRegistry);
      }
      void (async () => {
        await adoptLiveRemoteSessionsOnStartup();
        scheduleAdvertise();
      })();
    } else {
      scheduleAdvertise();
    }
    // Safety-net resync so offline/online transitions converge even without an event.
    if (advertiseResyncTimer) clearInterval(advertiseResyncTimer);
    advertiseResyncTimer = setInterval(() => scheduleAdvertise(), 60_000);
    advertiseResyncTimer.unref?.();
    // Periodic online heartbeat. The relay flips the node's `online` flag
    // fire-and-forget on socket connect/close with no ordering guard, so a
    // late/racing `false` can pin a genuinely-connected node offline in the
    // registry until some later reconnect wins. Re-affirming online on a steady
    // interval keeps `last_seen_at` fresh and self-heals a lost race (the control
    // plane treats a recent heartbeat as online — see NODE_ONLINE_TTL_MS). Fire one
    // immediately so a reconnect corrects a stale `false` without waiting a full tick.
    if (nodeHeartbeatTimer) clearInterval(nodeHeartbeatTimer);
    void sendNodeHeartbeat();
    nodeHeartbeatTimer = setInterval(() => void sendNodeHeartbeat(), NODE_HEARTBEAT_MS);
    nodeHeartbeatTimer.unref?.();
  }
  console.log("[relay] connector enabled");
  return true;
}

type ModelAuthVaultResponse = {
  vault?: { ciphertext: string; updatedAt: string; updatedByNodeId: string; needsRotation?: boolean } | null;
  wrappedKey?: { nodeId: string; wrappedKey: string; wrappedByNodeId: string; wrappedByPublicKey: string } | null;
  // Hosted escrow: the raw vault key, served only for hosted-provisioning accounts
  // so a lone hosted ephemeral can decrypt the vault without a peer (node-less).
  hostedKey?: string | null;
  requests?: Array<{ nodeId: string; publicKey: string }>;
};
const modelAuthVaultKeyPath = path.join(appDir, "model-auth-vault.json");
let lastPushedModelAuthCiphertext = "";

function readLocalModelAuthVaultKey(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelAuthVaultKeyPath, "utf8")) as { vaultKeyB64?: string };
    if (parsed.vaultKeyB64 && Buffer.from(parsed.vaultKeyB64, "base64").length === 32) return parsed.vaultKeyB64;
  } catch {
    // no local key yet
  }
  return undefined;
}

function writeLocalModelAuthVaultKey(vaultKeyB64: string) {
  fs.mkdirSync(path.dirname(modelAuthVaultKeyPath), { recursive: true });
  fs.writeFileSync(modelAuthVaultKeyPath, `${JSON.stringify({ vaultKeyB64, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(modelAuthVaultKeyPath, 0o600); } catch { /* best effort */ }
}

function forgetLocalModelAuthVaultKey() {
  try { fs.rmSync(modelAuthVaultKeyPath, { force: true }); } catch { /* best effort */ }
}

function ensureLocalModelAuthVaultKey(): string {
  const existing = readLocalModelAuthVaultKey();
  if (existing) return existing;
  const created = randomBytes(32).toString("base64");
  writeLocalModelAuthVaultKey(created);
  return created;
}

// Cross-node sync wire format: a Bivy-OWNED, versioned envelope rather than the
// bare provider map. This decouples the sync protocol from any dependency's
// internal credential shape, so nodes on different agent/pi versions can't
// silently exchange an incompatible structure. `decrypt` tolerates a bare map
// for forward-safety.
const MODEL_AUTH_ENVELOPE_VERSION = 2;
// The envelope carries both provider credentials AND Bivy's local-model
// registry. It is sealed node-side; the control plane only ever stores
// ciphertext, so adding `localModels` needs no control-plane schema change.
type ModelAuthEnvelope = {
  v: number;
  providers: Record<string, unknown>;
  deletedAt?: Record<string, number>;
  localModels?: Record<string, unknown>;
};

function encryptModelAuthProviders(
  providers: Record<string, unknown>,
  deletedAt: Record<string, number>,
  localModels: Record<string, unknown>,
  vaultKeyB64: string,
): string {
  const envelope: ModelAuthEnvelope = { v: MODEL_AUTH_ENVELOPE_VERSION, providers, deletedAt, localModels };
  return seal(Buffer.from(vaultKeyB64, "base64"), JSON.stringify(envelope));
}

function decryptModelAuthEnvelope(
  ciphertext: string,
  vaultKeyB64: string,
): { providers: Record<string, unknown>; deletedAt: Record<string, unknown>; localModels: Record<string, unknown> } {
  const empty = { providers: {}, deletedAt: {}, localModels: {} };
  const parsed = JSON.parse(open(Buffer.from(vaultKeyB64, "base64"), ciphertext)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  // Versioned Bivy envelope.
  const envelope = parsed as Partial<ModelAuthEnvelope>;
  if (typeof envelope.v === "number" && envelope.providers && typeof envelope.providers === "object") {
    return {
      providers: envelope.providers as Record<string, unknown>,
      deletedAt: envelope.deletedAt && typeof envelope.deletedAt === "object" ? envelope.deletedAt : {},
      localModels: (envelope.localModels && typeof envelope.localModels === "object" ? envelope.localModels : {}) as Record<string, unknown>,
    };
  }
  // Back-compat: a bare `{ [id]: Credential }` map (pre-envelope / other sender).
  return { providers: parsed as Record<string, unknown>, deletedAt: {}, localModels: {} };
}

async function modelAuthFetch(pathname: string, init: RequestInit = {}) {
  if (!sessionAdvertiseTarget) return null;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${sessionAdvertiseTarget.enrollmentToken}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}${pathname}`, { ...init, headers });
}

// Debounced model-auth sync trigger. A relay wake (`work.available`) fires this
// so peers answer a new node's vault-key request promptly (event-driven) instead
// of on the steady 30s poll. Coalesces a burst of wakes into one sync.
let modelAuthSyncSoonTimer: ReturnType<typeof setTimeout> | undefined;
function triggerModelAuthSyncSoon() {
  if (modelAuthSyncSoonTimer) return;
  modelAuthSyncSoonTimer = setTimeout(() => {
    modelAuthSyncSoonTimer = undefined;
    void syncModelAuthFromControlPlane();
  }, 250);
  modelAuthSyncSoonTimer.unref?.();
}

// Cold-start fast-retry. A freshly-launched node (typically a short-lived
// ephemeral runner) that holds vault ciphertext but no wrapped key yet must wait
// for a peer node to answer its key request. The 30s steady poll is too slow for
// a machine that may only live a minute, so once we've requested the key we
// re-sync on a brief bounded cadence until the wrapped key arrives (a peer
// answered) or we give up and let the steady poll continue. Peer-only by design:
// the key is always answered by another node over the E2E wrap — nothing ever
// transits the device or control plane in the clear.
const MODEL_AUTH_COLDSTART_INTERVAL_MS = 2_000;
const MODEL_AUTH_COLDSTART_MAX_ATTEMPTS = 30; // ~60s bounded
let modelAuthColdStartActive = false;
let modelAuthColdStartAttempts = 0;
let modelAuthColdStartTimer: ReturnType<typeof setTimeout> | undefined;
function stopModelAuthColdStart() {
  modelAuthColdStartActive = false;
  modelAuthColdStartAttempts = 0;
  if (modelAuthColdStartTimer) {
    clearTimeout(modelAuthColdStartTimer);
    modelAuthColdStartTimer = undefined;
  }
}
function ensureModelAuthColdStart() {
  if (modelAuthColdStartActive) return; // already retrying
  modelAuthColdStartActive = true;
  modelAuthColdStartAttempts = 0;
  const tick = () => {
    modelAuthColdStartTimer = undefined;
    if (!modelAuthColdStartActive) return;
    // A concurrent sync may have already landed the key — stop as soon as we have it.
    if (readLocalModelAuthVaultKey() || modelAuthColdStartAttempts >= MODEL_AUTH_COLDSTART_MAX_ATTEMPTS) {
      stopModelAuthColdStart();
      return;
    }
    modelAuthColdStartAttempts++;
    void syncModelAuthFromControlPlane();
    modelAuthColdStartTimer = setTimeout(tick, MODEL_AUTH_COLDSTART_INTERVAL_MS);
    modelAuthColdStartTimer.unref?.();
  };
  modelAuthColdStartTimer = setTimeout(tick, MODEL_AUTH_COLDSTART_INTERVAL_MS);
  modelAuthColdStartTimer.unref?.();
}

async function syncModelAuthFromControlPlane() {
  if (!sessionAdvertiseTarget) return;
  try {
    await modelAuthFetch("/node/model-auth-key/public", { method: "POST", body: JSON.stringify({ publicKey: pairingStore.nodePublicKeyB64() }) });
    const res = await modelAuthFetch("/node/model-auth-vault");
    if (!res?.ok) return;
    const data = (await res.json().catch(() => ({}))) as ModelAuthVaultResponse;
    let vaultKeyB64 = readLocalModelAuthVaultKey();

    if (!vaultKeyB64 && data.wrappedKey?.wrappedKey) {
      vaultKeyB64 = pairingStore.unwrapFromNodePublicKey(data.wrappedKey.wrappedByPublicKey, data.wrappedKey.wrappedKey);
      writeLocalModelAuthVaultKey(vaultKeyB64);
    }

    // Node-less inheritance: a lone HOSTED ephemeral (no peer to wrap the key)
    // adopts the vault key the control plane escrowed for this hosted account, so
    // it can decrypt the synced vault (incl. subscription OAuth) on cold start. The
    // control plane serves `hostedKey` only for hosted-provisioning accounts.
    if (!vaultKeyB64 && data.hostedKey && Buffer.from(data.hostedKey, "base64").length === 32) {
      vaultKeyB64 = data.hostedKey;
      writeLocalModelAuthVaultKey(vaultKeyB64);
    }

    if (data.vault?.ciphertext && vaultKeyB64) {
      let decrypted;
      try {
        decrypted = decryptModelAuthEnvelope(data.vault.ciphertext, vaultKeyB64);
      } catch (error) {
        // Most commonly this node cached the previous generation while another
        // survivor completed a revoke-triggered re-key. Forget it and request a
        // wrap of the current key; retaining it would make every poll fail forever.
        forgetLocalModelAuthVaultKey();
        lastPushedModelAuthCiphertext = "";
        await modelAuthFetch("/node/model-auth-key/request", { method: "POST", body: JSON.stringify({ publicKey: pairingStore.nodePublicKeyB64() }) });
        ensureModelAuthColdStart();
        console.warn("[auth-sync] cached vault key is stale; requested the rotated key:", (error as Error).message);
        return;
      }
      const { providers, deletedAt, localModels } = decrypted;
      await importProviderAuth(credsDir, providers, deletedAt);
      importLocalModels(localModelsDir, localModels);
      // A synced key or config change can both alter the projection, so always
      // regenerate it (and refresh the panel) after importing the vault.
      await writePiModelsProjection();
      await broadcastLocalModels();
      lastPushedModelAuthCiphertext = data.vault.ciphertext;
      // Got the key and imported the vault (incl. any subscription-OAuth logins) —
      // the cold-start race is over.
      stopModelAuthColdStart();
      broadcast({ type: "providers.list", providers: await listProvidersUnified() });
      if (data.vault.needsRotation) await pushModelAuthToControlPlane(true);
    } else if (data.vault?.ciphertext && !vaultKeyB64) {
      await modelAuthFetch("/node/model-auth-key/request", { method: "POST", body: JSON.stringify({ publicKey: pairingStore.nodePublicKeyB64() }) });
      // No peer has wrapped our key yet. Fast-retry (bounded) so a short-lived
      // ephemeral runner picks up the key within seconds of a peer answering,
      // rather than waiting for its next 30s poll.
      ensureModelAuthColdStart();
    } else if (
      Object.keys(await exportProviderAuth(credsDir)).length > 0 ||
      Object.keys(exportLocalModels(localModelsDir)).length > 0
    ) {
      await pushModelAuthToControlPlane();
    }

    await processModelAuthKeyRequests(data.requests ?? []);
  } catch (error) {
    console.warn("[auth-sync] model auth sync failed:", (error as Error).message);
  }
}

async function processModelAuthKeyRequests(requests: Array<{ nodeId: string; publicKey: string }>) {
  if (!sessionAdvertiseTarget || requests.length === 0) return;
  const vaultKeyB64 = readLocalModelAuthVaultKey();
  if (!vaultKeyB64) return;
  for (const request of requests) {
    const wrappedKey = pairingStore.wrapForNodePublicKey(request.publicKey, vaultKeyB64);
    await modelAuthFetch("/node/model-auth-key/wrapped", {
      method: "PUT",
      body: JSON.stringify({ targetNodeId: request.nodeId, wrappedByPublicKey: pairingStore.nodePublicKeyB64(), wrappedKey }),
    });
  }
}

async function pushModelAuthToControlPlane(rotateKey = false) {
  if (!sessionAdvertiseTarget) return;
  // Piggyback the (plaintext, non-secret) provider status summary on every
  // trigger that already pushes the encrypted model-auth vault — one "creds
  // changed" fan-out point instead of duplicating call sites. Independent
  // try/catch: a summary push failure must not block the vault push or vice
  // versa.
  await pushProviderSummaryToControlPlane();
  try {
    const providers = await exportProviderAuth(credsDir);
    const deletedAt = await exportProviderAuthTombstones(credsDir);
    const localModels = exportLocalModels(localModelsDir);
    const previousKey = readLocalModelAuthVaultKey();
    const vaultKeyB64 = rotateKey ? randomBytes(32).toString("base64") : ensureLocalModelAuthVaultKey();
    if (rotateKey) writeLocalModelAuthVaultKey(vaultKeyB64);
    const ciphertext = encryptModelAuthProviders(providers, deletedAt, localModels, vaultKeyB64);
    if (!rotateKey && ciphertext === lastPushedModelAuthCiphertext) return;
    const push = await modelAuthFetch("/node/model-auth-vault", { method: "PUT", body: JSON.stringify({ ciphertext, rotated: rotateKey }) });
    if (!push?.ok) {
      if (rotateKey) {
        if (previousKey) writeLocalModelAuthVaultKey(previousKey);
        else forgetLocalModelAuthVaultKey();
      }
      throw new Error(`model-auth vault push failed (${push?.status ?? "offline"})`);
    }
    await modelAuthFetch("/node/model-auth-key/wrapped", {
      method: "PUT",
      body: JSON.stringify({ targetNodeId: identity.nodeId, wrappedByPublicKey: pairingStore.nodePublicKeyB64(), wrappedKey: pairingStore.wrapForNodePublicKey(pairingStore.nodePublicKeyB64(), vaultKeyB64) }),
    });
    // Node-less inheritance: a HOSTED node also escrows the vault key to the control
    // plane (sealed at rest, hosted-only) so the account's NEXT hosted ephemeral —
    // possibly the only node — can decrypt this vault without a peer to wrap the key.
    // Gated to hosted nodes; the CP double-checks the account is hosted. Best effort.
    if (process.env.BIVY_GITHUB_HOSTED_TASKS) {
      await modelAuthFetch("/node/model-auth-key/hosted-escrow", { method: "PUT", body: JSON.stringify({ vaultKeyB64 }) }).catch(() => {});
    }
    lastPushedModelAuthCiphertext = ciphertext;
  } catch (error) {
    console.warn("[auth-sync] could not push model auth:", (error as Error).message);
  }
}

// --- GitHub App private-key vault sync (issue #88) --------------------------
// Opt-in cross-node sync of connected GitHub Apps' private keys, riding the
// same E2E wrap-key mechanism as the model-auth vault above (new HKDF purpose
// "github-app-vault" — see src/pairing-crypto.ts), but keyed per APP rather
// than one blob per account: an account can hold several apps (personal +
// one per org, see src/github-apps.ts), each syncing independently.
//
// Deliberately opt-in (BIVY_GITHUB_APP_SYNC=1, set via `bivy github:app-sync
// on`) rather than automatic like model auth: a GitHub App key is a repo-write
// credential, so widening which nodes hold it is a real blast-radius decision
// the issue asks to make deliberate, not a default (see issue #88's "Design
// decisions" section). A node that hasn't opted in never calls any of this.
//
// The control plane only ever stores ciphertext + per-node wrapped vault keys,
// exactly like model-auth-vault — see docs/credential-sync.md.
function githubAppSyncEnabled(): boolean {
  return (process.env.BIVY_GITHUB_APP_SYNC || "").trim() === "1";
}

type GithubAppVaultRow = { appId: string; ciphertext: string; updatedAt: string; updatedByNodeId: string; needsRotation: boolean };
type GithubAppWrappedKeyRow = { appId: string; nodeId: string; wrappedKey: string; wrappedByNodeId: string; wrappedByPublicKey: string };
type GithubAppKeyRequestRow = { appId: string; nodeId: string; publicKey: string };
type GithubAppVaultResponse = { vaults?: GithubAppVaultRow[]; wrappedKeys?: GithubAppWrappedKeyRow[]; requests?: GithubAppKeyRequestRow[] };

// Per-app fingerprint of the content (PEM + display metadata) this node last
// pushed, so a steady-state poll tick doesn't re-PUT unchanged content just
// because `seal()`'s random IV makes every ciphertext byte-different. Reset on
// restart — one redundant push after a restart is the same tolerance the
// model-auth vault above already accepts.
const lastPushedGithubAppFingerprint = new Map<string, string>();

function fingerprintGithubAppContent(record: GitHubAppRecord, privateKeyPem: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ privateKeyPem, slug: record.slug, name: record.name, owner: record.owner, ownerType: record.ownerType, hookId: record.hookId }))
    .digest("hex");
}

/**
 * One sync tick: pull apps this node doesn't hold yet (importing them once a
 * usable vault key is in hand), answer other nodes' pending key requests for
 * apps this node DOES hold, and push/rotate apps this node holds so the rest
 * of the account's opted-in nodes can pick them up.
 */
async function syncGithubAppVaultFromControlPlane(): Promise<void> {
  if (!sessionAdvertiseTarget || !githubAppSyncEnabled()) return;
  try {
    const res = await modelAuthFetch("/node/github-app-vault");
    if (!res?.ok) return;
    const data = (await res.json().catch(() => ({}))) as GithubAppVaultResponse;
    const vaults = Array.isArray(data.vaults) ? data.vaults : [];
    const wrappedKeys = Array.isArray(data.wrappedKeys) ? data.wrappedKeys : [];
    const requests = Array.isArray(data.requests) ? data.requests : [];
    const localAppIds = new Set(listGitHubApps(appDir).map((a) => a.appId));
    let importedAny = false;

    // 1) Pull every app we don't hold locally yet.
    for (const vault of vaults) {
      if (!vault.appId || !vault.ciphertext || localAppIds.has(vault.appId)) continue;
      let vaultKeyB64 = readLocalGithubAppVaultKey(appDir, vault.appId);
      if (!vaultKeyB64) {
        const wrapped = wrappedKeys.find((w) => w.appId === vault.appId);
        if (wrapped) {
          try {
            vaultKeyB64 = pairingStore.unwrapFromNodePublicKey(wrapped.wrappedByPublicKey, wrapped.wrappedKey, "github-app-vault");
            writeLocalGithubAppVaultKey(appDir, vault.appId, vaultKeyB64);
          } catch (error) {
            console.warn(`[github-app-sync] could not unwrap vault key for app ${vault.appId}:`, (error as Error).message);
          }
        }
      }
      if (vaultKeyB64) {
        try {
          const envelope = decryptGithubAppEnvelope(vault.ciphertext, vaultKeyB64);
          const keyId = privateKeyIdFor(envelope.appId);
          new SecretVault(appDir).setLocal(keyId, envelope.privateKeyPem, `GitHub App private key (${envelope.appId}, synced)`);
          upsertGitHubApp(appDir, {
            appId: envelope.appId,
            slug: envelope.slug,
            name: envelope.name,
            owner: envelope.owner,
            ownerType: envelope.ownerType,
            privateKeyRef: `secret://${keyId}`,
            hookId: envelope.hookId,
          });
          localAppIds.add(envelope.appId);
          importedAny = true;
        } catch (error) {
          // Stale/wrong local key (e.g. this app was just rotated by a
          // surviving node after a revoke) — drop it so we cleanly re-request
          // a fresh wrap instead of failing on every future poll.
          forgetLocalGithubAppVaultKey(appDir, vault.appId);
          console.warn(`[github-app-sync] could not decrypt vault for app ${vault.appId}, will re-request:`, (error as Error).message);
        }
      } else {
        await modelAuthFetch("/node/github-app-key/request", {
          method: "POST",
          body: JSON.stringify({ appId: vault.appId, publicKey: pairingStore.nodePublicKeyB64() }),
        }).catch(() => {});
      }
    }

    if (importedAny) {
      invalidateGitHubApps();
      void registerGithubAppMeta();
      void reportGithubAppInstallations();
    }

    // 2) Answer pending requests for apps we hold a resolved vault key for.
    for (const request of requests) {
      if (!request.appId || !localAppIds.has(request.appId)) continue;
      const vaultKeyB64 = readLocalGithubAppVaultKey(appDir, request.appId);
      if (!vaultKeyB64) continue;
      const wrappedKey = pairingStore.wrapForNodePublicKey(request.publicKey, vaultKeyB64, "github-app-vault");
      await modelAuthFetch("/node/github-app-key/wrapped", {
        method: "PUT",
        body: JSON.stringify({ appId: request.appId, targetNodeId: request.nodeId, wrappedByPublicKey: pairingStore.nodePublicKeyB64(), wrappedKey }),
      }).catch(() => {});
    }

    // 3) Push every app we hold: first sync for apps the vault doesn't have
    // yet, mint-a-fresh-key rotation when the control plane flags it (a node
    // that had this app's wrapped key was removed from the account), or a
    // content refresh when what we'd push differs from what we last pushed.
    for (const record of listGitHubApps(appDir)) {
      const remote = vaults.find((v) => v.appId === record.appId);
      const needsRotation = Boolean(remote?.needsRotation);
      const privateKeyPem = await resolveSecret(record.privateKeyRef, appDir);
      if (!privateKeyPem) continue;
      const fingerprint = fingerprintGithubAppContent(record, privateKeyPem);
      if (remote && !needsRotation && lastPushedGithubAppFingerprint.get(record.appId) === fingerprint) continue;
      const vaultKeyB64 = needsRotation || !readLocalGithubAppVaultKey(appDir, record.appId)
        ? mintLocalGithubAppVaultKey(appDir, record.appId)
        : (readLocalGithubAppVaultKey(appDir, record.appId) as string);
      const ciphertext = encryptGithubAppEnvelope(
        { appId: record.appId, privateKeyPem, slug: record.slug, name: record.name, owner: record.owner, ownerType: record.ownerType, hookId: record.hookId },
        vaultKeyB64,
      );
      const pushRes = await modelAuthFetch("/node/github-app-vault", { method: "PUT", body: JSON.stringify({ appId: record.appId, ciphertext }) }).catch(() => null);
      if (!pushRes?.ok) continue;
      lastPushedGithubAppFingerprint.set(record.appId, fingerprint);
      // Self-wrap: so this node's own row in `wrappedKeys` is populated too,
      // matching the model-auth vault's push (a node that later loses its
      // local github-app-vault.json cache but keeps its secret vault can
      // recover the key without needing another node online).
      await modelAuthFetch("/node/github-app-key/wrapped", {
        method: "PUT",
        body: JSON.stringify({
          appId: record.appId,
          targetNodeId: identity.nodeId,
          wrappedByPublicKey: pairingStore.nodePublicKeyB64(),
          wrappedKey: pairingStore.wrapForNodePublicKey(pairingStore.nodePublicKeyB64(), vaultKeyB64, "github-app-vault"),
        }),
      }).catch(() => {});
    }
  } catch (error) {
    console.warn("[github-app-sync] sync failed:", (error as Error).message);
  }
}

let githubAppSyncTimer: ReturnType<typeof setInterval> | undefined;

/** Start (or restart) the periodic GitHub App vault sync poll. A no-op — and
 *  no network calls at all — unless this node opted in (BIVY_GITHUB_APP_SYNC). */
function startGithubAppSyncWatcher(): void {
  if (githubAppSyncTimer) clearInterval(githubAppSyncTimer);
  if (!githubAppSyncEnabled()) return;
  void syncGithubAppVaultFromControlPlane();
  githubAppSyncTimer = setInterval(() => void syncGithubAppVaultFromControlPlane(), 30_000);
  githubAppSyncTimer.unref?.();
}

// Plaintext (non-secret) summary of which OAuth-capable providers this node has
// configured, and whether the stored token has expired — pushed alongside the
// encrypted model-auth vault (see pushModelAuthToControlPlane above) so the web
// client can show a per-node connection/expiry chip in NodeSwitcher without
// connecting to every node. Deliberately excludes any credential material or
// account identity — just {id, name, configured, expiresAt} per oauth-capable
// provider, the same trust tier as the node's existing plaintext online/lastSeenAt
// fields.
let lastPushedProviderSummary = "";
async function pushProviderSummaryToControlPlane() {
  if (!sessionAdvertiseTarget) return;
  try {
    const providers = await listProviders(credsDir, piDir);
    // Only providers the node has actually connected at some point — an
    // expired OAuth credential still reports configured:true (the token is
    // just past `expiresAt`), so this keeps "expired" entries while dropping
    // the rest of the oauth-capable catalog the user never touched (which
    // would otherwise show a "not connected" chip for every such provider on
    // every node in NodeSwitcher).
    const summary = providers
      .filter((p) => p.oauth && p.configured)
      .map((p) => ({ id: p.id, name: p.name, configured: p.configured, expiresAt: p.expiresAt }));
    const serialized = JSON.stringify(summary);
    if (serialized === lastPushedProviderSummary) return;
    await modelAuthFetch("/node/provider-summary", { method: "PUT", body: JSON.stringify({ providers: summary }) });
    lastPushedProviderSummary = serialized;
  } catch (error) {
    console.warn("[auth-sync] could not push provider summary:", (error as Error).message);
  }
}

// Re-project the vault into Pi's plaintext auth.json when it changes while a
// native `bivy run pi` TUI is live, so a credential that lands AFTER launch
// (e.g. a login synced from another node, or a token refresh) reaches the
// already-running Pi — instead of it staying stuck on the "No API key" prompt
// with which it launched. We ingest first so a login just typed into the TUI
// (written to auth.json but not yet folded into the vault) is preserved rather
// than clobbered by the re-projection. materializePlaintext and importAll are
// both write-if-changed, so this can't ping-pong with the auth.json watcher.
async function reprojectPiAuthForLiveRuns() {
  const hasLivePi = terminals
    .list((m) => m.kind === "run" && m.agent === "pi")
    .some((t) => runTerminals.has(t.id));
  if (!hasLivePi) return;
  try {
    const vault = createCredentialVault(credsDir, piDir);
    await vault.ingestPlaintext();
    vault.materializePlaintext();
  } catch (error) {
    console.warn("[provision] live pi auth.json re-projection failed:", (error as Error).message);
  }
}

let modelAuthWatchTimer: ReturnType<typeof setTimeout> | undefined;
let modelAuthPollTimer: ReturnType<typeof setInterval> | undefined;
function startModelAuthWatcher() {
  // The encrypted vault is the daemon's source of truth; watch it so any local
  // credential change triggers a cross-node push (and refreshes any live native
  // Pi TUI's plaintext projection).
  const vaultPath = path.join(credsDir, "auth.enc");
  const debouncedPush = () => {
    if (modelAuthWatchTimer) clearTimeout(modelAuthWatchTimer);
    modelAuthWatchTimer = setTimeout(() => void pushModelAuthToControlPlane(), 500);
  };
  fs.watchFile(vaultPath, { interval: 2000 }, () => {
    debouncedPush();
    void reprojectPiAuthForLiveRuns();
  });
  // Pi's own TUI writes credentials to the plaintext auth.json; fold those back
  // into the vault (then push) so a login done in the native TUI propagates.
  const legacyPath = path.join(piDir, "auth.json");
  fs.watchFile(legacyPath, { interval: 2000 }, () => {
    void createCredentialVault(credsDir, piDir).ingestPlaintext().then(debouncedPush).catch(() => {});
  });
  if (modelAuthPollTimer) clearInterval(modelAuthPollTimer);
  modelAuthPollTimer = setInterval(() => void syncModelAuthFromControlPlane(), 30_000);
  modelAuthPollTimer.unref?.();
}

// --- Cross-node session index (advertise metadata to the control plane) -------
// The control plane shows one merged session list across the account's nodes. We
// push METADATA ONLY; the title is sealed with the room key so the control plane
// stores ciphertext (clients decrypt). See docs/product-definition.md (option b).
let sessionAdvertiseTarget: { controlPlaneUrl: string; enrollmentToken: string } | undefined;
let advertiseTimer: ReturnType<typeof setTimeout> | undefined;
let advertiseResyncTimer: ReturnType<typeof setInterval> | undefined;
// Only one replace-all session advert may be in flight. If an older snapshot
// (still containing a just-deleted/pruned session) completes after a newer one,
// the control plane resurrects that row. Changes arriving during a request set
// this flag and are sent immediately after it completes, in order.
let advertiseRunning = false;
let advertiseAgain = false;

// How often the node re-affirms it's online to the control plane. Kept well
// under the control plane's NODE_ONLINE_TTL_MS (90s) so a missed beat or two
// doesn't flap a healthy node's status.
const NODE_HEARTBEAT_MS = 30_000;
let nodeHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

/** Re-affirm this node's online status so the registry self-heals a lost
 *  relay connect/close race (see the heartbeat wiring in the relay connector
 *  and NODE_ONLINE_TTL_MS in the control plane). Best-effort: a missed beat is
 *  covered by the next tick and the TTL window. */
async function sendNodeHeartbeat() {
  if (!sessionAdvertiseTarget) return;
  try {
    await fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}/node/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}` },
    });
  } catch {
    // best effort; the next tick retries
  }
}


async function advertiseNodeName(name: string, prevName?: string) {
  if (!sessionAdvertiseTarget) return;
  try {
    const res = await fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}/node/name`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}` },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      // The control plane keeps names unique; adopt whatever it accepted (in case
      // it normalised) so local identity matches what routes work.
      const data = (await res.json().catch(() => ({}))) as { node?: { name?: string } };
      const accepted = typeof data?.node?.name === "string" ? data.node.name : undefined;
      if (accepted && accepted !== identity.name) {
        identity.setName(accepted);
        refreshControlPlaneTaskLabels();
        broadcast({ type: "node.updated", name: accepted });
        relay?.sendEvent({ type: "node.updated", name: accepted });
      }
      return;
    }
    // Rejected (e.g. the name is already taken by another node) — revert the
    // optimistic local change so the node name stays consistent with the account.
    if (prevName && prevName !== identity.name) {
      identity.setName(prevName);
      refreshControlPlaneTaskLabels();
      broadcast({ type: "node.updated", name: prevName });
      relay?.sendEvent({ type: "node.updated", name: prevName });
    }
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    relay?.sendEvent({ type: "node.rename.error", error: err?.error || "That name is already in use on your account." });
  } catch {
    // Best-effort; local node identity remains authoritative for direct clients.
  }
}

// A short, human-readable label for a session, used inside push-notification
// text so a buzz tells you *which* session wants you instead of a generic
// "a session". Prefers the session's own name; falls back to agent + branch,
// then a generic word. Kept terse so it still reads on a lock screen.
function sessionNotifyLabel(record: SessionRecord | undefined, fallback = "A session"): string {
  const name = record?.session.getName()?.trim();
  if (name) return name;
  if (!record) return fallback;
  const agent = getRuntime(record.runtimeId).displayName?.trim();
  const branch = record.worktree?.branch?.trim();
  if (agent && branch) return `${agent} · ${branch}`;
  return agent || branch || fallback;
}

async function sendNotificationHint(input: { kind: string; sessionId?: string; title?: string; body?: string; targetSessionId?: string; attentionId?: string }) {
  if (!sessionAdvertiseTarget) return;
  try {
    await modelAuthFetch("/internal/notifications/hints", { method: "POST", body: JSON.stringify(input) });
  } catch {
    // Best-effort: notification delivery must never affect the local session.
  }
}

/** The agent-service address hosting a live session, when it runs on a remote
 *  runtime (Stage 2 re-attach routing, docs/agent-node-decoupling.md); undefined
 *  for in-process sessions. Best-effort — never blocks advertising. */
function sessionAgentServiceAddress(record?: SessionRecord): string | undefined {
  if (!record) return undefined;
  // Prefer the address of the service this session is ACTUALLY bound to (set at
  // create/attach time, Stage 3), so a session adopted from another service routes
  // to its real host rather than the node default. Fall back to the default
  // runtime's address for sessions created before the field existed.
  if (record.agentServiceAddress) return record.agentServiceAddress;
  try {
    return (getRuntime(record.runtimeId) as { agentServiceAddress?: string }).agentServiceAddress;
  } catch {
    return undefined;
  }
}

/** Record where a live remote session is hosted so a later openSessions miss can
 *  re-attach to it (Stage 2). No-op for in-process sessions. */
function recordSessionLocation(record: SessionRecord): void {
  const agentServiceAddress = sessionAgentServiceAddress(record);
  if (!agentServiceAddress) return;
  void sessionLocations
    .record({ sessionId: record.id, agentServiceAddress, runtimeId: record.runtimeId, nodeId: identity.nodeId, sandbox: record.sandbox })
    .catch(() => {});
}

/** Read this node's own session-index rows (WITH the agent-service address) from
 *  the control plane's node-facing endpoint (Stage 3). Bounded by a timeout so a
 *  slow/unreachable control plane can't stall startup adoption; degrades to []. */
async function fetchNodeSessionRows(): Promise<NodeSessionRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await modelAuthFetch("/node/sessions", { signal: controller.signal });
    if (!res || !res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return [];
    return body.sessions
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      .map((r) => ({
        sessionId: String(r.sessionId ?? ""),
        agentServiceAddress: r.agentServiceAddress != null ? String(r.agentServiceAddress) : undefined,
        status: r.status != null ? String(r.status) : undefined,
        source: r.source != null ? String(r.source) : undefined,
        branch: r.branch != null ? String(r.branch) : undefined,
      }))
      .filter((r) => r.sessionId);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stage 3 startup adoption (docs/agent-node-decoupling.md). Before the first
 * advert, re-attach to every session this node still owns on an agent service, so
 * a daemon RESTART re-binds still-live sessions instead of losing them (the
 * in-memory sessionLocations map died with the previous process). Runs only when
 * the remote flag is on. Per the failure policy: a definitively-gone session is
 * forgotten; an unreachable service keeps its mapping for a later retry.
 *
 * Race note: the addresses are PRE-RECORDED into the in-memory registry (awaited)
 * before the caller schedules the first advert, so the replace-all-per-node POST
 * preserves the `agent_service_address` column even while the (backgrounded)
 * attaches are still in flight. Without that ordering the first advert would wipe
 * the very column adoption reads.
 */
async function adoptLiveRemoteSessionsOnStartup(): Promise<void> {
  if (!remoteRuntimeEnabled() || !cpLocationRegistry) return;
  let rows: SessionLocation[];
  try {
    rows = await cpLocationRegistry.listNode();
  } catch {
    return; // control plane unreachable now — the resync/next access will retry
  }
  if (!rows.length) return;
  for (const loc of rows) await sessionLocations.record(loc).catch(() => {});
  void attachAdoptedSessions(rows, {
    attach: (loc) =>
      createSession(defaultWorkspace, loc.sessionId, { runtimeId: loc.runtimeId, sandbox: loc.sandbox as SandboxTier | undefined, makeActive: false, attachOnly: true }).then(() => undefined),
    forget: (id) => sessionLocations.forget(id).catch(() => {}),
    log: (message) => console.log(`[adopt] ${message}`),
  })
    .then((outcome) => console.log(`[adopt] startup adoption: ${outcome.adopted.length} adopted, ${outcome.kept.length} kept (unreachable), ${outcome.forgotten.length} forgotten (gone)`))
    .catch(() => {});
}

async function advertiseSessions() {
  if (!sessionAdvertiseTarget || !relay) return;
  const records = new Set([...openSessions.values()].filter((record) => !isEmptyUntitledRecord(record)));
  const summaries = await listAllSessions().catch(() => []);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const metadataById = new Map(metadata.listSessions().map((s) => [s.id, s]));
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, { id: record.id, path: record.sessionFile, name: record.session.getName(), modified: new Date().toISOString(), messageCount: conversationMessages(record).length, agent: record.runtimeId, agentName: getRuntime(record.runtimeId).displayName });
  }
  const sessions = await Promise.all([...byId.values()].map(async (s) => {
    const record = openSessions.get(s.id);
    const meta = metadataById.get(s.id);
    const name = record?.session.getName() || s.name || s.firstMessage || meta?.name;
    // See sessions.list's identical comment: also covers a pending question.
    const pendingApproval = record ? sessionHasPendingApproval(record) : approvals.list().some((a) => a.sessionId === s.id && a.status === "pending");
    // Preserve the agent-service address across this replace-all advert (Stage 3).
    // A live record supplies it directly; a session that is NOT currently open
    // (saved / cap-detached) would otherwise advertise `undefined` and the
    // replace-all POST would NULL its `agent_service_address` column — orphaning a
    // child the agent service is still running. Fall back to this daemon's durable
    // in-memory location for such sessions. Only the in-memory layer is consulted:
    // a definitively-gone session was forgotten there, so its address is correctly
    // dropped; and with the remote flag off the map is empty, so the payload is
    // byte-identical to before.
    const agentServiceAddress = sessionAgentServiceAddress(record) ?? (record ? undefined : (await inMemorySessionLocations.lookup(s.id).catch(() => undefined))?.agentServiceAddress);
    const approvalAttention = approvals.list()
      .filter((a) => a.sessionId === s.id && a.status === "pending")
      .map((a) => ({
        id: a.id,
        kind: "approval" as const,
        severity: a.risk === "critical" ? "critical" as const : a.risk === "high" ? "error" as const : "warning" as const,
        createdAt: new Date(a.createdAt).toISOString(),
      }));
    const questionAttention = questionManager.list()
      .filter((q) => q.sessionId === s.id && q.status === "pending")
      .map((q) => ({ id: q.id, kind: "question" as const, severity: "warning" as const, createdAt: new Date(q.createdAt).toISOString() }));
    const failureAt = record?.lastFailureAt || (meta?.status === "failed" ? Date.parse(meta.updatedAt) : 0);
    const failureAttention = failureAt
      ? [{
          id: "last-failure",
          kind: (record?.source || meta?.source ? "automation" : "session") as "automation" | "session",
          severity: "error" as const,
          createdAt: new Date(failureAt).toISOString(),
        }]
      : [];
    return {
      sessionId: s.id,
      // Failures (including exhausted credits/rate limits) are outcomes to
      // review, not blocking questions that keep saying "Needs your response".
      // Only a still-pending approval/question owns that status.
      status: pendingApproval ? "needs_action" : (record ? (sessionBusy(record) ? "working" : "idle") : "saved"),
      needsAction: pendingApproval,
      source: record?.source || meta?.source,
      titleEnc: name ? relay!.sealString(name) : undefined,
      branch: record?.worktree?.branch || meta?.branch,
      // This is activity time, not advert receive time. A daemon restart/full
      // resync must not make every historical row appear freshly updated.
      updatedAt: isoFrom(record?.lastTouchedAt ?? meta?.lastActivityAt ?? meta?.updatedAt ?? s.modified),
      agentServiceAddress,
      githubIssueUrl: record?.githubIssueUrl,
      prUrl: record?.prUrl,
      attention: [...approvalAttention, ...questionAttention, ...failureAttention],
    };
  }));
  try {
    await fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}/node/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}` },
      body: JSON.stringify({ sessions }),
    });
  } catch {
    // best effort; the periodic resync and the next change will retry
  }
}

/** Debounced, serialized advertise — many session events collapse into one
 * POST, and replace-all snapshots can never complete out of order. */
function scheduleAdvertise() {
  if (!sessionAdvertiseTarget) return;
  if (advertiseRunning) {
    advertiseAgain = true;
    return;
  }
  if (advertiseTimer) return;
  advertiseTimer = setTimeout(() => {
    advertiseTimer = undefined;
    void drainSessionAdverts();
  }, 1000);
  advertiseTimer.unref?.();
}

async function drainSessionAdverts() {
  if (advertiseRunning) {
    advertiseAgain = true;
    return;
  }
  advertiseRunning = true;
  try {
    do {
      advertiseAgain = false;
      await advertiseSessions();
    } while (advertiseAgain);
  } finally {
    advertiseRunning = false;
  }
}

let githubPoller: GitHubTaskPoller | undefined;

/**
 * Run one GitHub issue end to end: a background session in an isolated worktree
 * (worktree is REQUIRED for issue pickup), then commit → push → PR linked to the
 * issue. The agent's content never leaves this machine; only the branch + PR go
 * to GitHub, via the node's own token.
 */
type IssueEmit = (record: SessionRecord, stage: string, message: string, extra?: Record<string, unknown>) => void;

/**
 * Serialize all work for one issue (keyed by its `issue:owner/repo#N` source).
 * Two triggers can race — e.g. the labelled-issue pickup and a follow-up
 * @-mention, or two quick follow-ups — and without this they'd drive the same
 * worktree/branch/session concurrently (interleaved commits, a duplicate PR, or a
 * follow-up starting before the first run created the session it looks for). Each
 * call waits for the previous one on the same issue to settle, then runs. The tail
 * is cleaned up when no newer call is queued, so the map doesn't grow unbounded.
 */
const issueLocks = new Map<string, Promise<unknown>>();
function withIssueLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = issueLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the predecessor settles, success or failure
  const tail = run.catch(() => {}); // error-tolerant handle for chaining + cleanup
  issueLocks.set(key, tail);
  void tail.then(() => {
    if (issueLocks.get(key) === tail) issueLocks.delete(key);
  });
  return run;
}

/** Optional agent/model overrides for a queued run (from the manual "Run…" action).
 *  Take precedence over any `bivy-agent:`/`bivy-model:` directives in the issue body. */
interface RunIssueOverrides {
  runtimeId?: string;
  model?: string;
  /** Issue #153 — forward a sanitized evidence patch to the hosted control
   *  plane's run-evidence endpoint. Only set for control-plane-dispatched runs
   *  (self-hosted direct GitHub polling has no control-plane run to attach to). */
  onEvidence?: (patch: Record<string, unknown>) => void | Promise<void>;
}

async function runIssueTask(cfg: GitHubTaskConfig, issue: GitHubIssue, overrides: RunIssueOverrides = {}) {
  const source = `issue:${cfg.owner}/${cfg.repo}#${issue.number}`;
  return withIssueLock(source, () => runIssueTaskInner(cfg, issue, source, overrides));
}

async function runIssueTaskInner(cfg: GitHubTaskConfig, issue: GitHubIssue, source: string, overrides: RunIssueOverrides = {}) {
  const branch = issueBranchName(issue.number);
  const emit: IssueEmit = (record, stage, message, extra = {}) => {
    broadcast({ type: "session.github_issue_status", sessionId: record.id, issueNumber: issue.number, repo: `${cfg.owner}/${cfg.repo}`, branch, stage, message, ...extra });
    // Issue #153: mirror a handful of stages onto the control plane's sanitized
    // evidence trail — the branch/PR references and a bounded summary only,
    // never file lists or error details (those stay in `message`/`extra`,
    // which are broadcast to the live session but never sent to onEvidence).
    const kind = stage === "pr_opened" ? "pull_request"
      : stage === "started" || stage === "pushed" ? "branch"
        : stage === "failed" || stage === "checks_failed" || stage === "no_changes" ? "completed"
          : undefined;
    if (kind) {
      const summary = stage === "pr_opened" ? "Pull request opened."
        : stage === "started" ? "Working branch and session created."
          : stage === "pushed" ? "Changes pushed; no pull request is open."
            : stage === "no_changes" ? "Run completed with no file changes."
              : stage === "checks_failed" ? "Deterministic validation checks failed."
                : "Execution failed. Detailed diagnostics remain on the node.";
      void overrides.onEvidence?.({
        output: { sessionId: record.id, branch, prUrl: typeof extra.prUrl === "string" ? extra.prUrl : undefined },
        events: [{
          at: new Date().toISOString(),
          kind,
          summary,
          ref: branch,
          url: typeof extra.prUrl === "string" ? extra.prUrl : undefined,
          ...(stage === "checks_failed" || stage === "failed" ? { status: "failed" } : {}),
        }],
      });
    }
  };

  // Follow-up: a later @-mention on an issue we still have an open session for
  // continues that session (same worktree/branch/PR) instead of trying to
  // recreate the branch — which failed and silently marked the item "done" with
  // nothing happening. Requires the live session + its worktree on disk; a
  // node-restart follow-up (no live session) falls through to a fresh pickup,
  // which now adopts the existing remote branch rather than colliding.
  const existing = findIssueSession(source);
  if (existing?.worktree && fs.existsSync(existing.worktree.path)) {
    return runIssueFollowUp(cfg, issue, existing, emit, overrides);
  }

  // Idempotency guard against the duplicate-PR regression: if this issue's
  // deterministic branch already produced a *merged* pull request, the change has
  // already shipped. With no live session to continue (ruled out just above), a
  // fresh pickup would branch off current `main` and open a *second* PR on top of
  // merged work — exactly how #397–#404 landed (a lingering pickup label, a stale
  // poll, a control-plane re-dispatch, or a re-@-mention handing us a resolved
  // issue again). Skip it, and make the skip sticky by claiming the issue so the
  // poller's `selectActionableIssues` filter stops re-listing it. Genuine
  // follow-up work after a merge belongs on a reopened/new issue; a
  // closed-unmerged PR does not count as resolved, so abandoned work can be redone.
  const alreadyMerged = await findMergedPullRequestForBranch(cfg, branch);
  if (alreadyMerged) {
    console.log(`[github-tasks] skipping issue #${issue.number}: already resolved by merged ${alreadyMerged.url} — not opening a duplicate PR`);
    broadcast({ type: "session.github_issue_status", sessionId: "", issueNumber: issue.number, repo: `${cfg.owner}/${cfg.repo}`, branch, stage: "already_resolved", message: `Issue #${issue.number} already has a merged pull request (${alreadyMerged.url}); skipping to avoid a duplicate.`, prUrl: alreadyMerged.url });
    await addLabel(cfg, issue.number, cfg.claimLabel).catch(() => {});
    if (cfg.label && cfg.label !== cfg.claimLabel) {
      await removeLabel(cfg, issue.number, cfg.label).catch(() => {});
    }
    return;
  }

  // Visibly signal pickup on the issue itself: swap the routing label (e.g.
  // `bivy`) for the claim label (`bivy:in-progress`) and leave a comment naming
  // this node, so a human watching the issue knows work has actually started.
  // This is the only labeling GitHub ever sees for a hosted (GitHub App) work
  // item — that path claims via the control plane, not a GitHub label — and a
  // harmless idempotent repeat for the direct poller / manual pickup endpoint,
  // which already added the claim label before calling in here.
  await announcePickup(cfg, issue.number, identity.name);

  const parsed = parseBivyDirectives(issue.body);
  // Manual "Run…" overrides win over in-body directives, then the node's
  // *configured* default agent (Settings → Nodes → "Default agent"). We resolve
  // the default explicitly here rather than leaving `runtimeId` undefined for
  // `createSession` to fill in, because that fallback uses the mutable
  // `defaultRuntimeId` global — which the web UI reassigns to the *last used*
  // agent on every `runtime.select`. Issue pickups must honor the persisted
  // default, not whatever agent a human last happened to click.
  const directives = {
    runtimeId: overrides.runtimeId || parsed.runtimeId || nodeConfiguredDefaultAgent(),
    model: overrides.model || parsed.model,
  };
  // `cfg.repoDir` is a long-lived shared clone reused across every pickup on this
  // node. The hosted control-plane dispatch path (runWorkItem) refreshes it via
  // `cloneOrUpdateRepo` first, but the direct self-hosted poller
  // (`resolveGitHubTaskConfig`) hands us a bare `BIVY_GITHUB_REPO_DIR`/
  // `BIVY_WORKSPACE` checkout with NO fetch at all — and even `cloneOrUpdateRepo`
  // only fetches, it never fast-forwards the clone's checked-out branch. Either
  // way, leaving `base` unset here would fall through to `createWorktree`'s
  // default (the shared clone's local HEAD, i.e. whatever it happened to be on
  // at last clone/checkout) instead of the remote's actual current default
  // branch — silently branching new issue work off an increasingly stale `main`
  // the longer the clone goes untouched. Fetch unconditionally (harmless if the
  // caller already did — git no-ops when there's nothing new) and then resolve
  // the real upstream default explicitly, matching `createWorkspaceSession`'s
  // identical fetchOrigin-then-resolveDefaultBaseRef pattern for repo sessions.
  await fetchOrigin(cfg.repoDir);
  const base = await resolveDefaultBaseRef(cfg.repoDir);
  const record = await createSession(cfg.repoDir, undefined, {
    worktree: { branch, base },
    makeActive: false,
    source,
    runtimeId: directives.runtimeId,
  });
  record.githubIssueUrl = `https://github.com/${cfg.owner}/${cfg.repo}/issues/${issue.number}`;
  // Title the session from the issue up front so it never shows as "Untitled
  // session" in the sidebar — issue title + number is a good, stable start (the
  // agent-written PR title later gives the richer summary). Deterministic, so it
  // doesn't depend on the runtime naming itself.
  setSessionName(record, issueSessionTitle(issue));
  // Best-effort model selection for runtimes that support it (e.g. claude-code, pi).
  if (directives.model && typeof (record.session as any).setModel === "function") {
    try { await (record.session as any).setModel("", directives.model); } catch {}
  }
  if (!record.worktree) throw new Error("worktree was not created for the issue session");

  try {
    emit(record, "started", `Started work on ${cfg.owner}/${cfg.repo}#${issue.number}.`);
    await runSessionTurn(record, buildTaskPrompt(issue, nodeGithubIssuePrompt()));
    emit(record, "agent_done", `Agent finished issue #${issue.number}; running deterministic checks.`);
    await reportIssueOutcome(cfg, issue, record, emit, { followUp: false, onEvidence: overrides.onEvidence });
  } catch (error) {
    emit(record, "failed", `GitHub issue #${issue.number} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Continue an already-open issue session for a follow-up @-mention: sync the
 * branch with the base first (resolving conflicts via the agent if needed), run
 * the new comment as another turn in the same worktree, then report the outcome
 * the same way a fresh pickup does.
 */
async function runIssueFollowUp(cfg: GitHubTaskConfig, issue: GitHubIssue, record: SessionRecord, emit: IssueEmit, overrides: RunIssueOverrides = {}) {
  const wt = record.worktree;
  if (!wt) throw new Error("issue session has no worktree");
  try {
    emit(record, "started", `Follow-up on ${cfg.owner}/${cfg.repo}#${issue.number}.`);

    // Bring the branch up to date with the base before the agent starts its
    // follow-up turn, so it isn't working (and eventually pushing/opening a PR)
    // against an increasingly stale diff. On a conflict, hand resolution to the
    // agent as its own turn first.
    await fetchOrigin(wt.path);
    const base = await resolveDefaultBaseRef(wt.path);
    const merge = await mergeBaseIntoBranch(cfg, wt.path, base);
    if (merge.status === "conflicts") {
      emit(record, "resolving_conflicts", `Merge conflicts with ${base} in ${merge.conflicts.length} file(s); asking the agent to resolve them.`, { files: merge.conflicts });
      await runSessionTurn(record, buildConflictPrompt(base, merge.conflicts));
      const resolved = await completeMerge(wt.path, merge.conflicts);
      if (resolved) {
        emit(record, "conflicts_resolved", `Resolved merge conflicts with ${base}.`);
      } else {
        // The agent couldn't fully resolve it — back out the merge and carry on
        // with the branch as it was; the follow-up turn (and the agent's own
        // git/PR work) proceeds regardless.
        await abortMerge(wt.path);
        emit(record, "conflicts_unresolved", `Could not automatically resolve conflicts with ${base}; continuing without merging it in.`);
      }
    }

    await runSessionTurn(record, buildFollowUpPrompt(issue));
    emit(record, "agent_done", `Agent handled the follow-up on issue #${issue.number}; running deterministic checks.`);
    await reportIssueOutcome(cfg, issue, record, emit, { followUp: true, onEvidence: overrides.onEvidence });
  } catch (error) {
    emit(record, "failed", `GitHub issue #${issue.number} follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Shared tail for both the first run and follow-ups. Unlike the old
 * `finalizeIssueWork`, this does NOT commit, merge, push, or open/update a pull
 * request on the agent's behalf — the prompt (`buildTaskPrompt`/
 * `buildFollowUpPrompt`) now asks the agent to do all of that itself, so the
 * result reflects the agent's own judgment about scope, title, and description.
 * This just observes the outcome and keeps the UI + issue thread honest:
 *  - a light commit safety net for edits the agent forgot to stage (the same
 *    fallback the manual `/pr` chat command already uses),
 *  - publish the branch if the agent didn't push it itself, and adopt a PR it
 *    opened itself (`maybePushWorktreeBranch`/`maybeDetectPullRequest` — the
 *    same after-turn hooks a regular repo session gets; see `repoSessionParts`),
 *  - a status comment either way, so the issue reflects what happened without
 *    Bivy having written or opened anything.
 */
async function reportIssueOutcome(
  cfg: GitHubTaskConfig,
  issue: GitHubIssue,
  record: SessionRecord,
  emit: IssueEmit,
  opts: { followUp: boolean; onEvidence?: RunIssueOverrides["onEvidence"] },
) {
  const wt = record.worktree;
  if (!wt) throw new Error("issue session has no worktree");

  // Customer success is not `agent_end`. Run the repository's declared standard
  // checks under local time/output bounds and report only privacy-safe metadata
  // (name/hash/status/exit), never command text or output, to the control plane.
  const checks = runRequiredAutomationChecks(wt.path);
  if (checks.length > 0) {
    const failed = checks.filter((check) => check.status === "failed");
    await opts.onEvidence?.({
      checks,
      events: [{
        at: new Date().toISOString(),
        kind: "completed",
        summary: failed.length ? `${failed.length} deterministic check(s) failed.` : `${checks.length} deterministic check(s) passed.`,
        status: failed.length ? "failed" : "passed",
      }],
    });
    if (failed.length) {
      emit(record, "checks_failed", `${failed.map((check) => check.name).join(", ")} failed; the run needs review.`);
      throw new Error(`Required checks failed: ${failed.map((check) => check.name).join(", ")}`);
    }
  }

  const commitMessage = opts.followUp ? `Follow-up on #${issue.number}` : `${issue.title} (#${issue.number})`;
  await commitAll(wt.path, commitMessage);

  await fetchOrigin(wt.path);
  const base = await resolveDefaultBaseRef(wt.path);
  const ahead = gitAheadCount(base, wt.path) > 0;

  await maybePushWorktreeBranch(record);
  await maybeDetectPullRequest(record);

  if (record.prUrl) {
    emit(record, "pr_opened", `Pull request ready for issue #${issue.number}.`, { prUrl: record.prUrl });
    await commentIssue(cfg, issue.number, `🤖 ${record.prUrl}`).catch(() => {});
    // Clean up the claim label now that the PR itself is the live "in progress"
    // signal on the issue (linked in the timeline + the comment above) — keeping
    // `bivy:in-progress` around after a PR exists is stale and, per the issue's
    // acceptance criteria, label state should stay consistent through the
    // pickup → in-progress → PR lifecycle rather than accumulate.
    await removeLabel(cfg, issue.number, cfg.claimLabel).catch(() => {});
    return;
  }

  if (!ahead) {
    const message = opts.followUp
      ? "Bivy handled the follow-up but produced no file changes."
      : "Bivy ran on this issue but produced no file changes.";
    emit(record, "no_changes", message);
    await commentIssue(cfg, issue.number, message).catch(() => {});
    // The run is finished with nothing in progress — drop the claim label so it
    // doesn't linger on the issue. A stale `bivy/<node>:in-progress` label was
    // also mis-routing follow-up mentions before pickRoutingLabel was hardened;
    // clearing it keeps issue label state consistent across the pickup lifecycle.
    await removeLabel(cfg, issue.number, cfg.claimLabel).catch(() => {});
    return;
  }

  emit(record, "pushed", `Pushed ${wt.branch} for issue #${issue.number}; no pull request yet.`);
  await commentIssue(
    cfg,
    issue.number,
    `🤖 Pushed \`${wt.branch}\` but didn't open a pull request. Comment \`@bivy\` again to continue, or open one from the session's chat (\`/pr\`).`,
  ).catch(() => {});
}

/** The live open session for an issue (by source tag), if we still have one. */
function findIssueSession(source: string): SessionRecord | undefined {
  for (const record of new Set(openSessions.values())) {
    if (record.source === source) return record;
  }
  return undefined;
}

/** Prompt for a follow-up @-mention on an issue already in progress. */
function buildFollowUpPrompt(issue: GitHubIssue): string {
  return [
    `Follow-up on GitHub issue #${issue.number}${issue.title ? `: ${issue.title}` : ""}. New request:`,
    "",
    issue.body?.trim() || "(no additional detail provided)",
    "",
    issue.url ? `Issue: ${issue.url}\n` : "",
    "Address this on the branch you're already on, in the same repository. Keep it focused and consistent with the existing code, and keep the project building/passing — run the tests, linter, and type-checker and fix anything they turn up.",
    "",
    "When you're done, commit and push your changes yourself. If this branch already has an open pull request, update its title/description if it's gone stale (e.g. with `gh pr edit`) rather than opening a new one; otherwise open one, referencing this issue.",
  ].join("\n");
}

/** A stable session title for an issue pickup: the issue title + its number. */
function issueSessionTitle(issue: GitHubIssue): string {
  const title = issue.title?.trim();
  return title ? `${title} (#${issue.number})` : `Issue #${issue.number}`;
}

/** The prompt that asks the working agent to resolve merge conflicts in place. */
function buildConflictPrompt(base: string, conflicts: string[]): string {
  return [
    `Merging the base branch (\`${base}\`) into your work produced merge conflicts in these files:`,
    conflicts.map((f) => `- ${f}`).join("\n"),
    "",
    "Resolve every conflict directly in the working tree. Edit each file so the result is correct and keeps both your change and the incoming changes from the base where appropriate, and remove ALL conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Keep the project building/passing.",
    "",
    "Do NOT run git commands, stage, commit, or push — just edit the files to a clean, conflict-free state. The merge will be committed for you.",
  ].join("\n");
}

/**
 * Run one agent turn on a session and resolve when it finishes (agent_end).
 * Mirrors how the issue pickup awaited a turn inline; factored out so both the
 * implementation turn and the conflict-resolution turn share it.
 */
async function runSessionTurn(record: SessionRecord, prompt: string): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    const off = record.session.subscribe((event) => {
      if (event.type === "agent_end") {
        off();
        resolve();
      }
    });
  });
  await promptWithWatchdog(record, prompt);
  await finished;
}

/** Set + persist + broadcast a session's display name (used by issue pickup). */
function setSessionName(record: SessionRecord, name: string): void {
  const clean = name.trim();
  if (!clean) return;
  record.session.setName(clean);
  record.namedFromFirstPrompt = true; // don't let the first-prompt namer overwrite it
  persistSessionMetadata(record);
  broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: clean, branch: record.worktree?.branch });
  scheduleAdvertise();
}

async function anthropicHeadersFromNodeCredential(): Promise<Record<string, string> | undefined> {
  const cred = await createCredentialStore(credsDir).getCredential("anthropic");
  const envOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const envApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const token = cred?.token || envApiKey || envOAuth;
  if (!token) return undefined;

  const oauth = cred ? cred.kind === "oauth" : !envApiKey && Boolean(envOAuth);
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (oauth) {
    // Claude Pro/Max subscription tokens need the Anthropic OAuth beta header;
    // x-api-key only works for API keys. This env fallback matters for cloned
    // SDK sessions where the token is ambient rather than written to auth.json.
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

/**
 * On startup, resume any GitHub-issue session a previous process death (crash,
 * OOM-kill, unclean restart) interrupted mid-flight — see issue #125 ("Agent
 * should resume its task automatically after a session restart"). Before this,
 * the node would only finish *reporting* on whatever was already on disk
 * (commit → publish → detect), never actually re-drive the agent: if the
 * process died while the agent still had work left (tests to run, files left
 * to touch, nothing committed yet), the task just sat there until a human
 * noticed and nudged it with a new message. `reportIssueOutcome`'s
 * commit-safety-net → publish → detect sequence lives entirely in the
 * in-memory promise chain started by `runIssueTaskInner`/`runIssueFollowUp` —
 * if the process dies before that chain finishes, nothing durable records
 * "this was in progress", and nothing retries it: the only re-entry point,
 * `runIssueFollowUp`, needs a *new* webhook event on the issue, not just a
 * restart, and a plain chat message to the resumed session doesn't go through
 * the issue-automation path at all.
 *
 * This scans persisted session metadata for issue-sourced sessions whose
 * worktree is still on disk, still has unclaimed work (uncommitted changes, or
 * commits already ahead of base with no open PR yet), and isn't already being
 * driven live this run. Any such session was, by construction, cut off by the
 * node process dying rather than by the agent finishing or a human stopping
 * it, so it resumes the session, gives the agent one more turn
 * (`buildResumePrompt`) to pick up where it left off and finish the task, then
 * runs `reportIssueOutcome` exactly as a fresh pickup or follow-up would.
 * Serialized per-issue through `withIssueLock` so this can't race a webhook
 * that re-triggers the same issue while startup reconciliation is still
 * running. Best-effort: any session/config it can't cleanly resolve is skipped
 * and logged, never thrown, so one bad row can't block the rest or crash
 * startup.
 */
async function reconcileOrphanedIssueWork(): Promise<void> {
  const sourceRe = /^issue:([^/]+)\/([^#]+)#(\d+)$/;
  for (const meta of metadata.listSessions()) {
    const m = meta.source ? sourceRe.exec(meta.source) : null;
    if (!m || !meta.worktree || !meta.branch) continue;
    if (openSessions.has(meta.id)) continue; // already being driven live this run
    const wtPath = path.resolve(meta.worktree);
    if (!fs.existsSync(wtPath)) continue; // worktree pruned/gone — nothing left to recover
    const [, owner, repo, numStr] = m;
    const issueNumber = Number(numStr);
    const source = `issue:${owner}/${repo}#${issueNumber}`;
    try {
      const token = await resolveTokenForRepo(owner, repo);
      if (!token) continue; // no token yet — try again next boot

      // Anything worth finishing? Uncommitted edits, or commits already ahead of
      // base with no open PR yet. Skip quietly otherwise (e.g. a session that
      // never got past its very first prompt before the crash). Fetch first so
      // "ahead of base" is judged against the real current base, not whatever
      // this worktree's `origin/*` refs happened to hold at boot.
      await fetchOrigin(wtPath);
      const dirty = (runGit(["status", "--porcelain"], wtPath) ?? "").trim();
      const base = await resolveDefaultBaseRef(wtPath);
      const ahead = gitAheadCount(base, wtPath) > 0;
      if (!dirty && !ahead) continue;

      const cfg: GitHubTaskConfig = { token, owner, repo, repoDir: wtPath, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
      const existingPr = await findOpenPullRequestForBranch(cfg, meta.branch);
      if (existingPr) continue; // a later run (or the agent itself) already opened one

      const issue = await getIssue(cfg, issueNumber);
      if (!issue) continue; // issue gone/inaccessible — leave it for a human to sort out

      console.log(`[github-tasks] resuming orphaned issue automation for #${issueNumber} (session ${meta.id}) after an interrupted run`);
      await withIssueLock(source, async () => {
        const record = await resolveOrResumeSession(meta.id, meta.path);
        if (!record?.worktree) return;
        record.githubIssueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
        const branch = meta.branch!;
        const emit: IssueEmit = (rec, stage, message, extra = {}) => {
          broadcast({ type: "session.github_issue_status", sessionId: rec.id, issueNumber, repo: `${owner}/${repo}`, branch, stage, message, ...extra });
        };
        emit(record, "resumed", `Resuming issue #${issueNumber} after a restart interrupted the previous run.`);
        await runSessionTurn(record, buildResumePrompt(issue));
        emit(record, "agent_done", `Agent resumed and finished issue #${issueNumber}; checking for changes.`);
        await reportIssueOutcome(cfg, issue, record, emit, { followUp: false });
      });
    } catch (error) {
      console.warn(`[github-tasks] could not recover issue #${issueNumber} automation for session ${meta.id}`, error);
    }
  }
}

/**
 * On startup, recover any *interactive* session whose turn was cut off mid-flight
 * by a process death (crash, OOM-kill, unclean restart). `resetStaleWorking()`
 * captured their ids at boot — a persisted "working" status can only be stale in a
 * fresh process, and a turn the user stopped or that finished cleanly went through
 * clearSessionWorking → "idle", so this set is exactly the genuinely-interrupted
 * turns. Issue-sourced sessions are handled by reconcileOrphanedIssueWork (which
 * also commits/pushes/reports), so they're skipped here.
 *
 * Behaviour follows the node's `sessionResumeMode`:
 *   - "auto"   → re-drive the interrupted turn now with a generic resume prompt,
 *                so the agent finishes what it was doing without a human nudge.
 *   - "manual" → leave a durable `resumePending` marker so opening the session
 *                offers a one-tap "Resume" instead of silently spending tokens.
 *
 * Best-effort and non-blocking: any session it can't resolve is skipped and
 * logged, never thrown, so one bad row can't block the rest or crash startup.
 */
async function reconcileInterruptedSessions(): Promise<void> {
  if (!interruptedSessionIds.length) return;
  const mode = nodeSessionResumeMode();
  for (const id of interruptedSessionIds) {
    const meta = metadata.getSession(id);
    if (!meta) continue;
    // Issue automation resumes via reconcileOrphanedIssueWork (always auto).
    if (meta.source && meta.source.startsWith("issue:")) continue;
    if (openSessions.has(id)) continue; // already live this run (a client opened it during boot)
    if (mode === "manual") {
      metadata.setResumePending(id, true);
      continue;
    }
    try {
      console.log(`[resume] auto-resuming interactive session ${id} interrupted by a restart`);
      const record = await resolveOrResumeSession(id, meta.path);
      if (!record) continue; // transcript gone / unresolvable — nothing to resume
      await runSessionTurn(record, buildInteractiveResumePrompt());
    } catch (error) {
      // Clear any marker so a persistently-failing session can't loop forever.
      metadata.setResumePending(id, false);
      console.warn(`[resume] could not auto-resume session ${id}`, error);
    }
  }
}

async function startGitHubTasksIfConfigured() {
  const cfg = await resolveGitHubTaskConfig();
  if (!cfg) return;
  githubPoller = new GitHubTaskPoller(cfg, (issue) => runIssueTask(cfg, issue), nodeGithubMaxConcurrent);
  githubPoller.start();
}

let controlPlanePoller: ControlPlaneTaskPoller | undefined;

/** Refresh a running queue poller's labels after the node is renamed. */
function refreshControlPlaneTaskLabels(): void {
  if (!controlPlanePoller) return;
  const cfg = resolveControlPlaneTaskConfig(loadRelayConfig(appDir), process.env, identity.name);
  if (cfg) controlPlanePoller.setLabels(cfg.labels);
}

/**
 * Run one hosted work-queue item (E2 GitHub webhook / E4 Slack). GitHub-issue
 * items reuse the full issue→worktree→PR flow (`runIssueTask`) against a fresh
 * clone of the item's repo, using the node's own token. Other items (Slack, no
 * repo) start a background session in the default workspace with the prompt.
 */
// Lazily-built GitHub App state. A node can serve several apps — a private app
// can only be installed on the account that owns it, so covering a personal
// account plus one or more orgs takes one app each. `githubApps === undefined`
// means "not looked up yet"; an empty array means no app is configured and the
// PAT path applies.
//
// The owner/repo→installation map is cached (a repo's installation is stable);
// a `null` value means "looked up, no configured app is installed there".
type LoadedGitHubApp = { cfg: GitHubAppConfig; record: GitHubAppRecord; cache: InstallationTokenCache };
let githubApps: LoadedGitHubApp[] | undefined;
const installationIdByRepo = new Map<string, { appId: string; installationId: string } | null>();

/** Resolve (once) the GitHub Apps configured on this node. */
async function ensureGitHubApps(): Promise<LoadedGitHubApp[]> {
  if (githubApps === undefined) {
    const configs = await loadGitHubAppConfigs(appDir);
    githubApps = configs.map((c) => ({
      cfg: { appId: c.appId, privateKeyPem: c.privateKeyPem },
      record: c.record,
      cache: new InstallationTokenCache(c.appId, c.privateKeyPem),
    }));
  }
  return githubApps;
}

/** Forget cached app state so a newly connected app is picked up without a restart. */
function invalidateGitHubApps(): void {
  githubApps = undefined;
  installationIdByRepo.clear();
}

/**
 * The node-side token seam. A GitHub App work item (carries an installationId,
 * and an app is configured here) mints a short-lived installation token so
 * replies post as `<app>[bot]`; anything else uses the device-flow PAT. This is
 * where future sources (Slack bot token, Linear/Notion OAuth) branch in.
 */
// Hosted (control-plane-orchestrated) machines carry neither a static GitHub
// token nor an app key. When BIVY_HOSTED_MINT is set they mint a fresh,
// short-lived token from the control plane per git op — cached until ~5 min
// before expiry so a burst of git ops is a single round trip. This is the final
// fallback rung after local apps and BIVY_GITHUB_TOKEN.
let hostedMintCache: { token: string; expiresAt: number } | undefined;
async function hostedMintToken(): Promise<string | undefined> {
  if (!process.env.BIVY_HOSTED_MINT || !sessionAdvertiseTarget) return undefined;
  const now = Date.now();
  if (hostedMintCache && hostedMintCache.expiresAt - now > 5 * 60 * 1000) return hostedMintCache.token;
  try {
    const res = await fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}/node/hosted-git-credential`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: string };
    if (!data.token) return undefined;
    const parsed = data.expiresAt ? Date.parse(data.expiresAt) : NaN;
    hostedMintCache = { token: data.token, expiresAt: Number.isFinite(parsed) ? parsed : now + 55 * 60 * 1000 };
    return data.token;
  } catch {
    return undefined;
  }
}

async function resolveTokenForWorkItem(item: ControlPlaneWorkItem): Promise<string | undefined> {
  if (item.installationId) {
    const apps = await ensureGitHubApps();
    // The control plane tells us which app the webhook arrived on (each inbound
    // hook belongs to exactly one app). Older control planes don't, so fall back
    // to trying each app: minting with the wrong key just fails, and the right
    // one is usually first.
    const candidates = item.appId ? apps.filter((a) => a.cfg.appId === item.appId) : apps;
    for (const app of candidates.length ? candidates : apps) {
      try {
        return await app.cache.get(item.installationId);
      } catch {
        // wrong app for this installation, or a transient mint failure — try the next
      }
    }
  }
  return (await resolveGitHubToken()) ?? (await hostedMintToken());
}

/**
 * The token for interactive repo operations (clone/fetch/push/PR) on `owner/repo`.
 * When a GitHub App is configured AND installed on the repo, prefer a short-lived,
 * repo-scoped installation token (`ghs_`, ~1h) over the user's long-lived PAT —
 * far smaller blast radius, and it pairs with the credential helper so nothing
 * long-lived is ever handed to a workspace. Node-driven commits/PRs then post as
 * `<app>[bot]`. Falls back to the user PAT when no app is configured, the app
 * isn't installed on the repo, or the mint fails. (Do NOT use this for user-scoped
 * endpoints like `/user/repos` — an installation token can't call those.)
 */
async function resolveTokenForRepo(owner: string, repo: string): Promise<string | undefined> {
  const apps = await ensureGitHubApps();
  if (apps.length) {
    const key = `${owner}/${repo}`;
    let hit = installationIdByRepo.get(key);
    if (hit === undefined) {
      hit = null;
      // An app owned by the same account as the repo is almost always the right
      // one, so try it first: the common case stays a single API call rather
      // than one per configured app.
      for (const app of orderAppsForOwner(apps, owner)) {
        const installationId = await resolveInstallationId({
          appId: app.cfg.appId,
          privateKeyPem: app.cfg.privateKeyPem,
          owner,
          repo,
        }).catch(() => undefined);
        if (installationId) {
          hit = { appId: app.cfg.appId, installationId };
          break;
        }
      }
      installationIdByRepo.set(key, hit);
    }
    if (hit) {
      const app = apps.find((a) => a.cfg.appId === hit.appId);
      if (app) {
        try {
          return await app.cache.get(hit.installationId);
        } catch {
          // mint failed (revoked install, transient API error) — fall back to PAT
        }
      }
    }
  }
  return (await resolveGitHubToken()) ?? (await hostedMintToken());
}

/** The session source a Linear-issue pickup advertises, keyed by the issue's
 *  provider-native id so the control plane can correlate a re-dispatch to it
 *  (findSessionByExternalId → "linear:<externalId>"). The Linear analogue of the
 *  GitHub `issue:owner/repo#N` source. */
function linearSessionSource(externalId: string): string {
  return `linear:${externalId}`;
}

/**
 * Case B for a queued follow-up the control plane correlated to an existing
 * session (`targetKind === "existing_session"`): if that session is still live on
 * this node, continue it as a normal chat — run `prompt` as a follow-up turn and
 * re-publish its branch/PR — so a channel reply lands in the same thread. The
 * provider-agnostic analogue of the GitHub issue follow-up (`runIssueFollowUp`);
 * used by both the Linear and the generic (Slack) pickup paths. When the session
 * isn't live here (its machine was torn down), best-effort restore its snapshot so
 * the caller's fresh pickup continues its branch/transcript instead of cold-
 * starting, and return false so the caller falls through. Returns true only when
 * it fully handled the item.
 */
async function continueCorrelatedSession(
  item: ControlPlaneWorkItem,
  prompt: string,
  report: (patch: EvidencePatch) => Promise<void>,
): Promise<boolean> {
  if (item.targetKind !== "existing_session" || !item.targetSessionId) return false;
  const record = openSessions.get(item.targetSessionId);
  if (!record) {
    await restoreSessionFromSnapshot(item.targetSessionId).catch((e) =>
      console.warn(`[case-b] snapshot restore for ${item.targetSessionId} failed:`, (e as Error).message),
    );
    return false;
  }
  const branch = record.worktree?.branch;
  await runSessionTurn(record, prompt);
  if (record.worktree) {
    await maybePushWorktreeBranch(record);
    await maybeDetectPullRequest(record);
  }
  await report({
    output: { sessionId: record.id, branch, prUrl: record.prUrl },
    events: record.prUrl
      ? [{ at: new Date().toISOString(), kind: "pull_request", summary: "Pull request updated.", ref: branch, url: record.prUrl }]
      : undefined,
  });
  return true;
}

async function runWorkItem(item: ControlPlaneWorkItem, report: (patch: EvidencePatch) => Promise<void>) {
  if ((item.source === "schedule" || item.source === "manual") && item.body?.startsWith("bivy-room-v1:")) {
    const [, nodeId, ...payload] = item.body.split(":");
    if (nodeId !== identity.nodeId || payload.length === 0) {
      throw new Error("scheduled instructions were encrypted for a different node");
    }
    try {
      item = { ...item, body: open(pairingStore.roomKey(), payload.join(":")) };
    } catch {
      throw new Error("could not decrypt scheduled instructions on this node");
    }
  }
  // A labelled issue ("github:issue") and an @-mention comment ("github:comment")
  // both run the same way: clone, work on a branch, open a PR, comment back. For
  // a comment the instruction is the comment body (bivy-agent:/bivy-model:
  // directives in it are honoured by buildTaskPrompt/parseBivyDirectives
  // downstream). Issue #153: the control plane no longer retains issue/comment
  // title or body at all (see the webhook handlers in
  // services/control-plane/src/index.ts) — this node fetches the live content
  // directly from GitHub with its own token, immediately before use.
  if ((item.source === "github:issue" || item.source === "github:comment") && item.repo && item.issueNumber) {
    const parsed = parseRepo(item.repo);
    if (!parsed) throw new Error(`work item ${item.id} has an invalid repo "${item.repo}"`);
    const token = await resolveTokenForWorkItem(item);
    if (!token) throw new Error("no GitHub token available to run a queued issue");
    const repoDir = await cloneOrUpdateRepo({ owner: parsed.owner, repo: parsed.repo, token, root: reposRoot });
    const cfg: GitHubTaskConfig = {
      token,
      owner: parsed.owner,
      repo: parsed.repo,
      repoDir,
      label: item.label,
      claimLabel: `${item.label}:in-progress`,
      pollMs: 60_000,
    };
    const issue = await getIssue(cfg, item.issueNumber);
    if (!issue) throw new Error(`GitHub issue #${item.issueNumber} is unavailable`);
    if (item.source === "github:comment") {
      const instruction = await getIssueCommentBody(cfg, item.url);
      if (!instruction) throw new Error("the triggering GitHub comment is unavailable");
      issue.body = instruction;
      if (item.url) issue.url = item.url;
    }
    // Case B: the control plane asked us to CONTINUE an existing session for this
    // issue (an inbound comment/issue on a thread that already has one). If that
    // session isn't live on this node — e.g. its ephemeral machine was torn down —
    // best-effort restore its snapshot first so its transcript + branch state are
    // rebuilt and the work continues the thread instead of starting cold. On
    // failure we fall through to the normal idempotent, remote-branch-adopting
    // pickup, so this can only help, never break.
    const issueSource = `issue:${parsed.owner}/${parsed.repo}#${item.issueNumber}`;
    if (item.targetKind === "existing_session" && item.targetSessionId && !findIssueSession(issueSource)) {
      await restoreSessionFromSnapshot(item.targetSessionId).catch((e) => {
        console.warn(`[case-b] snapshot restore for ${item.targetSessionId} failed:`, (e as Error).message);
      });
    }
    await runIssueTask(cfg, issue, { runtimeId: item.runtimeId, model: item.model, onEvidence: report });
    return;
  }
  if (item.source === "linear:issue" && item.externalId) {
    const apiKey = process.env.BIVY_LINEAR_API_KEY?.trim();
    const repoSlug = item.repo || process.env.BIVY_LINEAR_REPO?.trim();
    if (!apiKey) throw new Error("no Linear API key available (set BIVY_LINEAR_API_KEY)");
    if (!repoSlug) throw new Error("no repository mapped for Linear work (set BIVY_LINEAR_REPO or add a repo:owner/name label)");
    const issue = await getLinearIssue(apiKey, item.externalId);
    if (!issue) throw new Error(`Linear issue ${item.externalId} is unavailable`);
    const parsed = parseRepo(repoSlug);
    if (!parsed) throw new Error(`Linear work item has an invalid repo "${repoSlug}"`);
    // Case B: a re-dispatch the control plane correlated to an existing session
    // continues it as a normal chat instead of starting cold (mirrors GitHub).
    if (await continueCorrelatedSession(item, buildLinearTaskPrompt(issue), report)) return;
    const githubToken = await resolveGitHubToken();
    if (!githubToken) throw new Error("no GitHub token available to clone the Linear issue repository");
    const repoDir = await cloneOrUpdateRepo({ owner: parsed.owner, repo: parsed.repo, token: githubToken, root: reposRoot });
    await fetchOrigin(repoDir);
    const base = await resolveDefaultBaseRef(repoDir);
    const branch = linearBranchName(issue.identifier);
    const record = await createSession(repoDir, undefined, {
      worktree: { branch, base },
      makeActive: false,
      source: linearSessionSource(item.externalId),
      runtimeId: item.runtimeId || nodeConfiguredDefaultAgent(),
      sandbox: normalizeSandboxTier(item.sandbox),
      approvalMode: approvalModeFrom(item.approvalMode),
    });
    setSessionName(record, `${issue.identifier}: ${issue.title}`);
    if (item.model) { try { await record.session.setModel("", item.model); } catch {} }
    await report({ output: { sessionId: record.id, branch }, events: [{ at: new Date().toISOString(), kind: "branch", summary: "Linear issue working branch and session created.", ref: branch, url: issue.url }] });
    await runSessionTurn(record, buildLinearTaskPrompt(issue));
    await maybePushWorktreeBranch(record);
    await maybeDetectPullRequest(record);
    await report({ output: { sessionId: record.id, branch, prUrl: record.prUrl }, events: record.prUrl ? [{ at: new Date().toISOString(), kind: "pull_request", summary: "Pull request opened.", ref: branch, url: record.prUrl }] : undefined });
    return;
  }
  // Slack can target a GitHub repository (`/bivy in owner/repo ...`). Give that
  // request the same isolated worktree and repo credentials as an interactive
  // repo session; without a repo it still runs safely in the configured default
  // workspace (and gains worktree isolation when that workspace is a checkout).
  const parsedRepo = item.repo ? parseRepo(item.repo) : undefined;
  if (item.repo && !parsedRepo) throw new Error(`work item ${item.id} has an invalid repo "${item.repo}"`);
  const request = item.body ? `${item.title}\n\n${item.body}` : item.title;
  // Case B (provider-agnostic): a follow-up the control plane correlated to an
  // existing session continues it as a normal chat. Reached by Slack the moment a
  // reply carries a thread identity the control plane can correlate; a one-shot
  // slash command has none, so it simply falls through to a fresh session.
  if (await continueCorrelatedSession(item, request, report)) return;
  const sessionOpts = {
    makeActive: false,
    title: item.title,
    runtimeId: item.runtimeId,
    sandbox: normalizeSandboxTier(item.sandbox),
  };
  const record = parsedRepo
    ? await createRepoSession(parsedRepo, sessionOpts)
    : await createWorkspaceSession(defaultWorkspace, sessionOpts);
  // Preserve queue provenance for non-repo work. Repo-backed sessions retain
  // `repo:owner/repo`, which is required by branch push/PR detection.
  if (!parsedRepo && !record.worktree) record.source = `queue:${item.source}`;
  record.approvalMode = approvalModeFrom(item.approvalMode);
  if (item.model) {
    try { await record.session.setModel("", item.model); } catch {}
  }
  const prompt = parsedRepo || record.worktree
    ? [
        request,
        "",
        "Work carefully in this repository and implement the request completely. Run the relevant tests, linter, and type-checker.",
        "When finished, commit and push your changes, then open a pull request with a clear title and description. If you cannot open it, leave the changes committed on this branch.",
      ].join("\n")
    : request;
  await runSessionTurn(record, prompt);
  if (record.worktree) {
    await maybePushWorktreeBranch(record);
    await maybeDetectPullRequest(record);
  }
  await report({
    output: {
      sessionId: record.id,
      branch: record.worktree?.branch,
      prUrl: record.prUrl,
    },
    events: record.prUrl ? [{
      at: new Date().toISOString(),
      kind: "pull_request",
      summary: "Pull request opened.",
      ref: record.worktree?.branch,
      url: record.prUrl,
    }] : undefined,
  });
}

function startControlPlaneTasksIfConfigured() {
  // Backfill this node's GitHub App slug/name with the control plane. Apps
  // connected before slug-registration existed (or where it failed) have no
  // mention handle, so `@`-mentions fall back to the generic default and get
  // dropped. Re-registering on every boot self-heals them. Fire-and-forget.
  void registerGithubAppMeta();
  // Report how many repos/orgs the app is installed on, so the UI can warn when
  // it's installed on nothing (the app is inert until installed somewhere).
  // Re-run on every boot/connect so a later install is reflected.
  void reportGithubAppInstallations();
  if (controlPlanePoller) return;
  // Pass the node's own name so it auto-serves `bivy/<name>` — matching the label
  // the control plane routes to for a default node / `bivy/<node>` / `on <node>`,
  // with no manual BIVY_NODE_LABEL needed.
  const cfg = resolveControlPlaneTaskConfig(loadRelayConfig(appDir), process.env, identity.name);
  if (!cfg) return;
  // Policy-driven run orchestration: classify a failed queue attempt into a
  // stable condition and decide retry / reroute / park instead of the historical
  // "any throw → failed". The default ruleset is safe (retry transient/rate-
  // limit, park quota/auth/context); user-authored rulesets can add fallback
  // chains. Queue runs are unattended, so they act automatically within bounds.
  controlPlanePoller = new ControlPlaneTaskPoller(cfg, runWorkItem, nodeGithubMaxConcurrent, {
    policy: queueRunPolicy,
  });
  controlPlanePoller.start();
}

const githubAppMetaRegistered = new Set<string>();

/**
 * Tell the control plane each app's slug (its unique `@`-mention handle) and
 * name, so mentions route correctly and the UI can show what's connected.
 *
 * Per app: a node may serve several, and each has its own inbound hook. The
 * slug is fetched from `GET /app`, which needs only an RS256 app JWT.
 */
async function registerGithubAppMeta(): Promise<void> {
  const relay = loadRelayConfig(appDir);
  if (!relay?.controlPlaneUrl || !relay?.enrollmentToken) return;
  const apps = await ensureGitHubApps();
  const slugs: string[] = [];
  for (const app of apps) {
    if (githubAppMetaRegistered.has(app.cfg.appId)) {
      if (app.record.slug) slugs.push(app.record.slug);
      continue;
    }
    try {
      const jwt = createAppJwt(app.cfg.appId, app.cfg.privateKeyPem, Math.floor(Date.now() / 1000));
      const appRes = await fetch("https://api.github.com/app", {
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
      });
      if (!appRes.ok) continue;
      const data = (await appRes.json().catch(() => ({}))) as {
        slug?: string;
        name?: string;
        owner?: { login?: string; type?: string };
      };
      const slug = String(data.slug ?? "");
      if (!slug) continue;
      const res = await fetch(`${relay.controlPlaneUrl.replace(/\/$/, "")}/node/github-app/meta`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.enrollmentToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          mention: slug,
          name: String(data.name ?? slug),
          appId: app.cfg.appId,
          owner: data.owner?.login,
          ownerType: data.owner?.type,
        }),
      });
      if (!res.ok) continue;
      githubAppMetaRegistered.add(app.cfg.appId);
      slugs.push(slug);
      // Remember the owner so repo→installation lookups can try the right app
      // first, and so the UI can say which account each app covers.
      app.record.slug = slug;
      app.record.name = String(data.name ?? slug);
      app.record.owner = data.owner?.login ?? app.record.owner;
      app.record.ownerType = data.owner?.type === "Organization" ? "Organization" : "User";
      if (listGitHubApps(appDir).some((a) => a.appId === app.cfg.appId)) {
        upsertGitHubApp(appDir, app.record);
      }
    } catch {
      // best effort — retried on the next boot / reconnect
    }
  }
  // Kept for the single-app env path and for anything still reading the slug.
  if (slugs.length) process.env.BIVY_GITHUB_APP_SLUG = slugs[0];
}

/**
 * Tell the control plane how many repos/orgs each of this node's GitHub Apps is
 * installed on. Only the node can know — it holds the app keys and queries
 * `/app/installations` (RS256 JWT, no installation token needed). The control
 * plane serves the total back via `/account/github-app` so the connected UI can
 * warn when an app is installed on nothing (it receives no events until it is).
 * Best-effort and re-run on each boot/connect, so installing a repo after setup
 * is picked up without a manual step.
 */
async function reportGithubAppInstallations(): Promise<void> {
  const relay = loadRelayConfig(appDir);
  if (!relay?.controlPlaneUrl || !relay?.enrollmentToken) return;
  const apps = await ensureGitHubApps();
  if (!apps.length) return;
  let total = 0;
  for (const app of apps) {
    try {
      const jwt = createAppJwt(app.cfg.appId, app.cfg.privateKeyPem, Math.floor(Date.now() / 1000));
      const res = await fetch("https://api.github.com/app/installations?per_page=100", {
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
      });
      if (!res.ok) continue;
      const list = await res.json().catch(() => []);
      total += Array.isArray(list) ? list.length : 0;
    } catch {
      // best effort — one unreachable app must not hide the others' counts
    }
  }
  await fetch(`${relay.controlPlaneUrl.replace(/\/$/, "")}/node/github-app/installations`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.enrollmentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ count: total }),
  }).catch(() => {});
}

function publicCommands() {
  return commands.map(({ name, description, kind }) => ({ name, description, kind }));
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000 });
  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout ?? "").trim();
}

function gitStatus(workspace: string) {
  if (!fs.existsSync(workspace)) return null;
  if (!runGit(["rev-parse", "--is-inside-work-tree"], workspace)) return null;
  const root = runGit(["rev-parse", "--show-toplevel"], workspace) || workspace;
  const branch = runGit(["branch", "--show-current"], workspace)
    || runGit(["rev-parse", "--short", "HEAD"], workspace)
    || "HEAD";
  const porcelain = runGit(["status", "--porcelain"], workspace) ?? "";
  const changes = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  return {
    root,
    branch,
    clean: changes === 0,
    changes,
    status: changes === 0 ? "clean" : `${changes} change${changes === 1 ? "" : "s"}`,
  };
}

function findCommand(name: string) {
  return commands.find((command) => command.name === name);
}

function stripAnsi(text: string) {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nativeLoginCommand() {
  return `cd ${shellQuote(repoRoot)} && BIVY_WORKSPACE=${shellQuote(active?.workspace ?? defaultWorkspace)} npm run bivy -- login`;
}

async function refreshSessionAfterAuth() {
  void createSession(active?.workspace ?? defaultWorkspace).catch((error) => {
    broadcast({ type: "session.error", sessionId: active?.id, error: String(error?.stack ?? error) });
  });
}

/**
 * The "Models & providers" list. `base` is the node's per-provider auth status
 * (stored key vs ambient env vs OAuth), read from the shared vault via the model
 * catalog Bivy borrows from Pi's registry — this is model metadata + vault status,
 * not an agent privilege. `catalog` is the symmetric aggregation across every
 * installed runtime's `listCatalog()` — Pi included as one contributor among
 * equals — so each provider shows which agents can run it and its models.
 */
async function listProvidersUnified() {
  const [base, catalog] = await Promise.all([
    listProviders(credsDir, piDir),
    aggregateModelCatalog(catalogRuntimes(credsDir, piDir, sessionsDir), credsDir).catch(() => []),
  ]);
  return mergeProviderCatalog(base, catalog);
}

function chooseHeadlessOAuthOption(prompt: any) {
  const options = Array.isArray(prompt?.options) ? prompt.options : [];
  // Remote/PWA sign-in runs on the node, so never choose a local-browser
  // callback flow when the provider offers a pollable device-code/headless flow.
  return (
    options.find((option: any) => /device|headless/i.test(`${option?.id ?? ""} ${option?.label ?? ""}`))?.id
    ?? options[0]?.id
  );
}

async function startOAuthLogin(provider: string) {
  if (!isNativeOAuthProvider(provider)) {
    throw new Error(`Provider ${provider} does not support browser/subscription login`);
  }

  // OpenAI's browser flow redirects to http://localhost:1455. Listen on IPv6
  // wildcard so browsers resolving localhost to ::1 can reach the callback.
  process.env.PI_OAUTH_CALLBACK_HOST ||= "::";

  // Opportunistically drop stale/abandoned logins whenever a new one starts, so a
  // long-lived node doesn't accumulate them between sweeps (and tests can drive it).
  sweepOauthLogins();
  const id = randomUUID();
  const abort = new AbortController();
  const state: OAuthLoginState = { id, provider, status: "starting", abort, createdAt: Date.now(), progress: [] };
  const manualCodePromise = new Promise<string>((resolve) => { state.manualCodeResolve = resolve; });
  oauthLogins.set(id, state);

  let releaseInitial: (() => void) | undefined;
  const initial = new Promise<void>((resolve) => { releaseInitial = resolve; });
  const settleInitial = () => { releaseInitial?.(); releaseInitial = undefined; };

  const notify = (event: AuthEvent) => {
    switch (event.type) {
      case "auth_url":
        state.status = "waiting";
        state.authUrl = event.url;
        state.instructions = event.instructions;
        settleInitial();
        break;
      case "device_code":
        state.status = "waiting";
        state.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds };
        settleInitial();
        break;
      case "info":
      case "progress":
        state.progress?.push(event.message);
        broadcast({ type: "auth.oauth.progress", id, provider, message: event.message });
        break;
    }
  };

  const prompt = async (input: AuthPrompt): Promise<string> => {
    // A provider that needs a pasted redirect URL/code: park until a remote
    // device supplies it (provider.oauth.code) — this replaces the old
    // usesCallbackServer detection.
    if (input.type === "manual_code") {
      state.status = "waiting";
      state.usesCallbackServer = true;
      settleInitial();
      return manualCodePromise;
    }
    // A headless device-code/browser option is auto-selected on the node.
    if (input.type === "select") return chooseHeadlessOAuthOption(input) ?? "";
    // Free-text/secret steps can't be answered from a remote device.
    throw new Error(`${input.message} Use terminal login for this provider step.`);
  };

  loginModelOAuth(credsDir, provider, { signal: abort.signal, notify, prompt })
    .then(() => {
      state.status = "done";
      settleInitial();
      broadcast({ type: "auth.oauth.done", id, provider });
      // OAuth completion happens asynchronously after the start request, so
      // there is no command response carrying the newly configured provider
      // list. Push a fresh list to every connected client; otherwise Settings
      // clears the login form but continues rendering its stale "Not connected"
      // snapshot until a reload or a later manual refresh.
      void listProvidersUnified()
        .then((providers) => broadcast({ type: "providers.list", providers }))
        .catch(() => {});
      void pushModelAuthToControlPlane();
      void refreshSessionAfterAuth();
    })
    .catch((error: unknown) => {
      if (abort.signal.aborted) return;
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      settleInitial();
      broadcast({ type: "auth.oauth.error", id, provider, error: state.error });
    });

  await Promise.race([initial, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (state.status === "starting") throw new Error("Login did not produce an authorization URL yet. Use terminal login instead.");
  return state;
}

function runNativeCommand(command: MeshCommand) {
  if (!command.spawn) throw new Error(`Command ${command.name} is not executable`);

  const runId = `cmd-${Date.now()}`;
  broadcast({ type: "command.started", runId, command: command.name });

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: piDir,
    BIVY_WORKSPACE: active?.workspace ?? defaultWorkspace,
    TERM: "xterm-256color",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  // Native commands (login/model/config/etc.) need a TTY for prompts and the
  // terminal UI. Everything else uses ordinary pipes: this avoids an extra
  // Python process and PTY relay for non-interactive commands while preserving
  // the old behavior for commands that genuinely require terminal semantics.
  const launch = commandLaunch(command.spawn.command, command.spawn.args, command.spawn.requiresTty, pythonCommand, ptyRunnerScript);
  const child = spawn(launch.command, launch.args, { cwd: repoRoot, env });

  commandProcesses.set(runId, child);
  child.stdout.on("data", (data) => {
    broadcast({ type: "command.output", runId, command: command.name, stream: "stdout", text: stripAnsi(String(data)) });
  });
  child.stderr.on("data", (data) => {
    broadcast({ type: "command.output", runId, command: command.name, stream: "stderr", text: stripAnsi(String(data)) });
  });
  child.on("error", (error) => {
    commandProcesses.delete(runId);
    broadcast({ type: "command.error", runId, command: command.name, error: String(error?.stack ?? error) });
  });
  child.on("exit", (code, signal) => {
    commandProcesses.delete(runId);
    broadcast({ type: "command.exited", runId, command: command.name, code, signal });
  });

  return { ok: true, runId };
}

const guardianInterceptorImpl: ToolInterceptor = async ({ sessionId, toolName, input, signal }) => {
  // AskUserQuestion is a Bivy-owned interaction, not a governed side effect: any
  // agent that emits it (pi's stealth toolset mirrors Claude Code; the Claude SDK
  // has it natively) is intercepted here and answered via Bivy's own question
  // card, uniformly, with zero per-runtime code. Runs before policy — a
  // clarifying question never needs an approval. A malformed shape degrades to
  // "let the tool run un-intercepted" (return nothing) rather than a broken card.
  if (isAskUserQuestionTool(toolName)) {
    const questions = validQuestions((input as { questions?: unknown } | undefined)?.questions);
    if (!questions) return;
    const answer = await questionManager.request({ sessionId, questions, signal });
    return { handled: true, result: formatQuestionResult(questions, answer) };
  }

  const record = openSessions.get(sessionId);
  const workspace = record?.workspace ?? active?.workspace ?? defaultWorkspace;
  const repo = record?.source?.startsWith("repo:") ? record.source.slice("repo:".length) : undefined;
  const branch = record?.worktree?.branch;
  const policy = new PolicyEngine({
    // A session created from a scheduled/manual automation may carry its own
    // approval-mode default (item.approvalMode in runWorkItem); otherwise fall
    // back to the node's globally configured mode.
    mode: record?.approvalMode ?? approvalMode,
    isRiskyIntegration: (tool) => integrations.isRiskyTool(tool),
    // Full access is an explicit opt-out from both the agent's native sandbox
    // and Bivy's tool governance. Without this, Pi/Claude still surfaced Bivy
    // approval cards even though the session was labelled unrestricted.
    unrestricted: record?.sandbox === "danger-full-access",
  });
  let { decision, reason, risk } = policy.decideToolCall(workspace, toolName, input);

  // A paused session forces every non-catastrophic action to ask, regardless
  // of approval mode — the "Pause" card action, distinct from Kill (abort).
  // Resume lifts this back to normal policy.
  if (record?.paused && decision === "allow") {
    decision = "ask";
    reason = "Session paused — approval required until resumed";
  }

  if (decision === "allow") return;
  if (decision === "deny") {
    broadcast({ type: "tool.blocked", sessionId, toolName, reason, risk });
    return { block: true, reason: reason ?? `Blocked ${toolName}` };
  }

  const approved = await approvals.request({
    sessionId,
    toolName,
    toolInput: input,
    reason: reason ?? `Approval required for ${toolName}`,
    risk,
    workspace,
    repo,
    branch,
  });

  if (!approved) {
    return { block: true, reason: `User rejected ${toolName}` };
  }
};

// Fail-closed wrapper around the guardian. The interceptor IS the security
// boundary (policy + approvals + questions), so if any of it throws — a bug in
// rule evaluation, a rejected approval promise, an aborted signal — the tool
// must be BLOCKED, never allowed to fall through to the SDK's default outcome.
const guardianInterceptor: ToolInterceptor = async (params) => {
  try {
    return await guardianInterceptorImpl(params);
  } catch (error) {
    broadcast({ type: "tool.blocked", sessionId: params.sessionId, toolName: params.toolName, reason: "internal approval error" });
    if (process.env.BIVY_DEBUG) console.error("guardianInterceptor error:", error);
    return { block: true, reason: "internal approval error" };
  }
};

// Universal Agent Harness — MCP effect boundary (daemon side).
//
// The `bivy mcp-proxy` subprocess in front of each agent's MCP servers calls
// these two endpoints. `decide` runs the MCP tool call through the SAME guardian
// as native tools (policy + rules + interactive ApprovalCard), so MCP tools are
// governed identically for every agent. The tool is namespaced `mcp:<server>:
// <tool>` so rules/risk apply distinctly. `event` records inventory + results
// and broadcasts them for the UI.
async function governMcpCall(sessionId: string, server: string, tool: string, args: unknown): Promise<{ allow: boolean; reason?: string }> {
  const toolName = `mcp:${server}:${tool}`;
  const decision = await guardianInterceptor({ sessionId, toolName, input: args });
  if (decision && decision.block) return { allow: false, reason: decision.reason };
  return { allow: true };
}

/** In-memory per-session MCP tool inventory (server → tools), for the UI. */
const mcpInventoryBySession = new Map<string, Map<string, { name: string; description?: string }[]>>();

function recordMcpEvent(sessionId: string, event: unknown): void {
  const e = (event ?? {}) as { type?: string; server?: string; tools?: unknown; tool?: string; isError?: boolean };
  if (e.type === "tools" && typeof e.server === "string" && Array.isArray(e.tools)) {
    const tools = e.tools
      .map((t) => (t && typeof t === "object" ? (t as { name?: unknown; description?: unknown }) : {}))
      .filter((t) => typeof t.name === "string")
      .map((t) => ({ name: t.name as string, description: typeof t.description === "string" ? t.description : undefined }));
    const byServer = mcpInventoryBySession.get(sessionId) ?? new Map();
    byServer.set(e.server, tools);
    mcpInventoryBySession.set(sessionId, byServer);
    broadcast({ type: "session.mcp_tools", sessionId, server: e.server, tools });
  } else if (e.type === "result") {
    broadcast({ type: "session.mcp_result", sessionId, server: e.server, isError: Boolean(e.isError) });
  }
}

// Resolve which session a request targets. Clients may pass an explicit
// `sessionId` (per-client focus / background sessions); when omitted we fall back
// to the node's last-focused `active` session for backward compatibility. This is
// the server side of "active is per-client" (DEVELOPMENT_PLAN D1).
function resolveSession(sessionId?: unknown): SessionRecord | undefined {
  const id = typeof sessionId === "string" && sessionId ? sessionId : undefined;
  // If a client explicitly names a session, never fall back to the node-global
  // active session. Parallel web/TUI clients can otherwise send a stale or
  // not-yet-known id and have their prompt/abort routed into another chat.
  return id ? openSessions.get(id) : active;
}

// Pause/resume: distinct from abort/kill. The agent process keeps running, but
// the guardian forces every subsequent tool call to ask until resumed — a soft
// "hold on" reachable from both HTTP (direct mode) and the relay (phone/browser).
function pauseSession(record: SessionRecord) {
  record.paused = true;
  broadcast({ type: "session.paused", sessionId: record.id });
  scheduleAdvertise();
}
function resumeSession(record: SessionRecord) {
  record.paused = false;
  broadcast({ type: "session.resumed", sessionId: record.id });
  scheduleAdvertise();
}

/** Deliver a client's answer to a pending `session.question` to Bivy's
 *  QuestionManager. A silent no-op if the id is stale (already answered, timed
 *  out, or aborted) — same tolerance as resolveApproval. The resolved broadcast
 *  is emitted from questionManager.onResolved, not here, so it fires exactly
 *  when the question actually settles (never for an already-discarded id). */
function answerSessionQuestion(_record: SessionRecord, requestId: string, msg: Record<string, unknown>) {
  const answers = msg.answers && typeof msg.answers === "object" ? (msg.answers as Record<string, string>) : {};
  questionManager.resolve(requestId, msg.cancelled ? { behavior: "cancelled" } : { behavior: "completed", answers });
}

/** Agent id requested by a client command (`agent` or legacy `runtimeId`); empty = default. */
function agentFrom(msg: Record<string, unknown>): string | undefined {
  const raw = String(msg.agent ?? msg.runtimeId ?? "").trim();
  return raw || undefined;
}

/** Per-session sandbox tier a client picked for a NOT-yet-created session.
 *  Undefined = use the node's default tier. */
function sandboxFrom(msg: Record<string, unknown>): SandboxTier | undefined {
  return normalizeSandboxTier(msg.sandbox);
}

/** Remote branch a client picked (the composer's branch pill) to clone/base a
 *  NOT-yet-created git-workspace session from. Undefined = branch off the
 *  repo's default branch (resolveDefaultBaseRef), same as before this existed. */
function branchFrom(msg: Record<string, unknown>): string | undefined {
  const raw = String(msg.branch ?? "").trim();
  return raw || undefined;
}

// The model a client picked in the composer for a NOT-yet-created session,
// as `{ provider, id }`. Threaded through session.new / POST /api/session so a
// brand-new session starts on the chosen model instead of the runtime default.
function modelFrom(msg: Record<string, unknown>): { provider: string; id: string } | undefined {
  const model = msg.model as { provider?: unknown; id?: unknown } | undefined;
  const provider = String(model?.provider ?? "").trim();
  const id = String(model?.id ?? "").trim();
  return id ? { provider, id } : undefined;
}

// Bind a requested model to a freshly created session before its first turn.
// Best-effort: an unknown/unavailable model surfaces as a session.error but must
// not abort session creation (the session is already usable on its default).
async function applyRequestedModel(record: SessionRecord, model: { provider: string; id: string } | undefined): Promise<void> {
  if (!model) return;
  try {
    await record.session.setModel(model.provider, model.id);
    broadcast({ type: "model.updated", sessionId: record.id, model: publicModel(record.session.getCurrentModel(), record.session.getCurrentModel()) });
  } catch (error) {
    broadcast({ type: "session.error", sessionId: record.id, error: error instanceof Error ? error.message : "Selected model is not available on this node." });
  }
}

// Serialize clone + worktree work per repo directory. Two forks (or a fork and
// a GitHub pickup) hitting the same shared clone concurrently race on
// `git worktree add`/`remove` and the `.bivy/worktrees` dir — the loser used to
// see "already exists"/"already checked out" or, worse, `createWorktree`'s
// adopt-path `rmSync` clearing a sibling's tree. A lightweight per-key async
// mutex removes the race without a filesystem lock.
const repoWorktreeLocks = new Map<string, Promise<unknown>>();
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoWorktreeLocks.get(key) ?? Promise.resolve();
  // Chain the map's tail on the PREVIOUS holder settling (never rejecting), so a
  // failing fork doesn't poison the next waiter's gate. Each caller still awaits
  // its own `run` and gets its own result/exception. Bounded by repo count.
  const gate = prev.then(() => {}, () => {});
  const run = gate.then(fn);
  repoWorktreeLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

/**
 * Best-effort push of a fork SOURCE's branch to origin before the bundle leaves
 * the node, so a cross-node fork's committed work travels via origin (the
 * destination bases its adopted worktree on `origin/<branch>` — see
 * `resolveAdoptBaseRef`). Guarded by a token + repo backing; a failure just
 * means the destination falls back to the default base and the dirty patch.
 */
async function pushForkSourceBranch(rec: SessionRecord): Promise<void> {
  const parts = repoSessionParts(rec);
  if (!parts) return;
  const { wt, parsed } = parts;
  try {
    const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
    if (!token) return;
    const cfg: GitHubTaskConfig = { token, owner: parsed.owner, repo: parsed.repo, repoDir: wt.repoRoot, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
    await pushBranch(cfg, wt.path, wt.branch);
    rec.branchPushed = true;
  } catch {
    // offline / no rights / protected branch — committed work may not reach a
    // cross-node destination, but the fork still proceeds from the best base.
  }
}

/** Options controlling how a fork bundle is stood up (docs/session-fork-plan.md). */
interface StandUpForkOptions {
  bundle: ForkBundle;
  /** Runtime to materialise into (may differ from the source for a cross-runtime fork). */
  targetRuntimeId: string;
  /** Model to bind before the first turn; falls back to the node default. */
  model?: { provider: string; id: string };
  /** Full transcript URL, woven into a seeded (cross-runtime) continuation prompt. */
  transcriptUrl?: string;
  /**
   * Worktree strategy for a repo-backed source:
   *   - "adopt" — check out the source's branch (cross-node import; the source
   *     lives on a different node, so there's no local branch collision).
   *   - "fresh" — cut a NEW `<branch>-fork-<hex>` branch from the source branch
   *     (same-node fork; git forbids two worktrees on one branch and the source
   *     still holds it).
   */
  worktree: "adopt" | "fresh";
  /**
   * Run full prerequisite detection (a missing target agent is a hard blocker;
   * a missing model login / unreachable repo are surfaced as non-blocking
   * `missing[]`). Skipped for a same-node local fork, where the agent and repo
   * are self-evidently present. See fork-prereqs.ts.
   */
  detectPrereqs: boolean;
  /** cwd/workspace to use when the source is NOT repo-backed (no worktree). */
  fallback?: { workspace: string; cwd: string };
}

type StandUpForkOutcome =
  | { ok: false; error: string; missing: ForkPrereq[] }
  | { ok: true; record: SessionRecord; plan: ForkPlan; missing: ForkPrereq[] };

/**
 * Stand a forked session up on THIS node from a `ForkBundle`: credential-move,
 * (optional) prerequisite detection, repo/worktree reconstruction, transcript
 * materialisation, and session creation. Shared by the cross-node
 * `session.fork.import` and the same-node `session.fork.local` paths — the only
 * differences between them are captured in `StandUpForkOptions`. Pure of `relay`:
 * it returns an outcome the handler turns into an event.
 */
async function standUpFork(opts: StandUpForkOptions): Promise<StandUpForkOutcome> {
  const { bundle, targetRuntimeId } = opts;
  const fallback = opts.fallback ?? { workspace: defaultWorkspace, cwd: defaultWorkspace };
  // Carry the source's sandbox tier so a sandboxed session forks into a
  // sandboxed one, rather than defaulting to this node's tier (fork.ts).
  const forkSandbox = normalizeSandboxTier(bundle.record.sandbox);

  // Credential-move: if the chosen model's provider isn't logged in on this node,
  // pull the account model-auth vault (a login done on another node carries over),
  // then re-check. Best-effort — a local-only node just skips it.
  const modelProvider = opts.model?.provider;
  const providerConfigured = async () =>
    modelProvider ? Boolean(await createCredentialStore(credsDir).getCredential(modelProvider).catch(() => undefined)) : undefined;
  let modelConfigured = await providerConfigured();
  if (modelProvider && modelConfigured === false) {
    await syncModelAuthFromControlPlane().catch(() => {});
    modelConfigured = await providerConfigured();
  }

  // Prerequisite detection. A missing AGENT is a hard blocker — stop before any
  // clone/worktree work. Skipped for a same-node local fork. Read the agent's
  // availability + display name from the runtime REGISTRY (which never throws)
  // rather than resolving the runtime up front: `getRuntime` throws for a
  // known-but-not-installed agent, which — called eagerly — surfaced a raw
  // "not available" string with an empty `missing[]` instead of this friendly
  // install checklist. An unknown id (no registry entry) is treated as
  // unavailable so it, too, degrades to the checklist rather than a getRuntime throw.
  const agentInfo = listRuntimes().find((r) => r.id === targetRuntimeId);
  const agentAvailable = agentInfo ? (agentInfo as { status?: string }).status === "available" : false;
  const agentDisplayName = agentInfo?.displayName ?? targetRuntimeId;
  const prereqInput: ForkPrereqInput = {
    agent: { id: targetRuntimeId, displayName: agentDisplayName, available: agentAvailable },
    ...(modelProvider ? { model: { provider: modelProvider, configured: Boolean(modelConfigured) } } : {}),
  };
  if (opts.detectPrereqs) {
    const early = evaluateForkPrereqs(prereqInput);
    if (blockingForkPrereqs(early).length > 0) {
      return { ok: false, error: `${agentDisplayName} is not installed on the destination node.`, missing: missingForkPrereqs(early) };
    }
  }

  // Safe now: the agent is available (or this is a same-node local fork whose
  // agent is self-evidently present). The per-session sandbox tier bakes into
  // the runtime's launch flags.
  const targetRuntime = getRuntime(targetRuntimeId, forkSandbox);

  // Reconstruct repo + worktree when the source was repo-backed.
  let workspace = fallback.workspace;
  let cwd = fallback.cwd;
  let repoReachable: boolean | undefined;
  let worktree: Worktree | undefined;
  let dirtyWarning: string | undefined;
  const parsed = bundle.record.repoSlug ? parseRepo(bundle.record.repoSlug) : undefined;
  if (parsed) {
    const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
    repoReachable = Boolean(token);
    const repoDir = await cloneOrUpdateRepo({ owner: parsed.owner, repo: parsed.repo, token, root: reposRoot });
    const srcBranch = bundle.record.branch;
    // Serialize clone-adjacent worktree ops on this repo so concurrent forks /
    // pickups don't race on `git worktree add` or clobber each other's trees.
    const wt = await withRepoLock(repoDir, async () => {
      if (opts.worktree === "fresh") {
        // Same-node fork: cut a NEW branch from the source's LOCAL branch (which
        // holds its latest, possibly-unpushed commits) or the repo default.
        const forkBranch = `${srcBranch ?? "fork"}-fork-${randomBytes(4).toString("hex")}`;
        return createWorktree({ repoDir, id: forkBranch, branch: forkBranch, base: srcBranch ?? await resolveDefaultBaseRef(repoDir) });
      }
      // Cross-node adopt: the source branch has no LOCAL ref here. Base the
      // adopted branch on the pushed `origin/<branch>` so committed work travels
      // (was: undefined → the destination's DEFAULT branch, silently dropping
      // every commit). Give the worktree DIR a unique suffix so a same-branch
      // adopt never reuses — or, via createWorktree's stale-dir cleanup, deletes
      // — another live session's tree.
      const dirId = `${srcBranch ?? "fork"}-${randomBytes(4).toString("hex")}`;
      const base = srcBranch ? await resolveAdoptBaseRef(repoDir, srcBranch) : await resolveDefaultBaseRef(repoDir);
      return createWorktree({ repoDir, id: dirId, branch: srcBranch, base });
    });
    const applied = applyDirtyPatch(wt.path, bundle.dirtyPatch);
    if (applied.warning) dirtyWarning = applied.warning;
    workspace = repoDir;
    cwd = wt.path;
    worktree = wt;
  } else {
    // Non-repo-backed source. The fork would otherwise reuse the PARENT's cwd,
    // putting two sessions in one working tree — so when that cwd is itself a git
    // checkout (a local repo without a GitHub origin), cut the fork its own
    // worktree on a fresh branch. Best-effort: a non-git workspace has no tree to
    // isolate, so the fork keeps the fallback cwd (no git collisions possible).
    const forkRepoRoot = await gitRepoRoot(cwd);
    if (forkRepoRoot) {
      const forkBranch = `bivy/fork-${randomBytes(6).toString("hex")}`;
      const wt = await withRepoLock(forkRepoRoot, () => createWorktree({ repoDir: forkRepoRoot, id: forkBranch, branch: forkBranch }));
      const applied = applyDirtyPatch(wt.path, bundle.dirtyPatch);
      if (applied.warning) dirtyWarning = applied.warning;
      workspace = forkRepoRoot;
      cwd = wt.path;
      worktree = wt;
    }
  }

  // Materialise the transcript, then stand the session up — resume the imported
  // transcript (full) or a fresh session the caller seeds with plan.seedPrompt.
  const plan = await materializeFork({ bundle, targetRuntime, ctx: { workspace, cwd }, seed: { transcriptUrl: opts.transcriptUrl } });
  const record = plan.kind === "resume"
    ? await createSession(cwd, plan.sessionFile, { runtimeId: targetRuntimeId, source: bundle.record.source, sandbox: forkSandbox, makeActive: false })
    : await createSession(cwd, undefined, { runtimeId: targetRuntimeId, source: bundle.record.source, sandbox: forkSandbox, makeActive: false });
  // Mark the new session as a fork of its source, so the run card can show
  // "Forked from …" and the lineage survives a reload (persisted below). Just
  // the parent's session id — an identifier, not content, so it's safe to
  // carry into metadata the same way branch/prUrl already are.
  record.forkedFrom = bundle.record.sourceSessionId;
  // Attach the reconstructed worktree to the record. createSession only
  // populates record.worktree when it provisions one itself (fresh repo session)
  // or restores it from stored metadata (resume) — neither happens for a fork,
  // whose worktree we cut above. Without this, repoSessionParts() can't see the
  // fork as repo-backed, so branch-push, PR detection and /pr all silently bail
  // (a PR opened inside the fork would never light up its badge). Mirror it onto
  // the persisted metadata so the association survives a reload, too.
  if (worktree && !record.worktree) {
    record.worktree = worktree;
    broadcast({ type: "session.updated", sessionId: record.id, sessionFile: record.sessionFile, bivySession: bivySessionEnvelope(record) });
  }
  if (bundle.record.title && !record.session.getName()) record.session.setName(bundle.record.title);
  // Surface a non-fatal note when the source's uncommitted changes didn't apply
  // cleanly, so the fork isn't silently missing work-in-progress.
  if (dirtyWarning) broadcast({ type: "session.notice", sessionId: record.id, message: dirtyWarning });
  await applyRequestedModel(record, opts.model ?? nodeDefaultModel() ?? undefined);
  persistSessionMetadata(record);
  scheduleAdvertise();

  const missing = opts.detectPrereqs
    ? missingForkPrereqs(evaluateForkPrereqs({
        ...prereqInput,
        ...(parsed ? { repo: { slug: parsed.slug, reachable: Boolean(repoReachable) } } : {}),
      }))
    : [];
  return { ok: true, record, plan, missing };
}

/** Build the `session.fork.done` event both fork paths emit from a stood-up session. */
function forkDoneEvent(requestId: string | undefined, record: SessionRecord, plan: ForkPlan, missing: ForkPrereq[]) {
  return {
    ...buildHistoryEvent({
      sessionId: record.id,
      workspace: record.workspace,
      source: record.source,
      runtimeId: record.runtimeId,
      isStreaming: sessionBusy(record),
      messages: conversationMessages(record),
    }),
    type: "session.fork.done" as const,
    requestId,
    sessionId: record.id,
    fidelity: plan.fidelity,
    seedPrompt: plan.kind === "seed" ? plan.seedPrompt : undefined,
    missing,
  };
}

/**
 * Merge persisted sessions across every available, resumable agent, tagging each
 * entry with the agent that owns it so the client can resume on the right runtime.
 */
async function listAllSessions(): Promise<Array<SessionSummary & { agent: string; agentName: string }>> {
  const toMs = (value: unknown) => {
    const n = new Date(value as string | number | Date).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  const merged: Array<SessionSummary & { agent: string; agentName: string }> = [];
  for (const info of runtimeList()) {
    if (info.status !== "available" || !info.capabilities.resume) continue;
    try {
      const rt = getRuntime(info.id);
      for (const s of await runtimeHost.listSessions(rt)) merged.push({ ...s, agent: rt.id, agentName: rt.displayName });
    } catch {
      // Best effort per agent: one runtime failing to list shouldn't blank the list.
    }
  }
  // Backfill titles from the durable metadata store. A runtime's own session file
  // can lack a name/first message — e.g. a session whose first prompt errored
  // before any message was persisted — but Bivy records the deterministic name at
  // prompt time, so this keeps sessions from showing as "Untitled".
  for (const s of merged) {
    // Also backfill the activity timestamp: some adapters (Claude Code's
    // in-memory list) return no `modified`, which would sort the row last and
    // hide its age. Metadata's updatedAt is the reliable last-activity time.
    if (s.name && s.firstMessage && s.modified != null) continue;
    const meta = metadata.getSession(s.id) ?? metadata.getSession(s.path);
    if (!meta) continue;
    if (!s.name && meta.name) s.name = meta.name;
    if (!s.firstMessage && meta.firstMessage) s.firstMessage = meta.firstMessage;
    if (s.modified == null && meta.updatedAt) s.modified = meta.updatedAt;
  }
  // Union in Bivy-known sessions the runtime forgot. Some adapters only list
  // sessions they currently hold in memory (the Claude Code runtime lists from
  // disk only when BIVY_CLAUDE_SESSIONS_DIR is set — otherwise just its open
  // sessions), so a closed session, or any session after a node restart, drops
  // out of the runtime list even though its transcript persists on disk. The
  // metadata store is the durable, Bivy-scoped, deletion-aware record of every
  // session we started, so backfill any it knows that the runtime didn't return.
  // Without this, sessions started from the PWA vanish from the sidebar once
  // they're no longer live in memory.
  const seen = new Set(merged.map((s) => s.id));
  const runtimes = runtimeList();
  for (const meta of metadata.listSessions()) {
    if (!meta.id || seen.has(meta.id)) continue;
    seen.add(meta.id);
    const rt = runtimes.find((r) => r.id === meta.runtimeId);
    merged.push({
      id: meta.id,
      path: meta.path,
      cwd: meta.worktree ?? meta.workspace,
      name: meta.name,
      created: meta.createdAt,
      modified: meta.updatedAt,
      messageCount: meta.messageCount,
      firstMessage: meta.firstMessage,
      agent: meta.runtimeId ?? defaultRuntimeId,
      agentName: meta.agentName ?? rt?.displayName ?? meta.runtimeId ?? defaultRuntimeId,
    });
  }
  // Multiple adapters can expose the same durable agent conversation. Codex,
  // for example, has both the exec and approvals adapters; their local ids can
  // differ while both point at one rollout. Collapse by transcript reference
  // and let durable metadata select the owning id/runtime.
  const deduped = dedupeSessionSummaries(merged, (session) => {
    const meta = metadata.getSession(session.path) ?? metadata.getSession(session.id);
    return meta ? { id: meta.id, path: meta.path, runtimeId: meta.runtimeId } : undefined;
  });

  // Final title fallback: a session that still has no real name but does carry a
  // first user message gets the same deterministic heuristic name the chat path
  // uses (fallbackSessionName). This covers native Claude Code / Codex sessions
  // started via the shim or `bivy run` — they run as PTY terminals, never pass
  // through Bivy's chat-time namer, and their adapters surface a firstMessage but
  // no name — so without this they show as "untitled" in the sidebar, relay list
  // and `bivy sessions`. Empty sessions (no first message) are left alone and
  // filtered out below.
  for (const s of deduped) {
    if (!isPlaceholderSessionName(s.name ?? undefined, s.id)) continue;
    const derived = fallbackSessionName(String(s.firstMessage ?? "").trim());
    if (derived) s.name = derived;
  }
  deduped.sort((a, b) => toMs(b.modified) - toMs(a.modified));
  return deduped.filter((s) => !isEmptyUntitledSummary(s));
}

// --- Native session discovery/adoption (issue #156) -------------------------
// "Let a node advertise discoverable provider-native sessions and let the app
// import/adopt one into Bivy" — capability-driven, not a per-provider UI
// branch: any runtime advertising capabilities.nativeSessionDiscovery is asked
// for its own discoveries (src/runtime/native-session-discovery.ts does the
// aggregation/dedupe), and the result is bounded metadata only, never
// transcript content, so nothing here risks leaking a conversation to a UI
// that merely lists nodes/sessions.

export interface DiscoveredSessionView extends DiscoveredNativeSession {
  agentName: string;
  plan: NativeAdoptionPlan;
  /** The provider's own CLI command to attach to this session directly, when
   *  known — the "follow/read-only" affordance for a live session Bivy can't
   *  safely take over itself (plan.mode === "follow-only"). Present whenever
   *  the runtime has a known native resume form, regardless of plan.mode, so
   *  the UI can also offer it as a secondary "or continue in a terminal"
   *  option on an adoptable session. */
  resumeCommand?: string;
}

/** Every provider-native session discoverable on this node, minus ones Bivy
 *  already manages (any runtime variant, any owning id — see
 *  native-session-discovery.ts's identity-based dedupe). */
async function listDiscoverableSessions(): Promise<DiscoveredSessionView[]> {
  const managed = await listAllSessions();
  const capableRuntimes = runtimeList()
    .filter((info) => info.status === "available" && info.capabilities.nativeSessionDiscovery)
    .map((info) => getRuntime(info.id));
  const discovered = await collectDiscoveredSessions(
    capableRuntimes,
    managed.map((s) => ({ id: s.id, path: s.path })),
  );
  return discovered.map((session) => {
    const rt = getRuntime(session.runtimeId);
    return {
      ...session,
      agentName: rt.displayName,
      plan: planNativeAdoption(session, rt.capabilities),
      resumeCommand: NATIVE_RESUME_CLI_BY_RUNTIME[session.runtimeId]?.(session.ref),
    };
  });
}

type ImportNativeSessionResult =
  | { ok: true; record: SessionRecord; plan: NativeAdoptionPlan; seedPrompt?: string }
  | { ok: false; status: number; error: string; needsDisclosure?: boolean; disclosure?: string };

/**
 * Import a discovered provider-native session into Bivy. Re-validates the ref
 * against a fresh discovery pass (rather than trusting the caller's cached
 * list) so a stale/removed session, or one with a live external process,
 * can't be imported out from under the safety checks — see planNativeAdoption:
 *
 *  - "native-resume": creates/binds the Bivy session via the ordinary resume
 *    path (createSession → runtime.openSession) — never a rewrite or deletion
 *    of the provider's own history.
 *  - "seeded": native resume isn't available. Requires `opts.acceptDisclosure`
 *    — the caller must have shown `plan.disclosure` to the user first (issue
 *    #156: "fall back to a seeded continuation only with explicit user
 *    disclosure"); without it this returns `needsDisclosure: true` instead of
 *    importing, so a client can never silently fall through to a seeded
 *    continuation. When accepted, a FRESH session is created (no resume ref)
 *    and its first-turn seed prompt (a bounded summary of the discovered
 *    session's recent turns, never the full transcript) is returned for the
 *    caller to send — mirroring how a cross-runtime session fork seeds its
 *    first turn client-side (session/fork.ts's ForkSeed).
 *  - "follow-only": a live external process was detected; refused outright.
 */
async function importNativeSession(
  runtimeId: string,
  ref: string,
  opts: { acceptDisclosure?: boolean } = {},
): Promise<ImportNativeSessionResult> {
  const rt = getRuntime(runtimeId);
  if (!rt.capabilities.nativeSessionDiscovery || !rt.capabilities.nativeSessionAdoption) {
    return { ok: false, status: 409, error: `${rt.displayName} does not support importing existing sessions.` };
  }
  const discovered = await runtimeHost.discoverNativeSessions(rt);
  const match = discovered.find((s) => s.ref === ref);
  if (!match) {
    return { ok: false, status: 404, error: "That session is no longer discoverable — it may already be imported, or removed." };
  }
  const plan = planNativeAdoption(match, rt.capabilities);
  if (plan.mode === "follow-only") {
    return { ok: false, status: 409, error: plan.disclosure ?? "This session has a live process outside Bivy; close it before adopting." };
  }
  if (plan.mode === "seeded") {
    if (!opts.acceptDisclosure) {
      return {
        ok: false,
        status: 409,
        needsDisclosure: true,
        disclosure: plan.disclosure,
        error: plan.disclosure ?? "This session can't be natively resumed; importing starts a seeded continuation instead.",
      };
    }
    const normalized = normalizeMessages(runtimeHost.readMessages(rt, ref), {
      sourceRuntimeId: rt.id,
      title: match.title,
      createdAt: new Date().toISOString(),
    });
    const seedPrompt = buildNativeImportSeedPrompt(normalized, { provider: rt.displayName, title: match.title, cwd: match.cwd });
    const record = await createSession(match.cwd || defaultWorkspace, undefined, { runtimeId, source: "import-seeded" });
    return { ok: true, record, plan, seedPrompt };
  }
  const record = await createSession(match.cwd || defaultWorkspace, ref, { runtimeId, source: "import" });
  return { ok: true, record, plan };
}

function isEmptyUntitledTitle(value: unknown): boolean {
  const title = String(value ?? "").trim();
  return !title || /^untitled session$/i.test(title);
}

function isEmptyUntitledSummary(s: Pick<SessionSummary, "name" | "firstMessage" | "messageCount">): boolean {
  return isEmptyUntitledTitle(s.name) && !String(s.firstMessage ?? "").trim() && Number(s.messageCount ?? 0) <= 0;
}

function isEmptyUntitledRecord(record: SessionRecord): boolean {
  return isEmptyUntitledTitle(record.session.getName()) && conversationMessages(record).length === 0;
}

function rememberSession(record: SessionRecord) {
  openSessions.set(record.id, record);
  if (record.sessionFile) openSessions.set(path.resolve(record.sessionFile), record);
  persistSessionMetadata(record);
  recordSessionLocation(record);
  enforceOpenSessionCap(record.id);
}

// Keep the number of live (in-memory) sessions bounded. Idle-close already
// trims over time, but a burst of opens within the idle window could pile up
// runtime subprocesses/RAM. When over the cap, evict the least-recently-touched
// idle session (never one that is busy or awaiting approval); closing only
// detaches + persists it, so it transparently reopens on next use.
function enforceOpenSessionCap(keepId?: string) {
  if (!Number.isFinite(maxOpenSessions) || maxOpenSessions <= 0) return;
  // openSessions is keyed by both id and file path, so dedupe to real records.
  let records = [...new Set(openSessions.values())];
  while (records.length > maxOpenSessions) {
    const victim = records
      .filter((r) => r.id !== keepId && !sessionBusy(r) && !sessionHasPendingApproval(r))
      .sort((a, b) => (a.lastTouchedAt ?? 0) - (b.lastTouchedAt ?? 0))[0];
    if (!victim) break; // everything else is busy/pending — don't evict live work
    evictSessionRecord(victim, "session-cap");
    records = [...new Set(openSessions.values())];
  }
}

function sessionBusy(record: SessionRecord) {
  return Boolean(record.isWorking || record.session.isStreaming);
}

function sessionStatus(record: SessionRecord): BivySessionStatus {
  if (sessionHasPendingApproval(record)) return "needs_attention";
  return sessionBusy(record) ? "working" : "idle";
}

function isoFrom(value: unknown, fallback = Date.now()): string {
  const ms = new Date(value as string | number | Date).getTime();
  return new Date(Number.isFinite(ms) ? ms : fallback).toISOString();
}

function parseGitHubSource(source?: string): { repoSlug?: string; issueNumber?: number; issueUrl?: string } {
  if (!source) return {};
  if (source.startsWith("repo:")) {
    return { repoSlug: source.slice(5) };
  }
  const m = source.match(/^issue:([^#]+)#(\d+)$/);
  if (m) {
    return { repoSlug: m[1], issueNumber: Number(m[2]) };
  }
  // legacy
  if (source.startsWith("issue:#")) {
    return { issueNumber: Number(source.slice(7)) };
  }
  return {};
}

function workspaceContextFor(record: SessionRecord) {
  const gh = parseGitHubSource(record.source);
  const repoSlug = gh.repoSlug;
  return {
    workspace: record.workspace,
    cwd: record.session.cwd || record.workspace,
    ...(record.worktree ? { worktree: record.worktree.path, branch: record.worktree.branch } : {}),
    ...(repoSlug ? { repoSlug } : {}),
  };
}

function bivySessionEnvelope(record: SessionRecord): BivySessionRecord {
  const now = Date.now();
  const touched = record.lastTouchedAt ?? record.workingStartedAt ?? now;
  const rt = getRuntime(record.runtimeId);
  const gh = parseGitHubSource(record.source);
  const issueUrl = gh.issueNumber && gh.repoSlug ? `https://github.com/${gh.repoSlug}/issues/${gh.issueNumber}` : undefined;
  return {
    id: record.id,
    runtimeId: rt.id,
    runtimeSessionRef: record.sessionFile,
    workspace: record.workspace,
    worktree: record.worktree?.path,
    branch: record.worktree?.branch,
    workspaceContext: workspaceContextFor(record),
    titleLocal: record.session.getName(),
    source: record.source ?? "manual",
    status: sessionStatus(record),
    createdAt: isoFrom(record.sessionFile ? undefined : touched, touched),
    updatedAt: isoFrom(touched, now),
    lastActivityAt: isoFrom(record.workingStartedAt ?? touched, now),
    capabilities: rt.capabilities,
    sandbox: record.sandbox,
    repoSlug: gh.repoSlug,
    issueNumber: gh.issueNumber,
    issueUrl: issueUrl || record.githubIssueUrl,
    prUrl: record.prUrl,
    githubIssueUrl: record.githubIssueUrl || issueUrl,
  };
}

function runtimeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") return String((part as Record<string, unknown>).text);
    return "";
  }).filter(Boolean).join("\n");
}

function persistSessionMetadata(record: SessionRecord, status = sessionStatus(record)) {
  // A throwaway session (model-picker scratch) that never received a real prompt
  // must not leave a metadata row behind. Skip persisting it while it's still an
  // empty shell; the moment it gains a name or a message it persists normally.
  if (record.ephemeral && isEmptyUntitledRecord(record)) return;
  const messages = record.session.getMessages();
  // Some agents inject synthetic leading "user" turns (e.g. Codex's
  // <environment_context> / <recommended_plugins> blocks). Skip those so the
  // session label is the user's real first prompt, not injected boilerplate.
  const userMessages = messages.filter((m) => m.role === "user");
  const firstUser =
    userMessages.find((m) => !/^<[a-z][\w-]*>/i.test(runtimeContentText(m.content).trimStart())) ??
    userMessages[0];
  metadata.upsertSession({
    id: record.id,
    path: record.sessionFile,
    name: record.session.getName(),
    workspace: record.workspace,
    source: record.source ?? "manual",
    forkedFrom: record.forkedFrom,
    runtimeId: record.runtimeId,
    sandbox: record.sandbox,
    agentName: getRuntime(record.runtimeId).displayName,
    status,
    branch: record.worktree?.branch,
    worktree: record.worktree?.path,
    prUrl: record.prUrl,
    prs: record.prs,
    messageCount: messages.length,
    firstMessage: runtimeContentText(firstUser?.content),
    updatedAt: isoFrom(record.lastTouchedAt ?? Date.now()),
    lastActivityAt: isoFrom(record.workingStartedAt ?? record.lastTouchedAt ?? Date.now()),
  });
}

function bivySessionEnvelopeFromSummary(s: SessionSummary & { agent: string; agentName: string }, rec?: SessionRecord, meta?: MetadataSession): BivySessionRecord {
  if (rec) return bivySessionEnvelope(rec);
  const rt = getRuntime(meta?.runtimeId ?? s.agent);
  const fallback = Date.now();
  const modified = isoFrom(meta?.updatedAt ?? s.modified, fallback);
  const workspace = meta?.workspace ?? s.cwd ?? defaultWorkspace;
  const source = meta?.source ?? "manual";
  const gh = parseGitHubSource(source);
  const issueUrl = gh.issueNumber && gh.repoSlug ? `https://github.com/${gh.repoSlug}/issues/${gh.issueNumber}` : undefined;
  const repoSlug = gh.repoSlug;
  return {
    id: s.id,
    runtimeId: rt.id,
    runtimeSessionRef: s.path,
    workspace,
    worktree: meta?.worktree,
    branch: meta?.branch,
    workspaceContext: { workspace, cwd: meta?.worktree ?? workspace, ...(meta?.worktree ? { worktree: meta.worktree } : {}), ...(meta?.branch ? { branch: meta.branch } : {}), ...(repoSlug ? { repoSlug } : {}) },
    titleLocal: meta?.name ?? s.name,
    source,
    status: "idle",
    createdAt: isoFrom(meta?.createdAt ?? s.created, fallback),
    updatedAt: modified,
    lastActivityAt: isoFrom(meta?.lastActivityAt ?? modified, fallback),
    capabilities: rt.capabilities,
    // `rec` is undefined here (the live path returned above via bivySessionEnvelope),
    // so the tier comes from the persisted metadata row.
    sandbox: normalizeSandboxTier(meta?.sandbox),
    repoSlug,
    issueNumber: gh.issueNumber,
    issueUrl,
    prUrl: meta?.prUrl ?? (s as any).prUrl,
  };
}

function touchSession(record: SessionRecord) {
  record.lastTouchedAt = Date.now();
  metadata.touchSession(record.id, sessionStatus(record));
}

// Named for its original, narrower purpose (still true to its callers' intent
// — "does this session need a human before it can proceed") but now also
// covers a pending clarifying question: both are "needs a response" states.
// Both live in daemon-owned global registries (approvals, questionManager), so
// every caller of this one helper (idle-close's skip check, this session's own
// "needs_attention" status) automatically gets question-awareness.
function sessionHasPendingApproval(record: SessionRecord) {
  return approvals.list().some((a) => a.sessionId === record.id && a.status === "pending") || questionManager.hasPendingForSession(record.id);
}

function closeIdleSessions() {
  if (!Number.isFinite(idleCloseMs) || idleCloseMs <= 0) return;
  const now = Date.now();
  for (const record of new Set(openSessions.values())) {
    if (sessionBusy(record) || sessionHasPendingApproval(record)) continue;
    const touched = record.lastTouchedAt ?? record.workingStartedAt ?? now;
    if (now - touched >= idleCloseMs) closeSessionRecord(record, "idle-timeout");
  }
}

function isManagedWorktreePath(wtPath: string) {
  const parts = path.resolve(wtPath).split(path.sep);
  return parts.length >= 3 && parts[parts.length - 3] === ".bivy" && parts[parts.length - 2] === "worktrees";
}

function sessionTimestampMs(value?: string) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

async function cleanupOldWorktrees() {
  if (!Number.isFinite(worktreeRetentionMs) || worktreeRetentionMs <= 0) return;
  const now = Date.now();
  const openIds = new Set([...new Set(openSessions.values())].map((record) => record.id));
  for (const session of metadata.listSessions()) {
    if (!session.worktree || openIds.has(session.id) || session.status === "working") continue;
    const touched = Math.max(sessionTimestampMs(session.lastActivityAt), sessionTimestampMs(session.updatedAt), sessionTimestampMs(session.createdAt));
    if (!touched || now - touched < worktreeRetentionMs) continue;

    const wtPath = path.resolve(session.worktree);
    if (!isManagedWorktreePath(wtPath)) continue;
    if (!fs.existsSync(wtPath)) {
      metadata.markWorktreePruned(session.id);
      continue;
    }

    const status = runGit(["status", "--porcelain"], wtPath);
    if (status === undefined || status.trim()) {
      console.warn(`[worktree-cleanup] keeping ${wtPath}: ${status === undefined ? "not a valid git worktree" : "has uncommitted changes"}`);
      continue;
    }
    const repoRootForWorktree = runGit(["rev-parse", "--show-toplevel"], wtPath);
    const mainWorktree = runGit(["worktree", "list", "--porcelain"], wtPath)?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const repoRootForRemove = mainWorktree || repoRootForWorktree;
    if (!repoRootForRemove) continue;

    await removeWorktree(repoRootForRemove, wtPath);
    metadata.markWorktreePruned(session.id);
    console.log(`[worktree-cleanup] removed old clean worktree ${wtPath}`);
  }
}

const mib = (n: number) => Math.round(n / (1024 * 1024));

// Hold the shared package-manager cache (BIVY_SHARED_DEP_CACHE) under a byte cap
// by evicting least-recently-used files — the caches are content-addressed and
// re-download on demand. Default cap applies only when the shared cache is on;
// BIVY_SHARED_DEP_CACHE_MAX_BYTES overrides (0 disables eviction). Best-effort.
const DEFAULT_DEP_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB
function evictSharedDepCacheIfNeeded() {
  const root = sharedDepCacheRoot();
  if (!root) return; // shared cache disabled — nothing we own to manage
  const cap = Number(process.env.BIVY_SHARED_DEP_CACHE_MAX_BYTES ?? DEFAULT_DEP_CACHE_MAX_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) return;
  try {
    const res = evictToCap(root, cap);
    if (res.removedFiles > 0) {
      console.log(`[dep-cache] evicted ${res.removedFiles} LRU files (${mib(res.removedBytes)} MiB) to hold under ${mib(cap)} MiB (now ${mib(res.after)} MiB)`);
    }
  } catch {
    // best effort — a racing install just means we retry next sweep
  }
}

// Advisory only: surface any managed worktree over a soft size cap so the user
// can clear build output or close the session. We deliberately do NOT delete —
// an active worktree can hold uncommitted work; destructive quotas belong to the
// OS. Opt-in via BIVY_WORKTREE_SOFT_CAP_BYTES (0/unset disables the scan).
function warnOversizedWorktrees() {
  const cap = Number(process.env.BIVY_WORKTREE_SOFT_CAP_BYTES ?? 0);
  if (!Number.isFinite(cap) || cap <= 0) return;
  for (const session of metadata.listSessions()) {
    if (!session.worktree) continue;
    const wt = path.resolve(session.worktree);
    if (!isManagedWorktreePath(wt) || !fs.existsSync(wt)) continue;
    let size: number;
    try {
      size = dirSizeBytes(wt);
    } catch {
      continue;
    }
    if (size > cap) {
      console.warn(`[worktree-cap] session ${session.id} worktree ${wt} is ${mib(size)} MiB (soft cap ${mib(cap)} MiB) — consider clearing build output or closing the session`);
    }
  }
}

// One disk-guardrail sweep: reap aged worktrees, cap the shared dep cache, and
// warn on oversized worktrees.
async function sweepDiskGuardrails() {
  await cleanupOldWorktrees();
  evictSharedDepCacheIfNeeded();
  warnOversizedWorktrees();
  const attachmentRefs = referencedAttachmentHashes();
  if (attachmentRefs) attachmentGcStats = attachmentStore.gc(attachmentRefs);
  else console.warn("[attachments] skipping garbage collection because event-log references are not healthy");
  if ((attachmentGcStats.overCapBytes ?? 0) > 0) {
    console.warn(`[attachments] store remains ${attachmentGcStats.overCapBytes} bytes over cap because referenced history is retained`);
  }
}

/**
 * Prune "ghost" sessions: metadata rows for a path-based runtime (pi) whose
 * transcript file was never written — a session whose very first turn failed
 * before anything flushed to disk. pi only writes the transcript once there's
 * content, so a metadata row pointing at a non-existent file has no recoverable
 * conversation behind it; resuming it forks a brand-new empty session under a
 * different id (resolveOrResumeSession now refuses to, returning "not found"),
 * so the row is a dead end that just clutters the sidebar. Drop it and tell
 * connected clients to remove it.
 *
 * Only sweeps sessions this process isn't currently holding open — a
 * freshly-created session lives in `openSessions` and hasn't necessarily flushed
 * its file yet, so it's protected until it closes (at which point, if it really
 * never got content, it's swept). id-based runtimes (Claude Code) keep their
 * transcripts elsewhere and record the id (not a real file path) as `path`, so
 * they're skipped — statting that path would always miss and wrongly prune them.
 */
function pruneGhostSessions() {
  const openIds = new Set([...new Set(openSessions.values())].map((record) => record.id));
  for (const session of metadata.listSessions()) {
    if (!session.id || openIds.has(session.id)) continue;
    if (!session.path || !runtimeResumesByPath(session.runtimeId)) continue;
    // Only a genuine failed-first-turn ghost — one that never produced content —
    // is safe to delete. A session that was actually used (any recorded activity,
    // message, or first-message text) but whose transcript now reads as missing
    // is far more likely a path-resolution mismatch than a real ghost; deleting
    // it would silently destroy the sidebar row and make the session
    // unresumable. Keep it and let the resume path surface a soft error instead
    // of nuking the row. (Sweeping only truly-empty ghosts keeps the original
    // intent without the "all my sessions vanished" failure mode.)
    const hadActivity =
      Boolean(session.lastActivityAt) ||
      (session.messageCount ?? 0) > 0 ||
      Boolean(session.firstMessage);
    if (hadActivity) continue;
    let missing = false;
    try {
      missing = !fs.existsSync(path.resolve(session.path));
    } catch {
      continue; // unreadable path — leave it alone rather than risk a wrong delete
    }
    if (!missing) continue;
    metadata.removeSession(session.id, session.path);
    broadcast({ type: "session.deleted", sessionId: session.id, sessionFile: session.path });
    console.log(`[session-cleanup] pruned ghost session ${session.id} (no transcript at ${session.path})`);
  }
}

// Sweep persisted "empty shell" sessions: a row that was never named, never
// carried a first user message, and has no messages — i.e. opened-but-never-used
// (model-picker scratch on older builds, an abandoned session.open, a
// createSession after auth refresh, …). Unlike pruneGhostSessions this is
// runtime- and file-agnostic on purpose: id-based runtimes (Claude Code) store
// an opaque id in `path`, so the file-based ghost check never matched them and
// their empties accumulated forever. lastActivityAt is deliberately NOT part of
// the test — persisting a row on create/idle-close stamps it even when nothing
// was ever said, so it's not a reliable "was used" signal. Open and working
// sessions are always left alone (a brand-new session you're typing in is still
// open, so it can't be swept mid-compose).
function pruneEmptySessions() {
  const openIds = new Set([...new Set(openSessions.values())].map((record) => record.id));
  for (const session of metadata.listSessions()) {
    if (!session.id || openIds.has(session.id)) continue;
    if (session.status === "working") continue;
    const emptyShell =
      isEmptyUntitledTitle(session.name) &&
      !String(session.firstMessage ?? "").trim() &&
      (session.messageCount ?? 0) <= 0;
    if (!emptyShell) continue;
    metadata.removeSession(session.id, session.path);
    broadcast({ type: "session.deleted", sessionId: session.id, sessionFile: session.path });
    console.log(`[session-cleanup] pruned empty session ${session.id} (never named, no messages)`);
  }
}

/**
 * Evict a session from the local cache. A live REMOTE session the agent service
 * keeps running is DETACHED (its local handle dropped, child left alive) and its
 * location retained, so the next access re-attaches (Stage 2 — openSessions is a
 * cache). Everything else closes/reaps as before. Used for cap eviction; an
 * explicit user close still goes through closeSessionRecord (which reaps).
 */
function evictSessionRecord(record: SessionRecord, reason: string) {
  if (record.session instanceof RemoteRuntimeSession && sessionAgentServiceAddress(record)) {
    detachSessionRecord(record, reason);
  } else {
    closeSessionRecord(record, reason);
  }
}

/** Drop a remote session's local handle without reaping it (see evictSessionRecord).
 *  Mirrors closeSessionRecord's teardown but keeps the child alive on the agent
 *  service and RETAINS the sessionLocations entry for re-attach. */
function detachSessionRecord(record: SessionRecord, reason: string) {
  persistSessionMetadata(record, "idle");
  eventLog.flush(record.id);
  questionManager.cancelForSession(record.id);
  approvals.cancelForSession(record.id);
  record.unsubscribe?.();
  record.unsubscribe = undefined;
  sessionEvents.flush(record.id);
  sessionEvents.clear(record.id);
  (record.session as RemoteRuntimeSession).detach(); // keep the child alive on the service
  harness.detach(record.id);
  record.mcpRestore?.();
  openSessions.delete(record.id);
  if (record.sessionFile) openSessions.delete(path.resolve(record.sessionFile));
  if (active?.id === record.id) active = undefined;
  // NB: keep the sessionLocations entry — resolveOrResumeSession re-attaches to it.
  broadcast({ type: "session.closed", sessionId: record.id, sessionFile: record.sessionFile, reason });
  scheduleAdvertise();
}

function closeSessionRecord(record: SessionRecord, reason = "closed") {
  // A real close reaps the session everywhere, so drop its location + terminal
  // mappings too (a detach keeps them — see detachSessionRecord).
  void sessionLocations.forget(record.id).catch(() => {});
  void sessionTerminals.forget(record.id).catch(() => {});
  persistSessionMetadata(record, "idle");
  eventLog.flush(record.id);
  // Cancel any question still awaiting an answer so its card closes and the
  // guardian promise (and the tool call behind it) settles rather than hanging
  // until timeout. Belt-and-suspenders alongside the tool-call abort signal.
  questionManager.cancelForSession(record.id);
  // Same for a pending approval: deny it so its card closes and the guardian
  // promise settles instead of haunting connected clients until the 5-min timeout.
  approvals.cancelForSession(record.id);
  record.unsubscribe?.();
  record.unsubscribe = undefined;
  // Flush any pending coalesced update (so the last streamed text isn't lost),
  // then drop the session's coalescing timer/state.
  sessionEvents.flush(record.id);
  sessionEvents.clear(record.id);
  record.session.dispose();
  harness.detach(record.id);
  // Tear down this session's own egress proxy, if it started one (read-only /
  // workflow network policy). No-op for the default path.
  void stopSessionEgress(record.id);
  record.mcpRestore?.();
  openSessions.delete(record.id);
  if (record.sessionFile) openSessions.delete(path.resolve(record.sessionFile));
  if (active?.id === record.id) active = undefined;
  broadcast({ type: "session.closed", sessionId: record.id, sessionFile: record.sessionFile, reason });
  scheduleAdvertise();
}

async function deleteSessionFile(opts: { id?: string; path?: string; fallbackActive?: boolean }) {
  const requestedPath = String(opts.path || "").trim();
  const requestedId = String(opts.id || "").trim();
  const record = requestedPath ? openSessions.get(path.resolve(requestedPath)) : requestedId ? openSessions.get(requestedId) : (opts.fallbackActive ? active ?? undefined : undefined);
  const sessionFile = requestedPath || record?.sessionFile || "";
  const deletedSessionId = record?.id || requestedId;
  // Need *some* target: a live record, an id we can forget, or a file to remove.
  if (!sessionFile && !deletedSessionId) throw new Error("No session selected");

  // Which runtime owns this session's transcript store — captured before the
  // metadata row is removed below (that's where the runtimeId lives for a
  // session this process isn't currently holding open).
  const owningRuntimeId =
    record?.runtimeId ??
    (deletedSessionId ? metadata.getSession(deletedSessionId)?.runtimeId : undefined) ??
    (requestedPath ? metadata.getSession(requestedPath)?.runtimeId : undefined);

  const resolved = sessionFile ? path.resolve(sessionFile) : "";
  const root = path.resolve(sessionsDir) + path.sep;
  // Only a file under the sessions dir may be unlinked. A resumed / takeover
  // session's transcript legitimately lives in the runtime's own store (outside
  // this dir) — we must not delete that file, but we still forget the session
  // below so it leaves the list. Reject an out-of-root path only when nothing
  // authorizes it (a raw client-supplied path with no matching live session).
  const inRoot = !!resolved && resolved.startsWith(root);
  if (resolved && !inRoot && !record) throw new Error("Invalid session path");
  if (record && sessionBusy(record)) throw new Error("Session is busy; stop it before deleting.");

  if (record) closeSessionRecord(record, "delete");
  if (inRoot) {
    await fs.promises.unlink(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (deletedSessionId) {
    // Cancel any pending throttled write and forget the cached arrays so a late
    // flush can't recreate the file we're about to delete.
    eventLog.drop(deletedSessionId);
    // Remove all sidecars so deleting a session doesn't leave orphaned
    // intermediate-message / tool-activity / transcript JSON accumulating under .bivy.
    for (const sidecar of [transcriptPath(deletedSessionId), eventLogPath(deletedSessionId)]) {
      await fs.promises.unlink(sidecar).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
  metadata.removeSession(deletedSessionId, inRoot ? resolved : undefined);
  // Forget the session from its runtime's own transcript store too. Runtimes
  // like Claude Code keep transcripts outside `piDir/sessions` (so the inRoot
  // unlink above never touched them); without this the next listSessions —
  // which unions in each runtime's own on-disk store — re-surfaces the row and
  // the "deleted" session reappears in the sidebar. Best-effort: a runtime that
  // can't (or doesn't own this id) just returns false. Prefer the owning
  // runtime; fall back to every resume-capable runtime when it's unknown.
  if (deletedSessionId) {
    const hint = requestedPath || record?.sessionFile || undefined;
    const targets = owningRuntimeId
      ? [owningRuntimeId]
      : runtimeList().filter((r) => r.status === "available" && r.capabilities.resume).map((r) => r.id);
    for (const runtimeId of targets) {
      try {
        await runtimeHost.deleteSession(getRuntime(runtimeId), deletedSessionId, hint);
      } catch (error) {
        console.warn(`[session.delete] runtime ${runtimeId} could not forget ${deletedSessionId}:`, error);
      }
    }
  }
  broadcast({ type: "session.deleted", sessionId: deletedSessionId, sessionFile: inRoot ? resolved : undefined });
  scheduleAdvertise();
  return { sessionId: deletedSessionId, sessionFile: inRoot ? resolved : undefined };
}

const idleCloseTimer = setInterval(() => { closeIdleSessions(); pruneGhostSessions(); pruneEmptySessions(); evaluateEphemeralTeardown(); }, idleCloseSweepMs);
idleCloseTimer.unref?.();
const worktreeCleanupTimer = setInterval(() => void sweepDiskGuardrails(), worktreeCleanupSweepMs);
worktreeCleanupTimer.unref?.();
// In-session auto-resume tunables (see the resume helpers below). setTimeout
// can't be trusted past ~24.8 days and we don't want one timer owning a
// multi-hour wait a restart would drop, so each timer is capped and the periodic
// sweep re-arms the remainder from the persisted resumeAt.
const SESSION_RESUME_MAX_TIMER_MS = 30 * 60_000;
const SESSION_RESUME_SWEEP_MS = 60_000;
/** Slack around "due": a capped timer may fire a touch early — drive only when
 *  within this of the target, else re-arm. */
const SESSION_RESUME_TICK_MS = 15_000;
/** Hard ceiling on consecutive auto-resumes for one session before we give up and
 *  surface the limit. The reroute controller already caps per turn, but its budget
 *  is in-memory: a session re-resolved after its child exits on the limit (or a
 *  daemon restart) gets a fresh controller, so without a durable count a limit that
 *  never actually clears would re-send every MIN_RESUME_DELAY_MS indefinitely.
 *  Generous enough to ride out a mis-parsed multi-day window (each wait is ≥1 min,
 *  usually far longer), low enough to bound a genuinely stuck limit. */
const MAX_DURABLE_RESUME_ATTEMPTS = 10;
const sessionResumeTimers = new Map<string, NodeJS.Timeout>();
// Fire due auto-resumes (a usage/rate limit that has since reset) and re-arm the
// tail of long waits whose in-process timer was capped or lost to a restart.
const sessionResumeTimer = setInterval(() => sessionResumeSweep(), SESSION_RESUME_SWEEP_MS);
sessionResumeTimer.unref?.();

// --- server-side ephemeral teardown ----------------------------------------
// On a disposable machine (bootstrap set BIVY_EPHEMERAL=1) the daemon ends the
// machine ITSELF once it goes idle, so teardown no longer needs the launching
// device online. See src/ephemeral-teardown.ts + docs/ephemeral-sessions.md.
const ephemeralTeardownCfg = readEphemeralTeardownConfig();
let ephemeralEverBusy = false;
let ephemeralLastBusyAt = Date.now();

/** Best-effort "I've settled — reap me" signal to the control plane. Non-secret
 *  (node id via the enrollment bearer); lets a hosted machine whose provider
 *  can't self-reap on exit (Hetzner) be destroyed server-side. */
async function signalSettledToControlPlane(): Promise<void> {
  if (!sessionAdvertiseTarget) return;
  await fetch(`${sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "")}/node/settled`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}`, "content-type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

/** Rebuild-resume (Gap B): on a freshly re-provisioned machine booted with
 *  `BIVY_RESTORE=<sessionId>`, fetch the session's control-plane snapshot,
 *  decrypt it with this machine's room key (reused from the torn-down session so
 *  the seal matches), and apply it — restoring the transcript (EventLog) and the
 *  git checkpoint into a repo the session can open. The runtime process starts
 *  fresh/seeded from the restored transcript ("reconstructed", not byte-identical
 *  — see docs/ephemeral-sessions.md). Best-effort: a missing/undecryptable
 *  snapshot leaves a clean fresh machine. Reuses the standby-replica machinery. */
async function restoreSessionFromSnapshot(sessionId: string): Promise<void> {
  if (!sessionAdvertiseTarget) return;
  const cpBaseUrl = sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${cpBaseUrl}/node/session-snapshot/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}` },
    });
    if (!res.ok) {
      console.error(`[restore] no snapshot for ${sessionId} (${res.status})`);
      return;
    }
    const data = (await res.json()) as { ciphertext?: string };
    if (!data.ciphertext) return;
    const applied = await applySessionSnapshot(data.ciphertext, pairingStore.roomKey(), {
      persistRecords: (id, records) => eventLog.rewrite(id, records),
      applyBundle: async (id, buf) => applyCheckpointBundle(await ensureReplicaRepo(id), id, buf),
      materialize: async (id) => materializeCheckpoint(await ensureReplicaRepo(id), id),
    });
    // Register the rebuilt session so it lists and opens (mirrors the standby's
    // upsertReplicaMeta); the transcript replays from the restored EventLog.
    try {
      metadata.upsertSession({ id: sessionId, source: "restored", status: "saved" });
    } catch {
      /* best-effort listing */
    }
    console.log(`[restore] session ${sessionId}: ${applied.recordCount} records, checkpoint ${applied.checkpointCommit ?? "none"}`);
  } catch (e) {
    console.error(`[restore] session ${sessionId} failed: ${(e as Error)?.message || e}`);
  }
}

/** Flush a durable, E2E-encrypted snapshot of each open session to the control
 *  plane before this disposable machine is torn down, so a destroy-lane session
 *  can be rebuilt on a fresh machine later (Gap B). Sealed under the node room
 *  key — the same key that seals the session title — so a restore machine that
 *  reuses this session's room key can decrypt it; the control plane sees only
 *  ciphertext. Best-effort per session; never blocks teardown for long. */
async function flushSessionSnapshots(): Promise<void> {
  if (!sessionAdvertiseTarget) return;
  const roomKey = pairingStore.roomKey();
  const cpBaseUrl = sessionAdvertiseTarget.controlPlaneUrl.replace(/\/$/, "");
  for (const record of new Set(openSessions.values())) {
    try {
      const sealed = await buildSessionSnapshot(record.id, roomKey, {
        readRecords: (id) => eventLog.entries(id),
        epochOf: () => 0,
        checkpointHead: async (id) => {
          try {
            return (await harness.checkpoints(id))[0]?.id;
          } catch {
            return undefined;
          }
        },
        bundleCheckpoint: async (id, since) => createCheckpointBundle(harnessDirFor(record), id, since),
        runtimeSessionRef: (id) => openSessions.get(id)?.sessionFile,
        worktreeSync: () => true,
      });
      if (!sealed) continue;
      await fetch(`${cpBaseUrl}/node/session-snapshot/${encodeURIComponent(record.id)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${sessionAdvertiseTarget.enrollmentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ciphertext: sealed }),
      }).catch(() => {});
    } catch {
      /* best effort per session — TTL/branch push remain the backstops */
    }
  }
}

let ephemeralTearingDown = false;
/** Evaluate the quiet condition and self-terminate if the machine is done. Reads
 *  live session/queue state each call, so it's safe to invoke from the idle
 *  sweep and from agent_end. No-op on a persistent node (env absent). */
function evaluateEphemeralTeardown(): void {
  if (!ephemeralTeardownCfg.enabled || ephemeralTearingDown) return;
  const records = new Set(openSessions.values());
  const anyWorking = [...records].some((r) => r.isWorking);
  const anyRemoteActive = [...records].some((r) => r.remoteActive);
  const inFlightWork = controlPlanePoller?.inFlightCount() ?? 0;
  if (anyWorking || anyRemoteActive || inFlightWork > 0) {
    ephemeralEverBusy = true;
    ephemeralLastBusyAt = Date.now();
    return;
  }
  const idleForMs = Date.now() - ephemeralLastBusyAt;
  if (!shouldSelfTeardown(ephemeralTeardownCfg, { everBusy: ephemeralEverBusy, anyWorking, anyRemoteActive, inFlightWork, idleForMs })) return;
  ephemeralTearingDown = true;
  void (async () => {
    // Persist a rebuild snapshot BEFORE the machine goes away (Gap B), then reap.
    await flushSessionSnapshots();
    await performSelfTeardown({
      provider: ephemeralTeardownCfg.provider,
      signalSettled: signalSettledToControlPlane,
      shutdown: () => { try { spawnSync("shutdown", ["-h", "now"], { stdio: "ignore" }); } catch { /* TTL backstops */ } },
    });
  })();
}

if (ephemeralTeardownCfg.enabled) {
  // Sample often enough to honour the finish grace (~10s) without waiting for the
  // 1–5min idle sweep. Ephemeral-only, so no cost on a persistent node.
  const ephemeralEvalMs = Math.max(2_000, Math.min(ephemeralTeardownCfg.finishGraceMs, 15_000));
  const ephemeralTeardownTimer = setInterval(() => evaluateEphemeralTeardown(), ephemeralEvalMs);
  ephemeralTeardownTimer.unref?.();
  console.log(`[ephemeral-teardown] armed: provider=${ephemeralTeardownCfg.provider} onFinish=${ephemeralTeardownCfg.onFinish} ttl=${ephemeralTeardownCfg.ttlMin}m`);
}
setTimeout(() => void sweepDiskGuardrails(), 30_000).unref?.();
// One sweep shortly after boot clears ghosts left by a previous run before any
// client paints its sidebar; the idle timer keeps it clean thereafter.
setTimeout(pruneGhostSessions, 10_000).unref?.();

const turnTimeoutMs = configuredTurnTimeoutMs();
if (turnTimeoutMs > 0) console.log(`[turn-watchdog] armed: timeout=${turnTimeoutMs}ms`);
else console.warn("[turn-watchdog] disabled by BIVY_TURN_TIMEOUT_MS=0");

function turnTimeoutMessage(): string {
  return `Agent turn timed out after ${Math.round(turnTimeoutMs / 60_000)} minutes and was stopped.`;
}

function clearTurnWatchdog(record: SessionRecord): void {
  if (record.turnWatchdog) clearTimeout(record.turnWatchdog);
  record.turnWatchdog = undefined;
  record.turnTimeoutSignal = undefined;
  record.turnTimeoutResolve = undefined;
}

function armTurnWatchdog(record: SessionRecord): void {
  clearTurnWatchdog(record);
  record.turnTimedOut = false;
  if (turnTimeoutMs <= 0) return;
  record.turnTimeoutSignal = new Promise<void>((resolve) => { record.turnTimeoutResolve = resolve; });
  record.turnWatchdog = setTimeout(() => {
    record.turnWatchdog = undefined;
    record.turnTimedOut = true;
    record.lastFailureAt = Date.now();
    const message = turnTimeoutMessage();
    record.turnTimeoutResolve?.();
    record.turnTimeoutResolve = undefined;
    // Clear/persist first so the session and an ephemeral runner cannot remain
    // pinned in a false working state if the runtime's abort path fails to emit
    // agent_end. abort() is still invoked to kill the underlying process group.
    clearSessionWorking(record, "idle");
    metadata.touchSession(record.id, "failed");
    broadcast({ type: "session.outcome", sessionId: record.id, status: "timed_out", completedAt: new Date().toISOString(), error: message });
    broadcast({ type: "session.error", sessionId: record.id, error: message });
    void record.session.abort().catch((error) => {
      console.error(`[turn-watchdog] abort failed for ${record.id}:`, error);
    }).finally(() => evaluateEphemeralTeardown());
  }, turnTimeoutMs);
  record.turnWatchdog.unref?.();
}

async function promptWithWatchdog(record: SessionRecord, prompt: string, options?: ReturnType<typeof promptOptionsFor>): Promise<void> {
  armTurnWatchdog(record);
  const timeoutSignal = record.turnTimeoutSignal;
  try {
    await Promise.race([
      record.session.prompt(prompt, options),
      ...(timeoutSignal ? [timeoutSignal.then(() => { throw new Error(turnTimeoutMessage()); })] : []),
    ]);
  } catch (error) {
    // The timeout callback already cleared/persisted the session. For an ordinary
    // prompt failure, disarm here and let the caller publish its actionable error.
    if (!record.turnTimedOut) clearTurnWatchdog(record);
    throw error;
  }
}

function markSessionWorking(record: SessionRecord, activity: unknown) {
  touchSession(record);
  const wasWorking = record.isWorking;
  record.isWorking = true;
  record.lastActivity = activity;
  record.workingStartedAt ||= Date.now();
  // A new attempt resolves the prior turn's failure condition at its source.
  record.lastFailureAt = undefined;
  metadata.touchSession(record.id, "working");
  if (!wasWorking) scheduleAdvertise(); // idle → working transition
}

function clearSessionWorking(record: SessionRecord, forcedStatus?: BivySessionStatus) {
  clearTurnWatchdog(record);
  touchSession(record);
  record.isWorking = false;
  record.lastActivity = undefined;
  record.workingStartedAt = undefined;
  // A completed turn clears any pending manual-resume offer: the session has now
  // moved on (whether it was the resume itself or an unrelated new message).
  metadata.setResumePending(record.id, false);
  // A stuck runtime can keep its own isStreaming bit true forever. Recovery
  // callers explicitly force idle so that stale SDK state is not persisted as
  // a permanently-working session after Bivy has settled the turn.
  persistSessionMetadata(record, forcedStatus ?? sessionStatus(record));
  scheduleAdvertise(); // working → idle transition
}

/**
 * Best-effort cost/token/plan-quota refresh (display-only — never used for
 * enforcement). Only runtimes with capabilities.usageReporting implement
 * getUsage(); everything else is a silent no-op.
 */
async function refreshSessionUsage(record: SessionRecord) {
  try {
    const usage = await record.session.getUsage?.();
    if (!usage) return;
    record.usage = usage;
    if (typeof usage.costUsd === "number") record.costUsd = usage.costUsd;
    metadata.upsertSession({ id: record.id, costUsd: usage.costUsd, tokensTotal: usage.tokens?.total });
    broadcast({ type: "session.usage", sessionId: record.id, usage });
  } catch {
    // Usage reporting must never affect the session it's reporting on.
  }
}

// ── In-session auto-resume after a usage/rate limit ─────────────────────────
// When a turn ends because a provider window is exhausted ("you've hit your
// weekly limit · resets 12am (UTC)") and the session's ruleset says retry, we
// wait out the window and re-send the same prompt when it resets — instead of
// leaving a dead error bubble. Durable: the due time is persisted (metadata
// resumeAt) so a daemon restart re-arms it (sessionResumeSweep); an in-process
// timer fires it promptly while the daemon is up. (Tunables + timer map are
// declared up by the timer cluster so the sweep interval can reference them.)

/** The authoritative reset time for the limit a session just hit: the soonest
 *  future reset among its most-utilized usage windows (the binding one), from
 *  the last snapshot the runtime reported. Essential for a multi-day "weekly"
 *  window, whose error text states only a time-of-day. Undefined when unknown. */
function limitResetHint(record: SessionRecord, nowMs: number): string | undefined {
  const windows = record.usage?.plan?.windows ?? [];
  let best: { at: number; util: number } | undefined;
  for (const w of windows) {
    if (!w.resetsAt) continue;
    const at = Date.parse(w.resetsAt);
    if (!Number.isFinite(at) || at <= nowMs) continue;
    const util = w.utilizationPct ?? 0;
    // Prefer the most-utilized window (the one being hit); tie-break on soonest reset.
    if (!best || util > best.util || (util === best.util && at < best.at)) best = { at, util };
  }
  return best ? new Date(best.at).toISOString() : undefined;
}

/** Cancel a pending in-process resume timer (leaves the durable marker alone). */
function cancelSessionResumeTimer(id: string): void {
  const timer = sessionResumeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    sessionResumeTimers.delete(id);
  }
}

/** Clear both the durable resume marker and any armed timer — the session moved
 *  on (a new user turn, or the resume itself started). */
function clearSessionResume(id: string): void {
  cancelSessionResumeTimer(id);
  metadata.setResumeAt(id, null);
}

function armSessionResumeTimer(id: string, dueMs: number): void {
  cancelSessionResumeTimer(id);
  const delay = Math.min(Math.max(0, dueMs - Date.now()), SESSION_RESUME_MAX_TIMER_MS);
  const timer = setTimeout(() => {
    sessionResumeTimers.delete(id);
    void driveSessionResume(id);
  }, delay);
  timer.unref?.();
  sessionResumeTimers.set(id, timer);
}

/** Persist + arm an auto-resume decided by the session policy. Synchronous so the
 *  caller can atomically suppress the turn's error toast. Returns false when the
 *  session has already exhausted its durable auto-resume budget (a limit that never
 *  clears) — the caller then lets the error surface instead of looping. */
function scheduleSessionResume(record: SessionRecord, plan: ResumePlan): boolean {
  const attempts = metadata.getSession(record.id)?.resumeAttempts ?? 0;
  if (attempts >= MAX_DURABLE_RESUME_ATTEMPTS) {
    console.warn(`[resume] session ${record.id} hit the durable auto-resume cap (${MAX_DURABLE_RESUME_ATTEMPTS}) without the limit clearing — giving up`);
    clearSessionResume(record.id);
    metadata.setResumeAttempts(record.id, 0);
    return false;
  }
  metadata.setResumeAt(record.id, plan.resumeAt);
  metadata.setResumeAttempts(record.id, attempts + 1);
  const when = Date.parse(plan.resumeAt);
  const cond = plan.condition.replace(/_/g, " ");
  broadcast({
    type: "session.notice",
    sessionId: record.id,
    level: "info",
    message: `Hit a ${cond} limit — I'll resume this automatically when it resets (${plan.resumeAt}).`,
  });
  armSessionResumeTimer(record.id, Number.isFinite(when) ? when : Date.now());
  return true;
}

/** Fire a due auto-resume: re-open the session if needed and re-send the turn's
 *  last prompt. Clears the durable marker BEFORE driving so a crash mid-resume
 *  can't loop. Best-effort — never throws into a timer/sweep. */
async function driveSessionResume(id: string): Promise<void> {
  const meta = metadata.getSession(id);
  if (!meta?.resumeAt) return; // cancelled or already resumed
  const due = Date.parse(meta.resumeAt);
  if (Number.isFinite(due) && due - Date.now() > SESSION_RESUME_TICK_MS) {
    // A capped timer fired before the real due time — re-arm for the remainder.
    armSessionResumeTimer(id, due);
    return;
  }
  clearSessionResume(id);
  try {
    const live = openSessions.get(id);
    if (live?.isWorking) return; // a user turn is already running — don't pile on
    const record = live ?? (await resolveOrResumeSession(id, meta.path));
    if (!record) return; // transcript gone / unresolvable
    if (record.isWorking) return;
    // In-memory lastPrompt is the exact user turn to retry; after a restart it's
    // gone, so fall back to the generic interrupted-turn continuation nudge.
    const prompt = record.lastPrompt ?? buildInteractiveResumePrompt();
    console.log(`[resume] auto-resuming session ${id} — provider limit has reset`);
    broadcast({ type: "session.notice", sessionId: id, level: "info", message: "The limit has reset — resuming now." });
    await promptWithWatchdog(record, prompt, record.lastPromptOptions);
  } catch (error) {
    console.warn(`[resume] auto-resume after a provider limit failed for ${id}`, error);
  }
}

/** Re-arm (or immediately fire) durable auto-resume markers. Runs once at boot
 *  and on an interval, so a wait survives a restart and a capped timer's tail
 *  still fires. */
function sessionResumeSweep(): void {
  const now = Date.now();
  for (const meta of metadata.sessionsWithResumeAt()) {
    const due = Date.parse(meta.resumeAt!);
    if (!Number.isFinite(due)) {
      metadata.setResumeAt(meta.id, null);
      continue;
    }
    if (sessionResumeTimers.has(meta.id)) continue; // already armed this run
    if (due <= now + SESSION_RESUME_TICK_MS) void driveSessionResume(meta.id);
    else armSessionResumeTimer(meta.id, due);
  }
}

/**
 * Turn a raw provider/runtime error string into something a human can read.
 * Model APIs commonly return `<status> {json}` (e.g. `400 {"error":{"message":
 * "…"}}`); we pull the embedded message out so the UI shows the actionable
 * sentence rather than a wall of JSON. Anything we can't parse is returned
 * trimmed and unchanged.
 */
function humanizeAgentError(raw: string): string {
  const text = String(raw ?? "").trim();
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(text.slice(brace)) as Record<string, unknown>;
      const err = body.error as Record<string, unknown> | string | undefined;
      const msg =
        (typeof err === "object" && err && typeof err.message === "string" && err.message) ||
        (typeof body.message === "string" && body.message) ||
        (typeof err === "string" && err) ||
        "";
      if (msg && msg.trim()) return msg.trim();
    } catch {
      // Not JSON we recognize — fall through to the raw text.
    }
  }
  return text;
}

function actionableAgentError(runtimeId: string, error: unknown): string {
  const raw = humanizeAgentError(error instanceof Error ? error.message : String(error));
  const id = String(runtimeId || "").toLowerCase();
  if (isModelAuthError(raw) || /reading ['"]provider['"]|no api key found/i.test(raw)) {
    if (id.includes("claude")) return "Claude Code is not signed in. Run `claude` once, complete sign-in, then retry; the same login works from Bivy and the PWA.";
    if (id.startsWith("codex")) return "Codex is not signed in. Run `codex login`, then retry; the same login works from Bivy and the PWA.";
    if (id === "pi" || id === "aider") return "No model credential is configured. Run `bivy login`, then retry. This is only required once and compatible credentials sync E2E-encrypted to your other Bivy nodes.";
    return "The selected agent needs model authentication. Sign in through its native CLI, then retry.";
  }
  return raw;
}

/**
 * A turn that ended in a *terminal* model/provider failure the runtime would
 * otherwise swallow. `agent_end` carries the turn's messages and whether the
 * runtime will retry; a final assistant message with `stopReason: "error"` and
 * an `errorMessage` (see pi-ai's AssistantMessage) is the API-level failure that
 * left the chat looking "done" with no reply. Returns a human-readable message,
 * or undefined when the turn succeeded, was aborted by the user, or will retry.
 */
function terminalTurnError(event: Record<string, unknown>): string | undefined {
  if (event.willRetry) return undefined;
  const messages = Array.isArray(event.messages) ? (event.messages as Array<Record<string, unknown>>) : undefined;
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    // Only the *last* assistant message decides the turn's outcome.
    if (m.stopReason === "error" && typeof m.errorMessage === "string" && m.errorMessage.trim()) {
      return humanizeAgentError(m.errorMessage);
    }
    return undefined;
  }
  return undefined;
}

/**
 * When a surfaced error looks like a model auth failure (no credential, or an
 * expired/invalid one that 401'd upstream), tell the client which provider to
 * (re)authenticate so it can pop the "Sign in to your model" sheet instead of
 * leaving a bare error bubble. Fires at most once per turn (reset on turn_start)
 * so a retry storm — e.g. Codex's repeated websocket 401s — raises the sheet once.
 */
function maybeSignalAuthRequired(record: SessionRecord, errorText: string): void {
  if (record.authRequiredSignaled) return;
  if (!isModelAuthError(errorText)) return;
  const provider = authProviderForSession(record.runtimeId, record.session.getCurrentModel()?.provider);
  if (!provider) return;
  record.authRequiredSignaled = true;
  broadcast({ type: "session.auth_required", sessionId: record.id, provider, reason: errorText.slice(0, 400) });
}

function attachSessionListeners(record: SessionRecord) {
  record.unsubscribe?.();
  // In-session recovery controller — waits out a usage/rate limit and resumes
  // (planResume), or swaps models down a fallback chain (planReroute). One per
  // session; its per-turn budget resets on each user prompt. The policy reads
  // the active session ruleset lazily, so it's inert until one authorizes a
  // retry/reroute for the failing condition.
  if (!record.reroute) {
    record.reroute = new SessionRerouteController({
      policy: sessionRunPolicy,
      onNotice: (n) => broadcast({ type: "session.notice", sessionId: record.id, level: n.level, message: n.message }),
      onModelChanged: () =>
        broadcast({ type: "model.updated", sessionId: record.id, model: publicModel(record.session.getCurrentModel(), record.session.getCurrentModel()) }),
      onFailed: (message) => broadcast({ type: "session.error", sessionId: record.id, error: message }),
    });
  }
  record.unsubscribe = record.session.subscribe((event) => {
    // Keep streamed assistant text ordered ahead of everything else: any event
    // that is not itself a superseding update must flush the session's pending
    // coalesced update first, so a tool_call / message_end never overtakes the
    // text the user is watching stream in.
    if (event.type !== "message_update") sessionEvents.flush(record.id);
    if (event.type === "tool_image") {
      // A runtime adapter (e.g. Claude Code) noticed an image inside a
      // tool_result and forwarded the raw bytes — store/persist/broadcast it as
      // a chat attachment (see handlePassiveToolImage) instead of the generic
      // session.event wrap below, which would otherwise ship the raw base64
      // payload to every client.
      handlePassiveToolImage(record, event as Record<string, unknown>);
      return;
    }
    const currentSessionFile = record.session.sessionFile;
    if (currentSessionFile && currentSessionFile !== record.sessionFile) {
      record.sessionFile = currentSessionFile;
      openSessions.set(path.resolve(currentSessionFile), record);
      persistSessionMetadata(record);
      broadcast({ type: "session.updated", sessionId: record.id, sessionFile: record.sessionFile, bivySession: bivySessionEnvelope(record) });
    }
    if ([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "turn_end",
      "tool_call",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "tool_result",
    ].includes(event.type)) {
      markSessionWorking(record, event);
    }
    // A fresh turn re-arms the once-per-turn auth-required signal, so a credential
    // that was fixed (or newly broke) is re-evaluated on the next prompt.
    if (event.type === "turn_start") record.authRequiredSignaled = false;
    if (event.type === "message_update" && (event as Record<string, unknown>).message && ((event as Record<string, { role?: unknown }>).message?.role === "assistant")) {
      persistIntermediateFromEvent(record, event as Record<string, unknown>, false);
    }
    if (event.type === "message_end" && (event as Record<string, unknown>).message && ((event as Record<string, { role?: unknown }>).message?.role === "assistant")) {
      persistIntermediateFromEvent(record, event as Record<string, unknown>, true);
    }
    persistToolActivityFromEvent(record, event);
    // Snapshot the base transcript (prompts + replies) alongside the tool/thinking
    // sidecars. turn_start captures the just-added user prompt (so a crash mid-turn
    // still keeps it); message_end/turn_end capture the assistant reply.
    if (event.type === "turn_start" || event.type === "message_end" || event.type === "turn_end") {
      persistTranscriptSnapshot(record);
    }
    // A finalized assistant message may reference a remote image via markdown
    // (`![alt](https://…)`) — fetch and store it now so the chat can render it
    // (see resolveInlineImages). Checked on both events: message_end is the
    // precise "this assistant message is done" signal most runtimes emit, but
    // turn_end is a safety net for one that only surfaces the final text there.
    // Fire-and-forget and internally deduped, so checking on both costs nothing.
    if (event.type === "message_end" || event.type === "turn_end") {
      resolveInlineImages(record);
    }
    // Durably persist the throttled sidecars at the turn boundary so a crash
    // loses at most the in-flight turn's UI detail, not the whole turn.
    if (event.type === "turn_end") eventLog.flush(record.id);
    // AskUserQuestion is intercepted and answered by the daemon's guardian /
    // QuestionManager (see guardianInterceptor), which broadcasts
    // session.question(.resolved) from its own listeners — runtimes no longer
    // emit user_question events.
    if (event.type === "session.notice") {
      // A runtime-emitted status notice (e.g. Claude Code restarting its query to
      // pick up a rotated OAuth credential mid-session — "Refreshing credentials…").
      // Promote to a top-level session.notice, like session.question above, so it
      // surfaces in that chat regardless of which session is focused rather than
      // only via the focus-gated session.event wrap below.
      const e = event as { level?: unknown; message?: unknown; action?: unknown };
      broadcast({ type: "session.notice", sessionId: record.id, level: e.level ?? "info", message: String(e.message ?? ""), ...(e.action ? { action: e.action } : {}) });
    }
    if (event.type === "session.error") {
      // A runtime-emitted auth failure (Codex's app-server websocket 401, or a
      // ProcessRuntime/ProtocolRuntime credential preflight) — raise the sign-in
      // sheet for the right provider alongside the inline error bubble.
      maybeSignalAuthRequired(record, String((event as { error?: unknown }).error ?? ""));
    }
    if (event.type === "runtime.commands") {
      // The agent learned its own slash commands mid-session (e.g. Claude Code's
      // system/init reports slash_commands only after the first turn starts).
      // Re-advertise the session's capabilities so the client folds the commands
      // onto the runtime row and the composer offers them. Its own top-level
      // broadcast (not the focus-gated session.event wrap) so every client updates.
      broadcast({ type: "session.capabilities", sessionId: record.id, runtimeId: record.runtimeId, capabilities: capabilitiesWithCommands(record.runtimeId, record.session) });
    }
    if (event.type === "tool_call" || event.type === "tool_execution_start") liveIntermediateBySession.delete(record.id);
    if (event.type === "agent_end") {
      liveIntermediateBySession.delete(record.id);
      clearSessionWorking(record);
      void refreshSessionUsage(record);
      // Snapshot the worktree and broadcast the structured diff this turn made —
      // universal edit review + rewind target, for every runtime.
      // Warm-replicate this turn to the standby AFTER the checkpoint is committed
      // (so the shipped frame carries this turn's transcript AND its checkpoint).
      // Gated on session sync — inert by default.
      void harnessEndTurn(record).finally(() => {
        void replication.onTurnComplete(record.id);
      });
      // A turn that ended in a terminal model/provider error (e.g. an expired
      // credential or a 4xx from the API) otherwise vanished: working cleared,
      // no reply, no signal. Surface it as a session-scoped error so the client
      // can show it *inline in that chat*, and notify instead of "done".
      // A terminal turn error reaches us two ways. pi-ai puts it on the last
      // assistant message (stopReason:"error" → terminalTurnError), and the
      // server owns surfacing it. Claude Code instead throws inside the SDK
      // query: it emits its OWN session.error to the client AND carries the raw
      // text on agent_end.error (e.g. "you've hit your weekly limit · resets 12am
      // (UTC)"). We read that too — but only to DRIVE recovery, since the runtime
      // already surfaced it; re-broadcasting would double the error bubble.
      const messageError = terminalTurnError(event as Record<string, unknown>);
      const agentEndError = typeof (event as Record<string, unknown>).error === "string"
        ? humanizeAgentError((event as Record<string, unknown>).error as string)
        : undefined;
      const turnError = messageError ?? (agentEndError?.trim() ? agentEndError : undefined);
      // Before surfacing a turn error, see if the session's run policy can recover
      // it in place by swapping to a fallback model and retrying the same prompt.
      // planReroute is synchronous, so we can atomically suppress the error toast
      // here and drive the async swap + retry below.
      const reroutePlan =
        turnError && record.lastPrompt !== undefined
          ? record.reroute?.planReroute(turnError, record.session.getCurrentModel()?.name) ?? null
          : null;
      // If a reroute doesn't apply, a usage/rate limit that gave a reset time can
      // instead be waited out and resumed when the window clears (planResume is
      // synchronous too, so this stays atomic with suppressing the error toast).
      const resumePlan =
        !reroutePlan && turnError && record.lastPrompt !== undefined
          ? record.reroute?.planResume(turnError, record.session.getCurrentModel()?.name, {
              resetsAtHint: limitResetHint(record, Date.now()),
            }) ?? null
          : null;
      // Did this turn end by scheduling another auto-resume? If not, the session
      // made forward progress (a user turn, a resume that cleared the limit, a
      // reroute, or a surfaced error), so its durable resume streak resets below.
      let scheduledResume = false;
      if (reroutePlan) {
        void record.reroute!.applyReroute(reroutePlan, {
          getCurrentModelName: () => record.session.getCurrentModel()?.name,
          setModel: (p, i) => record.session.setModel(p, i),
          reprompt: async () => {
            await promptWithWatchdog(record, record.lastPrompt!, record.lastPromptOptions);
          },
        });
      } else if (resumePlan && scheduleSessionResume(record, resumePlan)) {
        // Charge the attempt budget so a limit that re-fires after the reset can
        // eventually exhaust (→ surface) instead of looping, then park the turn
        // as a scheduled resume rather than a dead error. scheduleSessionResume
        // returns false once the durable cap is hit, so this falls through to
        // surface the limit instead of resuming forever.
        record.reroute!.noteResumeApplied();
        scheduledResume = true;
      } else if (messageError) {
        // Only the server-owned (pi-ai) path surfaces here; a Claude Code error
        // the runtime already broadcast falls through to avoid a duplicate bubble.
        record.lastFailureAt = Date.now();
        metadata.touchSession(record.id, "failed");
        scheduleAdvertise();
        broadcast({ type: "session.error", sessionId: record.id, error: actionableAgentError(record.runtimeId, messageError) });
        // If the terminal error is an auth failure (expired key/token → 4xx),
        // also raise the sign-in sheet for the failing provider.
        maybeSignalAuthRequired(record, messageError);
        void sendNotificationHint({
          kind: "session_error",
          sessionId: record.id,
          targetSessionId: record.id,
          title: "Session hit an error",
          body: `${sessionNotifyLabel(record)} failed its last turn — tap to see what went wrong.`,
        });
      } else if (!record.isWorking && !record.remoteActive) {
        void sendNotificationHint({
          kind: "session_done",
          sessionId: record.id,
          targetSessionId: record.id,
          title: "Session finished",
          body: `${sessionNotifyLabel(record)} finished — tap to review the result.`,
        });
      }
      // Any turn that didn't schedule another resume broke the limit streak —
      // clear the durable counter so a future limit starts with a full budget
      // (no-op when it's already 0, so a normal turn never touches the file).
      if (!scheduledResume) metadata.setResumeAttempts(record.id, 0);
      // First real commit on a repo-backed worktree → publish the branch to the
      // remote (sets upstream), so the work is visible on GitHub. No-op until
      // there's a commit, and only pushes once. Then adopt a PR the agent opened
      // itself (gh/API/web) so the badge lights up.
      void maybePushWorktreeBranch(record)
        .then(() => maybeDetectPullRequest(record));
      // On a disposable machine, a finished turn with nobody watching is the cue
      // to consider self-teardown promptly (the idle sweep is the backstop).
      evaluateEphemeralTeardown();
    }
    const sessionEventPayload = { type: "session.event", sessionId: record.id, event };
    if (event.type === "message_update") {
      // Superseding full-content update — coalesce instead of broadcasting every
      // agent stdout line. The flush above (on the next non-update event) and
      // the coalescer's own timer guarantee it is still delivered promptly.
      sessionEvents.push(record.id, sessionEventPayload);
    } else {
      broadcast(sessionEventPayload);
    }
  });
}

async function refreshRecordAfterTui(record: SessionRecord) {
  if (!record.sessionFile) { record.tuiRefreshing = false; return; }
  const oldSession = record.session;
  record.tuiRefreshing = true;
  try {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    const rt = await ensureRuntimeAvailable(record.runtimeId);
    const workspace = record.worktree?.path || oldSession.cwd || record.workspace;
    // Refreshing an EXISTING record: its id is already known, so attach_to_chat
    // (see toolProvider's SessionIdRef doc) can be wired live, not deferred.
    const runtimeSessionOptions = { workspace, toolProvider: integrations.toolProvider({ current: record.id }), ...(rt.capabilities.toolInterception ? { toolInterceptor: guardianInterceptor } : {}) };
    const { session, warning } = await runtimeHost.openSession(rt, { ...runtimeSessionOptions, sessionFile: record.sessionFile });
    record.session = session;
    record.sessionFile = session.sessionFile ?? record.sessionFile;
    record.workspace = session.cwd || workspace;
    record.warning = warning;
    openSessions.set(record.id, record);
    if (record.sessionFile) openSessions.set(path.resolve(record.sessionFile), record);
    oldSession.dispose();
    attachSessionListeners(record);
    touchSession(record);
    persistSessionMetadata(record);
    record.tuiRefreshing = false;
    if (warning) broadcast({ type: "session.warning", sessionId: record.id, warning });
    broadcast(buildHistoryEvent({
      sessionId: record.id,
      workspace: record.workspace,
      source: record.source,
      runtimeId: record.runtimeId,
      isStreaming: sessionBusy(record),
      messages: conversationMessages(record),
    }));
    scheduleAdvertise();
  } catch (error) {
    record.tuiRefreshing = false;
    attachSessionListeners(record);
    broadcast({ type: "session.error", sessionId: record.id, error: `Could not refresh chat after TUI exit: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function fallbackSessionName(firstPrompt: string): string | undefined {
  const words = firstPrompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>\[\]{}()]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return undefined;
  const title = words.join(" ");
  return title.length > 80 ? `${title.slice(0, 77).trim()}…` : title;
}

function branchFromSessionName(name: string, previousBranch?: string): string {
  const suffix = previousBranch?.match(/-([0-9a-f]{6})$/i)?.[1] ?? randomBytes(3).toString("hex");
  return `bivy/${branchSlug(name || "session")}-${suffix}`;
}

function maybeRenameWorktreeBranch(record: SessionRecord, name: string) {
  const wt = record.worktree;
  if (!wt || record.branchPushed || record.branchPushing) return;
  const next = branchFromSessionName(name, wt.branch);
  if (!next || next === wt.branch) return;

  const result = spawnSync("git", ["-C", wt.path, "branch", "-m", wt.branch, next], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error || "git branch rename failed").trim();
    // Pass the branch names as args, not spliced into the format string: a branch
    // name containing a %-specifier would otherwise be interpreted by console.warn
    // (CodeQL js/tainted-format-string).
    console.warn("[branch-rename] could not rename %s to %s:", wt.branch, next, detail);
    return;
  }

  wt.branch = next;
  broadcast({ type: "session.branch_renamed", sessionId: record.id, branch: next });
}

function cleanSessionName(value: string): string {
  return value
    .replace(/[\r\n"'`]/g, " ")
    .replace(/\p{Control}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,:;\-–—]+$/g, "")
    .slice(0, 60)
    .trim();
}

/**
 * A runtime-independent session namer. The Pi and Claude Code SDK adapters name
 * a session with their own model, but the CLI agents (codex, opencode, aider, …)
 * run the generic "dumb-pipe" ProcessRuntime, which has no model — so their
 * sessions never got an agent-written title, only the deterministic
 * fallbackSessionName. This closes that gap using whatever Anthropic credential
 * the node already holds (API key or a Claude Pro/Max OAuth token, resolved from
 * the shared vault or ambient env), so a codex session gets the same concise
 * title + branch as a Pi one. Best-effort: any missing credential / API error returns undefined and
 * the caller keeps the deterministic title. Mirrors ClaudeSession.suggestName's
 * request so behaviour matches the runtimes that name natively.
 */
/**
 * For process/CLI agents, ask the same provider/model the user selected for the
 * session to title it (via the node-level fallback namer, which resolves the
 * model through the borrowed catalog and the shared vault's credentials). If the
 * CLI uses an opaque local model or a short alias we can't resolve, this returns
 * undefined and the Anthropic node-level fallback (or deterministic title) stands.
 * The Pi inference SDK it uses lives in src/runtime/model-namer.ts so the core
 * daemon imports no Pi SDK package directly.
 */
async function suggestSessionNameFromSelectedModel(record: SessionRecord, firstPrompt: string): Promise<string | undefined> {
  const current = record.session.getCurrentModel();
  if (!firstPrompt.trim() || !current) return undefined;
  return suggestNameFromSelectedModel({
    credsDir,
    piDir,
    provider: current.provider,
    id: current.id,
    firstPrompt,
    sessionId: record.id,
  });
}

async function suggestSessionNameFromNode(firstPrompt: string): Promise<string | undefined> {
  const prompt = firstPrompt.trim();
  if (!prompt) return undefined;
  try {
    const headers = await anthropicHeadersFromNodeCredential();
    if (!headers) return undefined;
    // OAuth (Claude Pro/Max) credentials use a Bearer authorization header and
    // are only authorized for Claude Code, so a raw /v1/messages call must lead
    // with the Claude Code identity system block or it's rejected (which left
    // sessions stuck on the first-line fallback name). API keys (x-api-key)
    // carry no such restriction.
    const useOAuth = "authorization" in headers;
    const namingInstruction = "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.";
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-3-5-haiku-latest",
        max_tokens: 24,
        temperature: 0.2,
        system: useOAuth
          ? [
              { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
              { type: "text", text: namingInstruction },
            ]
          : namingInstruction,
        messages: [{ role: "user", content: `Create a short title for this coding-agent session using the full first message below:\n\n${prompt.slice(0, 4000)}` }],
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (json.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
    return cleanSessionName(text) || undefined;
  } catch (error) {
    console.warn("Node-level session naming failed", error);
    return undefined;
  }
}

/**
 * The auto-generated stand-ins a session carries BEFORE it has been named from
 * its first message: an empty/"Untitled session" title, or the `Session <id>`
 * placeholder set at creation. Any other value is a real name — from the
 * first-prompt namer or a manual rename — and must never be re-derived.
 */
function isPlaceholderSessionName(name: string | undefined, id: string): boolean {
  return isEmptyUntitledTitle(name) || String(name ?? "").trim() === `Session ${id.slice(0, 8)}`;
}

async function maybeNameSession(record: SessionRecord, firstPrompt: string) {
  if (record.naming || record.namedFromFirstPrompt) return;
  // `namedFromFirstPrompt` lives only in memory — it was never persisted, and a
  // resumed session gets its stored name restored onto the runtime (see
  // createSession) but starts with the flag false. So after any reopen (idle
  // close, PWA reconnect, node restart) the next prompt fell through to naming
  // again and re-derived BOTH the title and the branch from that later
  // message's first line — which is exactly the "session/branch renames on
  // every message" the UI showed. Treat an already-real name as named and leave
  // it (and the branch) untouched; only the creation-time placeholders get a
  // first-message name. This also lets an agent-written name survive: once the
  // runtime sets a real title, later prompts keep it instead of overwriting.
  if (!isPlaceholderSessionName(record.session.getName(), record.id)) {
    record.namedFromFirstPrompt = true;
    return;
  }
  // Once the fallback rename below lands, the title is no longer a
  // "placeholder" by isPlaceholderSessionName's definition — so a retry triggered
  // by a *later* prompt must still title from the session's actual first
  // message, not whatever text happens to trigger the retry. Capture it once
  // and reuse it on every attempt; otherwise a retry would rename (and
  // re-branch) the session from a much later message, which is exactly the
  // "renames on every message" bug this function exists to prevent.
  if (!record.firstNamingPrompt) record.firstNamingPrompt = firstPrompt.trim();
  const prompt = record.firstNamingPrompt;
  if (!prompt) return;

  const MAX_NAMING_ATTEMPTS = 3;

  record.naming = true;
  try {
    // This deterministic rename (unlike the LLM refinement below) must not be
    // allowed to fail silently: maybeNameSession is always invoked fire-and-
    // forget (`void maybeNameSession(...)`), so an exception here previously
    // had no catch anywhere in its call chain — it became an unhandled
    // rejection, and because `namedFromFirstPrompt` is only set true at the
    // very end, the session was left permanently stranded on its creation-time
    // "Session <hex>" placeholder with no retry (a later prompt would still
    // see `record.naming` reset to false by `finally` below and could retry,
    // but the *first* message's name was lost, and if the failure was
    // deterministic — e.g. a metadata-store I/O error — every later prompt
    // would fail the same way and the placeholder would never clear).
    try {
      const fallback = fallbackSessionName(prompt) || `Session ${record.id.slice(0, 8)}`;
      // Always rename deterministically from the first user message, then let the
      // runtime/agent refine it. This keeps the UI useful even if model-based
      // naming fails, and keeps repo branches away from raw prompt text.
      record.session.setName(fallback);
      persistSessionMetadata(record);
      maybeRenameWorktreeBranch(record, fallback);
      broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: fallback, branch: record.worktree?.branch });
      scheduleAdvertise();

      let finalName = fallback;
      let smartNamed = false;
      try {
        // Prefer the runtime's own model-based name (Pi, Claude Code SDK). CLI
        // agents on the dumb-pipe ProcessRuntime return undefined here, so next
        // ask the same provider/model selected for that session when it maps to
        // Pi's registry; only then fall back to the node-level Anthropic namer.
        const suggested = (await record.session.suggestName(prompt)) || (await suggestSessionNameFromSelectedModel(record, prompt)) || (await suggestSessionNameFromNode(prompt));
        if (suggested && suggested !== fallback) { finalName = suggested; smartNamed = true; }
      } catch (error) {
        console.warn("Session naming suggestion failed", error);
      }

      if (finalName !== fallback) {
        record.session.setName(finalName);
        persistSessionMetadata(record);
        maybeRenameWorktreeBranch(record, finalName);
        broadcast({ type: "session.renamed", sessionId: record.id, sessionFile: record.sessionFile, name: finalName, branch: record.worktree?.branch });
        scheduleAdvertise();
      }
      // Only lock the title in once a model actually produced one, or once
      // enough attempts have failed that further retries aren't worth it.
      // Previously this was set unconditionally here, so a single transient
      // failure of all three naming tiers (rate limit, network blip, a
      // credential mid-rotation) permanently froze the session on the blunt
      // word-truncated fallback — every session that hit it stayed on the
      // dumb title forever, with the retry the comment above promises never
      // actually happening. Leaving the flag false lets the next prompt's
      // fire-and-forget call retry the smart-naming tiers (still against the
      // captured first prompt above), up to a small cap so a session with no
      // usable credential at all doesn't retry on every single message forever.
      record.namingAttempts = (record.namingAttempts ?? 0) + 1;
      if (smartNamed || record.namingAttempts >= MAX_NAMING_ATTEMPTS) {
        record.namedFromFirstPrompt = true;
      }
    } catch (error) {
      console.error(`Session naming failed for ${record.id} — leaving the placeholder title in place; a later prompt will retry`, error);
    }
  } finally {
    record.naming = false;
  }
}

function restoredWorktreeFromMetadata(meta?: MetadataSession): Worktree | undefined {
  if (!meta?.worktree || !meta.branch) return undefined;
  const wtPath = path.resolve(meta.worktree);
  if (!fs.existsSync(wtPath)) return undefined;
  const mainWorktree = runGit(["worktree", "list", "--porcelain"], wtPath)?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  const repoRoot = mainWorktree || runGit(["rev-parse", "--show-toplevel"], wtPath) || wtPath;
  return { path: wtPath, branch: meta.branch, repoRoot };
}

/**
 * Fast path for opening a session: build a `session.history` event straight from
 * the session file, WITHOUT the (multi-second) runtime resume. Constructing a
 * live agent runtime — model registry, auth, resource loaders, extensions — is
 * what made clicking a session in the sidebar take many seconds to show
 * anything; the transcript is already on disk the whole time. This reads it
 * directly (see AgentRuntime.readMessages) so the PWA fills in near-instantly,
 * while the real resume proceeds in the background and reconciles (identical
 * content, so no visible change) and leaves the record open for prompts.
 *
 * Returns null — and the caller falls back to the normal path — for anything
 * this can't fast-serve: an already-open session (its live history is already
 * cheap), an id-based runtime with no build-free read (e.g. Claude Code), an
 * unknown session, or any read/guard error. Side-effect-free.
 *
 * `msg` may be a `session.open` (carries `path`) or a `history` poll (carries
 * only `sessionId`); the session file is taken from `path` when present, else
 * from the durable metadata store.
 */
function fastHistoryEvent(msg: ClientMessage): ReturnType<typeof buildHistoryEvent> | null {
  try {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (!sessionId) return null;
    // An already-open session has its transcript in memory. Closed sessions get
    // an instant disk paint before the slow resume; loaded (idle/active) sessions
    // used to bail here and only paint after the round-trip, so they felt slower
    // than closed ones. Serve their in-memory transcript synchronously too — the
    // same event session.open sends post-resolve, just at the earliest tick.
    const openRecord = openSessions.get(sessionId);
    if (openRecord) {
      return buildHistoryEvent({
        sessionId: openRecord.id,
        workspace: openRecord.workspace,
        source: openRecord.source,
        runtimeId: openRecord.runtimeId,
        isStreaming: sessionBusy(openRecord),
        messages: conversationMessages(openRecord),
        cursor: historyCursorFrom(msg),
      });
    }
    const pathRef = String(msg.path ?? "").trim();
    const meta = (pathRef ? metadata.getSession(pathRef) : undefined) ?? metadata.getSession(sessionId);
    const ref = pathRef || meta?.path;
    if (!ref) return null;
    const runtimeId = agentFrom(msg) ?? meta?.runtimeId;
    const file = resolveResumeRef({ ref, resumesByPath: runtimeResumesByPath(runtimeId), sessionsDir });
    const rt = getRuntime(runtimeId);
    // Prefer the runtime's build-free read (pi/claude-code); otherwise use the
    // transcript Bivy persisted itself, so process agents (Codex, generic CLIs)
    // fast-paint their real conversation instead of falling through to a slow
    // resume — or worse, rebuilding from tool cards alone.
    const runtimeBase = runtimeHost.readMessages(rt, file);
    const base = runtimeBase && runtimeBase.length ? runtimeBase : eventLog.readBase(sessionId);
    // Only fast-paint when there's actually something to show. Sending an empty
    // "full" snapshot would needlessly blank a client's cached view, so fall back
    // to the normal open path when neither source has anything.
    if (!base || base.length === 0) return null;
    return buildHistoryEvent({
      sessionId,
      workspace: meta?.worktree ?? meta?.workspace ?? defaultWorkspace,
      source: meta?.source,
      runtimeId: rt.id,
      isStreaming: false,
      messages: eventLog.deriveHistory(sessionId, base),
      cursor: historyCursorFrom(msg),
      name: meta?.name,
      branch: meta?.branch,
      prUrl: meta?.prUrl,
      prs: meta?.prs,
    });
  } catch {
    return null; // never let the fast path break opening — the normal resume still runs
  }
}

// Whether a runtime resumes by filesystem path (pi) vs. an opaque session id
// (Claude Code and other id-based agents). Only path-based refs are subject to
// the sessions-dir traversal guard. Unknown/unavailable runtimes default to
// path-based so the guard still protects the (pi) default; an id-based runtime
// that isn't resolvable here couldn't resume anyway.
function runtimeResumesByPath(runtimeId?: string): boolean {
  try {
    return getRuntime(runtimeId).capabilities.sessionRefIsPath === true;
  } catch {
    // Default to id-based (false), NOT path-based. getRuntime throws when the
    // runtime isn't currently "available" — notably an id-based runtime like
    // claude-code-sdk momentarily reporting "planned" because its optional SDK
    // failed to resolve (a reinstall, a version/layout change, a transient miss).
    // This function gates DESTRUCTIVE / rejecting behavior: pruneGhostSessions
    // deletes, and the resume guard returns "Session not found", whenever a
    // *path-based* transcript file is absent. Returning true here flipped every
    // Claude Code session (whose stored `path` is a session id, not a file) to
    // path-based, so existsSync(id) always missed — the rows were swept and
    // resume failed for all of them. On uncertainty treat the ref as an id: skip
    // the file guard, never prune. Worst case a genuinely path-based dead row
    // lingers (cosmetic) instead of real sessions being destroyed.
    return false;
  }
}

/** Stored session's last-active time as epoch ms — used to preserve it when a
 *  session is merely opened (opening must not count as activity). */
function metaLastActiveMs(meta?: { lastActivityAt?: string; updatedAt?: string }): number | undefined {
  const raw = meta?.lastActivityAt ?? meta?.updatedAt;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * If a session is still LIVE on an agent service (kept running after a cap
 * eviction or a daemon disconnect), re-attach to it instead of opening a fresh
 * copy — preserving the live child + in-memory state (Stage 2). Returns undefined
 * (so the caller falls back to a normal open) when there is no live session to
 * attach to, or the runtime isn't remote. Only fires when `rt` is a RemoteRuntime,
 * i.e. the remote flag routed this session there.
 */
/** Result of a re-attach attempt: the live session + the address it's bound to,
 *  or a miss carrying whether the session was DEFINITIVELY gone (vs the service
 *  merely being unreachable) so callers can apply the adoption failure policy. */
type AttachOutcome =
  | { result: OpenSessionResult; address: string }
  | { result: undefined; gone: boolean; error: unknown };

async function tryAttachLiveRemote(sessionId: string | undefined, options: OpenSessionOptions): Promise<AttachOutcome | undefined> {
  if (!sessionId) return undefined;
  const location = await sessionLocations.lookup(sessionId).catch(() => undefined);
  if (!location?.agentServiceAddress) return undefined;
  // Route to the service that ACTUALLY hosts this session (Stage 3 per-session
  // routing) — an adopted session may live on a different service than the node
  // default BIVY_REMOTE_RUNTIME_ADDR.
  let remote: AgentRuntime;
  try {
    remote = runtimeHost.getRemoteAt(location.runtimeId, location.agentServiceAddress, location.sandbox as SandboxTier | undefined);
  } catch {
    return undefined;
  }
  if (!(remote instanceof RemoteRuntime)) return undefined;
  try {
    const result = await remote.attachSession(sessionId, { toolInterceptor: options.toolInterceptor, toolProvider: options.toolProvider });
    return { result, address: location.agentServiceAddress };
  } catch (error) {
    // Forget the mapping ONLY when the service is reachable and reports no such
    // session (definitively gone). A transient failure (service down/restarting)
    // keeps the mapping so a later access can retry — never orphan a live child.
    const gone = classifyAttachFailure(error) === "gone";
    if (gone) await sessionLocations.forget(sessionId).catch(() => {});
    return { result: undefined, gone, error };
  }
}

/** Re-open a runtime that still reports streaming shortly after a manual Stop.
 * The client is settled immediately by the abort handler; prompts arriving from
 * its follow-up queue await this promise and therefore cannot be steered into the
 * stale in-process Pi turn. */
async function recoverRecordAfterAbort(record: SessionRecord): Promise<void> {
  const oldSession = record.session;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (record.session !== oldSession || !oldSession.isStreaming) return;
    if (!record.sessionFile) {
      broadcast({ type: "session.error", sessionId: record.id, error: "The stopped agent did not settle. Reopen this chat to continue." });
      return;
    }
    const rt = await ensureRuntimeAvailable(record.runtimeId, record.sandbox);
    const workspace = record.worktree?.path || oldSession.cwd || record.workspace;
    const runtimeSessionOptions = {
      workspace,
      toolProvider: integrations.toolProvider({ current: record.id }),
      ...(rt.capabilities.toolInterception ? { toolInterceptor: guardianInterceptor } : {}),
    };
    const { session, warning } = await runtimeHost.openSession(rt, {
      ...runtimeSessionOptions,
      sessionFile: record.sessionFile,
    });
    // The original abort may have completed while openSession was in flight.
    if (record.session !== oldSession || !oldSession.isStreaming) {
      session.dispose();
      return;
    }
    if (session.id !== record.id) {
      session.dispose();
      throw new Error(`runtime reopened session as ${session.id} instead of ${record.id}`);
    }
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.session = session;
    record.sessionFile = session.sessionFile ?? record.sessionFile;
    record.workspace = session.cwd || workspace;
    record.warning = warning;
    oldSession.dispose();
    attachSessionListeners(record);
    persistSessionMetadata(record, "idle");
    broadcast(buildHistoryEvent({
      sessionId: record.id,
      workspace: record.workspace,
      source: record.source,
      runtimeId: record.runtimeId,
      isStreaming: false,
      messages: conversationMessages(record),
    }));
    if (warning) broadcast({ type: "session.warning", sessionId: record.id, warning });
    console.warn(`[session-abort] reopened stuck runtime for ${record.id}`);
  } catch (error) {
    broadcast({ type: "session.error", sessionId: record.id, error: `Could not recover the stopped agent: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    record.abortRecovery = undefined;
  }
}

async function createSession(workspace = defaultWorkspace, sessionFile?: string, opts: CreateSessionOptions = {}) {
  const makeActive = opts.makeActive !== false;
  // Normalize the resume ref into the token the owning runtime actually expects.
  // Bivy is the unifying store for sessions started anywhere (react app, GitHub
  // issues, `bivy run`/`attach`, …), so resume must work for every runtime — not
  // just pi. Runtimes differ in what a "session ref" is: pi resumes by a
  // transcript path under the node's sessions dir (path-traversal guarded),
  // while Claude Code resumes by an opaque session id (a UUID) and keeps its
  // transcript under ~/.claude. Forcing every ref under pi's sessions dir is what
  // made Claude Code (and any id-based runtime) sessions un-resumable with
  // "Session file is outside the sessions directory".
  const requestedRef = typeof sessionFile === "string" && sessionFile.trim() ? sessionFile.trim() : undefined;
  const refRuntimeId = opts.runtimeId ?? (requestedRef ? metadata.getSession(requestedRef)?.runtimeId : undefined);
  const requestedSessionFile = requestedRef
    ? resolveResumeRef({ ref: requestedRef, resumesByPath: runtimeResumesByPath(refRuntimeId), sessionsDir })
    : undefined;
  const storedMeta = requestedSessionFile ? metadata.getSession(requestedSessionFile) : undefined;
  const restoredWorktree = requestedSessionFile ? restoredWorktreeFromMetadata(storedMeta) : undefined;

  const existing = requestedSessionFile ? (openSessions.get(requestedSessionFile) ?? (storedMeta?.id ? openSessions.get(storedMeta.id) : undefined)) : undefined;
  if (existing) {
    // Reopening an already-open session must NOT bump its last-active time —
    // that only tracks real user/agent activity, not focus. (Was touchSession.)
    if (makeActive) active = existing;
    broadcast({ type: "session.created", sessionId: existing.id, name: existing.session.getName(), workspace: existing.workspace, sessionFile: existing.sessionFile, source: existing.source, branch: existing.worktree?.branch, prUrl: existing.prUrl, runtimeId: existing.runtimeId, agentName: getRuntime(existing.runtimeId).displayName, bivySession: bivySessionEnvelope(existing), capabilities: capabilitiesWithCommands(existing.runtimeId, existing.session) });
    void maybeNotifyBivyUpdate();
    return existing;
  }

  // Pick the agent for this session (fixed for its life). Resuming a tagged
  // session passes its owning agent so it rebuilds on the right runtime.
  // A per-session sandbox override (fresh choice, else the one saved on resume)
  // bakes into the runtime's launch flags. Resolve and persist the effective
  // tier, including the node default. A session's sandbox is fixed for its
  // lifetime; retaining `undefined` here
  // made governance unable to tell that a defaulted session had full access and
  // also let a later node-default change alter its tier on resume.
  const sessionSandbox = sandboxTier(opts.sandbox ?? storedMeta?.sandbox);
  const rt = await ensureRuntimeAvailable(opts.runtimeId ?? storedMeta?.runtimeId, sessionSandbox);

  // Optional git-worktree isolation (fresh sessions only). The agent then runs in
  // the worktree, and the A1 boundary confines writes there.
  let worktree: Worktree | undefined = restoredWorktree;
  let runtimeWorkspace = requestedSessionFile ? (restoredWorktree?.path ?? storedMeta?.workspace ?? workspace) : workspace;
  if (opts.worktree && !requestedSessionFile) {
    // Admission control: refuse to provision a NEW worktree when the disk is
    // below the free-space floor, so Bivy never fills the user's device. This
    // gates only fresh worktree creation — resuming existing sessions above is
    // never blocked. Non-destructive: the user frees space and retries.
    const admission = checkDiskAdmission(workspace);
    if (!admission.allowed) throw new Error(`Not enough disk to start a new worktree session: ${admission.reason}`);
    const wtOpts = typeof opts.worktree === "object" ? opts.worktree : {};
    // A random suffix, never a timestamp: two sessions started in the same
    // millisecond would otherwise resolve to the same slug → same worktree path
    // and branch, and `createWorktree` would ADOPT the first's worktree, dropping
    // the second session into a directory another session already owns.
    worktree = await createWorktree({ repoDir: workspace, id: wtOpts.branch ?? `session-${randomBytes(6).toString("hex")}`, branch: wtOpts.branch, base: wtOpts.base });
    runtimeWorkspace = worktree.path;
  }

  // Resume with a reaped worktree. When a repo-backed session is resumed but its
  // worktree directory was removed while it was closed (disk cleanup, a manual
  // rm, `git worktree remove`), restoredWorktree is undefined and we'd otherwise
  // fall back to the shared clone root — which the invariant below then rejects.
  // Re-provision a fresh worktree on the SAME branch instead (branches survive
  // `git worktree remove`, so the agent's committed history is intact), restoring
  // isolation so the resumed session is usable again. Best-effort: if the clone
  // or branch is gone, we leave it to the invariant to fail safe rather than
  // corrupt a neighbour. The clone root is reconstructed from `source`
  // (`repo:owner/repo`) because stored `workspace` is the old worktree path.
  if (requestedSessionFile && !worktree && storedMeta?.worktree && storedMeta?.branch) {
    const parsedSource = parseRepoSource(storedMeta.source);
    if (parsedSource) {
      const repoDir = path.join(reposRoot, `${parsedSource.owner}__${parsedSource.repo}`);
      try {
        // Clear any stale registration left by a dir that was rm'd out from under
        // git, so re-adding the branch's worktree doesn't hit "already checked out".
        runGit(["worktree", "prune"], repoDir);
        const reprovisioned = await createWorktree({ repoDir, id: storedMeta.branch, branch: storedMeta.branch });
        worktree = reprovisioned;
        runtimeWorkspace = reprovisioned.path;
      } catch (error) {
        console.warn(`Could not re-provision worktree for resumed session on ${storedMeta.branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Isolation invariant. A session must NEVER run directly in a Bivy-managed
  // shared clone root (`<reposRoot>/owner__repo`): every session for that repo
  // shares that one checkout, so an agent running there collides with concurrent
  // sessions on `git checkout`/`git stash` — exactly the "sessions mixing" bug.
  // A GitHub-backed session is supposed to get its own worktree; reaching here
  // without one means an earlier step degraded (e.g. a transient repo-inference
  // failure, or a resume whose worktree was reaped). Fail loudly instead of
  // silently sharing the tree and corrupting a neighbouring session's work.
  if (!worktree && isSharedCloneRoot(runtimeWorkspace, reposRoot)) {
    throw new Error(
      `Refusing to start a session in the shared clone root ${runtimeWorkspace} without an isolated worktree — ` +
        `this would collide with concurrent sessions on the same repo. Retry; if it persists the checkout may be busy.`,
    );
  }

  // A brand-new session's id isn't known until runtimeHost.{create,open}Session
  // resolves below, but the ToolProvider (and its attach_to_chat tool) must be
  // built now, up front — so hand it this box instead of a session id and fill
  // `.current` in the moment `sessionId` is (see toolProvider's SessionIdRef doc).
  const attachSessionIdRef: SessionIdRef = {};
  const runtimeSessionOptions = { workspace: runtimeWorkspace, toolProvider: integrations.toolProvider(attachSessionIdRef), ...(rt.capabilities.toolInterception ? { toolInterceptor: guardianInterceptor } : {}) };
  // Stage 2/3: prefer re-attaching to a still-live remote session — routed to its
  // OWN agent service — over re-opening a fresh copy from disk. Falls back to
  // open/create when nothing live is there.
  const attachOutcome = requestedSessionFile ? await tryAttachLiveRemote(storedMeta?.id, runtimeSessionOptions) : undefined;
  const attached = attachOutcome?.result;
  const attachedAddress = attached ? (attachOutcome as { address: string }).address : undefined;
  if (opts.attachOnly && !attached) {
    // Adoption (attachOnly): NEVER spawn a fresh child from disk — surface the
    // attach failure so the caller can classify gone-vs-transient. A definitively
    // gone session was already forgotten inside tryAttachLiveRemote.
    throw (attachOutcome && "error" in attachOutcome ? (attachOutcome.error as Error | undefined) : undefined) ?? new Error(`No live remote session to adopt: ${storedMeta?.id ?? requestedSessionFile ?? ""}`);
  }
  const { session, warning: modelFallbackMessage } = attached
    ?? (requestedSessionFile
      ? await runtimeHost.openSession(rt, { ...runtimeSessionOptions, sessionFile: requestedSessionFile })
      : await runtimeHost.createSession(rt, runtimeSessionOptions));
  const sessionId = session.id;
  // Now that it's known, unblock any attach_to_chat call this session's agent
  // makes (see attachSessionIdRef above) — set synchronously, well before any
  // prompt (and so any tool call) can reach this session.
  attachSessionIdRef.current = sessionId;
  // Resuming an existing session: restore Bivy's canonical name onto the runtime
  // session when the runtime didn't itself (the Claude Code adapter resumes by id
  // and starts nameless). Without this getName() is undefined, so opening a
  // session never updates the header title, and persistSessionMetadata below
  // would overwrite the stored name with undefined — surfacing as "Untitled
  // session" in the sidebar.
  if (requestedSessionFile && storedMeta?.name && !session.getName()) session.setName(storedMeta.name);
  const sessionWorkspace = session.cwd || runtimeWorkspace;
  // Best-effort here (unlike createWorkspaceSession, which must fail loudly):
  // this only decides whether to ADOPT an already-checked-out branch as the
  // session's worktree label, so a transient inference failure should quietly
  // skip adoption rather than break resuming the session.
  const inferredRepo = opts.source || storedMeta?.source ? undefined : await inferGitHubRepoFromWorkspace(sessionWorkspace).catch(() => undefined);
  if (!worktree && requestedSessionFile && inferredRepo && !isSharedCloneRoot(sessionWorkspace, reposRoot)) {
    const branch = runGit(["branch", "--show-current"], sessionWorkspace) || runGit(["rev-parse", "--short", "HEAD"], sessionWorkspace) || undefined;
    if (branch) {
      const mainWorktree = runGit(["worktree", "list", "--porcelain"], sessionWorkspace)?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const repoRoot = mainWorktree || runGit(["rev-parse", "--show-toplevel"], sessionWorkspace) || sessionWorkspace;
      worktree = { path: sessionWorkspace, branch, repoRoot };
    }
  }
  const source = opts.source ?? storedMeta?.source ?? (inferredRepo ? `repo:${inferredRepo.slug}` : undefined);

  // Opening a resumed session must preserve its stored last-active time, not
  // bump it to now (only real activity should reorder the sidebar). A brand-new
  // session legitimately starts "active now".
  const resumedLastActive = requestedSessionFile ? metaLastActiveMs(storedMeta) : undefined;
  const record: SessionRecord = { id: sessionId, session, runtimeId: rt.id, sandbox: sessionSandbox, approvalMode: opts.approvalMode, workspace: sessionWorkspace, sessionFile: session.sessionFile, agentServiceAddress: attachedAddress ?? (rt as { agentServiceAddress?: string }).agentServiceAddress, worktree, source, prUrl: storedMeta?.prUrl, prs: storedMeta?.prs, lastTouchedAt: resumedLastActive ?? Date.now(), warning: modelFallbackMessage, ephemeral: opts.ephemeral };
  // Apply this session's sandbox network policy as a per-session egress proxy
  // (its own proxy/decider, never the node-global one). Opt-in via BIVY_SANDBOX_NET:
  // a read-only session then actually blocks outbound network even for a CLI agent
  // whose own sandbox doesn't (opencode/aider/goose). No-op otherwise. Fire-and-
  // forget — a slow proxy listen never delays session creation.
  void applySessionSandboxEgress(record.id, sessionSandbox, (event) => broadcast({ type: "node.egress", event }));
  // Stage 2 slice 4: a re-attached session recovers its still-running TUI
  // terminal link (the PTY survives a detach) from the session→terminal registry.
  if (attached) {
    const link = await sessionTerminals.lookup(sessionId).catch(() => undefined);
    if (link && terminals.has(link.termId)) record.tuiTermId = link.termId;
    else if (link) void sessionTerminals.forget(sessionId).catch(() => {});
  }
  // Universal Agent Harness (Phase 2b) — for CLI agents that can't govern their
  // own MCP tools (no native tool interception), rewrite their on-disk MCP
  // config so servers launch through `bivy mcp-proxy`; restored on close. Opt-in
  // via BIVY_MCP_PROXY. Pi/Claude-SDK govern MCP natively, so they're skipped.
  if (process.env.BIVY_MCP_PROXY && !rt.capabilities.toolInterception) {
    try {
      const res = injectMcpProxyForSession(rt.id, { workspace: sessionWorkspace, home: os.homedir() });
      if (res.injected.length) {
        record.mcpRestore = res.restore;
        console.log(`MCP proxy: routed ${res.injected.length} config(s) for session ${sessionId}`);
      }
    } catch {
      // Injection is best-effort; never block session creation.
    }
  }
  // Bivy-owned tools (attach_to_chat, …): make them discoverable to non-SDK
  // agents by adding a `bivy` server (run via `bivy mcp-serve`) to the agent's
  // config. Default-on (not gated on BIVY_MCP_PROXY) — it only ADDS a safe,
  // session-scoped, restored capability the agent already has via env, so the
  // chat can receive files. Claude/Pi expose these natively (in-process SDK MCP
  // server / integration ToolProvider), so the tool-interception runtimes are
  // skipped to avoid a duplicate registration.
  if (!rt.capabilities.toolInterception) {
    try {
      const res = injectBivyToolsForSession(rt.id, {
        workspace: sessionWorkspace,
        home: os.homedir(),
        sessionId,
        endpoint: process.env.BIVY_MCP_ENDPOINT,
      });
      if (res.injected.length) {
        const prev = record.mcpRestore;
        record.mcpRestore = () => { try { res.restore(); } finally { prev?.(); } };
        console.log(`MCP tools: added bivy server to ${res.injected.length} config(s) for session ${sessionId}`);
      }
    } catch {
      // Best-effort; never block session creation.
    }
  }
  rememberSession(record);
  rememberWorkspace(sessionWorkspace);

  attachSessionListeners(record);
  void refreshSessionUsage(record);

  if (makeActive) active = record;
  broadcast({ type: "session.created", sessionId, name: record.session.getName(), workspace: sessionWorkspace, sessionFile: record.sessionFile, source: record.source, branch: worktree?.branch, prUrl: record.prUrl, runtimeId: rt.id, agentName: rt.displayName, modelFallbackMessage, bivySession: bivySessionEnvelope(record), capabilities: capabilitiesWithCommands(rt.id, record.session) });
  void maybeNotifyBivyUpdate();
  scheduleAdvertise();
  return record;
}

/**
 * In-flight resume promises keyed by resolved session ref. The PWA fires a
 * `session.open` and the user's first `prompt` back-to-back (the fast on-disk
 * paint means the transcript appears before the runtime has actually resumed, so
 * the user can — and does — type immediately), and a history re-poll races both.
 * Without de-duplication each of those would stand up its own runtime for the
 * same session, double-opening it and leaking processes; worse, a `prompt` that
 * arrives before the `session.open` resume has landed would miss `openSessions`
 * entirely and fail with "Session not found". Collapsing every concurrent open
 * of the same session onto one promise fixes both.
 */
const resumingSessions = new Map<string, Promise<SessionRecord>>();

/**
 * Resolve the session a client command targets, resuming it from durable
 * metadata when it isn't currently held in memory. A session survives being
 * dropped from this process — a node restart, an idle close, or simply never
 * having been opened on this process (the PWA lists sessions straight from the
 * metadata store, so it can name one this process has never touched). A
 * prompt/open/model command for such a real-but-closed session must reopen it,
 * not fail with "Session not found" — which was the root of "can't resume
 * sessions / sessions not found" in the PWA.
 *
 * Returns undefined only when the id is genuinely unknown (never started on this
 * node, or deleted) — the caller then surfaces "Session not found". Rejects only
 * when a known session fails to resume (e.g. its runtime can't be built), so the
 * caller can surface the real reason.
 */
async function resolveOrResumeSession(sessionId?: unknown, sessionPath?: unknown): Promise<SessionRecord | undefined> {
  const id = typeof sessionId === "string" && sessionId ? sessionId : undefined;
  if (!id) return undefined;
  const open = openSessions.get(id);
  if (open) return open;
  const pathRef = typeof sessionPath === "string" && sessionPath.trim() ? sessionPath.trim() : undefined;
  const meta = metadata.getSession(id) ?? (pathRef ? metadata.getSession(pathRef) : undefined);
  // The resume ref: an explicit path, else metadata's stored path, else the id
  // itself (id-based runtimes like Claude Code resume by session id). Bail when
  // there is nothing durable to resume from — a genuinely unknown session.
  const ref = resumeRefFor({ id, path: pathRef, metaPath: meta?.path, metaKnown: Boolean(meta) });
  if (!ref) {
    // Self-diagnosing "Session not found": nothing durable to resume from —
    // metadata has no row for this id/path and no explicit path was given.
    console.warn(`[resume] not-found id=${id} reason=no-durable-ref metaKnown=${Boolean(meta)} pathRef=${pathRef ?? "-"}`);
    return undefined;
  }
  const runtimeId = meta?.runtimeId;
  // Key by the fully-resolved ref so `session.open`'s path and a racing prompt's
  // id collapse onto the same in-flight resume (both derive from the same
  // session, so both resolve to this file/id). createSession also stores the open
  // record under this resolved key, so a just-finished resume is found here too.
  const resumesByPath = runtimeResumesByPath(runtimeId);
  let key: string;
  try {
    key = resolveResumeRef({ ref, resumesByPath, sessionsDir });
  } catch (error) {
    // The sessions-dir path-traversal guard rejected this ref (path-based
    // runtime whose ref resolved outside sessionsDir). Fall back to the raw ref;
    // log it because it's a common cause of a subsequent missing-file bail.
    console.warn(`[resume] ref-outside-sessions-dir id=${id} runtimeId=${runtimeId ?? "-"} ref=${ref} sessionsDir=${sessionsDir} — ${error instanceof Error ? error.message : String(error)}`);
    key = ref;
  }
  const already = openSessions.get(key);
  if (already) return already;
  // A path-based runtime (pi) resumes by reading the transcript file. If that
  // file doesn't exist, there is nothing to resume — opening it would fork a
  // brand-new empty session under a *different* id, duplicating the row in the
  // sidebar (an id-based runtime like Claude Code validates its own id, so this
  // guard doesn't apply). Treat a missing transcript as "not found" instead.
  if (resumesByPath) {
    try {
      if (!fs.existsSync(key)) {
        // Path-based runtime, transcript file absent → treated as not-found (see
        // above). This is the branch that misfired when an id-based runtime was
        // wrongly classified path-based; the log makes that unmistakable.
        console.warn(`[resume] not-found id=${id} reason=transcript-missing runtimeId=${runtimeId ?? "-"} resumesByPath=true key=${key}`);
        return undefined;
      }
    } catch (error) {
      console.warn(`[resume] not-found id=${id} reason=transcript-stat-failed runtimeId=${runtimeId ?? "-"} key=${key} — ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  const inflight = resumingSessions.get(key);
  if (inflight) return inflight;
  const resume = createSession(defaultWorkspace, ref, { runtimeId, makeActive: false });
  resumingSessions.set(key, resume);
  try {
    return await resume;
  } finally {
    resumingSessions.delete(key);
  }
}

// Enumerating a runtime's models needs a live session (the model registry lives
// on it). When a client asks for models/model-select/thinking without naming a
// session, we must NOT spin up a node-global `active` session for that read:
// runtimes.list reports `active`'s agent as the current one, so a throwaway
// created here would silently revert the composer's agent pill — and, when it
// races the runtime.select that switches the default agent, pin the pill to the
// *previous* runtime (the reported agent-switching bug). Mirror how session.new/
// session.open already refuse to touch `active` for remote clients: reuse a
// non-active scratch session per runtime instead of spawning a fresh runtime
// process on every picker read.
//
// Keyed by runtime id, not a single slot: switching agents (Claude → Codex →
// Claude) used to evict and re-spawn the one scratch on every switch — the
// "switching agent takes a long time before models appear" bug. A map keeps one
// warm scratch per runtime so a switch back to an agent already viewed this
// session answers from the live session with no re-spawn, and `prefetchModels`
// can warm several ahead of the first pick.
const modelQueryScratch = new Map<string, SessionRecord>();
const modelQueryScratchPending = new Map<string, Promise<SessionRecord>>();
async function sessionForModelQuery(runtimeId?: string): Promise<SessionRecord> {
  const wanted = resolveRuntimeId(runtimeId);
  // A live active session answers for itself — but only when it IS the runtime
  // being queried, so a prefetch/draft read for a *different* agent doesn't get
  // the active session's (wrong-runtime) model list.
  if (active && active.runtimeId === wanted) return active;
  const cached = modelQueryScratch.get(wanted);
  if (cached && openSessions.has(cached.id) && cached.runtimeId === wanted && !sessionBusy(cached)) {
    touchSession(cached);
    return cached;
  }
  // De-dupe concurrent picker reads per runtime. Without this, a WS models.list
  // and an HTTP GET /api/models fired together on page load both miss the reuse
  // guard above (the scratch assignment only lands after createSession resolves
  // ~0.3s later) and each stand up a session, leaving two empty rows a fraction
  // of a second apart. Collapse concurrent builds onto one promise per runtime,
  // mirroring resumingSessions.
  const inflight = modelQueryScratchPending.get(wanted);
  if (inflight) return inflight;
  const build = createSession(defaultWorkspace, undefined, { makeActive: false, ephemeral: true, runtimeId: wanted })
    .then((rec) => { modelQueryScratch.set(wanted, rec); return rec; })
    .finally(() => { modelQueryScratchPending.delete(wanted); });
  modelQueryScratchPending.set(wanted, build);
  return build;
}

/**
 * Warm the model-query scratch for one or more runtimes in the background so the
 * first agent switch to any of them answers instantly instead of paying the
 * runtime spin-up on the critical path. Fired when the agent picker opens (see
 * the `models.prefetch` command). Best-effort and de-duped: a runtime already
 * warm (or being warmed) is a no-op, and a spin-up failure is swallowed — the
 * normal models.list path will surface any real error when the user picks it.
 */
function prefetchModels(runtimeIds: string[]): void {
  const wanted: string[] = [];
  for (const id of runtimeIds) {
    let resolved: string;
    try {
      resolved = resolveRuntimeId(id);
    } catch {
      continue; // unknown/uninstalled agent — nothing to warm
    }
    if (wanted.includes(resolved)) continue;
    const cached = modelQueryScratch.get(resolved);
    if (cached && openSessions.has(cached.id) && !sessionBusy(cached)) continue;
    if (modelQueryScratchPending.has(resolved)) continue;
    wanted.push(resolved);
  }
  // Warm serially, not in a burst: spinning up every agent subprocess at once
  // would spike a small node's memory/CPU right as the user is interacting. Each
  // build is cached (and de-duped) so this cost is paid at most once per runtime.
  void wanted.reduce(
    (chain, id) => chain.then(() => sessionForModelQuery(id).then(() => undefined, () => undefined)),
    Promise.resolve(),
  );
}

/**
 * Start a session on a GitHub repo. Clone/update the shared checkout, then branch
 * off the remote's default branch (origin/main) — or, when `opts.branch` names a
 * specific remote branch (the composer's branch pill), off that branch instead —
 * into an isolated git worktree named from the user's first message plus a short
 * random suffix for uniqueness. Each new repo-backed chat therefore gets its own
 * workspace + branch, ready to become a PR. Mirrors the issue-pickup worktree
 * flow (see runIssueTask).
 */
type SessionHelperOpts = {
  title?: string;
  runtimeId?: string;
  makeActive?: boolean;
  sandbox?: SandboxTier;
  /** A specific remote branch (the composer's branch pill) to base the new
   *  worktree on, instead of the repo's default branch. */
  branch?: string;
};

async function createRepoSession(parsed: ParsedRepo, opts: SessionHelperOpts = {}): Promise<SessionRecord> {
  const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
  const repoDir = await cloneOrUpdateRepo({ owner: parsed.owner, repo: parsed.repo, token, root: reposRoot });
  return createGitWorkspaceSession(repoDir, parsed, opts);
}

/**
 * Start a session in a workspace. If that workspace is already a GitHub checkout,
 * give the session the same branch/worktree isolation as an explicit repo-backed
 * session. This covers the common "connected to GitHub repo" path where the UI
 * only sends a workspace path, not an owner/repo slug.
 */
async function createWorkspaceSession(workspace: string, opts: SessionHelperOpts = {}): Promise<SessionRecord> {
  const parsed = await inferGitHubRepoFromWorkspace(workspace);
  if (parsed) {
    // Refresh origin so the session branches off the CURRENT remote default,
    // not the stale one this local checkout last fetched. The explicit
    // repo-pick path (createRepoSession → cloneOrUpdateRepo) already fetches;
    // this is the "workspace is an existing local checkout" path, which didn't.
    await fetchOrigin(workspace);
    return createGitWorkspaceSession(workspace, parsed, opts);
  }
  const record = await createSession(workspace, undefined, { runtimeId: opts.runtimeId, sandbox: opts.sandbox, makeActive: opts.makeActive });
  if (opts.title) { record.session.setName(`Session ${record.id.slice(0, 8)}`); persistSessionMetadata(record); }
  return record;
}

async function createGitWorkspaceSession(repoDir: string, parsed: ParsedRepo, opts: SessionHelperOpts = {}): Promise<SessionRecord> {
  // A requested branch (the composer's branch pill) bases the new worktree on
  // that remote branch instead of the repo's default; resolveBranchBaseRef
  // throws a clear error (surfaced as session.error / a 4xx) if it doesn't
  // exist on the remote, rather than silently falling back to the default.
  const base = opts.branch ? await resolveBranchBaseRef(repoDir, opts.branch) : await resolveDefaultBaseRef(repoDir);
  // Start from an opaque, git-safe unique branch. The first user message then
  // triggers maybeNameSession(), which renames both the session and local branch
  // before the first publish/PR attempt.
  const branch = `bivy/session-${randomBytes(6).toString("hex")}`;
  const record = await createSession(repoDir, undefined, {
    worktree: { branch, base },
    source: `repo:${parsed.slug}`,
    runtimeId: opts.runtimeId,
    sandbox: opts.sandbox,
    makeActive: opts.makeActive,
  });
  if (opts.title) { record.session.setName(`Session ${record.id.slice(0, 8)}`); persistSessionMetadata(record); }
  return record;
}

/**
 * Resolve the GitHub repo a session's worktree branch belongs to, for both
 * kinds of GitHub-connected sessions: a regular repo-backed session
 * (`repo:owner/repo`) and a GitHub-issue pickup (`issue:owner/repo#N` — the
 * trailing issue number is stripped before parsing). Sharing this lookup is
 * what lets `maybePushWorktreeBranch`/`maybeDetectPullRequest` below work the
 * same way for both: publish the branch and adopt/track a PR the agent opens
 * itself, with no issue-specific code.
 */
/** Parse a `record.source`/`MetadataSession.source` tag ("repo:owner/repo" or
 *  "issue:owner/repo#N") into its repo — shared by `repoSessionParts` (live
 *  sessions) and the metadata-only PR-refresh path (sessions not in memory). */
function parseRepoSource(source?: string): ParsedRepo | undefined {
  const src = source ?? "";
  const slug = src.startsWith("repo:")
    ? src.slice(5)
    : src.startsWith("issue:")
      ? src.slice(6).replace(/#\d+$/, "")
      : "";
  return slug ? parseRepo(slug) : undefined;
}

function repoSessionParts(record: SessionRecord): { wt: Worktree; parsed: ParsedRepo } | undefined {
  const wt = record.worktree;
  const parsed = parseRepoSource(record.source);
  return wt && parsed ? { wt, parsed } : undefined;
}

function gitAheadCount(base: string, cwd: string): number {
  const ahead = runGit(["rev-list", "--count", `${base}..HEAD`], cwd);
  return ahead ? Number(ahead) || 0 : 0;
}

/**
 * Publish a repo-backed session's worktree branch to the remote on its first
 * commit, so the work shows up on GitHub (and the branch has an upstream for
 * later pushes). Idempotent: no-op until the branch is ahead of origin's default
 * branch, and pushes only once per session. Best-effort — a failure (offline,
 * no token, no push rights) just leaves the branch local and retries next turn.
 */
async function maybePushWorktreeBranch(record: SessionRecord) {
  const parts = repoSessionParts(record);
  if (!parts || record.branchPushed || record.branchPushing) return;
  const { wt, parsed } = parts;

  record.branchPushing = true; // synchronous re-entry guard across turns
  try {
    const base = await resolveDefaultBaseRef(wt.repoRoot);
    if (gitAheadCount(base, wt.path) <= 0) return; // no commits yet — nothing to publish

    const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
    if (!token) return; // can't push without a token; the branch stays local

    const cfg: GitHubTaskConfig = { token, owner: parsed.owner, repo: parsed.repo, repoDir: wt.repoRoot, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
    await pushBranch(cfg, wt.path, wt.branch);
    record.branchPushed = true;
    broadcast({ type: "session.notice", sessionId: record.id, message: `Published branch ${wt.branch} to ${parsed.slug}.` });
    scheduleAdvertise();
  } finally {
    record.branchPushing = false;
  }
}

/** The single "primary" PR to surface on a one-badge row: an open PR if there
 *  is one, else the most-relevant recent one (the list is ordered open-first). */
function primaryPr(prs?: PrRef[]): PrRef | undefined {
  return prs && prs.length ? prs[0] : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// HTML-escape for the few browser pages the node serves itself (OAuth callback,
// GitHub App manifest). These pages interpolate values the caller can influence
// (`?error=`, provider/error strings), so every interpolation must be escaped to
// keep an attacker from injecting markup/script onto the node's own loopback
// origin — which, with loopback trusted by default, would be able to drive /api.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Order a merged PR set for a one-badge row: open first (the actionable one),
 *  then by PR number descending (newest first) within each state group. */
function sortPrs(prs: PrRef[]): PrRef[] {
  const rank = (s: PrState) => (s === "open" ? 0 : s === "merged" ? 1 : 2);
  return [...prs].sort((a, b) => rank(a.state) - rank(b.state) || (b.number ?? 0) - (a.number ?? 0));
}

/**
 * Harvest PR numbers this session references in its own transcript — the URL a
 * `gh pr create` / GitHub-MCP call returns, or that the agent restates in its
 * reply. Branch-scoped lookups only see the session's *own* worktree branch, so
 * this is what surfaces PRs a session opens on other branches (the multi-PR
 * case). Same-repo only, capped, best-effort. Trade-off: a PR the session merely
 * *mentions* (not opened) is also adopted — acceptable for coding sessions, whose
 * transcript PR URLs are overwhelmingly their own.
 */
function harvestPrNumbers(record: SessionRecord, owner: string, repo: string): Set<number> {
  const nums = new Set<number>();
  try {
    const json = JSON.stringify(record.session.getMessages());
    const re = new RegExp(`github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/pull/(\\d+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(json)) && nums.size < 30) {
      const n = Number(m[1]);
      if (n) nums.add(n);
    }
  } catch {
    // getMessages/stringify can throw on an odd runtime state — harvesting is a
    // best-effort augmentation, never let it break the after-turn hook.
  }
  return nums;
}

type PrState = PrRef["state"];

/**
 * Combine three PR signals into one fresh list, deduped by URL: (1) every PR
 * whose head is `branch`, (2) every PR referenced by number in `harvestNumbers`
 * (fetched individually for fresh state), and (3) every previously-known PR not
 * already re-surfaced by (1) or (2), re-fetched by number so a merge/close is
 * reflected even once its branch stops matching. Shared by the live-session path
 * (`refreshPullRequests`, which also harvests transcript-mentioned numbers) and
 * the metadata-only path (`refreshPullRequestsForMeta`, which doesn't have a
 * transcript to harvest — `harvestNumbers` is empty there).
 */
async function reconcilePrsAgainstGitHub(cfg: GitHubTaskConfig, branch: string, prevPrs: PrRef[] | undefined, harvestNumbers: Set<number>): Promise<PrRef[]> {
  const byUrl = new Map<string, PrRef>();
  for (const pr of await findPullRequestsForBranch(cfg, branch)) byUrl.set(pr.url, pr);

  const knownByNumber = new Set<number>();
  for (const pr of byUrl.values()) if (pr.number != null) knownByNumber.add(pr.number);

  for (const n of harvestNumbers) {
    if (knownByNumber.has(n)) continue;
    const pr = await getPullRequest(cfg, n);
    if (pr) { byUrl.set(pr.url, pr); if (pr.number != null) knownByNumber.add(pr.number); }
  }

  // Keep the stale entry if the fetch fails (a token blip shouldn't drop a PR
  // the user already saw).
  for (const prev of prevPrs ?? []) {
    if (byUrl.has(prev.url)) continue;
    const pr = prev.number != null ? await getPullRequest(cfg, prev.number) : undefined;
    byUrl.set(prev.url, pr ?? prev);
  }

  return sortPrs([...byUrl.values()]);
}

/**
 * Reconcile this session's PR list against GitHub. Updates `record.prs` and
 * keeps `record.prUrl` on the live *open* PR (undefined once all are
 * merged/closed, so the "already has a PR" guards allow a fresh one). Persists
 * + broadcasts only on change, so it's cheap after each turn. Also the engine
 * behind the on-demand `/github-status` command and REST endpoint — those force
 * a call here regardless of whether the session is mid-turn.
 */
async function refreshPullRequests(record: SessionRecord): Promise<boolean> {
  const parts = repoSessionParts(record);
  if (!parts) return false;
  const { wt, parsed } = parts;
  const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
  if (!token) return false; // can't query without a token
  const cfg: GitHubTaskConfig = { token, owner: parsed.owner, repo: parsed.repo, repoDir: wt.repoRoot, label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
  const prs = await reconcilePrsAgainstGitHub(cfg, wt.branch, record.prs, harvestPrNumbers(record, parsed.owner, parsed.repo));
  const openUrl = prs.find((p) => p.state === "open")?.url;
  const changed = JSON.stringify(prs) !== JSON.stringify(record.prs ?? []) || openUrl !== record.prUrl;
  if (!changed) return false;
  record.prs = prs;
  record.prUrl = openUrl;
  if (prs.length) record.prSuggested = true; // a PR exists (or did) — don't nudge
  persistSessionMetadata(record);
  broadcast({ type: "session.pr_opened", sessionId: record.id, prUrl: openUrl, prs });
  scheduleAdvertise();
  return true;
}

/**
 * Same reconciliation as `refreshPullRequests`, but for a session that's only a
 * persisted `MetadataSession` row — not live in `openSessions`. Used by the
 * global "refresh GitHub status" scan so reconciling hundreds of finished
 * sessions doesn't mean spinning up hundreds of runtimes (expensive, and
 * unnecessary: the two GitHub lookups this needs only take owner/repo/branch/
 * token, none of which require a live session or even the worktree to still
 * exist on disk). Trade-off vs. the live path: no transcript to harvest, so a PR
 * opened on a second branch that was never independently listed won't be
 * picked up here — only previously-known PRs and the session's own branch are
 * reconciled. That's exactly what's needed to flip a stale `open` badge to
 * merged/closed.
 */
async function refreshPullRequestsForMeta(meta: MetadataSession): Promise<boolean> {
  if (!meta.branch) return false;
  const parsed = parseRepoSource(meta.source);
  if (!parsed) return false;
  const token = await resolveTokenForRepo(parsed.owner, parsed.repo);
  if (!token) return false;
  const cfg: GitHubTaskConfig = { token, owner: parsed.owner, repo: parsed.repo, repoDir: meta.worktree ?? "", label: "bivy", claimLabel: "bivy:in-progress", pollMs: 60_000 };
  const prs = await reconcilePrsAgainstGitHub(cfg, meta.branch, meta.prs, new Set());
  const openUrl = prs.find((p) => p.state === "open")?.url;
  const changed = JSON.stringify(prs) !== JSON.stringify(meta.prs ?? []) || openUrl !== meta.prUrl;
  if (!changed) return false;
  metadata.upsertSession({ id: meta.id, prs, prUrl: openUrl });
  broadcast({ type: "session.pr_opened", sessionId: meta.id, prUrl: openUrl, prs });
  scheduleAdvertise();
  return true;
}

/**
 * Global "refresh GitHub status" scan: reconcile every session this node has
 * ever tracked (live or not) that carries PR state against GitHub, so stale
 * `open` badges left behind by finished/detached sessions get a chance to flip
 * to merged/closed without waiting for that session to take another turn. Live
 * sessions go through the full `refreshPullRequests` (transcript harvest
 * included); everything else through the cheaper metadata-only path. Bounded
 * concurrency keeps the GitHub call count sane across a large session list —
 * reuses the node's GitHub-queue concurrency setting as the cap.
 */
async function refreshAllPullRequestStatuses(): Promise<{ scanned: number; changed: number }> {
  const candidates = metadata.listSessions().filter((meta) => {
    if (!meta.branch || !parseRepoSource(meta.source)) return false;
    return Boolean(meta.prUrl) || Boolean(meta.prs && meta.prs.length > 0);
  });
  let scanned = 0;
  let changed = 0;
  let next = 0;
  const concurrency = Math.max(1, Math.min(nodeGithubMaxConcurrent() || 4, candidates.length || 1));
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      const meta = candidates[i];
      scanned++;
      try {
        const live = openSessions.get(meta.id);
        const didChange = live ? await refreshPullRequests(live) : await refreshPullRequestsForMeta(meta);
        if (didChange) changed++;
      } catch (error) {
        console.warn(`[github] could not refresh PR status for session ${meta.id}`, error);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { scanned, changed };
}

/**
 * Detect (and keep in sync) the pull requests for this session's branch — PRs
 * opened out-of-band by the agent's `gh pr create`, the GitHub API, or the web
 * UI, plus state changes (a PR merging or closing) on ones already known. Runs
 * after each turn (see the agent_end hook); a single cheap GitHub lookup. Unlike
 * the old detector it does NOT stop once a PR is known — it keeps refreshing so
 * the badge tracks the PR through merge.
 */
async function maybeDetectPullRequest(record: SessionRecord) {
  if (!repoSessionParts(record) || record.prOpening || record.prDetecting) return;
  record.prDetecting = true;
  try {
    await refreshPullRequests(record);
  } finally {
    record.prDetecting = false;
  }
}

approvals.onRequest((request: ApprovalRequest) => {
  persistApprovalRequest(request);
  scheduleAdvertise();
  if (approvalMode === "never") {
    resolveApproval(request.id, true);
    broadcast({ type: "approval.resolved", id: request.id, approved: true });
    scheduleAdvertise();
    return;
  }
  broadcast({ type: "approval.created", approval: request });
  const rec = resolveSession(request.sessionId);
  if (!rec?.isWorking && !rec?.remoteActive) {
    void sendNotificationHint({
      kind: "approval_requested",
      sessionId: request.sessionId,
      attentionId: request.id,
      title: "Approval needed",
      body: `${sessionNotifyLabel(rec)} wants to run something — tap to approve or deny.`,
    });
  }
});

const app = express();
app.use(express.json({ limit: "25mb" }));
// Defense-in-depth Content-Security-Policy for every node response. The node
// hosts no web UI — only the JSON API and a couple of minimal, self-owned
// browser pages (OAuth callback, GitHub App manifest) — so a strict default of
// `script-src 'none'` is safe and blocks injected inline script even if some
// future interpolation is missed. The GitHub-App manifest form legitimately
// needs one inline script to auto-submit to github.com; that single route
// overrides this header with a per-request nonce (see `/github/app/manifest/new`).
// `nosniff` stops a JSON response from being reinterpreted as HTML.
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'none'; script-src 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
// The node is a pure DATA PLANE: it serves the JSON API (/api), the WebSocket
// (/ws), a liveness probe (/healthz), and a few non-UI browser flows it owns
// (OAuth callback, GitHub App manifest). It does NOT host the web UI — the
// React/Vite PWA (@bivy/web) is served exclusively by the hosted or self-hosted
// control plane. `/` returns a small informational stub for anyone who points a
// browser straight at the node.
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res
    .status(200)
    .type("text/plain")
    .send("Bivy node — data plane (API + WebSocket) only. Open the Bivy app via your control plane.");
});
// Cheap, always-200 liveness probe. The CLI uses this to tell whether the node
// is up.
app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json({ ok: true });
});

// OAuth redirect target for integrations. Reached by a top-level browser
// redirect from the provider (no auth header), so it must precede the auth
// middleware. The unguessable `state` (minted server-side when the user starts
// the flow) is the CSRF guard.
app.get("/api/integrations/oauth/callback", async (req, res) => {
  const state = String(req.query.state ?? "");
  const code = String(req.query.code ?? "");
  const oauthError = String(req.query.error ?? "");
  const page = (title: string, body: string) => {
    const t = escapeHtml(title);
    return `<!doctype html><meta charset="utf-8"><title>${t}</title><body style="font:16px system-ui;margin:3rem;max-width:32rem"><h2>${t}</h2><p>${escapeHtml(body)}</p><p>You can close this tab and return to Bivy.</p></body>`;
  };
  if (oauthError) return res.status(400).send(page("Connection failed", `The provider returned: ${oauthError}`));
  if (!state || !code) return res.status(400).send(page("Connection failed", "Missing authorization code."));
  try {
    const conn = await integrations.completeOAuth(state, code);
    broadcast({ type: "integrations.updated", integrations: integrations.list() });
    void refreshSessionAfterAuth();
    res.send(page("Connected", `${conn.id}${conn.accountLabel ? ` — ${conn.accountLabel}` : ""} is now connected.`));
  } catch (error) {
    res.status(400).send(page("Connection failed", String(error instanceof Error ? error.message : error)));
  }
});

// Loopback-only git credential endpoint. The daemon-owned git credential helper
// (src/git-auth.ts) calls this on every git operation to get a FRESH token for a
// repo, so nothing long-lived or stale is stored on disk — important now that
// tokens can be short-lived (~1h) GitHub App installation tokens. Gated exactly
// like the bootstrap endpoint (loopback + the 0600 per-process bootstrap secret,
// so other local users on a shared host can't harvest tokens). Placed before the
// /api auth middleware because the helper is a bare process with no device token.
app.get("/api/git-credential", async (req, res) => {
  const ctx = resolveAuth(identity, req);
  if (!ctx.loopback) return res.status(403).json({ error: "git-credential is loopback-only" });
  if (!bootstrapSecretAccepted(req)) return res.status(403).json({ error: "bootstrap secret required" });
  const owner = String(req.query.owner ?? "");
  const repo = String(req.query.repo ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return res.status(400).json({ error: "invalid owner/repo" });
  }
  try {
    const token = await resolveTokenForRepo(owner, repo);
    if (!token) return res.status(404).json({ error: "no token available for this repo" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ token });
  } catch (error) {
    return res.status(500).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

// Loopback-only bootstrap: a same-machine caller (the CLI, a direct-mode web
// client, or the git-credential helper) mints itself a device token so it uses
// the same auth path as remote clients (Step 0c). Rejected off-loopback.
//
// Loopback alone is NOT sufficient isolation on a multi-user host: every local
// account shares 127.0.0.1, so any local user/process could otherwise mint a
// token. We therefore also require a per-process bootstrap secret that is only
// available to whoever launched the daemon (printed to its stdout and written
// to a 0600 file the owner can read). The caller reads that secret and presents
// it here. Set BIVY_OPEN_BOOTSTRAP=1 to drop this requirement on trusted
// single-user machines.
//
// Registered BEFORE the general `/api` auth middleware (below): this route is
// how a loopback caller with no token gets one in the first place, so it can't
// itself require the middleware's isAuthorized() to already be satisfied — on
// a host where the general loopback bypass is off (multi-user detection,
// BIVY_REQUIRE_LOCAL_AUTH=1), that would make bootstrap unreachable. It has its
// own, stricter gate (loopback + secret) instead, exactly like /api/git-credential
// above.
function bootstrapSecretAccepted(req: express.Request): boolean {
  if (process.env.BIVY_OPEN_BOOTSTRAP === "1") return true;
  const headerValue = req.headers["x-bivy-bootstrap"];
  const provided = String((Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? req.body?.bootstrap ?? "");
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(bootstrapSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/api/auth/bootstrap", (req, res) => {
  const ctx = resolveAuth(identity, req);
  if (!ctx.loopback) return res.status(403).json({ error: "Bootstrap is loopback-only" });
  if (!bootstrapSecretAccepted(req)) {
    return res.status(403).json({ error: "Bootstrap secret required. Open the URL printed by the launcher (bivy open)." });
  }
  const name = String(req.body?.name ?? "Local device");
  const { device, token } = identity.createDevice(name);
  broadcast({ type: "device.created", device });
  res.json({ ok: true, device, token });
});

// All other /api routes require auth (loopback may bypass, per config and host
// — see loopbackAllowed()/isMultiUserHost() in src/auth.ts).
app.use("/api", authMiddleware(identity));

// Reload relay.json without forcing the user to restart the whole node. This is
// used by `bivy relay:setup` after it enrolls the node.
app.post("/api/relay/reload", (_req, res) => {
  const ok = startRelayIfConfigured();
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: "Relay not configured" });
});

// Link a remote web/PWA device through the relay. Mints a short-lived,
// node-scoped client grant from the control plane and packages it with the
// relay URL + E2E key into a URL the phone opens (shown as a QR). The E2E key
// travels only in this QR — never through the relay.
app.post("/api/relay/link", async (_req, res, next) => {
  try {
    const config = loadRelayConfig(appDir);
    if (!config) return res.status(400).json({ error: "Relay not configured. Run: npm run relay:setup" });
    if (!config.controlPlaneUrl) return res.status(400).json({ error: "relay.json missing controlPlaneUrl" });

    const grantResponse = await fetch(`${config.controlPlaneUrl.replace(/\/$/, "")}/node/link-grant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.enrollmentToken}` },
      body: JSON.stringify({}),
    });
    const grantText = await grantResponse.text();
    let grant: any = null;
    try {
      grant = grantText ? JSON.parse(grantText) : null;
    } catch {
      return res.status(502).json({ error: `Link grant failed: control plane returned non-JSON (${grantResponse.status})${grantText ? `: ${grantText.slice(0, 240)}` : ""}` });
    }
    if (!grantResponse.ok) return res.status(502).json({ error: `Link grant failed (${grantResponse.status}): ${grant?.error ?? grantText ?? "empty response"}` });
    if (!grant?.sessionToken) return res.status(502).json({ error: `Link grant failed: ${JSON.stringify(grant)}` });

    // The remote browser gets: where to reach the relay + control plane, an account
    // session (to list/switch nodes), THIS node's id/name + X25519 public key,
    // and a single-use pairing secret. The room key is NOT in the QR — the phone
    // obtains it via the ECDH handshake over the relay (see src/pairing-crypto.ts).
    const payload = {
      controlPlane: config.controlPlaneUrl,
      relay: grant.relayUrl ?? config.url,
      session: grant.sessionToken,
      node: { id: identity.nodeId, name: identity.name, pub: pairingStore.nodePublicKeyB64() },
      pairSecret: pairingStore.issuePairSecret(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const base = (config.clientBaseUrl ?? config.controlPlaneUrl).replace(/\/$/, "");
    const url = `${base}/#${encoded}`;
    res.json({ ok: true, url });
  } catch (error) {
    next(error);
  }
});

// Linked remote web/PWA devices paired via the X25519 handshake. Local-UI
// authenticated like the rest of /api.
app.get("/api/devices", (_req, res) => {
  res.json({ devices: pairingStore.listDevices() });
});

// Revoke a device: drop it, rotate the room key, and push the re-wrapped key to
// the remaining devices so they stay connected while the revoked one is cut off.
app.delete("/api/devices/:id", (req, res) => {
  const deviceId = String(req.params.id);
  const deliveries = pairingStore.revokeDevice(deviceId);
  if (!deliveries) return res.status(404).json({ ok: false, error: "Unknown device" });
  metadata.revokeDevice(deviceId);
  syncPairingMetadata();
  relay?.pushRotate(deliveries);
  broadcast({ type: "devices.updated", devices: pairingStore.listDevices() });
  res.json({ ok: true, devices: pairingStore.listDevices() });
});

app.get("/api/node/info", (_req, res) => {
  const selectedRuntimeId = active?.runtimeId ?? defaultRuntimeId;
  const runtimeInfo = runtimeList(selectedRuntimeId).find((runtime) => runtime.id === selectedRuntimeId);
  const structuredControls = runtimeInfo?.protectionLevel === "native-sandbox" || runtimeInfo?.protectionLevel === "tool-controls";
  res.json({
    nodeId: identity.nodeId,
    name: identity.name,
    piDir,
    defaultWorkspace,
    activeSessionId: active?.id,
    approvalMode,
    guardrails: {
      mode: approvalMode,
      defaultAllow: approvalMode === "autonomous" || approvalMode === "never",
      enforcementLevel: runtimeInfo?.protectionLevel ?? "user-permissions",
      protection: runtimeInfo?.protectionLabel ?? "Runs as your user",
      workspaceBoundary: structuredControls
        ? "Structured file tools are checked against the active workspace; shell commands are not an OS isolation boundary."
        : "Not guaranteed by Bivy for this runtime. Run it in a container/VM when isolation is required.",
      denyList: structuredControls
        ? "Known catastrophic shell commands are heuristically blocked; this catches accidents, not adversarial bypasses."
        : "No universal Bivy command interception is available for this runtime.",
      strictApprovalOptIn: "Set approval mode to risky or always for prompt-heavy review where this runtime exposes tool controls.",
    },
    runtime: { ...runtimeSummary(getRuntime(selectedRuntimeId)), ...runtimeInfo },
    defaultRuntimeId,
    sandbox: sandboxInfo(),
  });
});

// One-tap "Update this node" from the app's version-mismatch banner, for
// direct/LAN clients (the relay path uses the RELAY_COMMANDS "node.update"
// handler). Both call the same runBivyUpdate.
app.post("/api/node/update", (_req, res) => {
  const result = runBivyUpdate();
  if (result.ok) res.json({ ok: true });
  else res.status(500).json({ ok: false, error: result.error });
});

// Build collectNodeStats() options, resolving the optional session so the panel
// can attribute a session-scoped tier (its live agent process + workspace size).
function nodeStatsOptsFor(sessionId?: unknown) {
  const record = resolveSession(sessionId);
  return {
    workspacePath: defaultWorkspace,
    appDir,
    nodeId: identity.nodeId,
    name: identity.name,
    sessionPid: record?.session.activePid?.(),
    sessionWorkspace: record?.worktree?.path ?? record?.workspace,
  };
}

// Node-resource snapshot (memory/CPU/storage) for the header "Node stats" panel.
// Direct-mode counterpart of the relay `node.stats` command.
app.get("/api/node/stats", async (req, res, next) => {
  try {
    const stats = await collectNodeStats(nodeStatsOptsFor(req.query.sessionId));
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// Enforcement snapshot for the current node: the tier each agent enforces through
// its own native sandbox (Codex --sandbox, Gemini --approval-mode, Claude
// permissionMode; see src/harness/sandbox.ts). Surfaced so clients can see the
// policy the node applies.
function sandboxInfo() {
  return {
    tier: sandboxTier(),
  };
}

// Redacted diagnostics bundle (B4d) — a shareable support export with no secrets,
// prompts, transcripts, diffs, or repo content: versions, health counters, a
// whitelisted set of config flags, and the activation stage record.
app.get("/api/diagnostics", (_req, res) => {
  const relayConfig = loadRelayConfig(appDir);
  const selectedRuntimeId = active?.runtimeId ?? defaultRuntimeId;
  const runtimeInfo = runtimeList(selectedRuntimeId).find((runtime) => runtime.id === selectedRuntimeId);
  const report = buildDiagnosticsReport({
    version: currentVersion() ?? undefined,
    platform: process.platform,
    nodeVersion: process.version,
    relayConfigured: Boolean(relayConfig),
    health: {
      sessionsOpen: new Set(openSessions.values()).size,
      sessionsIndexed: metadata.listSessions().length,
      enforcementLevel: runtimeInfo?.protectionLevel ?? "user-permissions",
      approvalMode,
      relayConnected: Boolean(relay?.connected),
    },
    env: process.env as Record<string, string | undefined>,
    // The node knows it is online and which runtime is selectable; the client's
    // setup readiness fills the rest. This baseline still records the golden path.
    activation: activationRecord({ nodeOnline: true, runtimeReady: Boolean(runtimeInfo) }),
    generatedAt: new Date().toISOString(),
  });
  res.json(report);
});

app.get("/api/status", (_req, res) => {
  const relayConfig = loadRelayConfig(appDir);
  const selectedRuntimeId = active?.runtimeId ?? defaultRuntimeId;
  const runtimeInfo = runtimeList(selectedRuntimeId).find((runtime) => runtime.id === selectedRuntimeId);
  const workspaceBoundary = runtimeInfo?.protectionLevel === "native-sandbox" || runtimeInfo?.protectionLevel === "tool-controls";
  res.json({
    ok: true,
    nodeId: identity.nodeId,
    name: identity.name,
    // The running daemon's package version, so `bivy status` (and any client)
    // can report which build the node is on.
    version: currentVersion() ?? null,
    port,
    workspace: defaultWorkspace,
    appDir,
    piDir,
    approvalMode,
    guardrails: {
      autonomousDefault: approvalMode === "autonomous",
      workspaceBoundary,
      enforcementLevel: runtimeInfo?.protectionLevel ?? "user-permissions",
      protection: runtimeInfo?.protectionLabel ?? "Runs as your user",
      strictApprovalOptIn: true,
    },
    relay: {
      configured: Boolean(relayConfig),
      // Real link state (relay sent `ready`), not merely "a connector exists".
      connected: Boolean(relay?.connected),
      controlPlaneUrl: relayConfig?.controlPlaneUrl,
      relayUrl: relayConfig?.url,
      ...(relay?.lastError ? { lastError: relay.lastError } : {}),
    },
    sessions: {
      open: new Set(openSessions.values()).size,
      indexed: metadata.listSessions().length,
      active: active?.id ?? null,
      // Sessions mid-turn (streaming a reply or running a tool) right now — a
      // `bivy update`/`bivy restart` polls this so it can wait for live work to
      // finish instead of SIGTERMing an in-flight tool call (issue #474).
      busy: [...new Set(openSessions.values())].filter(sessionBusy).length,
    },
    devices: { paired: pairingStore.listDevices().length, localTokens: identity.listDevices().length },
    approvals: { pending: approvals.list().filter((a) => a.status === "pending").length, recent: metadata.listApprovals(20) },
    eventLog: { ...eventLog.diskUsage(), ...eventLog.health(), affectedSessions: eventLogIssues.size },
    attachments: attachmentGcStats,
    turnWatchdog: { enabled: turnTimeoutMs > 0, timeoutMs: turnTimeoutMs },
    updatedAt: new Date().toISOString(),
  });
});

app.get("/api/billing/config", (_req, res) => {
  const config = loadRelayConfig(appDir);
  const base = config?.clientBaseUrl ?? config?.controlPlaneUrl;
  res.json({
    configured: Boolean(base),
    controlPlaneUrl: config?.controlPlaneUrl ?? null,
    accountUrl: base ? `${base.replace(/\/$/, "")}/?account=1` : null,
  });
});

app.get("/api/settings", (_req, res) => {
  res.json({ approvalMode });
});

// Per-node defaults (default agent/model/sandbox + GitHub concurrency) for the
// Settings → Nodes section. Direct-mode twin of the node.settings.get/set relay
// messages.
app.get("/api/node/settings", (_req, res) => {
  res.json(nodeSettingsSnapshot());
});

app.post("/api/node/settings", async (req, res, next) => {
  try {
    const settings = await applyNodeSettings((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/workspaces", (_req, res) => {
  res.json({ workspaces: loadSavedWorkspaces(), defaultWorkspace, active: active?.workspace });
});

app.post("/api/workspaces", (req, res, next) => {
  try {
    const workspaces = addSavedWorkspace(req.body?.path);
    broadcast({ type: "workspaces.updated", workspaces });
    res.json({ ok: true, workspaces });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/workspaces", (req, res, next) => {
  try {
    const workspaces = removeSavedWorkspace(req.body?.path ?? req.query?.path);
    broadcast({ type: "workspaces.updated", workspaces });
    res.json({ ok: true, workspaces });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/settings", (req, res, next) => {
  try {
    const mode = approvalModeFrom(req.body?.approvalMode);
    if (!mode) return res.status(400).json({ error: "Invalid approval mode" });
    saveApprovalMode(mode);
    if (mode === "never") {
      for (const request of approvals.resolveAll(true)) {
        persistApprovalRequest(request, Date.now());
        broadcast({ type: "approval.resolved", id: request.id, approved: true });
      }
    }
    broadcast({ type: "settings.updated", approvalMode });
    res.json({ ok: true, approvalMode });
  } catch (error) {
    next(error);
  }
});

app.post("/api/node/name", (req, res, next) => {
  try {
    const prev = identity.name;
    const name = identity.setName(String(req.body?.name ?? ""));
    void advertiseNodeName(name, prev);
    broadcast({ type: "node.updated", name });
    res.json({ ok: true, name });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/rename", (req, res, next) => {
  try {
    const sid = String(req.body?.sessionId ?? req.body?.id ?? "");
    const newName = String(req.body?.name ?? "").trim();
    if (!sid || !newName) return res.status(400).json({ error: "sessionId and name required" });
    const rec = resolveSession(sid);
    if (!rec) return res.status(404).json({ error: "Session not found" });
    rec.session.setName(newName);
    persistSessionMetadata(rec);
    broadcast({ type: "session.renamed", sessionId: rec.id, sessionFile: rec.sessionFile, name: newName });
    scheduleAdvertise();
    res.json({ ok: true, name: newName });
  } catch (error) {
    next(error);
  }
});

// Local device token management for the loopback development UI.
app.get("/api/devices", (_req, res) => {
  res.json(identity.listDevices());
});

app.post("/api/devices", (req, res, next) => {
  try {
    const { device, token } = identity.createDevice(String(req.body?.name ?? ""));
    broadcast({ type: "device.created", device });
    // `token` is returned exactly once and never recoverable afterwards.
    res.json({ ok: true, device, token });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/devices/:id", (req, res) => {
  const removed = identity.revokeDevice(req.params.id);
  if (removed) broadcast({ type: "device.revoked", id: req.params.id });
  res.status(removed ? 200 : 404).json({ ok: removed });
});

app.get("/api/commands", (_req, res) => {
  res.json(publicCommands());
});

function publicModel(model: any, current?: any) {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    current: Boolean(current && current.provider === model.provider && current.id === model.id),
    // Absent on runtimes that only ever report connected models (e.g. Claude
    // Code SDK) — treat as connected so the picker doesn't grow a bogus
    // "other models" section for them.
    configured: model.configured !== false,
  };
}

/**
 * Every model the picker should offer for this session: the connected ones
 * from getModels() (unchanged order/behavior — first in the list, exactly
 * what the picker showed before #390), followed by one summary row per
 * *other* provider the runtime supports but isn't authenticated for yet
 * (getAllModels(), when the runtime implements it), flagged
 * `configured: false` so the UI can render them in a separate "other models"
 * section with an inline connect action. A runtime without getAllModels() (or
 * one that reports no models at all) simply contributes no "other" tail.
 *
 * This is deliberately a per-*provider* summary, not one row per unconnected
 * model: Pi's full catalog is ~1000 models across ~35 providers (some, like
 * openrouter, list 200+ on their own), and a credential is granted per
 * provider anyway — one API key/OAuth sign-in unlocks every model under it at
 * once. Dumping the whole catalog into `models` would bloat every models.list
 * reply (sent on every reconnect, not just when the picker is open) and turn
 * "other models" into an unscrollable wall.
 */
async function publicModelsList(session: any, current: any) {
  const connected = (await session.getModels()).map((model: any) => publicModel(model, current));
  if (typeof session.getAllModels !== "function") return connected;
  const connectedProviders = new Set(connected.map((m: any) => m.provider));
  const counts = new Map<string, number>();
  for (const model of await session.getAllModels()) {
    if (connectedProviders.has(model.provider)) continue;
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  const other = [...counts.entries()].map(([provider, modelCount]) => ({
    provider,
    id: provider,
    name: provider,
    configured: false,
    modelCount,
  }));
  return [...connected, ...other];
}

function publicThinkingInfo(session: any) {
  const supports = typeof session.supportsThinking === "function" ? session.supportsThinking() : false;
  const level = typeof session.getThinkingLevel === "function" ? session.getThinkingLevel() : undefined;
  const levels = typeof session.getAvailableThinkingLevels === "function" ? session.getAvailableThinkingLevels() : [];
  return {
    supportsThinking: supports,
    thinkingLevel: level || (supports ? "medium" : "off"),
    availableThinkingLevels: levels.length ? levels : (supports ? ["off", "minimal", "low", "medium", "high"] : ["off"]),
  };
}

app.get("/api/models", async (req, res, next) => {
  try {
    const requestedSessionId = typeof req.query.sessionId === "string" && req.query.sessionId ? req.query.sessionId : undefined;
    const requestedPath = typeof req.query.path === "string" ? req.query.path : undefined;
    const wantedRuntimeId = typeof req.query.runtimeId === "string" && req.query.runtimeId ? req.query.runtimeId : undefined;
    let record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, requestedPath) : active;
    if (requestedSessionId && !record) return res.status(404).json({ error: "Session not found" });
    if (!requestedSessionId && wantedRuntimeId && record?.runtimeId !== wantedRuntimeId) record = undefined;
    record ??= await sessionForModelQuery(wantedRuntimeId);
    const session = record.session;
    const current = session.getCurrentModel();
    const models = await publicModelsList(session, current);
    const thinking = publicThinkingInfo(session);
    res.json({ sessionId: record.id, current: current ? publicModel(current, current) : null, models, thinking });
  } catch (error) {
    next(error);
  }
});

// Warm the per-runtime model-query scratch ahead of the first agent switch (see
// prefetchModels). Fire-and-forget: returns immediately while the runtimes spin
// up in the background, so the picker never blocks on it.
app.post("/api/models/prefetch", (req, res) => {
  const ids = Array.isArray(req.body?.runtimeIds)
    ? req.body.runtimeIds.filter((id: unknown): id is string => typeof id === "string" && !!id).slice(0, 16)
    : [];
  if (ids.length) prefetchModels(ids);
  res.json({ ok: true });
});

app.post("/api/models/select", async (req, res, next) => {
  try {
    const requestedSessionId = typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : undefined;
    let record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, req.body?.path) : active;
    if (requestedSessionId && !record) return res.status(404).json({ error: "Session not found" });
    record ??= await sessionForModelQuery();
    const provider = String(req.body?.provider ?? "").trim();
    const id = String(req.body?.id ?? "").trim();
    if (!provider || !id) return res.status(400).json({ error: "Missing model provider or id" });

    const session = record.session;
    try {
      await session.setModel(provider, id);
    } catch {
      return res.status(404).json({ error: "Model is not available" });
    }
    const selected = publicModel(session.getCurrentModel(), session.getCurrentModel());
    const thinking = publicThinkingInfo(session);
    broadcast({ type: "model.updated", sessionId: record.id, model: selected });
    broadcast({ type: "thinking.updated", sessionId: record.id, thinking });
    res.json({ ok: true, sessionId: record.id, model: selected, thinking });
  } catch (error) {
    next(error);
  }
});

app.post("/api/thinking/set-level", async (req, res, next) => {
  try {
    const requestedSessionId = typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : undefined;
    let record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, req.body?.path) : active;
    if (requestedSessionId && !record) return res.status(404).json({ error: "Session not found" });
    record ??= await sessionForModelQuery();
    const level = String(req.body?.level ?? "").trim();
    const session = record.session;
    if (typeof session.setThinkingLevel !== "function" || !level) {
      return res.status(400).json({ error: "Thinking level not supported for current model/session" });
    }
    try {
      session.setThinkingLevel(level);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Failed to set thinking level" });
    }
    const thinking = publicThinkingInfo(session);
    broadcast({ type: "thinking.updated", sessionId: record.id, thinking });
    res.json({ ok: true, sessionId: record.id, thinking });
  } catch (error) {
    next(error);
  }
});

// --- Local / custom models (Ollama, LM Studio, vLLM, etc) ---
// Bivy's registry (local-model-store.ts) is the source of truth; Pi reads a
// regenerated projection. These REST routes serve the same-origin (direct)
// transport; the relay transport uses the models.custom.* WS commands.
app.get("/api/models/custom", async (_req, res, next) => {
  try {
    res.json({ providers: await localModelSummaries() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/models/custom", async (req, res, next) => {
  try {
    const result = await persistLocalModelSave(req.body || {});
    res.json({ ok: true, provider: result.id, providers: await localModelSummaries() });
  } catch (error) {
    if (error instanceof Error && /baseUrl is required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.delete("/api/models/custom/:id", async (req, res, next) => {
  try {
    await persistLocalModelRemove(String(req.params.id || ""));
    res.json({ ok: true, providers: await localModelSummaries() });
  } catch (error) {
    if (error instanceof Error && /provider id required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

// --- Rulesets (run-orchestration policy; docs/rulesets.md) ---
// Bivy's registry (ruleset-store.ts) is the source of truth. These REST routes
// serve the same-origin (direct) transport; the relay transport uses the
// rulesets.* WS commands. Validation (400) mirrors validateRuleset's message.
app.get("/api/rulesets", (_req, res, next) => {
  try {
    res.json({ rulesets: rulesetInfos() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rulesets", (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const active = typeof body.active === "boolean" ? (body.active as boolean) : undefined;
    const result = persistRulesetSave(body.ruleset ?? body, active);
    res.json({ ok: true, name: result.name, rulesets: rulesetInfos() });
  } catch (error) {
    if (error instanceof Error && /^Invalid ruleset:|ruleset name required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.delete("/api/rulesets/:name", (req, res, next) => {
  try {
    persistRulesetRemove(String(req.params.name || ""));
    res.json({ ok: true, rulesets: rulesetInfos() });
  } catch (error) {
    if (error instanceof Error && /ruleset name required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

// Built-in quick-add presets for common local inference servers.
const LOCAL_MODEL_PRESETS = [
  { id: "ollama", name: "Ollama (default)", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", note: "Run: ollama serve + ollama pull llama3.1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", api: "openai-completions", apiKey: "lm-studio", note: "LM Studio local server" },
  { id: "vllm", name: "vLLM / OpenAI compat", baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "vllm", note: "vLLM server" },
  { id: "sglang", name: "SGLang", baseUrl: "http://localhost:30000/v1", api: "openai-completions", apiKey: "local", note: "SGLang server" },
  { id: "azure", name: "Azure OpenAI", baseUrl: "https://YOUR-RESOURCE.openai.azure.com", api: "azure-openai-responses", note: "Set base URL to your resource; add a model per deployment (model id = deployment name); paste the Azure API key." },
];

/** Presets, augmented (best effort) with a remote catalog for PWA suggestions. */
async function localModelPresets(): Promise<any[]> {
  const presets = [...LOCAL_MODEL_PRESETS];
  try {
    const remoteUrl = process.env.BIVY_MODEL_CATALOG_URL || "https://bivy.sh/api/models/local-catalog.json";
    const r = await fetch(remoteUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined as any });
    if (r.ok) {
      const remote = await r.json().catch(() => ({}));
      if (Array.isArray(remote?.presets)) presets.push(...remote.presets);
    }
  } catch {
    /* offline is fine — built-ins still work */
  }
  return presets;
}

// Quick presets / discover from remote catalog (served locally, can be overridden by remote PWA)
app.get("/api/models/catalog", async (_req, res) => {
  res.json({ presets: await localModelPresets() });
});

app.get("/api/runtimes", (_req, res) => {
  const activeAgent = active?.runtimeId ?? defaultRuntimeId;
  res.json({ current: runtimeSummary(getRuntime(defaultRuntimeId)), activeAgent, runtimes: runtimeList(activeAgent) });
});

app.post("/api/runtimes/install", async (req, res) => {
  const id = String(req.body?.id ?? "").trim().toLowerCase();
  const spec = runtimeInstallSpec(id);
  if (!spec) return res.status(400).json({ error: "This agent does not have an automatic installer on this node.", runtimes: runtimeList(active?.runtimeId ?? defaultRuntimeId) });

  const before = runtimeList().find((runtime) => runtime.id === spec.id);
  if (before?.status === "available") return res.json({ ok: true, alreadyInstalled: true, runtimes: runtimeList(active?.runtimeId ?? defaultRuntimeId) });

  try {
    const result = await runInstallCommand(spec);
    const activeAgent = active?.runtimeId ?? defaultRuntimeId;
    const runtimes = runtimeList(activeAgent);
    broadcast({ type: "runtime.updated", current: runtimeSummary(getRuntime(defaultRuntimeId)), runtimes });
    res.json({ ok: true, output: result.output, runtimes });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error), runtimes: runtimeList(active?.runtimeId ?? defaultRuntimeId) });
  }
});

// Sets the DEFAULT agent for new sessions (non-destructive — existing sessions
// keep their agent). To run a different agent, create a session with `agent`.
app.post("/api/runtimes/select", async (req, res) => {
  try {
    const rt = await setDefaultRuntime(String(req.body?.id ?? ""));
    res.json({ ok: true, current: runtimeSummary(rt), activeAgent: active?.runtimeId ?? rt.id, runtimes: runtimeList(rt.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), runtimes: runtimeList(defaultRuntimeId) });
  }
});

app.get("/api/git/status", (_req, res) => {
  res.json(active ? gitStatus(active.workspace) : null);
});

app.post("/api/auth/native-login", async (_req, res, next) => {
  try {
    const command = nativeLoginCommand();
    if (process.platform === "darwin") {
      const child = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], { detached: true, stdio: "ignore" });
      // A failed spawn reports asynchronously via 'error'; without a listener it
      // would crash the server. Best effort — the command is returned regardless.
      child.on("error", () => {});
      child.unref();
      return res.json({ ok: true, opened: true, command, instructions: "Type /login in the Terminal window, then select a provider." });
    }
    res.json({ ok: true, opened: false, command, instructions: "Run this command, then type /login and select a provider." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/oauth/start", async (req, res, next) => {
  try {
    const provider = String(req.body?.provider ?? "openai-codex").trim();
    const state = await startOAuthLogin(provider);
    res.json({ ok: true, id: state.id, provider: state.provider, status: state.status, authUrl: state.authUrl, instructions: state.instructions, deviceCode: state.deviceCode, usesCallbackServer: state.usesCallbackServer, error: state.error });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/oauth/:id/manual-code", (req, res) => {
  const state = oauthLogins.get(req.params.id);
  if (!state) return res.status(404).json({ error: "Unknown login session" });
  const code = String(req.body?.code ?? "").trim();
  if (!code) return res.status(400).json({ error: "Missing redirect URL or code" });
  state.manualCodeResolve?.(code);
  state.manualCodeResolve = undefined;
  state.progress?.push("Received pasted redirect URL from browser.");
  res.json({ ok: true });
});

app.get("/api/auth/oauth/:id", (req, res) => {
  const state = oauthLogins.get(req.params.id);
  if (!state) return res.status(404).json({ error: "Unknown login session" });
  res.json({ ok: true, id: state.id, provider: state.provider, status: state.status, authUrl: state.authUrl, instructions: state.instructions, deviceCode: state.deviceCode, usesCallbackServer: state.usesCallbackServer, progress: state.progress, error: state.error });
});

app.post("/api/auth/api-key", async (req, res, next) => {
  try {
    const provider = String(req.body?.provider ?? "").trim();
    const key = String(req.body?.key ?? "").trim();
    if (!/^[a-z0-9-]+$/.test(provider)) return res.status(400).json({ error: "Invalid provider" });
    if (!key) return res.status(400).json({ error: "Missing API key" });

    await setProviderApiKey(credsDir, provider, key);
    await pushModelAuthToControlPlane();
    await refreshSessionAfterAuth();
    res.json({ ok: true, provider, providers: await listProvidersUnified() });
  } catch (error) {
    next(error);
  }
});

// List model providers + auth status (the "Models & providers" screen). Shared by
// every agent runtime via the credential vault, so one login here serves all.
app.get("/api/auth/providers", async (_req, res, next) => {
  try {
    res.json({ providers: await listProvidersUnified() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/providers/:id", async (req, res) => {
  const id = String(req.params.id ?? "").trim().toLowerCase();
  const auth = id ? ((await exportProviderAuth(credsDir))[id] as any) : undefined;
  const provider = (await listProviders(credsDir, piDir)).find((p) => p.id === id);
  res.json({
    provider: id,
    configured: Boolean(provider?.configured || auth),
    source: provider?.source,
    kind: provider?.kind || auth?.type,
    key: auth?.type === "api_key" ? auth.key : undefined,
    oauth: (provider?.kind || auth?.type) === "oauth" ? { present: true } : undefined,
  });
});

// Forget a provider's stored credential (API key or OAuth token).
app.delete("/api/auth/providers/:id", async (req, res) => {
  try {
    await removeProvider(credsDir, String(req.params.id));
    await pushModelAuthToControlPlane();
    await refreshSessionAfterAuth();
    res.json({ ok: true, providers: await listProvidersUnified() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- Speech-to-text (voice input) --------------------------------------
// The client records audio and hands it to the node, which holds the provider
// key and makes the transcription call. Shared by the direct REST path and the
// relay command path (handleRelayMessage), so both transports behave the same.

async function applySttConfigChange(body: {
  provider?: unknown;
  setKey?: unknown;
  removeKey?: unknown;
}): Promise<Awaited<ReturnType<typeof getSttConfig>>> {
  if (body.provider !== undefined) {
    const p = String(body.provider);
    if (!isSttProvider(p)) throw new Error(`Unknown speech provider: ${p}`);
    setSttProvider(appDir, p);
  }
  const setKey = body.setKey as { provider?: unknown; value?: unknown } | undefined;
  if (setKey && setKey.provider !== undefined) {
    const p = String(setKey.provider);
    if (!isSttProvider(p)) throw new Error(`Unknown speech provider: ${p}`);
    setSttKey(appDir, p, String(setKey.value ?? ""));
  }
  if (body.removeKey !== undefined) {
    const p = String(body.removeKey);
    if (!isSttProvider(p)) throw new Error(`Unknown speech provider: ${p}`);
    removeSttKey(appDir, p);
  }
  return getSttConfig(appDir);
}

async function runTranscription(body: {
  audio?: unknown;
  mimeType?: unknown;
  provider?: unknown;
  language?: unknown;
}): Promise<string> {
  const audioB64 = String(body.audio ?? "");
  if (!audioB64) throw new Error("No audio was provided.");
  const audio = Buffer.from(audioB64, "base64");
  if (audio.length > MAX_AUDIO_BYTES) throw new Error("Recording is too large to transcribe.");
  const provider = isSttProvider(body.provider) ? (body.provider as SttProvider) : undefined;
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
  return transcribeAudio({
    appDir,
    audio,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
    provider,
    language,
  });
}

app.get("/api/stt/config", async (_req, res, next) => {
  try {
    res.json(await getSttConfig(appDir));
  } catch (error) {
    next(error);
  }
});

app.post("/api/stt/config", async (req, res) => {
  try {
    res.json(await applySttConfigChange(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/transcribe", async (req, res) => {
  try {
    const text = await runTranscription(req.body ?? {});
    res.json({ text });
  } catch (error) {
    // 200 with an `error` field: the client resolves transcription through a
    // uniform result event across transports, so a failure must still carry a
    // readable message rather than a bare HTTP error the event layer drops.
    res.json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function integrationRedirectUri(req: express.Request) {
  const base = (process.env.BIVY_PUBLIC_URL ?? `${req.protocol}://${req.get("host") ?? `localhost:${port}`}`).replace(/\/$/, "");
  return `${base}/api/integrations/oauth/callback`;
}

// List integrations with connection status (no secrets).
app.get("/api/integrations", (_req, res) => {
  res.json({ integrations: integrations.list() });
});

// Connect an API-key integration (Notion, GitHub, ...).
app.post("/api/integrations/:id/api-key", async (req, res, next) => {
  try {
    await integrations.connectApiKey(req.params.id, String(req.body?.key ?? ""));
    broadcast({ type: "integrations.updated", integrations: integrations.list() });
    await refreshSessionAfterAuth();
    res.json({ ok: true, integrations: integrations.list() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Begin an OAuth integration; returns the authorize URL for the user to open.
app.post("/api/integrations/:id/connect", (req, res) => {
  try {
    const { authUrl } = integrations.startOAuth(req.params.id, integrationRedirectUri(req));
    res.json({ ok: true, authUrl });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Disconnect / forget credentials for an integration.
app.delete("/api/integrations/:id", async (req, res) => {
  const removed = integrations.disconnect(req.params.id);
  if (removed) {
    broadcast({ type: "integrations.updated", integrations: integrations.list() });
    await refreshSessionAfterAuth();
  }
  res.status(removed ? 200 : 404).json({ ok: removed, integrations: integrations.list() });
});

app.post("/api/commands/run", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const command = findCommand(name);
    if (!command) return res.status(404).json({ error: "Unknown command" });

    if (command.kind === "native") {
      return res.json(runNativeCommand(command));
    }

    if (!command.run) return res.status(400).json({ error: "Command is handled by the client" });

    const result = await command.run();
    broadcast({ type: "command.result", command: command.name, result });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

// Live run-terminals (native agent sessions started by `bivy run`), for
// `bivy sessions` and the app's attach surface.
app.get("/api/terminals", async (_req, res, next) => {
  try { res.json({ terminals: await runTerminalList() }); }
  catch (error) { next(error); }
});

// Kill a live run-terminal by id (the HTTP equivalent of the WS terminal.close),
// so `bivy kill <termId>` can stop a daemon-owned agent PTY.
app.post("/api/terminals/close", (req, res) => {
  const termId = String(req.body?.termId || "").trim();
  if (!termId) return res.status(400).json({ error: "termId is required" });
  const closed = terminals.close(termId);
  if (!closed) return res.status(404).json({ error: `No live terminal ${termId}` });
  broadcast({ type: "terminal.closed", termId });
  res.json({ ok: true });
});

// "Continue as chat": stop the native TUI in a pinned run-terminal and reopen its
// pinned session as a governed chat. Accepts { termId } or { sessionId }.
app.post("/api/terminals/takeover", async (req, res, next) => {
  try {
    const termId = String(req.body?.termId || "").trim() || undefined;
    const sessionId = String(req.body?.sessionId || "").trim() || undefined;
    if (!termId && !sessionId) return res.status(400).json({ error: "termId or sessionId is required" });
    const result = await takeoverRunTerminal({ termId, sessionId });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, sessionId: result.sessionId, runtimeId: result.runtimeId, resumeCommand: result.resumeCommand });
  } catch (error) {
    next(error);
  }
});

// Terminal-multiplexer sessions on this node (tmux/zellij/screen) that were
// started outside Bivy, for the app's attach surface.
app.get("/api/multiplexers", async (_req, res) => {
  try {
    res.json({ sessions: await listMultiplexerSessions() });
  } catch {
    res.json({ sessions: [] });
  }
});

// Read-only browsing of Codex sessions started outside Bivy. Codex has no
// launch-time session-id pin, so this endpoint reconstructs on-disk rollouts for
// discovery/history. Live continuation is handled by the normal resumable Codex
// runtimes (`codex` or governed `codex-approvals`), while this endpoint stays a
// safe read-side view plus a `codex resume <id>` terminal handoff.
app.get("/api/codex/sessions", (_req, res) => {
  const sessions = listCodexSessions().map((s) => ({
    id: s.id,
    cwd: s.cwd,
    createdAt: s.createdAt,
    firstMessage: s.firstMessage,
    resumeCommand: s.id ? `codex resume ${s.id}` : undefined,
  }));
  res.json({ sessions });
});

app.get("/api/codex/sessions/:id/messages", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "session id is required" });
  res.json({ messages: loadCodexTranscript(id), readOnly: true, resumeCommand: `codex resume ${id}` });
});

// Provider-native session discovery/adoption (issue #156) — the runtime-agnostic
// generalization of the Codex-only endpoints above. Bounded metadata only,
// deduped against sessions Bivy already manages; see listDiscoverableSessions.
app.get("/api/sessions/discover", async (_req, res, next) => {
  try {
    res.json({ sessions: await listDiscoverableSessions() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/import", async (req, res, next) => {
  try {
    const runtimeId = String(req.body?.runtimeId || "").trim();
    const ref = String(req.body?.ref || "").trim();
    if (!runtimeId || !ref) return res.status(400).json({ error: "runtimeId and ref are required" });
    const result = await importNativeSession(runtimeId, ref, { acceptDisclosure: Boolean(req.body?.acceptDisclosure) });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, needsDisclosure: result.needsDisclosure, disclosure: result.disclosure });
    }
    res.json({ sessionId: result.record.id, runtimeId: result.record.runtimeId, workspace: result.record.workspace, mode: result.plan.mode, seedPrompt: result.seedPrompt });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions", async (_req, res, next) => {
  try {
    const sessions = await listAllSessions();
    const list = sessions.map((s) => {
      const rec = openSessions.get(s.id) || (s.path ? openSessions.get(path.resolve(s.path)) : undefined);
      const meta = metadata.getSession(s.id) ?? metadata.getSession(s.path);
      // See the WS sessions.list handler's identical comment: this also
      // covers a pending clarifying question, not just a tool approval.
      const pendingApproval = rec ? sessionHasPendingApproval(rec) : approvals.list().some((a) => a.sessionId === s.id && a.status === "pending");
      return {
        ...s,
        agent: meta?.runtimeId ?? s.agent,
        agentName: meta?.agentName ?? s.agentName,
        source: rec?.source ?? meta?.source,
        forkedFrom: rec?.forkedFrom ?? meta?.forkedFrom,
        branch: rec?.worktree?.branch ?? meta?.branch,
        prUrl: rec?.prUrl ?? meta?.prUrl,
        prs: rec?.prs ?? meta?.prs,
        status: pendingApproval ? "needs_action" : (rec ? (sessionBusy(rec) ? "working" : "idle") : "saved"),
        open: Boolean(rec),
        needsAction: pendingApproval,
        costUsd: rec?.costUsd ?? meta?.costUsd,
        usage: rec?.usage,
        bivySession: bivySessionEnvelopeFromSummary(s, rec, meta),
      };
    });
    res.json(list);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/open", async (req, res, next) => {
  try {
    const session = await createSession(defaultWorkspace, String(req.body?.path ?? ""), { runtimeId: agentFrom(req.body ?? {}) });
    res.json({
      id: session.id,
      workspace: session.workspace,
      sessionFile: session.sessionFile,
      runtimeId: session.runtimeId,
      agentName: getRuntime(session.runtimeId).displayName,
      name: session.session.getName(),
      messages: conversationMessages(session),
      isStreaming: sessionBusy(session),
      lastActivity: session.lastActivity,
      workingStartedAt: session.workingStartedAt,
      source: session.source,
      branch: session.worktree?.branch,
      prUrl: session.prUrl,
      bivySession: bivySessionEnvelope(session),
      capabilities: getRuntime(session.runtimeId).capabilities,
      warning: session.warning,
      costUsd: session.costUsd,
      usage: session.usage,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/sessions/delete", async (req, res, next) => {
  try {
    const deleted = await deleteSessionFile({ path: String(req.body?.path || "").trim(), id: String(req.body?.id || "").trim(), fallbackActive: true });
    res.json({ ok: true, ...deleted });
  } catch (error) {
    next(error);
  }
});

app.get("/api/session", (_req, res) => {
  res.json(
    active
      ? { id: active.id, workspace: active.workspace, sessionFile: active.sessionFile, name: active.session.getName(), isStreaming: sessionBusy(active), lastActivity: active.lastActivity, workingStartedAt: active.workingStartedAt, source: active.source, branch: active.worktree?.branch, prUrl: active.prUrl }
      : null,
  );
});

app.get("/api/session/history", async (req, res) => {
  try {
    const sid = String(req.query.sessionId ?? "").trim();
    let record = sid ? openSessions.get(sid) : active;
    if (!record && sid) {
      const summary = (await listAllSessions()).find((s) => s.id === sid);
      if (summary?.path) record = await createSession(defaultWorkspace, summary.path, { runtimeId: summary.agent, makeActive: false });
    }
    if (!record) return res.status(404).json({ error: "Session not found" });
    res.json(buildHistoryEvent({
      sessionId: record.id,
      workspace: record.workspace,
      source: record.source,
      runtimeId: record.runtimeId,
      isStreaming: sessionBusy(record),
      messages: conversationMessages(record),
      cursor: { have: typeof req.query.have === "string" ? Number(req.query.have) : undefined, haveToken: typeof req.query.haveToken === "string" ? req.query.haveToken : undefined },
    }));
    // Direct/local clients receive cards on their WS, not in this response body;
    // re-emit any pending question/approval so a reopened session shows the card.
    replayPendingInteractions(record.id);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/session", async (req, res, next) => {
  try {
    // A git-workspace session: clone "owner/repo" and branch off origin/main into
    // a new worktree named from `title` (the user's first message), mirroring the
    // relay `session.new` repo path. Takes precedence over a manual workspace path.
    const repoInput = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : undefined;
    // Validate the workspace before entering the dedupe path so a bad path still
    // returns a 400 (rather than being cached as a rejected creation).
    let workspace = defaultWorkspace;
    if (!repoInput && req.body?.workspace !== undefined && String(req.body.workspace).trim()) {
      try {
        workspace = validateWorkspace(req.body.workspace);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    let parsed: ParsedRepo | undefined;
    if (repoInput) {
      parsed = parseRepo(repoInput);
      if (!parsed) return res.status(400).json({ error: `Invalid repository "${repoInput}" — use owner/repo.` });
    }
    let session: SessionRecord;
    try {
      // Deduped by requestId so a direct client's post-reconnect retry adopts the
      // session this request already created rather than spawning a duplicate.
      session = await dedupeSessionNew(requestId, async () => {
        const rec = parsed
          ? await createRepoSession(parsed, { title, runtimeId: agentFrom(req.body ?? {}), branch: branchFrom(req.body ?? {}) })
          : await createWorkspaceSession(workspace, { title, runtimeId: agentFrom(req.body ?? {}), branch: branchFrom(req.body ?? {}) });
        // Bind the composer's chosen model to the new session before its first turn.
        await applyRequestedModel(rec, modelFrom(req.body ?? {}));
        return rec;
      });
    } catch (error) {
      if (parsed) return res.status(502).json({ error: `Could not clone ${parsed.slug}: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
    res.json({ id: session.id, workspace: session.workspace, source: session.source, branch: session.worktree?.branch, prUrl: session.prUrl, sessionFile: session.sessionFile, name: session.session.getName(), runtimeId: session.runtimeId, agentName: getRuntime(session.runtimeId).displayName, model: publicModel(session.session.getCurrentModel(), session.session.getCurrentModel()) });
  } catch (error) {
    res.status(400).json({ error: actionableAgentError(agentFrom(req.body ?? {}) ?? defaultRuntimeId, error) });
  }
});

app.get("/api/github/issues", async (_req, res, next) => {
  try {
    const cfg = await resolveGitHubTaskConfig();
    if (!cfg) return res.status(400).json({ error: "GitHub issue pickup is not configured. Set BIVY_GITHUB_TASKS=1 in a GitHub checkout, or set BIVY_GITHUB_TOKEN + BIVY_GITHUB_REPO." });
    const issues = selectActionableIssues(await listOpenLabelledIssues(cfg), cfg.claimLabel);
    res.json({ repo: `${cfg.owner}/${cfg.repo}`, label: cfg.label, claimLabel: cfg.claimLabel, issues });
  } catch (error) {
    next(error);
  }
});

app.post("/api/github/issues/:number/pickup", async (req, res, next) => {
  try {
    const cfg = await resolveGitHubTaskConfig();
    if (!cfg) return res.status(400).json({ error: "GitHub issue pickup is not configured. Set BIVY_GITHUB_TASKS=1 in a GitHub checkout, or set BIVY_GITHUB_TOKEN + BIVY_GITHUB_REPO." });
    const issueNumber = Number(req.params.number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return res.status(400).json({ error: "Issue number must be a positive integer." });
    const issue = await getIssue(cfg, issueNumber);
    if (!issue) return res.status(404).json({ error: `Issue #${issueNumber} was not found.` });
    if (issue.labels.includes(cfg.claimLabel)) return res.status(409).json({ error: `Issue #${issueNumber} is already claimed with ${cfg.claimLabel}.` });
    await addLabel(cfg, issue.number, cfg.claimLabel);
    void runIssueTask(cfg, issue).catch((error) => {
      console.warn(`[github-tasks] manual issue #${issue.number} failed:`, error);
      broadcast({ type: "session.error", sessionId: undefined, error: `GitHub issue #${issue.number} failed: ${error instanceof Error ? error.message : String(error)}` });
    });
    res.json({ ok: true, repo: `${cfg.owner}/${cfg.repo}`, issue });
  } catch (error) {
    next(error);
  }
});

type RepoListing = {
  authed: boolean;
  repos: { slug: string; description: string; private: boolean; pushedAt?: string; defaultBranch?: string }[];
  error?: string;
  // Why the list is empty, so the picker can show an ACTIONABLE prompt instead of
  // a dead-end string. Only set when authed:false (no usable token):
  //   "no-token"    — nothing connected; steer to `bivy github:connect`.
  //   "gh-unauthed" — the `gh` CLI is installed but logged out; also offer `gh auth login`.
  reason?: "no-token" | "gh-unauthed";
};

type BranchListing = {
  repo: string;
  branches: { name: string }[];
  defaultBranch?: string;
  error?: string;
};

// Short-lived in-memory caches for the repo/branch pickers. Both are read-only
// GitHub listings a user pages through interactively, so a few tens of seconds
// of staleness is invisible — but it turns a reopen (or the client's prefetch)
// into an instant hit instead of another multi-hundred-ms GitHub round trip
// (plus, for repos, a `gh auth token` shell-out). Cleared on token changes via
// invalidateGithubListingCaches().
const REPO_LIST_TTL_MS = 60_000;
const BRANCH_LIST_TTL_MS = 30_000;
let reposCache: { at: number; val: RepoListing } | null = null;
const branchesCache = new Map<string, { at: number; val: BranchListing }>();
function invalidateGithubListingCaches(): void {
  reposCache = null;
  branchesCache.clear();
}

type CliConfig = { workspace?: string; port?: number; env?: Record<string, string>; service?: boolean };

function loadCliConfig(): CliConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "cli.json"), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function saveCliEnv(updates: Record<string, string | undefined>): void {
  const file = path.join(appDir, "cli.json");
  const config = loadCliConfig();
  const env = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, string>;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") delete env[key];
    else env[key] = value;
  }
  config.env = env;
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

async function createControlPlaneHook(kind = "github"): Promise<{ url: string; secret: string; id: string }> {
  const cfg = loadRelayConfig(appDir);
  if (!cfg?.controlPlaneUrl || !cfg.enrollmentToken) throw new Error("Hosted relay is not configured. Run bivy relay:setup first.");
  const res = await fetch(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/node/hooks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.enrollmentToken}` },
    body: JSON.stringify({ kind }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url || !data?.secret) throw new Error(data?.error || `Could not create Bivy webhook (${res.status})`);
  return data;
}

// List the GitHub repos the node can reach with its own token (for picking a
// git workspace). Privacy-preserving: uses only the token stored on this
// machine (env or `gh`), never the control plane. Returns `authed: false` with
// an empty list when there's no token so the UI falls back to manual owner/repo.
async function listAccessibleRepos(): Promise<RepoListing> {
  if (reposCache && Date.now() - reposCache.at < REPO_LIST_TTL_MS) return reposCache.val;
  try {
    const token = await resolveGitHubToken();
    if (!token) return { authed: false, repos: [], reason: (await ghCliInstalled()) ? "gh-unauthed" : "no-token" };
    const ghRes = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
    });
    if (!ghRes.ok) return { authed: true, repos: [], error: `GitHub responded ${ghRes.status}` };
    const raw = (await ghRes.json().catch(() => [])) as Array<Record<string, unknown>>;
    const repos = (Array.isArray(raw) ? raw : []).map((r) => ({
      slug: String(r.full_name ?? ""),
      description: typeof r.description === "string" ? r.description : "",
      private: Boolean(r.private),
      pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : undefined,
      // GitHub already hands us each repo's default branch here, so the branch
      // picker can label "Default branch (main)" instantly from the cached repo
      // list — no separate /repos/{owner}/{repo} round trip when it opens.
      defaultBranch: typeof r.default_branch === "string" ? r.default_branch : undefined,
    })).filter((r) => r.slug);
    const val: RepoListing = { authed: true, repos };
    reposCache = { at: Date.now(), val };
    return val;
  } catch (error) {
    return { authed: false, repos: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Web-driven "Connect GitHub" (repo-scope device flow) ------------------
// The repo picker's Connect button runs GitHub's device flow ON THIS NODE — the
// same flow as `bivy github:connect`, so a repo-scoped token lands in the node
// vault and the picker fills in, with no `gh` and no terminal. The browser
// drives the cadence: one `github.connect.start`, then `github.connect.poll` on
// GitHub's interval. A single in-flight flow (a personal, foreground action); a
// fresh start replaces any stale one.
type GithubConnectStatus =
  | { status: "unconfigured" } // BIVY_GITHUB_OAUTH_CLIENT_ID unset — client falls back to the CLI instructions
  | { status: "waiting"; userCode: string; verificationUri: string; intervalMs: number; expiresInMs: number }
  | { status: "connected" }
  | { status: "idle" } // no flow in progress (poll with nothing pending)
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; error: string };

let pendingGithubConnect: { clientId: string; device: DeviceCode; expiresAt: number } | null = null;

async function startGithubConnect(): Promise<GithubConnectStatus> {
  const clientId = deviceFlowClientId();
  if (!clientId) return { status: "unconfigured" };
  try {
    const device = await requestDeviceCode(clientId, REPO_CONNECT_SCOPE);
    pendingGithubConnect = { clientId, device, expiresAt: Date.now() + device.expiresInSec * 1000 };
    return {
      status: "waiting",
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalMs: device.intervalSec * 1000,
      expiresInMs: device.expiresInSec * 1000,
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

async function pollGithubConnect(): Promise<GithubConnectStatus> {
  const pending = pendingGithubConnect;
  if (!pending) return { status: "idle" };
  if (Date.now() > pending.expiresAt) {
    pendingGithubConnect = null;
    return { status: "expired" };
  }
  let poll;
  try {
    poll = await pollAccessTokenOnce(pending.clientId, pending.device.deviceCode);
  } catch (error) {
    // A transient network blip mid-flow — keep the code alive and let the client
    // poll again rather than discarding a device code the user may have authorized.
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  switch (poll.status) {
    case "ok":
      pendingGithubConnect = null;
      persistConnectedGithubToken(poll.token);
      return { status: "connected" };
    case "slow_down":
      // GitHub says we're polling too fast — widen the interval it hands the
      // browser so the next poll backs off (and doesn't burn the device code).
      pending.device.intervalSec = poll.intervalSec ?? pending.device.intervalSec + 5;
    // falls through — same "keep waiting" answer, just a larger interval.
    case "pending":
      return {
        status: "waiting",
        userCode: pending.device.userCode,
        verificationUri: pending.device.verificationUri,
        intervalMs: pending.device.intervalSec * 1000,
        expiresInMs: Math.max(0, pending.expiresAt - Date.now()),
      };
    case "denied":
      pendingGithubConnect = null;
      return { status: "denied" };
    case "expired":
      pendingGithubConnect = null;
      return { status: "expired" };
    default:
      pendingGithubConnect = null;
      return { status: "error", error: poll.error };
  }
}

// Store the repo-scoped token exactly like `bivy github:connect`: the raw token
// in the node's secret vault, and only a `secret://` reference in cli.json. But
// ALSO update the LIVE process env so resolveGitHubToken() picks it up without a
// restart (the Tier-1 caveat), and drop the repo-list cache so the very next
// list is authed.
function persistConnectedGithubToken(token: string): void {
  new SecretVault(appDir).setLocal("github.repo-token", token, "GitHub repo/work-queue token");
  saveCliEnv({ BIVY_GITHUB_TOKEN: "secret://github.repo-token" });
  process.env.BIVY_GITHUB_TOKEN = "secret://github.repo-token";
  invalidateGithubListingCaches();
}

// Fetch a repo's remote branch names with a given token (or none, for a public
// repo). One GitHub call; returns null on a non-OK response so the caller can
// decide whether to retry with a different token.
async function fetchRepoBranchNames(owner: string, repo: string, token: string | undefined): Promise<{ name: string }[] | null> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "bivy" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers });
  if (!res.ok) return null;
  const raw = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  return (Array.isArray(raw) ? raw : []).map((b) => ({ name: String(b.name ?? "") })).filter((b) => b.name);
}

// List a single repo's remote branches for the branch picker. The default
// branch is NOT resolved here — the client already has it from the repo listing
// (RepoInfo.defaultBranch), so the picker can show "Default branch (main)"
// instantly and this call only needs the branch names.
//
// Speed: uses the SAME user-scoped token the repo picker listed this repo with
// (`resolveGitHubToken`, already warm) rather than minting a GitHub App
// installation token — every repo reachable in the picker is reachable with
// that token, so this avoids the installation-resolve + token-mint round trips
// that dominated the old path. Only if that fails (e.g. a fine-grained PAT that
// can list but not read a private repo, where the App can) do we fall back to
// the per-repo App token. Cached briefly so a reopen/prefetch is instant.
async function listRepoBranches(repoInput: string): Promise<BranchListing> {
  const parsed = parseRepo(repoInput);
  if (!parsed) return { repo: repoInput, branches: [], error: `Invalid repository "${repoInput}" — use owner/repo.` };
  const cached = branchesCache.get(parsed.slug);
  if (cached && Date.now() - cached.at < BRANCH_LIST_TTL_MS) return cached.val;
  try {
    let branches = await fetchRepoBranchNames(parsed.owner, parsed.repo, await resolveGitHubToken());
    if (branches === null) {
      // User token couldn't read it (or none) — fall back to the App installation
      // token, the same one cloning would use, before giving up.
      const appToken = await resolveTokenForRepo(parsed.owner, parsed.repo);
      branches = await fetchRepoBranchNames(parsed.owner, parsed.repo, appToken);
    }
    if (branches === null) return { repo: parsed.slug, branches: [], error: "GitHub could not list this repo's branches." };
    const val: BranchListing = { repo: parsed.slug, branches };
    branchesCache.set(parsed.slug, { at: Date.now(), val });
    return val;
  } catch (error) {
    return { repo: parsed.slug, branches: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// --- One-click GitHub App (manifest) flow ------------------------------------
// The node drives GitHub's App-manifest flow so the private key never touches
// the control plane (flavor A). `new` creates a github_app hook and sends the
// pre-filled manifest to GitHub; GitHub redirects to `callback` with a code the
// node exchanges for the app id + private key + webhook secret.
async function setControlPlaneHookSecret(hookId: string, secret: string): Promise<void> {
  const cfg = loadRelayConfig(appDir);
  if (!cfg?.controlPlaneUrl || !cfg.enrollmentToken) throw new Error("Hosted relay is not configured.");
  const res = await fetch(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/node/hooks/${encodeURIComponent(hookId)}/secret`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.enrollmentToken}` },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) throw new Error(`Could not register the webhook secret (${res.status})`);
}

// Register the app's slug (→ unique `@`-mention handle) and name with the control
// plane, so mentions route correctly and the settings UI can show what's
// connected. Best-effort: setup still succeeds if this call fails.
async function setControlPlaneHookAppMeta(hookId: string, meta: { mention?: string; name?: string; appId?: string }): Promise<void> {
  const cfg = loadRelayConfig(appDir);
  if (!cfg?.controlPlaneUrl || !cfg.enrollmentToken) return;
  try {
    await fetch(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/node/hooks/${encodeURIComponent(hookId)}/app-meta`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.enrollmentToken}` },
      body: JSON.stringify(meta),
    });
  } catch {
    /* non-fatal — the mention falls back to the env default until re-registered */
  }
}

function defaultAppName(): string {
  return `Bivy-${os.hostname().replace(/[^A-Za-z0-9-]/g, "").slice(0, 20) || "node"}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Step 1 of the manifest flow, shared by the CLI's server-rendered page, the
 * direct-mode JSON endpoint, and the relay message handler. Creates the
 * `github_app` inbound hook and builds the manifest + the GitHub action URL.
 *
 * `redirectBase` is where GitHub should send the browser back with the one-time
 * `code` — the **browser's own origin**, which the node can't know on its own,
 * so the caller passes it in. That's what makes the web-app flow work remotely:
 * the redirect lands on the control-plane origin the user is already on, and the
 * browser relays the code back to the node (which alone exchanges it, keeping
 * the private key off the control plane).
 */
async function startAppManifest(input: { redirectBase: string; org?: string; name?: string }): Promise<{
  action: string;
  manifest: Record<string, unknown>;
  state: string;
}> {
  const name = input.name?.trim() || defaultAppName();
  const hook = await createControlPlaneHook("github_app"); // { url, secret, id }
  const base = input.redirectBase.replace(/\/$/, "");
  // A query marker on the origin root, so the returning SPA can recognise the
  // redirect without depending on a dedicated server route (GitHub appends
  // `&code=…&state=…`).
  const redirectUrl = `${base}/?bivy_github_app=1`;
  const manifest = buildAppManifest({ name, url: "https://bivy.sh", hookUrl: hook.url, redirectUrl });
  const action = input.org
    ? `https://github.com/organizations/${encodeURIComponent(input.org)}/settings/apps/new?state=${encodeURIComponent(hook.id)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(hook.id)}`;
  return { action, manifest, state: hook.id };
}

/**
 * Step 2: exchange the one-time `code` for the app credentials **on the node**,
 * store the private key locally, register the GitHub-generated webhook secret
 * with the control plane (`state` is the hook id), and persist the env. Shared
 * by every entry point.
 */
async function completeAppManifest(input: { code: string; state: string }): Promise<{ installUrl: string; appId: string }> {
  const app0 = await convertManifest(input.code);
  // Private key → node vault; only a secret:// reference is written to cli.json.
  new SecretVault(appDir).setLocal("github.app-private-key", app0.pem, "GitHub App private key");
  // The webhook secret GitHub generated must match what the control plane verifies.
  await setControlPlaneHookSecret(input.state, app0.webhookSecret);
  // The app slug is the unique `@`-mention handle; register it (+ name) so it
  // routes correctly and the settings UI shows what's connected.
  await setControlPlaneHookAppMeta(input.state, { mention: app0.slug, name: app0.name, appId: app0.appId });
  const label = process.env.BIVY_GITHUB_LABEL?.trim() || "bivy";
  process.env.BIVY_GITHUB_APP_ID = app0.appId;
  process.env.BIVY_GITHUB_APP_PRIVATE_KEY = "secret://github.app-private-key";
  process.env.BIVY_GITHUB_HOSTED_TASKS = "1";
  process.env.BIVY_GITHUB_LABEL = label;
  if (app0.slug) process.env.BIVY_GITHUB_APP_SLUG = app0.slug;
  saveCliEnv({
    BIVY_GITHUB_APP_ID: app0.appId,
    BIVY_GITHUB_APP_PRIVATE_KEY: "secret://github.app-private-key",
    BIVY_GITHUB_HOSTED_TASKS: "1",
    BIVY_GITHUB_LABEL: label,
    BIVY_GITHUB_APP_SLUG: app0.slug || undefined,
    BIVY_GITHUB_REPO_DIR: defaultWorkspace,
    BIVY_GITHUB_REPO: undefined,
  });
  startControlPlaneTasksIfConfigured();
  const installUrl = app0.htmlUrl ? `${app0.htmlUrl}/installations/new` : "https://github.com/settings/installations";
  return { installUrl, appId: app0.appId };
}

/** Adopt the account's existing github_app hook (same webhook URL + secret the
 *  app is already configured with), or create one if the account has none. */
async function getOrCreateGithubAppHook(appId?: string): Promise<{ id: string; url: string; secret: string }> {
  const cfg = loadRelayConfig(appDir);
  if (!cfg?.controlPlaneUrl || !cfg.enrollmentToken) throw new Error("Hosted relay is not configured. Run bivy relay:setup first.");
  // Each app gets its own hook, so the control plane can tell which app an event
  // arrived on (and therefore which key the node should mint with). Asking by
  // app id reuses the hook when the same app is reconnected — on this node or
  // another — so the app's existing webhook config keeps working untouched.
  const query = appId ? `?appId=${encodeURIComponent(appId)}` : "";
  const res = await fetch(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/node/hooks/github_app${query}`, {
    headers: { authorization: `Bearer ${cfg.enrollmentToken}` },
  });
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; secret?: string; appId?: string };
    // Never adopt a hook that already belongs to a *different* app: its secret
    // is the one GitHub signs that app's deliveries with.
    const mismatch = appId && data?.appId && data.appId !== appId;
    if (data?.id && data.url && data.secret && !mismatch) return { id: data.id, url: data.url, secret: data.secret };
  }
  return createControlPlaneHook("github_app");
}

/**
 * Connect an ALREADY-EXISTING GitHub App to this node — the user brings the App
 * ID + a `.pem` private key (no manifest create). Adopts the account's existing
 * control-plane hook so the app's already-configured webhook keeps working with
 * no reconfiguration and no duplicate app. Mirrors `completeAppManifest`'s
 * persistence. Used by the web "Connect existing app" form over the E2E relay.
 */
async function connectExistingApp(input: { appId: string; privateKeyPem: string; nodeLabel?: string }): Promise<{ installUrl: string; appId: string; slug?: string; webhookUrl: string; webhookSecret: string }> {
  const appId = input.appId.trim();
  const pem = input.privateKeyPem.trim();
  if (!/^\d+$/.test(appId)) throw new Error("App ID must be the GitHub App's numeric App ID.");
  if (!pem.includes("PRIVATE KEY")) throw new Error("That doesn't look like a PEM private key (expected a -----BEGIN … PRIVATE KEY----- block).");

  // Validate the key against GitHub and resolve the app's slug (@-mention) + name.
  let slug = "";
  let name = "";
  try {
    const jwt = createAppJwt(appId, pem, Math.floor(Date.now() / 1000));
    const appRes = await fetch("https://api.github.com/app", {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
    });
    if (!appRes.ok) throw new Error(`GitHub rejected the App ID/key (${appRes.status}). Check the App ID and that the .pem matches it.`);
    const data = (await appRes.json().catch(() => ({}))) as { slug?: string; name?: string };
    slug = String(data.slug ?? "");
    name = String(data.name ?? slug);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub rejected")) throw error;
    throw new Error("Could not verify the App ID/private key against GitHub. Check they match and try again.");
  }

  // Private key → node vault (never leaves the machine). Keyed per app, so a
  // node can hold several apps' keys side by side (personal account + orgs).
  const keyId = privateKeyIdFor(appId);
  new SecretVault(appDir).setLocal(keyId, pem, `GitHub App private key (${slug || appId})`);
  const hook = await getOrCreateGithubAppHook(appId);

  // Point the app's OWN webhook at the adopted hook (url + secret). Unlike the
  // manifest/create flow — where GitHub sets the webhook from the manifest — an
  // existing app keeps whatever webhook it last had, which is often a stale hook
  // from an earlier connect, so events never reach the live hook. The app can
  // update its own webhook config via the app JWT, so wire it here. Best-effort:
  // the connect still succeeds if this fails (the user can set it by hand).
  try {
    const jwt = createAppJwt(appId, pem, Math.floor(Date.now() / 1000));
    const wr = await fetch("https://api.github.com/app/hook/config", {
      method: "PATCH",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bivy", "content-type": "application/json" },
      body: JSON.stringify({ url: hook.url, secret: hook.secret, content_type: "json" }),
    });
    if (!wr.ok) console.warn(`[github-app] could not auto-configure the app webhook (${wr.status}); set it manually to ${hook.url}`);
  } catch {
    console.warn(`[github-app] could not auto-configure the app webhook; set it manually to ${hook.url}`);
  }

  const label = process.env.BIVY_GITHUB_LABEL?.trim() || "bivy";
  const rawNodeLabel = input.nodeLabel?.trim();
  const nodeLabel = rawNodeLabel ? (rawNodeLabel.includes("/") ? rawNodeLabel : `bivy/${rawNodeLabel}`) : undefined;
  // Record the app in the node's registry. This is what makes several apps
  // possible: the env vars below only ever describe one, and are kept for
  // container/ephemeral setups configured purely through the environment.
  upsertGitHubApp(appDir, {
    appId,
    slug: slug || undefined,
    name: name || undefined,
    privateKeyRef: `secret://${keyId}`,
    hookId: hook.id,
  });
  process.env.BIVY_GITHUB_HOSTED_TASKS = "1";
  process.env.BIVY_GITHUB_LABEL = label;
  if (slug) process.env.BIVY_GITHUB_APP_SLUG = slug;
  if (nodeLabel) process.env.BIVY_NODE_LABEL = nodeLabel;
  saveCliEnv({
    BIVY_GITHUB_HOSTED_TASKS: "1",
    BIVY_GITHUB_LABEL: label,
    BIVY_GITHUB_APP_SLUG: slug || undefined,
    ...(nodeLabel ? { BIVY_NODE_LABEL: nodeLabel } : {}),
    BIVY_GITHUB_REPO_DIR: defaultWorkspace,
  });
  // Register slug/name (also records this node as the app's serving node) so the
  // UI reflects a live connection, then start polling + report install count.
  if (hook.id && slug) await setControlPlaneHookAppMeta(hook.id, { mention: slug, name, appId });
  invalidateGitHubApps(); // pick the new app up without a restart
  startControlPlaneTasksIfConfigured();
  void reportGithubAppInstallations();
  const installUrl = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : "https://github.com/settings/installations";
  return { installUrl, appId, slug: slug || undefined, webhookUrl: hook.url, webhookSecret: hook.secret };
}

/**
 * Disconnect the GitHub App on this node: wipe the private key from the vault and
 * clear the app env, so the node stops minting tokens for it. The control plane
 * drops the hook separately. Local, idempotent; leaves other config untouched.
 *
 * Scope precedence: by `appId`, else by `hookId` (a stale app with no App ID);
 * only when BOTH are omitted is EVERY app disconnected. Passing an unmatched
 * appId/hookId is a no-op — a single-app disconnect must never nuke the others.
 */
function disconnectGithubApp({ appId, hookId }: { appId?: string; hookId?: string } = {}): void {
  const vault = new SecretVault(appDir);
  const all = listGitHubApps(appDir);
  const targets = appId ? all.filter((a) => a.appId === appId) : hookId ? all.filter((a) => a.hookId === hookId) : all;
  for (const app of targets) {
    try {
      // Only drop a key we own. An `op://` or `env://` reference points at
      // something the user manages elsewhere; deleting the vault entry for it
      // would be both useless and surprising.
      if (app.privateKeyRef.startsWith("secret://")) vault.delete(app.privateKeyRef.slice("secret://".length));
    } catch {
      /* key may already be gone */
    }
    removeGitHubApp(appDir, app.appId);
  }
  // The env-configured single app (containers, ephemeral runners) has no
  // registry entry to remove, so clear it explicitly — but only on a full wipe
  // or when the disconnect specifically targets that env app's id.
  if ((!appId && !hookId) || process.env.BIVY_GITHUB_APP_ID === appId) {
    try {
      vault.delete("github.app-private-key");
    } catch {
      /* key may already be gone */
    }
    delete process.env.BIVY_GITHUB_APP_ID;
    delete process.env.BIVY_GITHUB_APP_PRIVATE_KEY;
    delete process.env.BIVY_GITHUB_APP_SLUG;
    saveCliEnv({
      BIVY_GITHUB_APP_ID: undefined,
      BIVY_GITHUB_APP_PRIVATE_KEY: undefined,
      BIVY_GITHUB_APP_SLUG: undefined,
    });
  }
  invalidateGitHubApps(); // re-evaluated on the next work item
  invalidateGithubListingCaches(); // repo/branch listings may change with auth
}

app.get("/github/app/manifest/new", async (req, res, next) => {
  try {
    const base = `${req.protocol}://${req.get("host")}`;
    const org = typeof req.query.org === "string" ? req.query.org : undefined;
    const name = typeof req.query.name === "string" && req.query.name.trim() ? req.query.name : undefined;
    // The CLI page redirects back to the node's own callback (browser reaches
    // the node directly over an SSH tunnel), not the SPA origin marker.
    const hook = await createControlPlaneHook("github_app"); // { url, secret, id }
    const manifest = buildAppManifest({
      name: name?.trim() || defaultAppName(),
      url: "https://bivy.sh",
      hookUrl: hook.url,
      redirectUrl: `${base}/github/app/manifest/callback`,
    });
    // This page auto-submits a form to github.com via one inline script, so it
    // overrides the global `script-src 'none'; form-action 'none'` CSP with a
    // per-request nonce and a github.com form-action allowance — nothing else.
    const nonce = randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action https://github.com`,
    );
    res.type("html").send(renderManifestForm(manifest, { org, state: hook.id, nonce }));
  } catch (error) {
    next(error);
  }
});

// Direct-mode JSON endpoints (mirrored by the relay message handler). The web
// app posts its own `location.origin` as the redirect base so the flow works
// whether the browser is same-origin with the node or on the hosted control
// plane reaching it over the relay.
app.post("/api/github/app/manifest/start", async (req, res, next) => {
  try {
    const redirectBase = String(req.body?.origin || `${req.protocol}://${req.get("host")}`);
    const org = typeof req.body?.org === "string" && req.body.org.trim() ? req.body.org.trim() : undefined;
    res.json(await startAppManifest({ redirectBase, org }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/github/app/manifest/complete", async (req, res) => {
  try {
    const code = String(req.body?.code ?? "").trim();
    const state = String(req.body?.state ?? "").trim();
    if (!code || !state) return res.status(400).json({ error: "Missing code/state." });
    res.json(await completeAppManifest({ code, state }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/github/app/connect-existing", async (req, res) => {
  try {
    res.json(await connectExistingApp({
      appId: String(req.body?.appId ?? ""),
      privateKeyPem: String(req.body?.privateKeyPem ?? ""),
      nodeLabel: typeof req.body?.nodeLabel === "string" ? req.body.nodeLabel : undefined,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/github/apps", async (_req, res) => {
  // What this node actually holds keys for. The control plane knows which apps
  // an account has connected; only the node knows which it can serve.
  res.json({
    apps: listGitHubApps(appDir).map((a) => ({
      appId: a.appId,
      slug: a.slug,
      name: a.name,
      owner: a.owner,
      ownerType: a.ownerType,
      hookId: a.hookId,
    })),
  });
});

app.post("/api/github/app/disconnect", async (req, res) => {
  const appId = typeof req.body?.appId === "string" ? req.body.appId.trim() : "";
  const hookId = typeof req.body?.hookId === "string" ? req.body.hookId.trim() : "";
  disconnectGithubApp({ appId: appId || undefined, hookId: hookId || undefined });
  res.json({ ok: true });
});

app.get("/github/app/manifest/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const hookId = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !hookId) return res.status(400).type("html").send("<p>Missing code/state from GitHub.</p>");
    const { installUrl } = await completeAppManifest({ code, state: hookId });
    const label = process.env.BIVY_GITHUB_LABEL?.trim() || "bivy";
    // installUrl comes from GitHub's manifest-conversion response; only render it
    // as a link if it is a real http(s) URL (never a `javascript:`/`data:` URI),
    // and escape it for the attribute context regardless.
    const safeInstallUrl = /^https?:\/\//i.test(installUrl) ? installUrl : "https://github.com/settings/installations";
    res.type("html").send(`<!doctype html><html><body style="font-family:system-ui;padding:2rem">
<h2>✓ Bivy GitHub App created</h2>
<p>The app's private key is stored on this node. One webhook now covers every repo you install it on.</p>
<p><a href="${escapeHtml(safeInstallUrl)}">Install it on your repositories →</a></p>
<p>Then label an issue <code>${escapeHtml(label)}</code> or comment <code>@bivy …</code>.</p>
</body></html>`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/repos", async (_req, res) => {
  res.json(await listAccessibleRepos());
});

// Direct-transport (local PWA) equivalents of the github.connect.* commands.
app.post("/api/github/connect/start", async (_req, res) => {
  res.json(await startGithubConnect());
});
app.get("/api/github/connect/poll", async (_req, res) => {
  res.json(await pollGithubConnect());
});

app.get("/api/repos/branches", async (req, res) => {
  res.json(await listRepoBranches(String(req.query.repo || "").trim()));
});

// Serve a stored attachment's bytes by content hash (direct/LAN clients). Behind
// /api's authMiddleware. Content-addressed, so responses are immutably cacheable.
// The hash is validated to a 64-char hex before it ever touches a path.
app.get("/api/attachment/:hash", (req, res) => {
  const hash = String(req.params.hash || "");
  if (!isValidAttachmentHash(hash)) return res.status(400).json({ error: "Invalid attachment id" });
  const bytes = attachmentStore.read(hash);
  if (!bytes) return res.status(404).json({ error: "Attachment not found" });
  const meta = attachmentStore.readMeta(hash);
  res.setHeader("Content-Type", meta?.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Content-addressed: the bytes for a hash never change, so cache aggressively.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.end(bytes);
});

// Let an AGENT push a file into the chat as an attachment (image/file) — the
// reverse of the composer upload. Called by the agent's own shell (`bivy attach`)
// or any local tool; on a single-user host the loopback bypass means no token is
// needed. Behind /api's authMiddleware. `path` is resolved inside — and confined
// to — the session's workspace (see planAttachment's security note).
app.post("/api/session/:id/attach", (req, res) => {
  const record = openSessions.get(String(req.params.id));
  if (!record) return res.status(404).json({ error: "Session not found" });
  const filePath = String(req.body?.path ?? req.body?.filePath ?? "").trim();
  if (!filePath) return res.status(400).json({ error: "Missing file path" });
  const result = attachToChat(record, {
    filePath,
    caption: typeof req.body?.caption === "string" ? req.body.caption : undefined,
    mimeType: typeof req.body?.mimeType === "string" ? req.body.mimeType : undefined,
    name: typeof req.body?.name === "string" ? req.body.name : undefined,
  });
  if ("error" in result) return res.status(400).json({ error: result.error });
  const { hash, name, mimeType, size, kind } = result.ref;
  res.json({ ok: true, hash, name, mimeType, size, kind });
});

app.post("/api/session/prompt", async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (text === "/login" || text.startsWith("/login ")) {
      return res.status(400).json({ error: "Use the Login / API tokens dialog from the phone UI. If it is not visible, refresh this page after updating Bivy." });
    }
    const { images, imageNotes, imageRefs, files } = attachmentsFrom(req.body?.attachments);
    if (!text && !images.length && !files.length) return res.status(400).json({ error: "Missing text" });
    // File notes (with on-disk paths) are folded in once the workdir exists; the
    // session title can only reflect what's known before then.
    const titleText = [text, imageNotes.join("\n")].filter(Boolean).join("\n\n") || (images.length ? "Please review the attached image(s)." : "attachment");

    const requestedSessionId = typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : undefined;
    const requestedWorkspace = req.body?.workspace !== undefined && String(req.body.workspace).trim() ? validateWorkspace(req.body.workspace) : undefined;
    // A prompt with no session id but an explicit workspace is a new per-client
    // chat (the web UI sends this for a blank draft). Do not attach it to the
    // daemon's global active session, which may belong to another web/TUI client.
    let record = requestedSessionId ? await resolveOrResumeSession(requestedSessionId, req.body?.path) : requestedWorkspace ? undefined : resolveSession();
    // A named session that resolved to nothing is genuinely gone — surface it
    // rather than silently spawning a new chat under the caller's old id.
    if (requestedSessionId && !record) return res.status(404).json({ error: "Session not found" });
    if (!record) {
      record = await createWorkspaceSession(requestedWorkspace ?? defaultWorkspace, { title: titleText, runtimeId: agentFrom(req.body ?? {}) });
    }
    await record.abortRecovery;
    if (record.tuiTermId || record.tuiRefreshing) {
      return res.status(409).json({ error: record.tuiRefreshing ? "This session is returning from the terminal. Try again in a moment." : "This session is open in the terminal (TUI). Close the TUI to chat here." });
    }
    const session = record.session;
    const { note: fileNote, refs: fileRefs } = materializeAttachments(record, files);
    const promptText =
      [text, imageNotes.join("\n"), fileNote].filter(Boolean).join("\n\n") ||
      (images.length ? "Please review the attached image(s)." : files.length ? "Please review the attached file(s)." : "");
    eventLog.appendAttachments(record.id, promptText, [...imageRefs, ...fileRefs]);
    const agentPrompt = promptForAgent(record, promptText);
    const cmid = typeof req.body?.clientMessageId === "string" && req.body.clientMessageId ? req.body.clientMessageId : undefined;
    markSessionWorking(record, { type: "agent_start" });
    // Do not await completion; events stream over WebSocket.
    void dedupePrompt(cmid, async () => {
      broadcast({ type: "session.user_message", sessionId: record.id, text: promptText, clientMessageId: req.body?.clientMessageId });
      void maybeNameSession(record, promptText);
      harnessBeginTurn(record);
      await promptWithWatchdog(record, agentPrompt, promptOptionsFor(record, req.body?.streamingBehavior, images));
    }).catch((error) => {
      clearSessionWorking(record);
      broadcast({ type: "session.error", sessionId: record.id, error: String(error?.stack ?? error) });
    });
    res.json({ ok: true, sessionId: record.id, sessionFile: record.sessionFile });
  } catch (error) {
    next(error);
  }
});

app.post("/api/commands/:runId/input", (req, res) => {
  const child = commandProcesses.get(req.params.runId);
  if (!child) return res.status(404).json({ error: "No active command process" });

  child.stdin.write(`${String(req.body?.text ?? "")}\n`);
  res.json({ ok: true });
});

app.post("/api/commands/:runId/terminate", (req, res) => {
  const child = commandProcesses.get(req.params.runId);
  if (!child) return res.status(404).json({ error: "No active command process" });

  child.kill("SIGINT");
  res.json({ ok: true });
});


// On-demand "update GitHub status" for one session: force `refreshPullRequests`
// regardless of whether the session is live/attached, so a stale `open` badge
// on a finished session can be reconciled without waiting for another turn.
app.post("/api/session/pr/refresh", async (req, res, next) => {
  try {
    const session = await resolveOrResumeSession(req.body?.sessionId, req.body?.path);
    if (!session) return res.status(404).json({ error: "Session not found" });
    await refreshPullRequests(session);
    res.json({ ok: true, prUrl: session.prUrl, prs: session.prs });
  } catch (error) {
    next(error);
  }
});

// Global scan: reconcile every session this node has tracked that carries PR
// state. Bounded concurrency inside refreshAllPullRequestStatuses(); only
// changed sessions persist + broadcast.
app.post("/api/sessions/pr/refresh", async (_req, res, next) => {
  try {
    const result = await refreshAllPullRequestStatuses();
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/session/abort", async (req, res, next) => {
  try {
    const record = resolveSession(req.body?.sessionId);
    if (!record) return res.status(404).json({ error: "No active session" });
    await record.session.abort();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Promote a replicated session onto THIS node (the standby taking over an offline
// owner). Runs the control-plane compare-and-set on the ownership epoch, then
// materializes the replicated worktree so the session can be resumed locally.
// Manual — triggered from the app or `bivy sessions promote` (docs/session-replication.md).
app.post("/api/session/promote", async (req, res, next) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    const epoch = await replication.promote(sessionId, identity.nodeId);
    if (epoch === undefined) return res.status(409).json({ error: "Promotion lost the epoch race (another node owns it, or it isn't replicated)" });
    scheduleAdvertise();
    res.json({ ok: true, epoch });
  } catch (error) {
    next(error);
  }
});

// Invoke a protocol-mode agent command (direct/local mode counterpart of the
// relay `session.command.invoke`). Prompt-mode commands go through /prompt; only
// commands the runtime handles out-of-band (RuntimeSession.invokeCommand) land here.
app.post("/api/session/command", async (req, res, next) => {
  try {
    const record = resolveSession(req.body?.sessionId);
    if (!record) return res.status(404).json({ error: "No active session" });
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Command name required" });
    if (typeof record.session.invokeCommand !== "function") {
      return res.status(400).json({ error: `This agent can't run ${name}.` });
    }
    await record.session.invokeCommand(name, String(req.body?.args ?? ""));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Pause: distinct from abort/kill. The agent process keeps running, but the
// guardian forces every subsequent tool call to ask until resumed — a soft
// "hold on" rather than terminating the session.
app.post("/api/session/pause", (req, res) => {
  const record = resolveSession(req.body?.sessionId);
  if (!record) return res.status(404).json({ error: "No active session" });
  pauseSession(record);
  res.json({ ok: true });
});

app.post("/api/session/resume", (req, res) => {
  const record = resolveSession(req.body?.sessionId);
  if (!record) return res.status(404).json({ error: "No active session" });
  resumeSession(record);
  res.json({ ok: true });
});

app.post("/api/session/question/answer", (req, res) => {
  const record = resolveSession(req.body?.sessionId);
  const requestId = String(req.body?.requestId ?? "");
  if (!record || !requestId) return res.status(404).json({ error: "No matching session/question" });
  answerSessionQuestion(record, requestId, req.body ?? {});
  res.json({ ok: true });
});

// Universal Agent Harness — list this session's git checkpoints (rewind targets).
app.post("/api/session/checkpoints", async (req, res, next) => {
  try {
    const record = resolveSession(req.body?.sessionId);
    if (!record) return res.status(404).json({ error: "No active session" });
    const checkpoints = await harness.checkpoints(record.id);
    res.json({ ok: true, sessionId: record.id, checkpoints });
  } catch (error) {
    next(error);
  }
});

// Universal Agent Harness — MCP proxy decision endpoint (called by `bivy
// mcp-proxy`). Governs an MCP tool call through the shared guardian.
app.post("/api/mcp/decide", async (req, res, next) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "");
    const server = String(req.body?.server ?? "mcp");
    const tool = String(req.body?.tool ?? "");
    const out = await governMcpCall(sessionId, server, tool, req.body?.args);
    res.json(out);
  } catch (error) {
    next(error);
  }
});

// Universal Agent Harness — MCP proxy event sink (inventory + results).
app.post("/api/mcp/event", (req, res) => {
  recordMcpEvent(String(req.body?.sessionId ?? ""), req.body?.event);
  res.json({ ok: true });
});

// Universal Agent Harness — restore this session's workspace to a checkpoint.
app.post("/api/session/rewind", async (req, res, next) => {
  try {
    const record = resolveSession(req.body?.sessionId);
    const checkpointId = String(req.body?.checkpointId ?? "").trim();
    if (!record) return res.status(404).json({ error: "No active session" });
    if (!checkpointId) return res.status(400).json({ error: "Missing checkpointId" });
    if (sessionBusy(record)) return res.status(409).json({ error: "Stop the current turn before rewinding." });
    await harness.rewind(record.id, checkpointId);
    broadcast({ type: "session.rewound", sessionId: record.id, checkpointId });
    res.json({ ok: true, sessionId: record.id, checkpointId });
  } catch (error) {
    next(error);
  }
});

app.get("/api/approvals", (_req, res) => {
  res.json(approvals.list());
});

app.post("/api/approvals/:id/approve", (req, res) => {
  const ok = resolveApproval(req.params.id, true);
  broadcast({ type: "approval.resolved", id: req.params.id, approved: true });
  scheduleAdvertise();
  res.status(ok ? 200 : 404).json({ ok });
});

app.post("/api/approvals/:id/reject", (req, res) => {
  const ok = resolveApproval(req.params.id, false);
  broadcast({ type: "approval.resolved", id: req.params.id, approved: false });
  scheduleAdvertise();
  res.status(ok ? 200 : 404).json({ ok });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Honor the error's own status code. Notably `res.sendFile` reports a missing
  // asset as a 404-status error; without this it was surfaced as a 500, which
  // in turn made the CLI health check (`GET /`) read the node as unreachable
  // even though it was up and serving. Only 5xx are genuine server faults worth
  // logging with a stack.
  const status = Number((error as { status?: number; statusCode?: number })?.status
    ?? (error as { statusCode?: number })?.statusCode) || 500;
  if (status >= 500) console.error(error);
  if (res.headersSent) return;
  res.status(status).json({ error: String(error instanceof Error ? error.message : error) });
});

const server = app.listen(port, host, async () => {
  publishBootstrapSecret();
  // Publish the loopback endpoint (+ bootstrap secret) the git credential helper
  // calls to fetch fresh per-repo tokens on demand.
  writeGitCredentialEndpoint(`http://127.0.0.1:${port}`, bootstrapSecret);
  console.log(`Bivy node: http://localhost:${port} (data plane — API + WebSocket; no local UI)`);
  console.log("Open the app via your control plane: run 'bivy open' (or 'bivy relay:setup' first).");
  console.log(`Agent data dir: ${piDir}`);
  console.log(`Workspace: ${defaultWorkspace}`);
  startRelayIfConfigured();
  // Rebuild-resume (Gap B): if this machine was re-provisioned to restore a
  // torn-down session, pull + apply its snapshot before serving. Non-blocking.
  if (process.env.BIVY_RESTORE) void restoreSessionFromSnapshot(String(process.env.BIVY_RESTORE));
  startModelAuthWatcher();
  startOAuthLoginSweeper();
  startGithubAppSyncWatcher();
  await startGitHubTasksIfConfigured();
  startControlPlaneTasksIfConfigured();
  // Best-effort, non-blocking: finish any issue automation an earlier crash/
  // restart interrupted before it could commit/push/open a PR. Never delays
  // startup and never throws (see reconcileOrphanedIssueWork).
  void reconcileOrphanedIssueWork().catch((error) => console.warn("[github-tasks] orphaned-issue reconciliation failed", error));
  // Recover interactive sessions a restart interrupted mid-turn (auto-continue, or
  // flag for a one-tap manual Resume) per the node's sessionResumeMode setting.
  void reconcileInterruptedSessions().catch((error) => console.warn("[resume] interrupted-session reconciliation failed", error));
  // Re-arm (or fire) durable auto-resume markers a limit-hit turn left behind,
  // so a session waiting out a usage/rate window still resumes after a restart.
  try { sessionResumeSweep(); } catch (error) { console.warn("[resume] auto-resume sweep failed at boot", error); }
  // Universal Agent Harness — network effect boundary (opt-in via
  // BIVY_EGRESS_PROXY). Governs/logs outbound traffic of CLI agents, which
  // inherit the proxy env from process.ts.
  const egress = await startEgressProxyIfEnabled((event) => broadcast({ type: "node.egress", event }));
  if (egress) console.log(`Egress broker: http://127.0.0.1:${egress.port} (agent traffic governed)`);
  // Point `bivy mcp-proxy` subprocesses at this node's actual port (they inherit
  // this env). Defaults to 4317 in the CLI, so only needed on a custom port.
  if (!process.env.BIVY_MCP_ENDPOINT) process.env.BIVY_MCP_ENDPOINT = `http://127.0.0.1:${port}`;
});

// A failed bind is fatal and must be reported, not swallowed. `app.listen` emits
// the error on the server; with no handler it reaches the global
// `uncaughtException` net below, which keeps the process alive — leaving a node
// that is "running" but listening on nothing. The common cause is another node
// already on this port (two OS users, or a staging + production node, both
// defaulting to 4317). Print an actionable message and exit so the supervisor
// and `bivy logs` surface a real failure instead of a silent hang.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `[bivy] Port ${port} is already in use — another Bivy node or process holds ${host}:${port}. ` +
        `Give this node its own port (set PORT, or re-run 'bivy setup', which now picks a free one automatically) and start it again.`,
    );
  } else {
    console.error(`[bivy] Could not bind ${host}:${port}:`, error);
  }
  process.exit(1);
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket, req) => {
  // Reject cross-origin / DNS-rebinding upgrades before auth: loopback bypasses
  // auth by default, so a page the user merely visited could otherwise open a
  // cross-origin WebSocket and drive the agent. See requestOriginAllowed.
  if (!requestOriginAllowed(req)) {
    socket.close(1008, "Forbidden origin");
    return;
  }
  if (!isAuthorized(resolveAuth(identity, req))) {
    socket.close(1008, "Unauthorized");
    return;
  }
  clients.add(socket);
  // Terminals opened on this socket; closed when the socket disconnects so a
  // dropped browser tab doesn't leak shells. Output is unicast to this socket.
  const ownedTerminals = new Set<string>();
  // Stable id for this socket, keying its per-terminal size so several clients
  // sharing a PTY size it to their min (see TerminalManager.setClientSize).
  const clientTerminalId = `sock-${randomUUID()}`;
  socket.send(JSON.stringify({ type: "hello", activeSessionId: active?.id, activeSession: active ? { id: active.id, isStreaming: sessionBusy(active), lastActivity: active.lastActivity, workingStartedAt: active.workingStartedAt } : null }));
  // Authoritative version status on every connect: `latest` set means this node
  // is behind (banner shows); absent means up to date (banner + any "Updating…"
  // state clear — this is how the banner disappears after an update lands and
  // the socket reconnects on the new build). Then (re)run the throttled check so
  // a freshly-opened app surfaces a newly-available update without waiting for a
  // session turn.
  socket.send(JSON.stringify({ type: "node.update", current: currentVersion() ?? "", latest: pendingBivyUpdate?.latest }));
  void checkBivyUpdate();
  socket.on("message", (raw) => {
    let msg: { kind?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.kind === "ping") {
      const requestId = (msg as { requestId?: unknown }).requestId;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong", requestId: typeof requestId === "string" ? requestId : undefined }));
      return;
    }
    if (typeof msg?.kind === "string" && msg.kind.startsWith("terminal.")) {
      handleTerminalMessage(msg, (event) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      }, ownedTerminals, clientTerminalId, (termId) => addRunViewer(termId, socket));
    }
  });
  socket.on("close", () => {
    clients.delete(socket);
    dropRunViewer(socket);
    // Release this socket's size on every terminal it sized (owned or just
    // viewed) so shared PTYs grow back to the min of whoever's left attached.
    terminals.dropClient(clientTerminalId);
    for (const id of ownedTerminals) terminals.close(id);
  });
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  relay?.stop();
  githubPoller?.stop();
  controlPlanePoller?.stop();
  // Close each session record so final metadata/status is flushed and every
  // runtime subprocess is disposed (snapshot first — closeSessionRecord mutates
  // openSessions). closeSessionRecord flushes each session's sidecars; flush any
  // remaining (e.g. sessions not currently open) as a backstop.
  for (const record of [...openSessions.values()]) {
    try { closeSessionRecord(record, "shutdown"); } catch {}
  }
  eventLog.flushAll();
  // Persist the tail of the debounced metadata writes (status/activity updates
  // are coalesced on the hot path — see MetadataStore.save).
  try { metadata.flushSync(); } catch {}
  terminals.disposeAll();
  // Drop persistent client/relay sockets so server.close() can actually drain;
  // otherwise a lingering WebSocket keeps the process alive until the supervisor
  // SIGKILLs it, orphaning children.
  for (const socket of clients) {
    try { socket.terminate(); } catch {}
  }
  server.close(() => process.exit(0));
  // Fail-safe: never let a stuck connection block a clean stop. Under systemd/
  // docker/k8s the supervisor sends SIGTERM and expects a timely exit.
  setTimeout(() => process.exit(0), 5000).unref();
}
// Register the signals every production supervisor actually uses to stop a
// service, not just interactive Ctrl-C.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(signal));
}

// Last-resort crash net. The daemon hosts many sessions in one process, so an
// unhandled rejection (which terminates the process on Node 22+) or a stray
// throw from a stream/event callback would take down EVERY live session at
// once, not just the one that faulted. Log it and keep serving rather than
// letting one bad session kill the whole daemon; the supervisor's restart is
// the fallback for a genuinely wedged process, not the first line of defence.
// A rejected promise never corrupts global state, so continuing is safe there;
// for an uncaught exception, continuing is the lesser evil versus dropping
// every other session's in-flight turn.
process.on("unhandledRejection", (reason) => {
  console.error(`[bivy] unhandledRejection (daemon kept running):`, reason);
});
process.on("uncaughtException", (error) => {
  console.error(`[bivy] uncaughtException (daemon kept running):`, error);
});
