// SPDX-License-Identifier: AGPL-3.0-only
//
// The first-class Automations destination — a full-screen surface reached from
// the sidebar foot (peer to Settings). Outcome-first: suggested jobs, your
// automations, recent activity. Source connect (GitHub / Linear / Slack) stays
// on this surface via WorkQueueSetupSheet so setup never dumps people into
// Settings and loses the thread. Creating/editing uses one form modal
// (name → trigger → instructions → machine); templates pre-fill it. Everything
// still writes the same POST /account/automations definition.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cronstrue from "cronstrue";
import {
  createAutomation,
  deleteAutomation,
  fetchAccountNodes,
  fetchAutomationRuns,
  fetchAutomations,
  fetchGithubApp,
  fetchHostedProvisioning,
  fetchLinearHook,
  fetchSlackHook,
  runAutomationNow,
  rotateAutomationWebhook,
  updateAutomation,
  importRoomKey,
  seal,
  open,
  unb64url,
  nlToCron,
  isNlCronOk,
  type AppState,
  type AccountMe,
  type AccountAutomation,
  type AccountAutomationRun,
  type AccountNode,
  type AutomationSimulationDraft,
  type AutomationSimulationEvent,
  type GithubAppInfo,
  type LinearHook,
  type SlackHook,
  type HostedProvisioningStatus,
} from "@bivy/core";
import { controller } from "../store/controller.js";
import {
  type AutomationTemplate,
  type ScheduleTemplate,
  type SourceTemplate,
  type WebhookTemplate,
} from "./automationTemplates.js";
import { WorkQueueSetupSheet, type SourceSetupFocus } from "./WorkQueueSetupSheet.js";
import { GithubQueuePanel } from "./GithubQueue.js";
import { RulesetsPanel } from "./Rulesets.js";
import { QueueRoutingSection } from "./QueueRouting.js";
import { HostedMachinesPanel } from "./HostedMachines.js";
import { takeAutomationsSetupFocus } from "../automationsRoute.js";
import { requestSignIn } from "../signInRequest.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { useCloudMachinesEnabled } from "../cloudMachines.js";
import type { AutomationsSection } from "../router.js";
import type { GithubQueueItem } from "@bivy/core";
import { ConfirmDialog } from "./AppDialog.js";
import { CloseIcon, PlusIcon } from "./UiIcons.js";
import { AutomationSourcesPanel } from "./AutomationSourcesPanel.js";
import { RunHistory } from "./RunHistory.js";
import { compactCronSummary, formatAutomationMoment, formatNextAutomationRun } from "../automationPresentation.js";
import { isListedAutomation } from "../automationList.js";
import { Badge } from "./Badge.js";
import { NewAutomationChooser, NewAutomationPicker } from "./NewAutomationChooser.js";
import { AutomationPreflightPanel, useAutomationPreflight } from "./AutomationPreflight.js";
import { IconBolt, IconClock, IconPr, IconWebhook } from "./AutomationIcons.js";

const TEMPLATE_PREFIX = "bivy-room-v1";

// Trigger picker options shown under "+ Add Trigger". Schedule/webhook map onto
// automation definition fields. GitHub/Linear are source triggers whose event
// filters are configured in the source editor; connection setup is only shown
// when the selected source has not been connected yet.
type TriggerPick =
  | { id: "daily"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "weekly"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "monthly"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "once"; label: string; hint: string; trigger: "schedule"; kind: "once" }
  | { id: "webhook"; label: string; hint: string; trigger: "webhook" }
  | { id: "github"; label: string; hint: string; trigger: "source"; source: "github" }
  | { id: "linear"; label: string; hint: string; trigger: "source"; source: "linear" };

const TRIGGER_OPTIONS: TriggerPick[] = [
  { id: "daily", label: "Daily", hint: "Every day at a chosen time", trigger: "schedule", kind: "cron", cron: "0 9 * * *", nlText: "every day at 9am" },
  { id: "weekly", label: "Weekly", hint: "Every week on a chosen day", trigger: "schedule", kind: "cron", cron: "0 9 * * 1", nlText: "every monday at 9am" },
  { id: "monthly", label: "Monthly", hint: "Every month on a chosen day", trigger: "schedule", kind: "cron", cron: "0 9 1 * *", nlText: "every month on the 1st at 9am" },
  { id: "once", label: "One time", hint: "Run once at a chosen date and time", trigger: "schedule", kind: "once" },
  // One GitHub entry — events (issues, mentions, CI, …) are filters on the job, not sibling triggers.
  { id: "github", label: "GitHub", hint: "App events you choose — labels, @mentions, failed CI, …", trigger: "source", source: "github" },
  { id: "linear", label: "Linear", hint: "Labeled issue → session on your machine", trigger: "source", source: "linear" },
  { id: "webhook", label: "Webhook", hint: "When a signed request hits its URL", trigger: "webhook" },
];

/** Render a cron expression as a human sentence; blank on anything invalid. */
function describeCron(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed) return "";
  try {
    return cronstrue.toString(trimmed, { throwExceptionOnParseError: true, use24HourTimeFormat: false });
  } catch {
    return "";
  }
}

function timezoneOptions(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let zones: string[];
  try {
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  if (!zones.length) {
    zones = ["UTC", "Europe/Oslo", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function scheduleSummary(item: AccountAutomation): string {
  const repo = item.repo ? ` · ${item.repo}` : "";
  const repos = item.repos?.length ? ` · ${item.repos.join(", ")}` : "";
  const labels = item.labels?.length ? item.labels.join(", ") : "bivy";
  const node = item.nodeLabel ? ` · ${item.nodeLabel}` : "";
  if (item.trigger === "github") {
    const events = summarizeGithubEvents(item);
    return `GitHub · ${events}${repos}${node}`;
  }
  if (item.trigger === "github_ci") {
    const wf = item.labels?.length ? ` · workflow ${item.labels.join(", ")}` : " · any workflow";
    return `GitHub · failed CI${wf}${repos}${node}`;
  }
  if (item.trigger === "linear") return `Linear · label ${labels}${repo || repos}${node}`;
  if (item.trigger === "webhook") return `Webhook · runs on a signed request${repo}`;
  if (!item.schedule) return `Scheduled${repo}`;
  if (item.schedule.kind === "once") return `Runs once · ${formatAutomationMoment(item.schedule.at)}${repo}`;
  const when = compactCronSummary(item.schedule.expression) || describeCron(item.schedule.expression) || `${item.schedule.expression} · ${item.schedule.timezone}`;
  return `${when}${repo}`;
}

function isSourceTrigger(t: AccountAutomation["trigger"]): t is "github" | "linear" | "github_ci" {
  return t === "github" || t === "linear" || t === "github_ci";
}

function automationPrioritySort(a: AccountAutomation, b: AccountAutomation): number {
  const ao = a.configOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.configOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/** Human summary of GitHub `on` rules (or legacy defaults). */
function summarizeGithubEvents(item: AccountAutomation): string {
  const on = item.on;
  if (!on?.length) {
    const labels = item.labels?.length ? item.labels.join(", ") : "bivy";
    return `label ${labels} · @mention`;
  }
  const bits: string[] = [];
  if (on.some((r) => r.event === "issues")) bits.push("issues");
  if (on.some((r) => r.event === "issue_comment" || r.mention)) bits.push("@mention");
  if (on.some((r) => r.event === "pull_request")) bits.push("PRs");
  if (on.some((r) => r.event === "pull_request_review_comment")) bits.push("review @mention");
  if (on.some((r) => r.event === "workflow_run")) bits.push("failed CI");
  return bits.length ? bits.join(" · ") : "custom events";
}

type GithubEventToggles = {
  issuesLabeled: boolean;
  issueMention: boolean;
  prLabeled: boolean;
  prMention: boolean;
  workflowFailed: boolean;
};

function togglesFromAutomation(item: AccountAutomation): GithubEventToggles {
  if (item.trigger === "github_ci") {
    return { issuesLabeled: false, issueMention: false, prLabeled: false, prMention: false, workflowFailed: true };
  }
  const on = item.on;
  if (!on?.length) {
    // Legacy github default.
    return { issuesLabeled: true, issueMention: true, prLabeled: false, prMention: false, workflowFailed: false };
  }
  return {
    issuesLabeled: on.some((r) => r.event === "issues"),
    issueMention: on.some((r) => r.event === "issue_comment" && r.mention),
    prLabeled: on.some((r) => r.event === "pull_request"),
    prMention: on.some((r) => r.event === "pull_request_review_comment" && r.mention),
    workflowFailed: on.some((r) => r.event === "workflow_run"),
  };
}

function buildGithubOn(
  toggles: GithubEventToggles,
  labelList: string[] | undefined,
  workflowList: string[] | undefined,
): NonNullable<AccountAutomation["on"]> {
  const labels = labelList?.length ? labelList : ["bivy"];
  const on: NonNullable<AccountAutomation["on"]> = [];
  if (toggles.issuesLabeled) on.push({ event: "issues", labels });
  if (toggles.issueMention) on.push({ event: "issue_comment", mention: true });
  if (toggles.prLabeled) on.push({ event: "pull_request", labels });
  if (toggles.prMention) on.push({ event: "pull_request_review_comment", mention: true });
  if (toggles.workflowFailed) {
    on.push({
      event: "workflow_run",
      actions: ["completed"],
      conclusions: ["failure", "timed_out", "startup_failure"],
      workflows: workflowList?.length ? workflowList : undefined,
    });
  }
  return on;
}

/**
 * A representative event fixture for the editor's "Test event" workflow —
 * derived from whichever GitHub event toggle (or the Linear label filter) is
 * currently enabled, so testing needs no separate fixture-authoring step. The
 * first enabled toggle wins, matching first-match's own "first wins"
 * intuition; a source trigger with nothing enabled yet has nothing
 * representative to test.
 */
function buildRepresentativeEvent(d: Draft): AutomationSimulationEvent | undefined {
  const repo = d.repo.trim() || d.repos.split(/[,\n]/).map((v) => v.trim()).find(Boolean);
  const labels = d.labels.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  const workflows = d.workflows.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  if (d.trigger === "linear") return { kind: "linear", repo, labels: labels.length ? labels : ["bivy"] };
  if (d.trigger !== "github") return undefined;
  const appId = d.appId.trim() || undefined;
  if (d.githubEvents.issuesLabeled) return { kind: "github", repo, appId, event: "issues", action: "labeled", labels: labels.length ? labels : ["bivy"] };
  if (d.githubEvents.issueMention) return { kind: "github", repo, appId, event: "issue_comment", mention: true };
  if (d.githubEvents.prLabeled) return { kind: "github", repo, appId, event: "pull_request", action: "labeled", labels: labels.length ? labels : ["bivy"] };
  if (d.githubEvents.prMention) return { kind: "github", repo, appId, event: "pull_request_review_comment", mention: true };
  if (d.githubEvents.workflowFailed) return { kind: "github", repo, appId, event: "workflow_run", action: "completed", conclusion: "failure", workflow: workflows[0] };
  return undefined;
}

function nodeLabelSuffix(nodeLabel?: string): string {
  if (!nodeLabel) return "";
  return nodeLabel.startsWith("bivy/") ? nodeLabel.slice("bivy/".length) : nodeLabel;
}

interface SourcesSnapshot {
  github: GithubAppInfo | null;
  linear: LinearHook | null;
  slack: SlackHook | null;
  nodes: AccountNode[];
  hosted: HostedProvisioningStatus | null;
}

function emptySources(): SourcesSnapshot {
  return { github: null, linear: null, slack: null, nodes: [], hosted: null };
}

function githubSourceStatus(gh: GithubAppInfo | null, hostedReady = false): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!gh?.connected || !gh.apps?.length) {
    return { tone: "off", label: "Not connected", detail: "Connect a GitHub App to run issue and CI automations." };
  }
  const installed = gh.apps.some((a) => a.installed || (a.installCount ?? 0) > 0);
  const served = gh.apps.some((a) => a.servedBy?.online);
  const count = gh.apps.reduce((n, a) => n + (a.installCount ?? (a.installed ? 1 : 0)), 0);
  if (!installed) {
    return { tone: "warn", label: "App created · not installed", detail: "Install the app on at least one repository." };
  }
  if (hostedReady) return { tone: "on", label: `Installed${count ? ` · ${count} repo(s)` : ""} · ephemeral ready`, detail: "Hosted ephemeral execution can claim work without a persistent node." };
  if (!served && !gh.apps.some((a) => a.servedBy)) {
    return { tone: "warn", label: `Installed${count ? ` · ${count} repo(s)` : ""} · no machine`, detail: "No machine is serving the app key yet." };
  }
  const online = served ? "online" : "offline";
  return {
    tone: served ? "on" : "warn",
    label: `${count || gh.apps.length} repo(s) · machine ${online}`,
    detail: "Issues, @mentions, and (when enabled) Actions failures can start sessions.",
  };
}

function linearSourceStatus(lin: LinearHook | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!lin) return { tone: "off", label: "Not connected", detail: "Connect Linear to turn labeled issues into sessions." };
  if (lin.enabled === false) return { tone: "warn", label: "Needs secret", detail: "Webhook URL exists — finish with Linear's signing secret." };
  return { tone: "on", label: "Connected", detail: "Labeled Linear issues can start sessions." };
}

function slackSourceStatus(slack: SlackHook | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!slack) return { tone: "off", label: "Not connected", detail: "Connect Slack so /bivy commands reach your machines." };
  if (slack.enabled === false) return { tone: "warn", label: "Disabled", detail: "Slack hook exists but is turned off." };
  return { tone: "on", label: "Connected", detail: "Slash commands create runs." };
}

/** Status chip for a source automation given live connect state. */
function githubAppOptionLabel(app: NonNullable<GithubAppInfo["apps"]>[number]): string {
  const name = app.name || app.mention || app.owner || app.appId || "GitHub App";
  const kind = app.central ? "Hosted Bivy App" : app.hosted ? "Hosted custom app" : "Custom/user-installed app";
  const owner = app.owner ? ` · ${app.owner}${app.ownerType ? ` (${app.ownerType})` : ""}` : "";
  return `${name} · ${kind}${owner}`;
}

function sourceAutomationChip(
  item: AccountAutomation,
  sources: SourcesSnapshot,
): { tone: "on" | "off" | "warn"; label: string } {
  const executorReady = sources.nodes.some((node) => node.online) || Boolean(sources.hosted?.execution.ready);
  if (item.trigger === "github" || item.trigger === "github_ci") {
    const gh = githubSourceStatus(sources.github, Boolean(sources.hosted?.execution.ready));
    if (gh.tone === "off") return { tone: "warn", label: item.enabled ? "Needs GitHub" : "Draft · needs GitHub" };
    if (gh.tone === "warn") return { tone: "warn", label: item.enabled ? gh.label : `Draft · ${gh.label}` };
    if (!item.enabled) return { tone: "off", label: "Paused" };
    if (!executorReady) return { tone: "warn", label: "Needs executor" };
    if (item.trigger === "github_ci") return { tone: "on", label: "Active · verify workflow_run" };
    return { tone: "on", label: "Active" };
  }
  if (item.trigger === "linear") {
    const lin = linearSourceStatus(sources.linear);
    if (lin.tone === "off") return { tone: "warn", label: item.enabled ? "Needs Linear" : "Draft · needs Linear" };
    if (lin.tone === "warn") return { tone: "warn", label: item.enabled ? lin.label : `Draft · ${lin.label}` };
    if (!item.enabled) return { tone: "off", label: "Paused" };
    return executorReady ? { tone: "on", label: "Active" } : { tone: "warn", label: "Needs executor" };
  }
  if (!item.enabled) return { tone: "off", label: "Paused" };
  return executorReady ? { tone: "on", label: "Active" } : { tone: "warn", label: "Needs executor" };
}

/** Infer which trigger-picker option best matches a draft (for the chip label). */
function matchTriggerPick(d: Draft): TriggerPick | null {
  if (d.trigger === "github" || d.trigger === "linear") return TRIGGER_OPTIONS.find((o) => o.id === d.trigger) ?? null;
  if (d.trigger === "webhook") return TRIGGER_OPTIONS.find((o) => o.id === "webhook") ?? null;
  if (d.kind === "once") return TRIGGER_OPTIONS.find((o) => o.id === "once") ?? null;
  const cron = d.cron.trim();
  for (const o of TRIGGER_OPTIONS) {
    if (o.trigger === "schedule" && o.kind === "cron" && o.cron === cron) return o;
  }
  // Custom cron — synthesise a chip from the human description.
  return {
    id: "weekly",
    label: describeCron(cron) || "Custom schedule",
    hint: cron,
    trigger: "schedule",
    kind: "cron",
    cron,
    nlText: d.nlText,
  };
}

interface Draft {
  id: string | null;
  name: string;
  instructions: string;
  /** False until the user picks a trigger (or a template supplies one). */
  hasTrigger: boolean;
  trigger: "schedule" | "webhook" | "github" | "linear";
  kind: "cron" | "once";
  cron: string;
  nlText: string;
  timezone: string;
  onceAt: string;
  /** GitHub repo workspace (`owner/name`) when the trigger does not carry one. */
  repo: string;
  labels: string;
  repos: string;
  appId: string;
  githubEvents: GithubEventToggles;
  workflows: string;
  nodeId: string;
  runtimeId: string;
  model: string;
  approvalMode: "never" | "risky" | "always" | "autonomous";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  requireSigning: boolean;
}

function emptyDraft(nodeId: string): Draft {
  return {
    id: null,
    name: "",
    instructions: "",
    hasTrigger: false,
    trigger: "schedule",
    kind: "cron",
    cron: "0 9 * * *",
    nlText: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    onceAt: toLocalInput(new Date(Date.now() + 60 * 60_000)),
    repo: "",
    labels: "bivy",
    repos: "",
    appId: "",
    githubEvents: { issuesLabeled: true, issueMention: true, prLabeled: false, prMention: false, workflowFailed: false },
    workflows: "",
    nodeId,
    runtimeId: "",
    model: "",
    approvalMode: "autonomous",
    sandbox: "workspace-write",
    requireSigning: true,
  };
}

/** Prefer the composer's current draft repo so templates open pre-filled. */
function rememberedRepo(state: AppState): string {
  return state.draft.repo || "";
}

function defaultSourceInstructions(): string {
  return "Handle the incoming item using its event context. Investigate the request, make the smallest safe change, run the relevant checks, and report the outcome with links to any pull request or follow-up.";
}

interface Notice {
  tone: "ok" | "info" | "warn";
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}

/** Top-level destinations: definitions and source setup, the unified Run feed
 *  and routing, then execution policy. The URL owns the selected tab. */
const AUTOMATIONS_TABS: Array<{ label: string; section: AutomationsSection | null }> = [
  { label: "Automations", section: null },
  { label: "Rulesets", section: "rulesets" },
];

function automationCloudGate(me: AccountMe | null): { actions: NonNullable<NonNullable<AccountMe["extension"]>["actions"]> } | null {
  const extension = me?.extension;
  const automationFact = extension?.facts?.find((fact) => fact.id === "automations");
  if (!extension || !automationFact || !/cloud required/i.test(automationFact.value)) return null;
  return { actions: extension.actions ?? [] };
}

export function AutomationsView({
  state,
  onClose,
  section,
  onSectionChange,
  onOpenSession,
  onOpenRun,
  githubQueue,
  onRefreshGithubQueue,
}: {
  state: AppState;
  onClose: () => void;
  /** Active tab, driven by the URL (`/automations/:section`); null = Overview. */
  section: AutomationsSection | null;
  onSectionChange: (section: AutomationsSection | null) => void;
  onOpenSession: (sessionId: string) => void;
  /** Open the routable Run detail screen (/runs/:runId) for a Run in the feed. */
  onOpenRun?: (runId: string) => void;
  /** Incoming GitHub/Linear work-queue items — polled at the app shell and
   *  rendered by the Work Queue tab (was a Settings panel). */
  githubQueue?: GithubQueueItem[] | null;
  onRefreshGithubQueue?: () => void;
}) {
  const [items, setItems] = useState<AccountAutomation[]>([]);
  const [runs, setRuns] = useState<AccountAutomationRun[]>([]);
  const [sources, setSources] = useState<SourcesSnapshot>(emptySources);
  const [me, setMe] = useState<AccountMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sourceEdit, setSourceEdit] = useState<AccountAutomation | null>(null);
  const [rotated, setRotated] = useState<{ id: string; secret: string } | null>(null);
  const [setupFocus, setSetupFocus] = useState<SourceSetupFocus | null>(null);
  const [cancelRun, setCancelRun] = useState<AccountAutomationRun | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AccountAutomation | null>(null);
  /** Create chooser (scratch + templates). Opens from New automation. */
  const [chooserOpen, setChooserOpen] = useState(false);
  const [historyAutomationId, setHistoryAutomationId] = useState<string | null>(null);

  // Solo (account-free QR) and direct (loopback) pairings have no account
  // session — every account fetch below would 401. Skip them and render the
  // signpost branch instead of surfacing a raw error.
  const accountless = !controller.signedIn;
  const cloudMachinesOptIn = useCloudMachinesEnabled();
  const cloudMachinesEnabled = EPHEMERAL_MACHINES_ENABLED && cloudMachinesOptIn;

  const refreshRuns = useCallback(async () => {
    if (accountless) return;
    const recent = await fetchAutomationRuns(controller.local, 30);
    setRuns(recent);
  }, [accountless]);

  const refresh = useCallback(async () => {
    if (accountless) {
      setLoading(false);
      return;
    }
    const canQuery = !controller.direct;
    const [definitions, recent, account, gh, lin, slack, nodes, hosted] = await Promise.all([
      fetchAutomations(controller.local),
      fetchAutomationRuns(controller.local, 30),
      canQuery ? controller.fetchMe().catch(() => null) : Promise.resolve(null),
      canQuery ? fetchGithubApp(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchLinearHook(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchSlackHook(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchAccountNodes(controller.local).catch(() => [] as AccountNode[]) : Promise.resolve([] as AccountNode[]),
      canQuery ? fetchHostedProvisioning(controller.local).catch(() => null) : Promise.resolve(null),
    ]);
    setItems(definitions);
    setRuns(recent);
    setMe(account);
    setSources({ github: gh, linear: lin, slack, nodes, hosted });
    setLoading(false);
  }, [accountless]);

  useEffect(() => { void refresh().catch((e) => { setError(String(e)); setLoading(false); }); }, [refresh]);
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = controller.onRunUpdated(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refreshRuns().catch(() => {}), 100);
    });
    // Polling is recovery only: a backgrounded browser or old relay can miss a
    // best-effort hint. Keep the interval deliberately calm.
    const recovery = section === "queue" ? setInterval(() => void refreshRuns().catch(() => {}), 30_000) : null;
    return () => { unsubscribe(); if (debounce) clearTimeout(debounce); if (recovery) clearInterval(recovery); };
  }, [refreshRuns, section]);
  useEffect(() => {
    controller.listRuntimes();
    controller.listModels();
    controller.listRepos();
  }, []);
  // Settings / OAuth return can open Automations with a connection sheet already up.
  useEffect(() => {
    const focus = takeAutomationsSetupFocus();
    if (focus) setSetupFocus(focus);
  }, []);


  const defaultNodeId = state.connection.currentNodeId || controller.local.cur || "";
  const listedItems = useMemo(() => items.filter(isListedAutomation).sort(automationPrioritySort), [items]);
  const isEmpty = !loading && listedItems.length === 0;

  function openSetup(focus: SourceSetupFocus) {
    setSetupFocus(focus);
  }

  function openChooser() {
    setError("");
    setNotice(null);
    setChooserOpen(true);
  }

  function startFromScheduleTemplate(template: ScheduleTemplate) {
    const p = template.prefill;
    setError("");
    setNotice(null);
    setDraft({
      ...emptyDraft(defaultNodeId),
      name: p.name,
      instructions: p.instructions,
      hasTrigger: true,
      trigger: "schedule",
      kind: "cron",
      cron: p.schedule.cron,
      nlText: p.schedule.nlText,
      repo: rememberedRepo(state),
      approvalMode: p.approvalMode,
      sandbox: p.sandbox,
    });
  }

  function startFromWebhookTemplate(template: WebhookTemplate) {
    const p = template.prefill;
    setError("");
    setNotice(null);
    setDraft({
      ...emptyDraft(defaultNodeId),
      name: p.name,
      instructions: p.instructions,
      hasTrigger: true,
      trigger: "webhook",
      repo: rememberedRepo(state),
      approvalMode: p.approvalMode,
      sandbox: p.sandbox,
    });
  }

  async function startFromSourceTemplate(template: SourceTemplate) {
    setError("");
    setNotice(null);
    try {
      // A source Automation is a Draft until its source is actually connected.
      // Creating an enabled definition first made the UI claim “on” while no
      // event could reach it. Probe before writing, then persist truthful state.
      const github = template.trigger === "github" || template.trigger === "github_ci"
        ? await fetchGithubApp(controller.local).catch(() => null)
        : null;
      const linear = template.trigger === "linear"
        ? await fetchLinearHook(controller.local).catch(() => null)
        : null;
      const needsGithub = Boolean(github && githubSourceStatus(github).tone !== "on") || ((template.trigger === "github" || template.trigger === "github_ci") && !github);
      const needsLinear = template.trigger === "linear" && linearSourceStatus(linear).tone !== "on";
      const sourceReady = !needsGithub && !needsLinear;

      if (template.trigger !== "github_ci") {
        const existing = items.find((i) => i.trigger === template.trigger);
        if (existing) {
          await continueWithSource(template.trigger, emptyDraft(defaultNodeId));
        } else {
          const base = emptyDraft(defaultNodeId);
          setDraft({
            ...base,
            name: template.prefill.name,
            instructions: defaultSourceInstructions(),
            hasTrigger: true,
            trigger: template.trigger,
            labels: (template.prefill.labels ?? ["bivy"]).join(", "),
            githubEvents: template.trigger === "github"
              ? { issuesLabeled: true, issueMention: true, prLabeled: true, prMention: true, workflowFailed: false }
              : base.githubEvents,
            approvalMode: "autonomous",
            sandbox: "workspace-write",
          });
        }
        if (needsGithub) openSetup("work-queue");
        if (needsLinear) openSetup("linear");
        setNotice({
          tone: sourceReady ? "info" : "warn",
          title: sourceReady ? `${template.title} ready to review` : `${template.title} needs setup`,
          body: sourceReady
            ? "Review the encrypted instructions and turn it on when ready."
            : "Finish connecting the source, then review and turn on the Automation. It cannot receive events yet.",
        });
        return;
      }

      const existing = items.find((i) => i.trigger === template.trigger);
      if (existing) {
        if (sourceReady && !existing.enabled) await updateAutomation(controller.local, existing.id, { enabled: true });
      } else {
        await createAutomation(controller.local, {
          name: template.prefill.name,
          trigger: template.trigger,
          templateId: template.prefill.templateId,
          labels: template.prefill.labels,
          enabled: sourceReady,
        });
      }
      await refresh();

      if (needsGithub) {
        openSetup(template.trigger === "github_ci" ? "github" : "work-queue");
        setNotice({
          tone: "info",
          title: `${template.title} saved as a draft`,
          body: "Connect and install the GitHub App, then resume the Automation. It cannot receive events yet.",
        });
      } else if (needsLinear) {
        openSetup("linear");
        setNotice({
          tone: "info",
          title: `${template.title} saved as a draft`,
          body: "Finish connecting Linear, then resume the Automation. It cannot receive events yet.",
        });
      } else {
        setNotice({
          tone: "ok",
          title: `${template.title} is live`,
          body: template.trigger === "github_ci"
            ? "Failed workflow runs will open a diagnosing session. Existing GitHub Apps may need the workflow_run event."
            : template.trigger === "linear"
              ? "Label a Linear issue bivy (or bivy/<machine>) to enqueue it."
              : "Label a GitHub issue bivy or @mention the app with what to do.",
        });
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  function startFromTemplate(template: AutomationTemplate) {
    setChooserOpen(false);
    if (template.kind === "schedule") startFromScheduleTemplate(template);
    else if (template.kind === "webhook") startFromWebhookTemplate(template);
    else void startFromSourceTemplate(template);
  }

  function startFromScratch() {
    setChooserOpen(false);
    setError("");
    setNotice(null);
    setDraft(emptyDraft(defaultNodeId));
  }

  async function continueWithSource(source: "github" | "linear", current: Draft, opts?: { keepExistingName?: boolean }) {
    const existing = items.find((item) => item.trigger === source);
    if (!existing) {
      setDraft({ ...current, hasTrigger: true, trigger: source });
      return;
    }

    let instructions = defaultSourceInstructions();
    const parts = existing.templateCiphertext?.split(":");
    if (parts?.[0] === TEMPLATE_PREFIX && parts[1] && parts.slice(2).length) {
      const roomKey = controller.local.keys()[parts[1]];
      if (roomKey) instructions = await open(await importRoomKey(unb64url(roomKey)), parts.slice(2).join(":"));
    }
    const base = emptyDraft(parts?.[1] || defaultNodeId);
    setDraft({
      ...base,
      id: existing.id,
      name: current.name.trim() ? current.name : opts?.keepExistingName ? existing.name : "",
      instructions: current.instructions.trim() ? current.instructions : instructions,
      hasTrigger: true,
      trigger: source,
      repo: existing.repo || "",
      labels: (existing.labels ?? ["bivy"]).join(", "),
      repos: (existing.repos ?? []).join(", "),
      appId: existing.appId || "",
      githubEvents: togglesFromAutomation(existing),
      workflows: (existing.on?.find((rule) => rule.event === "workflow_run")?.workflows ?? []).join(", "),
      runtimeId: existing.runtimeId || "",
      model: existing.model || "",
      approvalMode: existing.approvalMode ?? "autonomous",
      sandbox: existing.sandbox || "workspace-write",
    });
  }

  async function edit(item: AccountAutomation) {
    setError("");
    if (item.trigger === "github" || item.trigger === "linear") {
      await continueWithSource(item.trigger, emptyDraft(defaultNodeId), { keepExistingName: true });
      return;
    }
    if (item.trigger === "github_ci") {
      setSourceEdit(item);
      return;
    }
    let instructions = "";
    const parts = item.templateCiphertext?.split(":");
    if (parts?.[0] === TEMPLATE_PREFIX && parts[1] && parts.slice(2).length) {
      const roomKey = controller.local.keys()[parts[1]];
      if (!roomKey) {
        setError("This device does not hold the assigned machine's encryption key, so its instructions can't be shown here.");
        return;
      }
      instructions = await open(await importRoomKey(unb64url(roomKey)), parts.slice(2).join(":"));
    }
    const nodeId = parts?.[1] || defaultNodeId;
    const base = emptyDraft(nodeId);
    setDraft({
      ...base,
      id: item.id,
      name: item.name,
      instructions,
      hasTrigger: true,
      trigger: item.trigger === "webhook" ? "webhook" : "schedule",
      requireSigning: item.trigger === "webhook" ? item.requireSigning !== false : base.requireSigning,
      nodeId,
      repo: item.repo || "",
      runtimeId: item.runtimeId || "",
      model: item.model || "",
      approvalMode: item.approvalMode ?? "autonomous",
      sandbox: item.sandbox || "workspace-write",
      kind: item.schedule?.kind === "once" ? "once" : "cron",
      cron: item.schedule?.kind === "cron" ? item.schedule.expression : base.cron,
      timezone: item.schedule?.kind === "cron" ? item.schedule.timezone : base.timezone,
      onceAt: item.schedule?.kind === "once" ? toLocalInput(new Date(item.schedule.at)) : base.onceAt,
    });
  }

  async function toggle(item: AccountAutomation) {
    try {
      await updateAutomation(controller.local, item.id, { enabled: !item.enabled });
      await refresh();
      setNotice({
        tone: "ok",
        title: item.enabled ? `Paused “${item.name}”` : `Resumed “${item.name}”`,
      });
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function moveSourceAutomation(item: AccountAutomation, direction: -1 | 1) {
    const sourceItems = items.filter((i) => isSourceTrigger(i.trigger) && !i.configKey).sort(automationPrioritySort);
    const index = sourceItems.findIndex((i) => i.id === item.id);
    const swap = sourceItems[index + direction];
    if (!swap) return;
    const orders = sourceItems.map((i, n) => i.configOrder ?? n);
    try {
      await Promise.all([
        updateAutomation(controller.local, item.id, { configOrder: orders[index + direction] }),
        updateAutomation(controller.local, swap.id, { configOrder: orders[index] }),
      ]);
      await refresh();
      setNotice({ tone: "ok", title: `Moved “${item.name}” ${direction < 0 ? "earlier" : "later"}` });
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function runNow(item: AccountAutomation) {
    try {
      const run = await runAutomationNow(controller.local, item.id);
      controller.recordProductMilestone("run_accepted");
      await refresh();
      const sessionId = run.output?.sessionId;
      setNotice({
        tone: "ok",
        title: `Started “${item.name}”`,
        body: sessionId ? "A session is running on the assigned machine." : "Queued — it will appear in Recent activity shortly.",
        action: sessionId
          ? { label: "Open session", onClick: () => { onOpenSession(sessionId); onClose(); } }
          : undefined,
      });
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function cancelConfirmedRun() {
    const run = cancelRun;
    if (!run) return;
    setCancelRun(null);
    setCancelError(null);
    setCancelBusyId(run.id);
    try {
      const refreshed = await controller.cancelAutomationRun(run.id);
      setRuns(refreshed.runs);
      onRefreshGithubQueue?.();
    } catch (e) {
      setCancelError(String((e as Error)?.message || e));
    } finally {
      setCancelBusyId(null);
    }
  }

  async function rotate(item: AccountAutomation) {
    setError("");
    try {
      const result = await rotateAutomationWebhook(controller.local, item.id);
      setRotated({ id: item.id, secret: result.webhookSecret });
      await refresh();
      setNotice({
        tone: "warn",
        title: "New signing secret — copy it now",
        body: "It is only shown once. The previous secret stops working immediately.",
      });
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function remove(item: AccountAutomation): Promise<boolean> {
    setPendingDelete(item);
    return false;
  }

  async function deleteConfirmed() {
    const item = pendingDelete;
    if (!item) return;
    setPendingDelete(null);
    try {
      await deleteAutomation(controller.local, item.id);
      setDraft(null);
      setSourceEdit(null);
      await refresh();
      setNotice({ tone: "ok", title: `Deleted “${item.name}”` });
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  const definitionRuns = runs;
  const cloudAutomationGate = useMemo(() => automationCloudGate(me), [me]);
  const invokeCloudGateAction = useCallback((actionId: string) => {
    controller.invokeAccountExtensionAction(actionId)
      .then(({ url }) => { window.location.assign(url); })
      .catch((e) => setError(String(e?.message || e)));
  }, []);
  const ghStatus = githubSourceStatus(sources.github);
  const linStatus = linearSourceStatus(sources.linear);
  const slackStatus = slackSourceStatus(sources.slack);

  // No account session (solo QR pairing or loopback/direct): automations run
  // through a control plane — Bivy Cloud or a self-hosted one — which stores
  // triggers and queues Runs while this device and the machine are offline.
  // Say so and point at both remedies instead of hiding the surface or
  // surfacing a raw 401 (the pre-split behavior).
  if (accountless) {
    return createPortal(
      <div className="automations-view" role="dialog" aria-modal="true" aria-label="Automations">
        <header className="automations-view-head">
          <div className="automations-view-head-text">
            <h1 className="automations-view-heading">Automations</h1>
            <p className="automations-view-sub">Jobs that run on your machines while you&apos;re away.</p>
          </div>
          <div className="automations-view-head-actions">
            <button type="button" className="btn ghost icon autom-close-btn" onClick={onClose} title="Close" aria-label="Close automations"><CloseIcon /></button>
          </div>
        </header>
        <div className="automations-view-body">
          <section className="autom-hero">
            <div className="autom-hero-copy">
              <h2 className="autom-hero-title">Automations need an account</h2>
              <p className="autom-hero-body">
                Automations run through a control plane, which stores your triggers and queues Runs
                even while this device and your machine are offline. Right now this device is paired
                to your machine directly, without an account, so there&apos;s nowhere to keep them.
              </p>
              <p className="autom-hero-body">
                {controller.solo
                  ? "Sign in here to add this machine to an account — on Bivy Cloud or on a control plane you host yourself."
                  : "Open the Bivy app from a control plane — Bivy Cloud or one you host yourself — and sign in there to use automations."}
              </p>
              <div className="autom-hero-actions">
                {controller.solo && (
                  <button type="button" className="btn primary" onClick={requestSignIn}>
                    Sign in or create an account
                  </button>
                )}
                <a className="btn" href="https://github.com/bivysh/bivy/blob/main/docs/self-host.md" target="_blank" rel="noopener">
                  Self-hosting guide
                </a>
              </div>
            </div>
          </section>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className={`automations-view${historyAutomationId ? " is-history" : ""}`} role="dialog" aria-modal="true" aria-label="Automations">
      <header className="automations-view-head">
        <div className="automations-view-head-text">
          <h1 className="automations-view-heading">Automations</h1>
          <p className="automations-view-sub">Jobs that run on your machines while you&apos;re away.</p>
        </div>
        <div className="automations-view-head-actions">
          <button type="button" className="btn primary autom-new-btn" onClick={openChooser} aria-label="New automation">
            <PlusIcon size={18} />
            <span className="autom-new-btn-label">New automation</span>
          </button>
          <button type="button" className="btn ghost icon autom-close-btn" onClick={onClose} title="Close" aria-label="Close automations"><CloseIcon /></button>
        </div>
      </header>

      <nav className="automations-tabs" aria-label="Automations sections">
        {AUTOMATIONS_TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            className={`automations-tab${section === tab.section ? " active" : ""}`}
            aria-current={section === tab.section ? "page" : undefined}
            onClick={() => onSectionChange(tab.section)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="automations-view-body">
        {cloudAutomationGate && (
          <div className="autom-notice warn" role="status">
            <div className="autom-notice-text">
              <strong>Hosted automations require Cloud</strong>
              <span>GitHub, schedules, and other hosted triggers can be configured, but incoming events are shown as blocked until this account is upgraded. Self-hosted control planes are not limited by Bivy Cloud billing.</span>
            </div>
            {cloudAutomationGate.actions.length > 0 && (
              <div className="autom-notice-actions">
                {cloudAutomationGate.actions.map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    className={`btn sm ${action.kind === "primary" ? "primary" : ""}`}
                    onClick={() => invokeCloudGateAction(action.id)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="autom-notice warn" role="alert">
            <div className="autom-notice-text"><strong>Something went wrong</strong><span>{error}</span></div>
            <button type="button" className="btn ghost icon" onClick={() => setError("")} aria-label="Dismiss">✕</button>
          </div>
        )}
        {notice && (
          <div className={`autom-notice ${notice.tone}`} role="status">
            <div className="autom-notice-text">
              <strong>{notice.title}</strong>
              {notice.body && <span>{notice.body}</span>}
            </div>
            <div className="autom-notice-actions">
              {notice.action && (
                <button type="button" className="btn sm primary" onClick={notice.action.onClick}>
                  {notice.action.label}
                </button>
              )}
              <button type="button" className="btn ghost icon" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
            </div>
          </div>
        )}

        {section === null && !historyAutomationId && (
        <>
        {/* Sources collapse to one overview row. Connection details stay nearby
            without making three setup cards the first thing on every visit. */}
        <AutomationSourcesPanel
          sources={[
            { name: "GitHub", status: ghStatus, onClick: () => openSetup(ghStatus.tone === "on" ? "github" : "work-queue") },
            { name: "Linear", status: linStatus, onClick: () => openSetup("linear") },
            { name: "Slack", status: slackStatus, onClick: () => openSetup("slack") },
          ]}
        />

        {items.some((i) => i.trigger === "github_ci" && i.enabled) && sources.github?.connected && (
          <div className="autom-banner" role="status">
            <strong>Fix failed CI is on.</strong>{" "}
            New GitHub Apps created in Bivy receive <code>workflow_run</code> events automatically.
            Existing apps need <code>workflow_run</code> + Actions/Checks read on the app in GitHub.
            <button type="button" className="btn sm autom-banner-action" onClick={() => openSetup("github")}>
              Review GitHub setup
            </button>
          </div>
        )}

        {loading && items.length === 0 && (
          <p className="settings-hint" style={{ marginTop: 24 }}>Loading your automations…</p>
        )}

        {/* Empty state is the create chooser itself — no buried templates. */}
        {isEmpty && (
          <section className="autom-hero autom-empty-state">
            <div className="autom-empty-icon" aria-hidden="true"><IconClock /></div>
            <div className="autom-hero-copy">
              <h2 className="autom-hero-title">Start by adding an automation</h2>
              <p className="autom-hero-body">
                Schedule an automation to run any prompt and get reminded when it completes.
              </p>
            </div>
            <div className="autom-empty-action">
              <button type="button" className="btn primary autom-empty-new-btn" onClick={openChooser}>
                <PlusIcon size={22} /> New automation
              </button>
            </div>
            <div className="autom-empty-picker">
              <NewAutomationPicker
                onScratch={startFromScratch}
                onTemplate={startFromTemplate}
              />
            </div>
          </section>
        )}

        {/* Populated layout — your automations first. */}
        {listedItems.length > 0 && (
          <>
            <section className="autom-section">
              <div className="autom-section-head">
                <h2 className="autom-section-label">Your automations</h2>
              </div>
              <div className="automation-list">
                {listedItems.map((item) => {
                  const chip = isSourceTrigger(item.trigger)
                    ? sourceAutomationChip(item, sources)
                    : { tone: item.enabled ? "on" as const : "off" as const, label: item.enabled ? "Active" : "Paused" };
                  const needsConnect = isSourceTrigger(item.trigger) && chip.tone === "warn" && chip.label.toLowerCase().includes("needs");
                  const nextRun = item.enabled && item.nextRunAt && item.schedule?.kind !== "once"
                    ? formatNextAutomationRun(item.nextRunAt)
                    : null;
                  const meta = [scheduleSummary(item), item.configKey ? "Managed by file" : null, isSourceTrigger(item.trigger) ? "Priority: first match wins" : null, nextRun].filter(Boolean).join(" · ");
                  return (
                    <div
                      className={`automation-row${item.enabled ? "" : " is-paused"}`}
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => void edit(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void edit(item);
                        }
                      }}
                      aria-label={`Edit ${item.name}`}
                    >
                      <span className="automation-row-icon" aria-hidden="true">
                        {item.trigger === "webhook" ? <IconWebhook /> : isSourceTrigger(item.trigger) ? <IconPr /> : <IconClock />}
                      </span>
                      <div className="automation-row-main">
                        <div className="automation-row-title">
                          <strong>{item.name}</strong>
                          {chip.tone !== "on" && !needsConnect && <Badge tone={chip.tone === "warn" ? "warn" : undefined}>{chip.label}</Badge>}
                        </div>
                        <div className="settings-hint">{meta}</div>
                        {item.trigger === "webhook" && rotated?.id === item.id && (
                          <div className="reveal-row">
                            <code className="reveal-value">{rotated.secret}</code>
                            <button type="button" className="btn sm" onClick={(event) => { event.stopPropagation(); void copyText(rotated.secret); }}>Copy secret</button>
                            <span className="settings-hint">New signing secret — shown once.</span>
                          </div>
                        )}
                      </div>
                      <div className="automation-row-actions">
                        {(() => {
                          const activeRun = runs.find((run) => run.definitionId === item.id && ["pending", "claimed", "running", "waiting", "needs_attention"].includes(run.status));
                          return activeRun ? <span className="automation-row-run-status" role="status">{activeRun.status === "running" ? "Running now" : "Queued"}</span> : null;
                        })()}
                        {needsConnect && (
                          <button
                            type="button"
                            className="btn sm primary"
                            onClick={(event) => { event.stopPropagation(); openSetup(item.trigger === "linear" ? "linear" : "work-queue"); }}
                          >
                            Connect
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

          </>
        )}
        </>
        )}

        {section === null && historyAutomationId && (
          <section className="autom-section automation-history-view">
            <div className="autom-section-head">
              <button type="button" className="btn link" onClick={() => setHistoryAutomationId(null)}>‹ Automations</button>
              <strong>{listedItems.find((item) => item.id === historyAutomationId)?.name || "Automation"} history</strong>
            </div>
            <RunHistory
              runs={runs.filter((run) => run.definitionId === historyAutomationId)}
              definitions={items}
              cancelBusyId={cancelBusyId}
              onRefresh={() => void refresh().catch((e) => setError(String((e as Error).message || e)))}
              onCancel={(run) => { setCancelError(null); setCancelRun(run); }}
              onOpenRun={onOpenRun}
              onOpenSession={(sessionId) => { onOpenSession(sessionId); onClose(); }}
            />
          </section>
        )}

        {section === "queue" && (
          <>
            {cancelError && <div className="banner inline" data-tone="danger">Could not cancel run: {cancelError}</div>}
            {cloudMachinesEnabled && (
              <details className="runs-setup">
                <summary>
                  <span>
                    <strong>Run setup &amp; routing</strong>
                    <small>Choose where unattended work runs</small>
                  </span>
                  <span className="runs-setup-chevron" aria-hidden="true">›</span>
                </summary>
                <div className="runs-setup-body">
                  <QueueRoutingSection hosted={sources.hosted} onConfigureCredentials={() => openSetup("work-queue")} />
                </div>
              </details>
            )}
            <RunHistory
              runs={definitionRuns}
              definitions={items}
              cancelBusyId={cancelBusyId}
              onRefresh={() => void refresh().catch((e) => setError(String((e as Error).message || e)))}
              onCancel={(run) => { setCancelError(null); setCancelRun(run); }}
              onOpenRun={onOpenRun}
              onOpenSession={(sessionId) => { onOpenSession(sessionId); onClose(); }}
            />
            <section className="autom-section incoming-work">
              <h2 className="autom-section-label">Incoming work</h2>
              <GithubQueuePanel
                queue={githubQueue ?? null}
                onRefresh={() => onRefreshGithubQueue?.()}
                onPick={(id) => { onOpenSession(id); onClose(); }}
                onOpenRun={onOpenRun}
                onOpenGithubSettings={() => openSetup("github")}
                showHistory={false}
              />
            </section>
            {cloudMachinesEnabled && <HostedMachinesPanel />}
          </>
        )}

        {section === "rulesets" && <RulesetsPanel state={state} />}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete automation?"
          message={`Delete “${pendingDelete.name}”? This can't be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteConfirmed()}
        />
      )}

      {cancelRun && (
        <ConfirmDialog
          title="Cancel Run?"
          message={`Request cancellation of “${cancelRun.title}”? The Run will remain active until its durable record reports a terminal result.`}
          confirmLabel="Cancel Run"
          danger
          onCancel={() => setCancelRun(null)}
          onConfirm={() => void cancelConfirmedRun()}
        />
      )}

      {chooserOpen && (
        <NewAutomationChooser
          onClose={() => setChooserOpen(false)}
          onScratch={startFromScratch}
          onTemplate={startFromTemplate}
        />
      )}

      {draft && (
        <AutomationEditor
          state={state}
          sources={sources}
          initial={draft}
          existing={draft.id ? items.find((item) => item.id === draft.id) : undefined}
          onRunNow={runNow}
          onToggle={toggle}
          onDelete={async (item) => { if (await remove(item)) setDraft(null); }}
          onHistory={(id) => { setDraft(null); setHistoryAutomationId(id); }}
          onRotate={rotate}
          onSourceSetup={(item) => openSetup(item.trigger === "linear" ? "linear" : "github")}
          onMove={moveSourceAutomation}
          onCancel={() => setDraft(null)}
          onSaved={async (result) => {
            setDraft(null);
            await refresh().catch((e) => setError(String(e)));
            if (result?.kind === "created-schedule") {
              const createdId = result.id;
              const createdName = result.name;
              setNotice({
                tone: "ok",
                title: `“${createdName}” is live`,
                body: result.nextHint || "It will run on the schedule you set.",
                action: createdId
                  ? {
                      label: "Run now",
                      onClick: () => {
                        void runNow({ id: createdId, name: createdName } as AccountAutomation);
                      },
                    }
                  : undefined,
              });
            } else if (result?.kind === "updated") {
              setNotice({ tone: "ok", title: `Saved “${result.name}”` });
            }
          }}
          onSelectSource={(source, current) => { void continueWithSource(source, current).catch((e) => setError(String(e))); }}
        />
      )}

      {sourceEdit && (
        <SourceAutomationEditor
          item={sourceEdit}
          state={state}
          sources={sources}
          onClose={() => setSourceEdit(null)}
          onRunNow={(item) => runNow(item)}
          onToggle={(item) => toggle(item)}
          onDelete={async (item) => { if (await remove(item)) setSourceEdit(null); }}
          onHistory={(id) => { setSourceEdit(null); setHistoryAutomationId(id); }}
          onSourceSetup={(item) => openSetup(item.trigger === "linear" ? "linear" : "github")}
          onMove={moveSourceAutomation}
          onSaved={async () => {
            setSourceEdit(null);
            await refresh().catch((e) => setError(String(e)));
            setNotice({ tone: "ok", title: "Automation updated" });
          }}
          onConnect={() => {
            const focus: SourceSetupFocus = sourceEdit.trigger === "linear" ? "linear" : "work-queue";
            setSourceEdit(null);
            openSetup(focus);
          }}
        />
      )}

      {setupFocus && (
        <WorkQueueSetupSheet
          state={state}
          focus={setupFocus}
          onClose={() => {
            setSetupFocus(null);
            void refresh().catch((e) => setError(String(e)));
          }}
          onChanged={() => { void refresh().catch(() => {}); }}
          onOpenFullSettings={() => {
            // Connections live only in Automations — keep the sheet open.
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/** Copy a value to the clipboard, no-op if unavailable. */
function copyText(value: string): void {
  void navigator.clipboard?.writeText(value);
}

// ── Source automation editor (GitHub / Linear / CI) ─────────────────────────

function SourceAutomationEditor({
  item,
  state,
  sources,
  onClose,
  onRunNow,
  onToggle,
  onDelete,
  onHistory,
  onSourceSetup,
  onMove,
  onSaved,
  onConnect,
}: {
  item: AccountAutomation;
  state: AppState;
  sources: SourcesSnapshot;
  onClose: () => void;
  onRunNow?: (item: AccountAutomation) => void | Promise<void>;
  onToggle?: (item: AccountAutomation) => void | Promise<void>;
  onDelete?: (item: AccountAutomation) => void | Promise<void>;
  onHistory?: (id: string) => void;
  onSourceSetup?: (item: AccountAutomation) => void;
  onMove?: (item: AccountAutomation, direction: -1 | 1) => void | Promise<void>;
  onSaved: () => void | Promise<void>;
  onConnect: () => void;
}) {
  const trigger = item.trigger as "github" | "linear" | "github_ci";
  const [name, setName] = useState(item.name);
  const [enabled, setEnabled] = useState(item.enabled);
  const initialToggles = togglesFromAutomation(item);
  const [events, setEvents] = useState<GithubEventToggles>(initialToggles);
  const [labelsText, setLabelsText] = useState((item.labels ?? (trigger === "github_ci" ? [] : ["bivy"])).join(", "));
  const [workflowsText, setWorkflowsText] = useState(
    trigger === "github_ci"
      ? (item.labels ?? []).join(", ")
      : (item.on?.find((r) => r.event === "workflow_run")?.workflows ?? []).join(", "),
  );
  const [reposText, setReposText] = useState((item.repos ?? []).join(", "));
  const [appId, setAppId] = useState(item.appId || "");
  const [repoDefault, setRepoDefault] = useState(item.repo || "");
  const [nodeSuffix, setNodeSuffix] = useState(nodeLabelSuffix(item.nodeLabel));
  const [runtimeId, setRuntimeId] = useState(item.runtimeId || "");
  const [model, setModel] = useState(item.model || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Account-wide GitHub setting (same control as Settings → GitHub App).
  const initialTriggerAccess =
    sources.github?.apps?.find((a) => a.triggerAccess)?.triggerAccess
    ?? sources.github?.triggerAccess
    ?? "everyone";
  const [triggerAccess, setTriggerAccess] = useState<"everyone" | "contributor" | "collaborator">(initialTriggerAccess);
  const [triggerAccessDirty, setTriggerAccessDirty] = useState(false);
  const preflight = useAutomationPreflight(item.id || undefined);

  const needsConnect =
    (trigger === "github" || trigger === "github_ci") && githubSourceStatus(sources.github).tone === "off"
    || trigger === "linear" && linearSourceStatus(sources.linear).tone === "off";
  const isGithub = trigger === "github" || trigger === "github_ci";
  const mention = sources.github?.apps?.find((a) => a.mention)?.mention || "bivy";
  const anyEvent = events.issuesLabeled || events.issueMention || events.prLabeled || events.prMention || events.workflowFailed;

  const parseList = (raw: string): string[] | undefined => {
    const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  };

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (isGithub && !anyEvent) throw new Error("Pick at least one GitHub event.");
      const labels = parseList(labelsText);
      const workflows = parseList(workflowsText);
      const repos = parseList(reposText);
      if (repos) {
        for (const r of repos) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(r) || r.includes("..")) {
            throw new Error(`Invalid repo "${r}" — use owner/name`);
          }
        }
      }
      if (repoDefault && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repoDefault) || repoDefault.includes(".."))) {
        throw new Error("Default repo must look like owner/name");
      }
      const patch: Parameters<typeof updateAutomation>[2] = {
        name: name.trim() || item.name,
        enabled,
        labels: labels ?? [],
        repos: repos ?? [],
        appId: isGithub ? appId.trim() || "" : "",
        repo: repoDefault.trim() || "",
        nodeLabel: nodeSuffix.trim() ? `bivy/${nodeSuffix.trim()}` : "",
        runtimeId: runtimeId.trim() || "",
        model: model.trim() || "",
      };
      if (isGithub) {
        // Persist structured event rules. Legacy github_ci keeps its trigger kind
        // so existing seeds keep working; labels[] there still means workflows.
        patch.on = buildGithubOn(events, labels, workflows);
        if (trigger === "github_ci") {
          patch.labels = workflows ?? [];
        }
      }

      // Shared preflight gate before ever calling create/update (see
      // docs/automation-evaluator.md). resetAck: false so a box already
      // ticked on a prior Save click still counts on this one.
      const evaluation = await preflight.run({ ...patch, trigger, templateCiphertext: item.templateCiphertext }, undefined, { resetAck: false });
      if (evaluation.gate.blocked) {
        throw new Error(`Can't save yet — ${evaluation.gate.blockingChecks.map((c) => c.label).join(", ")}. See the checklist below.`);
      }
      if (evaluation.gate.requiresAck && !preflight.ack) {
        throw new Error("Review the warnings below, check the acknowledgement box, then save again.");
      }

      if (item.id) {
        await updateAutomation(controller.local, item.id, patch);
      } else {
        await createAutomation(controller.local, {
          ...patch,
          name: patch.name || item.name,
          trigger,
          enabled: patch.enabled ?? true,
        });
      }
      if (isGithub && triggerAccessDirty) {
        await controller.setGithubAppTriggerAccess(triggerAccess);
      }
      await onSaved();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  /** Best-effort draft (works even before the form is complete, unlike
   *  save()) run through the shared evaluator — explains source connection,
   *  machine and credential readiness without starting a run. */
  async function checkAutomation() {
    const labels = parseList(labelsText);
    const workflows = parseList(workflowsText);
    const repos = parseList(reposText);
    const draft: AutomationSimulationDraft = {
      name: name.trim() || item.name,
      trigger,
      enabled,
      templateCiphertext: item.templateCiphertext,
      labels: labels ?? [],
      repos: repos ?? [],
      appId: isGithub ? appId.trim() || undefined : undefined,
      repo: repoDefault.trim() || undefined,
      nodeLabel: nodeSuffix.trim() ? `bivy/${nodeSuffix.trim()}` : undefined,
      runtimeId: runtimeId.trim() || undefined,
      model: model.trim() || undefined,
      ...(isGithub ? { on: buildGithubOn(events, labels, workflows) } : {}),
    };
    const event: AutomationSimulationEvent | undefined = trigger === "linear"
      ? { kind: "linear", repo: repoDefault.trim() || undefined, labels: labels ?? ["bivy"] }
      : trigger === "github_ci"
        ? { kind: "github", repo: repoDefault.trim() || undefined, event: "workflow_run", action: "completed", conclusion: "failure", workflow: workflows?.[0] }
        : undefined;
    await preflight.run(draft, event, { resetAck: true }).catch(() => {});
  }

  const action = item.id ? "Edit" : "Create";
  const title =
    trigger === "github_ci" ? `${action} GitHub automation (CI)`
      : trigger === "linear" ? `${action} Linear automation`
        : `${action} GitHub automation`;

  function toggleEvent<K extends keyof GithubEventToggles>(key: K) {
    setEvents((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="wizard-scrim" onClick={onClose}>
      <div className="wizard autom-editor" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="wizard-head">
          <strong>{title}</strong>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Cancel">✕</button>
        </div>
        <details className="autom-editor-actions">
          <summary className="btn sm" aria-label="Automation actions">Actions</summary>
          <div className="menu row-menu-pop" role="menu">
            {onRunNow && <button type="button" className="menu-item" role="menuitem" onClick={() => void onRunNow(item)}>Run now</button>}
            {onToggle && <button type="button" className="menu-item" role="menuitem" onClick={() => void onToggle(item)}>{enabled ? "Pause" : "Resume"}</button>}
            {onHistory && <button type="button" className="menu-item automation-history-btn" role="menuitem" onClick={() => onHistory(item.id)}>History</button>}
            {onSourceSetup && <button type="button" className="menu-item" role="menuitem" onClick={() => onSourceSetup(item)}>Source setup</button>}
            {onMove && (trigger === "github" || trigger === "linear") && <>
              <button type="button" className="menu-item" role="menuitem" onClick={() => void onMove(item, -1)}>Move earlier</button>
              <button type="button" className="menu-item" role="menuitem" onClick={() => void onMove(item, 1)}>Move later</button>
            </>}
            {onDelete && !item.configKey && <button type="button" className="menu-item danger" role="menuitem" onClick={() => void onDelete(item)}>Delete</button>}
          </div>
        </details>
        <div className="wizard-body">
          {needsConnect && (
            <div className="autom-banner" role="status">
              Connect {trigger === "linear" ? "Linear" : "GitHub"} before this automation can fire.
              <button type="button" className="btn sm primary" style={{ marginLeft: 8 }} onClick={onConnect}>Connect here</button>
            </div>
          )}
          {events.workflowFailed && enabled && !needsConnect && isGithub && (
            <div className="autom-banner" role="status">
              Failed CI needs <code>workflow_run</code> on the GitHub App (included for apps created in Bivy).
              Existing apps: add the event + Actions/Checks read in GitHub settings.
            </div>
          )}

          <div className="settings-field">
            <label className="field-label" htmlFor="src-name">Name</label>
            <input id="src-name" className="picker-search" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <label className="autom-check-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled — {enabled ? "matching events start sessions" : "events are ignored"}</span>
          </label>

          {isGithub && (
            <div className="settings-field">
              <div className="autom-field-label">When any of these fire</div>
              <p className="settings-hint" style={{ marginBottom: 6 }}>
                One GitHub App. Events are filters on this job — the outcome is whatever your instructions say
                (comment, PR, fix, …).
              </p>
              <label className="autom-check-row">
                <input type="checkbox" checked={events.issuesLabeled} onChange={() => toggleEvent("issuesLabeled")} />
                <span>Issue labeled <span className="settings-hint">(uses label filter below)</span></span>
              </label>
              <label className="autom-check-row">
                <input type="checkbox" checked={events.issueMention} onChange={() => toggleEvent("issueMention")} />
                <span>@mention on issue or PR conversation <code>@{mention}</code></span>
              </label>
              <label className="autom-check-row">
                <input type="checkbox" checked={events.prLabeled} onChange={() => toggleEvent("prLabeled")} />
                <span>Pull request labeled</span>
              </label>
              <label className="autom-check-row">
                <input type="checkbox" checked={events.prMention} onChange={() => toggleEvent("prMention")} />
                <span>@mention on a PR review comment</span>
              </label>
              <label className="autom-check-row">
                <input type="checkbox" checked={events.workflowFailed} onChange={() => toggleEvent("workflowFailed")} />
                <span>Workflow failed</span>
              </label>
              {!anyEvent && <p className="schedule-hint warn">Select at least one event.</p>}
            </div>
          )}

          {isGithub && (sources.github?.apps?.length ?? 0) > 1 && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-app-id">GitHub App source</label>
              <select id="src-app-id" className="picker-search" value={appId} onChange={(e) => setAppId(e.target.value)}>
                <option value="">All GitHub Apps</option>
                {sources.github?.apps.map((app) => (
                  <option key={app.appId || app.hookId || app.name} value={app.appId || ""} disabled={!app.appId}>
                    {githubAppOptionLabel(app)}
                  </option>
                ))}
              </select>
              <p className="settings-hint">Scope this automation to the hosted Bivy App or to a custom/user-installed GitHub App.</p>
            </div>
          )}

          {isGithub && (events.issuesLabeled || events.prLabeled) && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-labels">Labels</label>
              <input
                id="src-labels"
                className="picker-search"
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
                placeholder="e.g. bivy"
              />
              <p className="settings-hint">
                Comma-separated. The default also matches labels that target a specific machine.
                @mentions ignore this filter.
              </p>
            </div>
          )}

          {isGithub && events.workflowFailed && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-workflows">Workflow names (optional)</label>
              <input
                id="src-workflows"
                className="picker-search"
                value={workflowsText}
                onChange={(e) => setWorkflowsText(e.target.value)}
                placeholder="e.g. CI, Build (empty = any failed workflow)"
              />
              <p className="settings-hint">Comma-separated. Empty matches every failed workflow on allowed repos.</p>
            </div>
          )}

          {trigger === "linear" && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-labels-lin">Labels</label>
              <input
                id="src-labels-lin"
                className="picker-search"
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
                placeholder="e.g. bivy"
              />
              <p className="settings-hint">
                Comma-separated. The default also matches labels that target a specific machine.
              </p>
            </div>
          )}

          <div className="settings-field">
            <label className="field-label" htmlFor="src-repos">Repository allowlist (optional)</label>
            <input
              id="src-repos"
              className="picker-search"
              value={reposText}
              onChange={(e) => setReposText(e.target.value)}
              placeholder="owner/repo, owner/other"
            />
            <p className="settings-hint">Empty = all installed repos. Use owner/name slugs.</p>
          </div>

          {isGithub && !needsConnect && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-trigger-access">Who can trigger runs</label>
              <select
                id="src-trigger-access"
                className="picker-search"
                value={triggerAccess}
                onChange={(e) => {
                  setTriggerAccess(e.target.value as "everyone" | "contributor" | "collaborator");
                  setTriggerAccessDirty(true);
                }}
              >
                <option value="everyone">Everyone — any GitHub user (default)</option>
                <option value="contributor">Contributors — prior merged contribution, or higher</option>
                <option value="collaborator">Collaborators only — push access</option>
              </select>
              <p className="settings-hint">
                On a public repo, anyone can open an issue or comment. Restrict who can start a run via{" "}
                <code>@{mention}</code> or a label. Account-wide — applies to every GitHub App.
              </p>
            </div>
          )}

          {(trigger === "linear" || trigger === "github_ci") && (
            <div className="settings-field">
              <label className="field-label" htmlFor="src-repo-default">
                {trigger === "linear" ? "Default repository (when ticket has no git link)" : "Default repository (optional)"}
              </label>
              <select
                id="src-repo-default"
                className="picker-search"
                value={repoDefault}
                onChange={(e) => setRepoDefault(e.target.value)}
              >
                <option value="">None</option>
                {repoDefault && !state.catalogs.repos.some((r) => r.slug === repoDefault) && (
                  <option value={repoDefault}>{repoDefault}</option>
                )}
                {state.catalogs.repos.map((r) => (
                  <option key={r.slug} value={r.slug}>{r.slug}</option>
                ))}
              </select>
            </div>
          )}

          <div className="settings-field">
            <label className="field-label" htmlFor="src-node">Default machine</label>
            <select id="src-node" className="picker-search" value={nodeSuffix} onChange={(e) => setNodeSuffix(e.target.value)}>
              <option value="">Shared pool / issue label</option>
              {sources.nodes.map((n) => {
                const name = String(n.name || n.id);
                return <option key={n.id} value={name}>{name}{n.online ? "" : " (offline)"}</option>;
              })}
            </select>
          </div>

          <details className="autom-cron-details">
            <summary>Agent &amp; model defaults</summary>
            <div className="settings-field">
              <label className="field-label" htmlFor="src-agent">Agent</label>
              <select id="src-agent" className="picker-search" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
                <option value="">Machine default</option>
                {state.catalogs.runtimes.map((r) => (
                  <option key={r.id} value={r.id}>{r.name || r.id}</option>
                ))}
              </select>
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="src-model">Model</label>
              <input id="src-model" className="picker-search" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Machine default" />
            </div>
          </details>

          <div className="settings-field">
            <button type="button" className="btn sm" disabled={preflight.busy} onClick={() => void checkAutomation()}>
              {preflight.busy ? "Checking…" : "Check readiness"}
            </button>
            <p className="settings-hint">
              Explains source connection, machine, and credential readiness — and, for CI, whether a
              representative failed-workflow event would fire — without starting a run.
            </p>
            <AutomationPreflightPanel
              result={preflight.result}
              error={preflight.error}
              ack={preflight.ack}
              onAckChange={preflight.setAck}
              showTrail={trigger === "github_ci" || trigger === "linear"}
            />
          </div>

          {error && <p className="settings-error">{error}</p>}
        </div>
        <div className="wizard-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary autom-save-btn" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single-page create/edit sheet ───────────────────────────────────────────

interface SaveResult {
  kind: "created-schedule" | "created-webhook" | "updated";
  name: string;
  id?: string;
  nextHint?: string;
}

function AutomationEditor({
  state,
  sources,
  initial,
  existing,
  onRunNow,
  onToggle,
  onDelete,
  onHistory,
  onRotate,
  onSourceSetup,
  onMove,
  onCancel,
  onSaved,
  onSelectSource,
}: {
  state: AppState;
  sources: SourcesSnapshot;
  initial: Draft;
  existing?: AccountAutomation;
  onRunNow?: (item: AccountAutomation) => void | Promise<void>;
  onToggle?: (item: AccountAutomation) => void | Promise<void>;
  onDelete?: (item: AccountAutomation) => void | Promise<void>;
  onHistory?: (id: string) => void;
  onRotate?: (item: AccountAutomation) => void | Promise<void>;
  onSourceSetup?: (item: AccountAutomation) => void;
  onMove?: (item: AccountAutomation, direction: -1 | 1) => void | Promise<void>;
  onCancel: () => void;
  onSaved: (result?: SaveResult) => void;
  onSelectSource: (source: "github" | "linear", current: Draft) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nlError, setNlError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; secret: string; name: string; updated?: boolean } | null>(null);
  const [allowDangerous, setAllowDangerous] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const preflight = useAutomationPreflight(d.id || undefined);

  const tzList = useMemo(() => timezoneOptions(d.timezone), [d.timezone]);
  const cronHuman = useMemo(() => describeCron(d.cron), [d.cron]);
  const selectedNode = state.connection.nodes.find((n) => n.id === d.nodeId);
  const selectedNodeHasKey = Boolean(d.nodeId && controller.local.keys()[d.nodeId]);
  const pairedNodes = state.connection.nodes.filter((n) => Boolean(controller.local.keys()[n.id]));
  const pick = d.hasTrigger ? matchTriggerPick(d) : null;
  const canEditTrigger = !d.id;

  useEffect(() => { setD(initial); }, [initial]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  function onNlChange(value: string) {
    set("nlText", value);
    if (!value.trim()) { setNlError(""); return; }
    const parsed = nlToCron(value);
    if (isNlCronOk(parsed)) { set("cron", parsed.cron); setNlError(""); }
    else setNlError(parsed.error);
  }

  function applyTrigger(opt: TriggerPick) {
    if (opt.trigger === "source") {
      setPickerOpen(false);
      onSelectSource(opt.source, d);
      return;
    } else if (opt.trigger === "webhook") {
      setD((prev) => ({ ...prev, hasTrigger: true, trigger: "webhook" }));
    } else if (opt.kind === "once") {
      setD((prev) => ({ ...prev, hasTrigger: true, trigger: "schedule", kind: "once" }));
    } else {
      setD((prev) => ({
        ...prev,
        hasTrigger: true,
        trigger: "schedule",
        kind: "cron",
        cron: opt.cron,
        nlText: opt.nlText,
      }));
      setNlError("");
    }
    setPickerOpen(false);
  }

  function clearTrigger() {
    if (!canEditTrigger) return;
    setD((prev) => ({ ...prev, hasTrigger: false }));
  }

  const scheduleOk = d.trigger !== "schedule"
    || (d.kind === "cron" ? Boolean(d.cron.trim()) && Boolean(cronHuman) : Boolean(d.onceAt));
  const repoOk = d.trigger !== "schedule" || Boolean(d.repo.trim());
  const missing: string[] = [];
  if (!d.name.trim()) missing.push("a name");
  if (!d.hasTrigger) missing.push("a trigger");
  if (d.hasTrigger && !scheduleOk) missing.push("a valid schedule");
  if (d.hasTrigger && !repoOk) missing.push("a repository");
  if (d.hasTrigger && d.trigger === "github" && !Object.values(d.githubEvents).some(Boolean)) missing.push("a GitHub event");
  if (!d.instructions.trim()) missing.push("instructions");
  if (!d.nodeId) missing.push("a machine");
  else if (!controller.local.keys()[d.nodeId]) missing.push("a paired machine (encryption key missing)");
  const canSave = missing.length === 0;
  const unsafeCombo = d.approvalMode === "autonomous" && d.sandbox === "danger-full-access";

  /** Builds the same draft shape save() would submit (best-effort — this
   *  works even on an incomplete draft, unlike save() which requires
   *  canSave) and runs it through the shared evaluator, with a
   *  representative event for source triggers. Powers the "Test event" /
   *  "Check readiness" button; save() runs its own stricter pass right
   *  before submitting (see below). */
  async function checkAutomation() {
    const roomKey = d.nodeId ? controller.local.keys()[d.nodeId] : undefined;
    let templateCiphertext: string | undefined;
    if (d.nodeId && roomKey && d.instructions.trim()) {
      templateCiphertext = `${TEMPLATE_PREFIX}:${d.nodeId}:${await seal(await importRoomKey(unb64url(roomKey)), d.instructions.trim())}`;
    }
    const labels = d.labels.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
    const repos = d.repos.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
    const workflows = d.workflows.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
    const draft: AutomationSimulationDraft = {
      name: d.name.trim() || undefined,
      trigger: d.trigger,
      enabled: true,
      templateCiphertext,
      nodeLabel: selectedNode?.name ? `bivy/${selectedNode.name}` : undefined,
      runtimeId: d.runtimeId.trim() || undefined,
      model: d.model.trim() || undefined,
      approvalMode: d.approvalMode,
      sandbox: d.sandbox,
      allowDangerous,
      repo: d.repo.trim() || undefined,
      ...(d.trigger === "github" || d.trigger === "linear" ? {
        labels,
        repos,
        ...(d.trigger === "github" ? { appId: d.appId.trim() || undefined, on: buildGithubOn(d.githubEvents, labels, workflows) } : {}),
      } : {}),
    };
    await preflight.run(draft, buildRepresentativeEvent(d), { resetAck: true }).catch(() => {});
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const roomKey = d.nodeId ? controller.local.keys()[d.nodeId] : undefined;
      if (!d.nodeId || !roomKey) throw new Error("Connect to the assigned machine before saving encrypted instructions.");
      const encrypted = await seal(await importRoomKey(unb64url(roomKey)), d.instructions.trim());
      const nodeName = selectedNode?.name;
      const repo = d.repo.trim();
      const labels = d.labels.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
      const repos = d.repos.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
      const workflows = d.workflows.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
      const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
      if (repo && (!repoPattern.test(repo) || repo.includes(".."))) {
        throw new Error("Repository must look like owner/name");
      }
      if (repos.some((value) => !repoPattern.test(value) || value.includes(".."))) {
        throw new Error("Every repository allowlist entry must look like owner/name");
      }
      const input = {
        name: d.name.trim(),
        templateCiphertext: `${TEMPLATE_PREFIX}:${d.nodeId}:${encrypted}`,
        nodeLabel: nodeName ? `bivy/${nodeName}` : undefined,
        runtimeId: d.runtimeId.trim() || undefined,
        model: d.model.trim() || undefined,
        approvalMode: d.approvalMode,
        sandbox: d.sandbox,
        allowDangerous,
        enabled: true,
        trigger: d.trigger,
        ...(d.trigger === "webhook" ? { requireSigning: d.requireSigning } : {}),
        repo: repo || (d.id ? "" : undefined),
        ...(d.trigger === "github" || d.trigger === "linear" ? {
          labels,
          repos,
          ...(d.trigger === "github" ? { appId: d.appId.trim() || undefined, on: buildGithubOn(d.githubEvents, labels, workflows) } : {}),
        } : {}),
        ...(d.trigger === "schedule"
          ? {
              schedule: d.kind === "cron"
                ? { kind: "cron" as const, expression: d.cron.trim(), timezone: d.timezone.trim() }
                : { kind: "once" as const, at: new Date(d.onceAt).toISOString() },
            }
          : {}),
      };

      // Run the shared preflight gate before ever calling create/update — a
      // hard failure (e.g. autonomous + full access without the checkbox
      // below) never reaches the API, and a non-blocking warning always
      // needs the acknowledgement checkbox first (see
      // docs/automation-evaluator.md). resetAck: false so a box the user
      // already ticked on a prior Save click still counts on this one.
      const evaluation = await preflight.run(input, undefined, { resetAck: false });
      if (evaluation.gate.blocked) {
        setError(`Can't save yet — ${evaluation.gate.blockingChecks.map((c) => c.label).join(", ")}. See the checklist below.`);
        return;
      }
      if (evaluation.gate.requiresAck && !preflight.ack) {
        setError("Review the warnings below, check the acknowledgement box, then save again.");
        return;
      }

      if (d.id) {
        const result = await updateAutomation(controller.local, d.id, input);
        // Turning signing on for a previously unsigned webhook mints a secret
        // that is disclosed only in this response — show it like a create.
        if (d.trigger === "webhook" && result.webhookSecret) {
          setCreated({ url: result.webhookUrl ?? existing?.webhookUrl ?? "", secret: result.webhookSecret, name: d.name.trim(), updated: true });
        } else {
          onSaved({ kind: "updated", name: d.name.trim(), id: d.id });
        }
      } else {
        const result = await createAutomation(controller.local, input);
        if (d.trigger === "webhook" && result.webhookSecret) {
          setCreated({ url: result.webhookUrl ?? "", secret: result.webhookSecret, name: d.name.trim() });
        } else if (d.trigger === "webhook") {
          onSaved({ kind: "created-webhook", name: d.name.trim(), id: result.id });
        } else {
          const nextHint = d.trigger === "schedule"
            ? (d.kind === "cron"
                ? (cronHuman ? `Next: ${cronHuman.charAt(0).toLowerCase() + cronHuman.slice(1)} (${d.timezone}).` : "On the schedule you set.")
                : `Once at ${new Date(d.onceAt).toLocaleString()}.`)
            : d.trigger === "github" ? "Matching GitHub events will start a run with these instructions."
              : d.trigger === "linear" ? "Matching Linear issues will start a run with these instructions."
                : undefined;
          onSaved({
            kind: "created-schedule",
            name: d.name.trim(),
            id: result.id,
            nextHint,
          });
        }
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-scrim" onClick={onCancel}>
      <div
        className="wizard autom-editor"
        role="dialog"
        aria-modal="true"
        aria-label={d.id ? "Edit automation" : "New automation"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-head">
          <strong>{created ? "Webhook ready" : d.id ? "Edit automation" : "New automation"}</strong>
          <button type="button" className="btn ghost icon" onClick={onCancel} aria-label="Cancel">✕</button>
        </div>

        {existing && !created && (
          <details className="autom-editor-actions">
            <summary className="btn sm" aria-label="Automation actions">Actions</summary>
            <div className="menu row-menu-pop" role="menu">
              {onRunNow && <button type="button" className="menu-item" role="menuitem" onClick={() => void onRunNow(existing)}>{existing.trigger === "webhook" ? "Test run" : "Run now"}</button>}
              {onToggle && <button type="button" className="menu-item" role="menuitem" onClick={() => void onToggle(existing)}>{existing.enabled ? "Pause" : "Resume"}</button>}
              {onHistory && <button type="button" className="menu-item automation-history-btn" role="menuitem" onClick={() => onHistory(existing.id)}>History</button>}
              {existing.webhookUrl && <button type="button" className="menu-item" role="menuitem" onClick={() => { void copyText(existing.webhookUrl!); }}>Copy URL</button>}
              {existing.trigger === "webhook" && onRotate && <button type="button" className="menu-item" role="menuitem" onClick={() => void onRotate(existing)}>Rotate secret</button>}
              {onSourceSetup && (existing.trigger === "github" || existing.trigger === "linear") && <button type="button" className="menu-item" role="menuitem" onClick={() => onSourceSetup(existing)}>Source setup</button>}
              {onMove && (existing.trigger === "github" || existing.trigger === "linear") && <>
                <button type="button" className="menu-item" role="menuitem" onClick={() => void onMove(existing, -1)}>Move earlier</button>
                <button type="button" className="menu-item" role="menuitem" onClick={() => void onMove(existing, 1)}>Move later</button>
              </>}
              {onDelete && !existing.configKey && <button type="button" className="menu-item danger" role="menuitem" onClick={() => void onDelete(existing)}>Delete</button>}
            </div>
          </details>
        )}

        {created ? (
          <>
            <div className="wizard-body">
              <div className="autom-success" role="status">
                <strong>{created.updated ? `“${created.name}” now requires signing.` : `“${created.name}” is live.`}</strong> Send signed events to this URL. Copy the signing secret now — it isn&apos;t shown again.
              </div>
              <div className="settings-field">
                <label className="field-label">Webhook URL</label>
                <div className="reveal-row">
                  <code className="reveal-value">{created.url}</code>
                  <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(created.url)}>Copy</button>
                </div>
              </div>
              <div className="settings-field">
                <label className="field-label">Signing secret</label>
                <div className="reveal-row">
                  <code className="reveal-value">{created.secret}</code>
                  <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(created.secret)}>Copy</button>
                </div>
              </div>
              <p className="settings-hint">
                Sign each request with <code>X-Bivy-Signature-256: sha256=HMAC-SHA256(body)</code> and a unique <code>X-Bivy-Idempotency-Key</code>.
              </p>
            </div>
            <div className="wizard-actions">
              <span />
              <button
                type="button"
                className="btn primary autom-save-btn"
                onClick={() => onSaved(created.updated ? { kind: "updated", name: created.name, id: existing?.id } : { kind: "created-webhook", name: created.name })}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="wizard-body">
              <div className="autom-name-row">
                <span className="autom-name-icon" aria-hidden="true"><IconBolt /></span>
                <input
                  className="autom-name-input"
                  value={d.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="My automation"
                  aria-label="Name"
                  autoFocus
                />
              </div>

              <div className="autom-field-block">
                <div className="autom-field-label">Triggers</div>
                {d.hasTrigger && pick ? (
                  <div className="autom-trigger-chip">
                    <span className="autom-trigger-chip-icon" aria-hidden="true">
                      {pick.id === "webhook" ? <IconWebhook /> : pick.id === "github" || pick.id === "linear" ? <IconPr /> : <IconClock />}
                    </span>
                    <div className="autom-trigger-chip-text">
                      <strong>{pick.label}</strong>
                      <span>
                        {d.trigger === "webhook"
                          ? pick.hint
                          : d.trigger === "github" || d.trigger === "linear"
                            ? pick.hint
                          : d.kind === "once"
                            ? (d.onceAt ? new Date(d.onceAt).toLocaleString() : pick.hint)
                            : (cronHuman || pick.hint)}
                      </span>
                    </div>
                    {canEditTrigger && (
                      <button type="button" className="btn ghost icon autom-trigger-clear" onClick={clearTrigger} aria-label="Remove trigger">✕</button>
                    )}
                  </div>
                ) : (
                  <div className="autom-trigger-add-wrap" ref={pickerRef}>
                    <button
                      type="button"
                      className="autom-trigger-add"
                      onClick={() => setPickerOpen((v) => !v)}
                      aria-expanded={pickerOpen}
                    >
                      + Add trigger
                    </button>
                    {pickerOpen && (
                      <div className="autom-trigger-menu" role="listbox" aria-label="Trigger types">
                        {TRIGGER_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className="autom-trigger-option"
                            role="option"
                            onClick={() => applyTrigger(opt)}
                          >
                            <span className="autom-trigger-option-icon" aria-hidden="true">
                              {opt.id === "webhook"
                                ? <IconWebhook />
                                : opt.id === "github" || opt.id === "linear"
                                  ? <IconPr />
                                  : <IconClock />}
                            </span>
                            <span className="autom-trigger-option-text">
                              <strong>{opt.label}</strong>
                              <span>{opt.hint}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {d.hasTrigger && d.trigger === "schedule" && d.kind === "cron" && (
                  <div className="autom-trigger-config">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-nl">When to run</label>
                      <input
                        id="autom-nl"
                        className="picker-search"
                        value={d.nlText}
                        onChange={(e) => onNlChange(e.target.value)}
                        placeholder="e.g. every day at 9am"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {nlError
                        ? <p className="schedule-hint warn">{nlError}</p>
                        : cronHuman
                          ? <p className="schedule-hint ok">Runs {cronHuman.charAt(0).toLowerCase() + cronHuman.slice(1)}.</p>
                          : <p className="schedule-hint warn">Not a valid schedule yet.</p>}
                    </div>
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-tz">Timezone</label>
                      <select id="autom-tz" className="picker-search" value={d.timezone} onChange={(e) => set("timezone", e.target.value)}>
                        {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                      </select>
                    </div>
                    <details className="autom-cron-details">
                      <summary>Edit cron expression</summary>
                      <input
                        className="picker-search schedule-cron-input"
                        value={d.cron}
                        onChange={(e) => { set("cron", e.target.value); set("nlText", ""); setNlError(""); }}
                        aria-label="Cron expression"
                        spellCheck={false}
                      />
                    </details>
                  </div>
                )}
                {d.hasTrigger && d.trigger === "schedule" && d.kind === "once" && (
                  <div className="autom-trigger-config">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-once">Run at</label>
                      <input
                        id="autom-once"
                        className="picker-search"
                        type="datetime-local"
                        min={toLocalInput(new Date())}
                        value={d.onceAt}
                        onChange={(e) => set("onceAt", e.target.value)}
                      />
                    </div>
                  </div>
                )}
                {d.hasTrigger && d.trigger === "webhook" && (
                  <div className="autom-trigger-config">
                    {existing?.trigger === "webhook" && existing.webhookUrl && (
                      <div className="settings-field">
                        <label className="field-label">Webhook URL</label>
                        <div className="reveal-row">
                          <code className="reveal-value">{existing.webhookUrl}</code>
                          <button type="button" className="btn sm" onClick={() => void copyText(existing.webhookUrl!)}>Copy</button>
                        </div>
                      </div>
                    )}
                    <label className="settings-toggle-row webhook-signing-toggle">
                      <span className="settings-toggle-text">
                        <strong className="settings-toggle-title">Require signing headers</strong>
                        <small className="muted">Recommended for authenticating webhook requests.</small>
                      </span>
                      <input className="sr-only" type="checkbox" checked={d.requireSigning} onChange={(event) => set("requireSigning", event.target.checked)} />
                      <span className={`settings-toggle${d.requireSigning ? " on" : ""}`} aria-hidden="true"><span className="settings-toggle-knob" /></span>
                    </label>
                    <p className="settings-hint">
                      {!d.requireSigning
                        ? "Requests may be sent without a signing secret or Bivy headers."
                        : existing?.trigger === "webhook" && existing.requireSigning
                          ? "Requests must carry Bivy signing headers. Use “Rotate secret” in the automation menu to issue a new secret."
                          : "You'll get the signed URL and a one-time signing secret after you save."}
                    </p>
                  </div>
                )}
                {d.hasTrigger && (d.trigger === "github" || d.trigger === "linear") && (
                  <div className="autom-trigger-config">
                    {d.trigger === "github" && (
                      <div className="settings-field">
                        <div className="autom-field-label">When any of these fire</div>
                        {([
                          ["issuesLabeled", "Issue labeled"],
                          ["issueMention", "@mention on an issue or PR conversation"],
                          ["prLabeled", "Pull request labeled"],
                          ["prMention", "@mention on a PR review comment"],
                          ["workflowFailed", "Workflow failed"],
                        ] as const).map(([key, label]) => (
                          <label className="autom-check-row" key={key}>
                            <input
                              type="checkbox"
                              checked={d.githubEvents[key]}
                              onChange={() => set("githubEvents", { ...d.githubEvents, [key]: !d.githubEvents[key] })}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {d.trigger === "github" && (sources.github?.apps?.length ?? 0) > 1 && (
                      <div className="settings-field">
                        <label className="field-label" htmlFor="autom-source-app">GitHub App source</label>
                        <select id="autom-source-app" className="picker-search" value={d.appId} onChange={(e) => set("appId", e.target.value)}>
                          <option value="">All GitHub Apps</option>
                          {sources.github?.apps.map((app) => (
                            <option key={app.appId || app.hookId || app.name} value={app.appId || ""} disabled={!app.appId}>
                              {githubAppOptionLabel(app)}
                            </option>
                          ))}
                        </select>
                        <p className="settings-hint">Choose the hosted Bivy App or one of your custom/user-installed GitHub Apps.</p>
                      </div>
                    )}
                    {(d.trigger === "linear" || d.githubEvents.issuesLabeled || d.githubEvents.prLabeled) && (
                      <div className="settings-field">
                        <label className="field-label" htmlFor="autom-source-labels">Labels</label>
                        <input id="autom-source-labels" className="picker-search" value={d.labels} onChange={(e) => set("labels", e.target.value)} placeholder="bivy" />
                        <p className="settings-hint">Comma-separated labels that may trigger this automation.</p>
                      </div>
                    )}
                    {d.trigger === "github" && d.githubEvents.workflowFailed && (
                      <div className="settings-field">
                        <label className="field-label" htmlFor="autom-source-workflows">Workflow names (optional)</label>
                        <input id="autom-source-workflows" className="picker-search" value={d.workflows} onChange={(e) => set("workflows", e.target.value)} placeholder="CI, Build" />
                      </div>
                    )}
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-source-repos">Repository allowlist (optional)</label>
                      <input id="autom-source-repos" className="picker-search" value={d.repos} onChange={(e) => set("repos", e.target.value)} placeholder="owner/repo, owner/other" />
                      <p className="settings-hint">Empty means every repository where the app is installed.</p>
                    </div>
                  </div>
                )}

                {d.hasTrigger && (
                  <div className="autom-trigger-config">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-repo">
                        {d.trigger === "schedule" ? "Repository" : "Repository (optional default)"}
                      </label>
                      {state.catalogs.repos.length > 0 ? (
                        <select
                          id="autom-repo"
                          className="picker-search"
                          value={d.repo}
                          onChange={(e) => set("repo", e.target.value)}
                        >
                          <option value="">{d.trigger === "schedule" ? "Select a GitHub repo…" : "Event may supply the repo"}</option>
                          {d.repo && !state.catalogs.repos.some((r) => r.slug === d.repo) && (
                            <option value={d.repo}>{d.repo}</option>
                          )}
                          {state.catalogs.repos.map((r) => (
                            <option key={r.slug} value={r.slug}>{r.slug}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id="autom-repo"
                          className="picker-search"
                          value={d.repo}
                          onChange={(e) => set("repo", e.target.value)}
                          placeholder={d.trigger === "schedule" ? "owner/repo" : "Event may supply the repo"}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      )}
                      <p className="settings-hint">
                        {d.trigger === "schedule"
                          ? "The machine clones this repo before the session starts."
                          : "Used when the webhook event does not include a repo."}
                      </p>
                      {!d.repo && d.trigger === "schedule" && (
                        <p className="schedule-hint warn">
                          {state.catalogs.repos.length === 0
                            ? "No repos listed yet — enter owner/name, or connect GitHub on the machine to populate this list."
                            : "Pick a repository so scheduled runs land in the right project."}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="autom-field-block autom-runner-block">
                <div className="autom-field-label">Run on</div>
                <div className={`card autom-runner-card${selectedNodeHasKey ? " ready" : " warn"}`} data-tone={selectedNodeHasKey ? "ok" : "warn"}>
                  <label className="autom-runner-select-row">
                    <span className="autom-runner-icon" aria-hidden="true">⌁</span>
                    <span className="autom-runner-select-copy">
                      <strong>{selectedNode ? String(selectedNode.name || selectedNode.id) : "Choose a paired machine"}</strong>
                      <span>
                        {selectedNode
                          ? `${selectedNode.online ? "Online" : "Offline — the run will wait or use your configured fallback"}${selectedNodeHasKey ? " · encryption ready" : " · key missing on this device"}`
                          : "The instructions are encrypted before they leave this device."}
                      </span>
                    </span>
                    <select className="autom-inline-select" value={d.nodeId} onChange={(e) => set("nodeId", e.target.value)} aria-label="Run on machine">
                      <option value="">Select…</option>
                      {state.connection.nodes.map((n) => {
                        const hasKey = Boolean(controller.local.keys()[n.id]);
                        return <option key={n.id} value={n.id}>{String(n.name || n.id)}{hasKey ? n.online ? " · online" : " · offline" : " · key unavailable"}</option>;
                      })}
                      {d.nodeId && !state.connection.nodes.some((n) => n.id === d.nodeId) && <option value={d.nodeId}>{d.nodeId} · unavailable</option>}
                    </select>
                  </label>
                  {!selectedNodeHasKey && (
                    <div className="autom-runner-help" role="status">
                      {pairedNodes.length === 0
                        ? "Pair this phone or browser with a machine first. That pairing key protects the instructions; account sign-in alone cannot decrypt them."
                        : "Choose a machine marked online or offline (not key unavailable). Offline machines can still own the encrypted job and use an isolated fallback from the Runs tab."}
                    </div>
                  )}
                </div>
                <p className="settings-hint">
                  Persistent machine: runs there whenever it is online. Ephemeral-only setup: pair once to establish encryption, then set an isolated profile as the default or fallback under <strong>Runs → Queue routing</strong>. Cloud and model sign-ins are separate and are injected only when the runner starts.
                </p>
              </div>

              <div className="autom-field-block">
                <div className="autom-field-label">Instructions</div>
                <div className="autom-instructions">
                  <textarea
                    className="autom-instructions-input"
                    rows={7}
                    value={d.instructions}
                    onChange={(e) => set("instructions", e.target.value)}
                    placeholder="What should the agent do on your machine…"
                  />
                  <div className="autom-instructions-bar">
                    <span className="settings-hint">Encrypted end to end</span>
                    <button
                      type="button"
                      className="autom-advanced-link"
                      onClick={() => setShowAdvanced((v) => !v)}
                      aria-expanded={showAdvanced}
                    >
                      {showAdvanced ? "Hide advanced" : "Agent, model & safety"}
                    </button>
                  </div>
                </div>
                {showAdvanced && (
                  <div className="wizard-advanced">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-runtime">Agent</label>
                      <select id="autom-runtime" className="picker-search" value={d.runtimeId} onChange={(e) => set("runtimeId", e.target.value)}>
                        <option value="">Machine default</option>
                        {state.catalogs.runtimes.map((r) => <option key={r.id} value={r.id}>{String(r.displayName || r.name || r.id)}</option>)}
                        {d.runtimeId && !state.catalogs.runtimes.some((r) => r.id === d.runtimeId) && (
                          <option value={d.runtimeId}>{d.runtimeId} (not installed here)</option>
                        )}
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-model">Model</label>
                      <select id="autom-model" className="picker-search" value={d.model} onChange={(e) => set("model", e.target.value)}>
                        <option value="">Agent default</option>
                        {state.catalogs.models.map((m) => (
                          <option key={String((m as { provider?: string }).provider || "") + ":" + m.id} value={m.id}>{m.label || m.id}</option>
                        ))}
                        {d.model && !state.catalogs.models.some((m) => m.id === d.model) && <option value={d.model}>{d.model}</option>}
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-approvals">Approvals</label>
                      <select id="autom-approvals" className="picker-search" value={d.approvalMode} onChange={(e) => set("approvalMode", e.target.value as Draft["approvalMode"])}>
                        <option value="autonomous">Autonomous (default; pauses only for high-risk actions)</option>
                        <option value="risky">Ask before risky actions</option>
                        <option value="always">Ask before every action</option>
                        <option value="never">Never ask</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-sandbox">Sandbox</label>
                      <select id="autom-sandbox" className="picker-search" value={d.sandbox} onChange={(e) => set("sandbox", e.target.value as Draft["sandbox"])}>
                        <option value="read-only">Read only</option>
                        <option value="workspace-write">Workspace write</option>
                        <option value="danger-full-access">Full access</option>
                      </select>
                    </div>
                    {unsafeCombo && (
                      <label className="autom-check-row">
                        <input type="checkbox" checked={allowDangerous} onChange={(e) => setAllowDangerous(e.target.checked)} />
                        <span>I understand the risk of autonomous approval with full access — allow it anyway.</span>
                      </label>
                    )}
                  </div>
                )}
                <p className="settings-hint">Encrypted for the assigned machine before upload. The hosted control plane never sees the prompt, your code, or credentials.</p>
              </div>

              {d.hasTrigger && (
                <div className="settings-field">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={preflight.busy}
                    onClick={() => void checkAutomation()}
                  >
                    {preflight.busy ? "Checking…" : (d.trigger === "github" || d.trigger === "linear") ? "Test event" : "Check readiness"}
                  </button>
                  <p className="settings-hint">
                    {(d.trigger === "github" || d.trigger === "linear")
                      ? "Explains which automation a representative event would fire — including overlap/shadow warnings — without starting a run."
                      : "Explains source connection, machine, and credential readiness without starting a run."}
                  </p>
                  <AutomationPreflightPanel
                    result={preflight.result}
                    error={preflight.error}
                    ack={preflight.ack}
                    onAckChange={preflight.setAck}
                    showTrail={d.trigger === "github" || d.trigger === "linear"}
                  />
                </div>
              )}

              {error && <p className="settings-error">{error}</p>}
              {!canSave && missing.length > 0 && (
                <p className="settings-hint autom-save-hint">Needs {missing.join(", ")} to save.</p>
              )}
            </div>

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
              <button
                type="button"
                className="btn primary autom-save-btn"
                onClick={() => void save()}
                disabled={busy || !canSave}
              >
                {busy ? "Saving…" : d.id ? "Save changes" : "Turn on"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
