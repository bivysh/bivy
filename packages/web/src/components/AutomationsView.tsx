// SPDX-License-Identifier: AGPL-3.0-only
//
// The first-class Automations destination — a full-screen surface reached from
// the sidebar foot (peer to Settings). Layout inspired by a clean single-page
// create sheet: suggested templates as soft cards, then your automations and
// recent activity. Creating/editing uses one form modal (name → trigger →
// instructions → machine) rather than a multi-step wizard; templates pre-fill
// the form. Everything still writes the same POST /account/automations
// definition — presentation over the existing system.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import cronstrue from "cronstrue";
import {
  createAutomation,
  fetchAccountNodes,
  fetchAutomationRuns,
  fetchAutomations,
  fetchGithubApp,
  fetchLinearHook,
  fetchSlackHook,
  runAutomationNow,
  rotateAutomationWebhook,
  updateAutomation,
  importRoomKey,
  seal,
  open,
  unb64,
  nlToCron,
  isNlCronOk,
  type AppState,
  type AccountAutomation,
  type AccountAutomationRun,
  type AccountNode,
  type GithubAppInfo,
  type LinearHook,
  type SlackHook,
} from "@bivy/core";
import { controller } from "../store/controller.js";
import {
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
  type ScheduleTemplate,
  type SourceTemplate,
  type WebhookTemplate,
} from "./automationTemplates.js";
import { WorkQueueSetupSheet } from "./WorkQueueSetupSheet.js";

const TEMPLATE_PREFIX = "bivy-room-v1";

// Trigger picker options shown under "+ Add Trigger". Schedule/webhook map onto
// automation definition fields. GitHub/Linear are source triggers that open the
// work-queue setup (same session runtime; connect lives next to the trigger).
type TriggerPick =
  | { id: "daily"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "weekly"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "monthly"; label: string; hint: string; trigger: "schedule"; kind: "cron"; cron: string; nlText: string }
  | { id: "once"; label: string; hint: string; trigger: "schedule"; kind: "once" }
  | { id: "webhook"; label: string; hint: string; trigger: "webhook" }
  | { id: "github"; label: string; hint: string; trigger: "source"; source: "github" }
  | { id: "github_ci"; label: string; hint: string; trigger: "source"; source: "github" }
  | { id: "linear"; label: string; hint: string; trigger: "source"; source: "linear" };

const TRIGGER_OPTIONS: TriggerPick[] = [
  { id: "daily", label: "Daily", hint: "Every day at a chosen time", trigger: "schedule", kind: "cron", cron: "0 9 * * *", nlText: "every day at 9am" },
  { id: "weekly", label: "Weekly", hint: "Every week on a chosen day", trigger: "schedule", kind: "cron", cron: "0 9 * * 1", nlText: "every monday at 9am" },
  { id: "monthly", label: "Monthly", hint: "Every month on a chosen day", trigger: "schedule", kind: "cron", cron: "0 9 1 * *", nlText: "every month on the 1st at 9am" },
  { id: "once", label: "One time", hint: "Run once at a chosen date and time", trigger: "schedule", kind: "once" },
  { id: "github", label: "GitHub", hint: "Issue labeled or @mention → session → PR", trigger: "source", source: "github" },
  { id: "github_ci", label: "GitHub Actions", hint: "Failed workflow run → diagnose and fix", trigger: "source", source: "github" },
  { id: "linear", label: "Linear", hint: "Assigned / labeled issue → session → PR", trigger: "source", source: "linear" },
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
  if (item.trigger === "github") return `GitHub · label ${labels}${repos}${node}`;
  if (item.trigger === "github_ci") {
    const wf = item.labels?.length ? ` · workflow ${item.labels.join(", ")}` : " · any workflow";
    return `GitHub Actions · failure${wf}${repos}${node}`;
  }
  if (item.trigger === "linear") return `Linear · label ${labels}${repo || repos}${node}`;
  if (item.trigger === "webhook") return `Webhook · runs on a signed request${repo}`;
  if (!item.schedule) return `Scheduled${repo}`;
  if (item.schedule.kind === "once") return `Once · ${new Date(item.schedule.at).toLocaleString()}${repo}`;
  const when = describeCron(item.schedule.expression) || `${item.schedule.expression} · ${item.schedule.timezone}`;
  return `${when}${repo}`;
}

function isSourceTrigger(t: AccountAutomation["trigger"]): t is "github" | "linear" | "github_ci" {
  return t === "github" || t === "linear" || t === "github_ci";
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
}

function emptySources(): SourcesSnapshot {
  return { github: null, linear: null, slack: null, nodes: [] };
}

function githubSourceStatus(gh: GithubAppInfo | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!gh?.connected || !gh.apps?.length) {
    return { tone: "off", label: "Not connected", detail: "Connect a GitHub App to run issue and CI automations." };
  }
  const installed = gh.apps.some((a) => a.installed || (a.installCount ?? 0) > 0);
  const served = gh.apps.some((a) => a.servedBy?.online);
  const count = gh.apps.reduce((n, a) => n + (a.installCount ?? (a.installed ? 1 : 0)), 0);
  if (!installed) {
    return { tone: "warn", label: "App created · not installed", detail: "Install the app on at least one repository." };
  }
  if (!served && !gh.apps.some((a) => a.servedBy)) {
    return { tone: "warn", label: `Installed${count ? ` · ${count} repo(s)` : ""} · no node`, detail: "No machine is serving the app key yet." };
  }
  const online = served ? "online" : "offline";
  return {
    tone: served ? "on" : "warn",
    label: `${count || gh.apps.length} repo(s) · node ${online}`,
    detail: "Issues, @mentions, and (when enabled) Actions failures can start sessions.",
  };
}

function linearSourceStatus(lin: LinearHook | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!lin) return { tone: "off", label: "Not connected", detail: "Connect Linear to turn labeled issues into sessions." };
  if (lin.enabled === false) return { tone: "warn", label: "Disabled", detail: "Linear hook exists but is turned off." };
  return { tone: "on", label: "Connected", detail: "Labeled Linear issues can start sessions." };
}

function slackSourceStatus(slack: SlackHook | null): { tone: "on" | "off" | "warn"; label: string; detail: string } {
  if (!slack) return { tone: "off", label: "Not connected", detail: "Connect Slack so /bivy commands reach your machines." };
  if (slack.enabled === false) return { tone: "warn", label: "Disabled", detail: "Slack hook exists but is turned off." };
  return { tone: "on", label: "Connected", detail: "Slash commands enqueue sessions on the work queue." };
}

/** Status chip for a source automation given live connect state. */
function sourceAutomationChip(
  item: AccountAutomation,
  sources: SourcesSnapshot,
): { tone: "on" | "off" | "warn"; label: string } {
  if (!item.enabled) return { tone: "off", label: "Paused" };
  if (item.trigger === "github" || item.trigger === "github_ci") {
    const gh = githubSourceStatus(sources.github);
    if (gh.tone === "off") return { tone: "warn", label: "Needs GitHub" };
    if (gh.tone === "warn") return { tone: "warn", label: gh.label };
    if (item.trigger === "github_ci") return { tone: "on", label: "Active · verify workflow_run" };
    return { tone: "on", label: "Active" };
  }
  if (item.trigger === "linear") {
    const lin = linearSourceStatus(sources.linear);
    if (lin.tone === "off") return { tone: "warn", label: "Needs Linear" };
    if (lin.tone === "warn") return { tone: "warn", label: lin.label };
    return { tone: "on", label: "Active" };
  }
  return { tone: item.enabled ? "on" : "off", label: item.enabled ? "Active" : "Paused" };
}

function runOutcome(status: AccountAutomationRun["status"]): { label: string; tone: "ok" | "warn" | "bad" | "info" } {
  switch (status) {
    case "succeeded": return { label: "Succeeded", tone: "ok" };
    case "failed": return { label: "Failed", tone: "bad" };
    case "needs_attention": return { label: "Needs review", tone: "warn" };
    case "running": return { label: "Running", tone: "info" };
    case "waiting": return { label: "Waiting", tone: "info" };
    case "cancelled": return { label: "Cancelled", tone: "warn" };
    default: return { label: "Queued", tone: "info" };
  }
}

/** Infer which trigger-picker option best matches a draft (for the chip label). */
function matchTriggerPick(d: Draft): TriggerPick | null {
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
  trigger: "schedule" | "webhook";
  kind: "cron" | "once";
  cron: string;
  nlText: string;
  timezone: string;
  onceAt: string;
  /** GitHub repo workspace (`owner/name`) when the trigger does not carry one. */
  repo: string;
  nodeId: string;
  runtimeId: string;
  model: string;
  approvalMode: "never" | "risky" | "always" | "autonomous";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
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
    nodeId,
    runtimeId: "",
    model: "",
    approvalMode: "autonomous",
    sandbox: "workspace-write",
  };
}

/** Prefer the composer's current draft repo so templates open pre-filled. */
function rememberedRepo(state: AppState): string {
  return state.draftRepo || "";
}

// Soft glyph for each suggested template card (Grok-style icon-in-circle).
function templateIcon(key: string): ReactNode {
  switch (key) {
    case "upgrade-dependencies": return <IconPackage />;
    case "dependency-security-audit": return <IconShield />;
    case "lint-format-autofix": return <IconSpark />;
    case "flaky-test-triage": return <IconFlask />;
    case "fix-failed-ci": return <IconCi />;
    case "fix-error-tracker-issue": return <IconBug />;
    case "investigate-production-errors": return <IconRadar />;
    case "work-issues-into-prs":
    case "work-linear-issues-into-prs": return <IconPr />;
    default: return <IconBolt />;
  }
}

export function AutomationsView({
  state,
  onClose,
  onOpenSettings,
  onOpenSession,
}: {
  state: AppState;
  onClose: () => void;
  onOpenSettings: (view: "webhooks" | "queue" | "github" | "linear") => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<AccountAutomation[]>([]);
  const [runs, setRuns] = useState<AccountAutomationRun[]>([]);
  const [sources, setSources] = useState<SourcesSnapshot>(emptySources);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sourceEdit, setSourceEdit] = useState<AccountAutomation | null>(null);
  const [rotated, setRotated] = useState<{ id: string; secret: string } | null>(null);
  // In-sheet work-queue setup ("Work issues into PRs") — stays on Automations
  // instead of bouncing to Settings.
  const [workQueueOpen, setWorkQueueOpen] = useState(false);

  const refresh = useCallback(async () => {
    const canQuery = !controller.direct;
    const [definitions, recent, gh, lin, slack, nodes] = await Promise.all([
      fetchAutomations(controller.local),
      fetchAutomationRuns(controller.local, 30),
      canQuery ? fetchGithubApp(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchLinearHook(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchSlackHook(controller.local).catch(() => null) : Promise.resolve(null),
      canQuery ? fetchAccountNodes(controller.local).catch(() => [] as AccountNode[]) : Promise.resolve([] as AccountNode[]),
    ]);
    setItems(definitions);
    setRuns(recent);
    setSources({ github: gh, linear: lin, slack, nodes });
  }, []);

  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, [refresh]);
  useEffect(() => {
    controller.listRuntimes();
    controller.listModels();
    // Repo picker for schedule/webhook workspace targets.
    controller.listRepos();
  }, []);

  const defaultNodeId = state.currentNodeId || controller.local.cur || "";

  function startFromScheduleTemplate(template: ScheduleTemplate) {
    const p = template.prefill;
    setError("");
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
    try {
      // Reuse an existing source automation when present (seeded on list); otherwise create.
      const existing = items.find((i) => i.trigger === template.trigger);
      if (existing) {
        if (!existing.enabled) {
          await updateAutomation(controller.local, existing.id, { enabled: true });
        }
      } else {
        await createAutomation(controller.local, {
          name: template.prefill.name,
          trigger: template.trigger,
          templateId: template.prefill.templateId,
          labels: template.prefill.labels,
          enabled: true,
        });
      }
      await refresh();
      // Connect sheet for GitHub App / Linear when the source is not ready yet.
      setWorkQueueOpen(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  function startFromTemplate(template: AutomationTemplate) {
    if (template.kind === "schedule") startFromScheduleTemplate(template);
    else if (template.kind === "webhook") startFromWebhookTemplate(template);
    else if (template.kind === "source") void startFromSourceTemplate(template);
    else if (template.route === "queue") setWorkQueueOpen(true);
    else onOpenSettings(template.route);
  }

  function startCustom() {
    setError("");
    setDraft(emptyDraft(defaultNodeId));
  }

  async function edit(item: AccountAutomation) {
    setError("");
    // Source automations get a dedicated filters editor (labels/repos/node/agent).
    if (isSourceTrigger(item.trigger)) {
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
      instructions = await open(await importRoomKey(unb64(roomKey)), parts.slice(2).join(":"));
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
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function runNow(item: AccountAutomation) {
    try {
      await runAutomationNow(controller.local, item.id);
      await refresh();
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  async function rotate(item: AccountAutomation) {
    setError("");
    try {
      const result = await rotateAutomationWebhook(controller.local, item.id);
      setRotated({ id: item.id, secret: result.webhookSecret });
      await refresh();
    } catch (e) { setError(String((e as Error).message || e)); }
  }

  const definitionRuns = useMemo(() => runs.filter((r) => r.definitionId), [runs]);

  return createPortal(
    <div className="automations-view" role="dialog" aria-modal="true" aria-label="Automations">
      <header className="automations-view-head">
        <h1 className="automations-view-heading">Automations</h1>
        <div className="automations-view-head-actions">
          <button type="button" className="btn autom-new-btn" onClick={startCustom}>New automation</button>
          <button type="button" className="icon-btn" onClick={onClose} title="Close" aria-label="Close automations">✕</button>
        </div>
      </header>

      <div className="automations-view-body">
        {error && <p className="settings-error">{error}</p>}

        <section className="autom-section">
          <h2 className="autom-section-label">Sources</h2>
          <p className="settings-hint" style={{ marginBottom: 8 }}>
            Sources start automations when something happens outside Bivy. Status below is live from your account hooks.
          </p>
          {(() => {
            const gh = githubSourceStatus(sources.github);
            const lin = linearSourceStatus(sources.linear);
            const slack = slackSourceStatus(sources.slack);
            return (
              <div className="automation-list">
                <div className="automation-row">
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>GitHub</strong>
                      <span className={`autom-status ${gh.tone}`}>{gh.label}</span>
                    </div>
                    <div className="settings-hint">{gh.detail}</div>
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="btn sm" onClick={() => setWorkQueueOpen(true)}>
                      {gh.tone === "off" ? "Connect" : "Manage"}
                    </button>
                  </div>
                </div>
                <div className="automation-row">
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>Linear</strong>
                      <span className={`autom-status ${lin.tone}`}>{lin.label}</span>
                    </div>
                    <div className="settings-hint">{lin.detail}</div>
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="btn sm" onClick={() => setWorkQueueOpen(true)}>
                      {lin.tone === "off" ? "Connect" : "Manage"}
                    </button>
                  </div>
                </div>
                <div className="automation-row">
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>Slack</strong>
                      <span className={`autom-status ${slack.tone}`}>{slack.label}</span>
                    </div>
                    <div className="settings-hint">{slack.detail}</div>
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="btn sm" onClick={() => onOpenSettings("webhooks")}>
                      {slack.tone === "off" ? "Connect" : "Manage"}
                    </button>
                  </div>
                </div>
                <div className="automation-row">
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>Schedule &amp; webhook</strong>
                      <span className="autom-status on">Built in</span>
                    </div>
                    <div className="settings-hint">Cron and signed webhooks are triggers on each automation — pick a repo when the event does not name one.</div>
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="btn sm" onClick={startCustom}>New automation</button>
                  </div>
                </div>
              </div>
            );
          })()}
        </section>

        {items.some((i) => i.trigger === "github_ci" && i.enabled) && sources.github?.connected && (
          <div className="autom-banner" role="status">
            <strong>Fix failed CI is on.</strong>{" "}
            New GitHub Apps created in Bivy receive <code>workflow_run</code> events automatically.
            Existing apps need <code>workflow_run</code> + Actions/Checks read on the app in GitHub,
            or failures will never reach Bivy.
            <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={() => setWorkQueueOpen(true)}>Open GitHub setup</button>
          </div>
        )}

        <section className="autom-section">
          <h2 className="autom-section-label">Suggested</h2>
          <div className="automation-templates">
            {AUTOMATION_TEMPLATES.map((template) => (
              <div className="template-card" key={template.key}>
                <div className="template-card-top">
                  <span className="template-card-icon" aria-hidden="true">{templateIcon(template.key)}</span>
                  <button
                    type="button"
                    className="btn sm template-card-add"
                    onClick={() => startFromTemplate(template)}
                  >
                    {template.kind === "external" || template.kind === "source"
                      ? (template.cta || "Set up")
                      : "Add"}
                  </button>
                </div>
                <strong className="template-card-title">{template.title}</strong>
                <p className="template-card-tagline">{template.tagline}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="autom-section">
          <h2 className="autom-section-label">Your automations</h2>
          {items.length === 0 ? (
            <p className="settings-hint">Nothing yet. Add a suggestion above, or create a custom automation.</p>
          ) : (
            <div className="automation-list">
              {items.map((item) => {
                const chip = isSourceTrigger(item.trigger)
                  ? sourceAutomationChip(item, sources)
                  : { tone: item.enabled ? "on" as const : "off" as const, label: item.enabled ? "Active" : "Paused" };
                return (
                <div className="automation-row" key={item.id}>
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>{item.name}</strong>
                      <span className={`autom-status ${chip.tone}`}>{chip.label}</span>
                    </div>
                    <div className="settings-hint">
                      {scheduleSummary(item)}
                      {item.enabled && item.nextRunAt ? ` · next ${new Date(item.nextRunAt).toLocaleString()}` : ""}
                    </div>
                    {item.trigger === "webhook" && item.webhookUrl && (
                      <div className="reveal-row">
                        <code className="reveal-value">{item.webhookUrl}</code>
                        <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(item.webhookUrl!)}>Copy URL</button>
                      </div>
                    )}
                    {rotated?.id === item.id && (
                      <div className="reveal-row">
                        <code className="reveal-value">{rotated.secret}</code>
                        <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(rotated.secret)}>Copy secret</button>
                        <span className="settings-hint">New signing secret — shown once.</span>
                      </div>
                    )}
                  </div>
                  <div className="settings-actions">
                    {!isSourceTrigger(item.trigger) && (
                      <button type="button" className="btn sm" onClick={() => void runNow(item)}>{item.trigger === "webhook" ? "Test run" : "Run now"}</button>
                    )}
                    <button type="button" className="btn sm" onClick={() => void edit(item)}>Edit</button>
                    {isSourceTrigger(item.trigger) && chip.tone === "warn" && chip.label.startsWith("Needs") && (
                      <button type="button" className="btn sm" onClick={() => setWorkQueueOpen(true)}>Connect</button>
                    )}
                    {item.trigger === "webhook" && <button type="button" className="btn sm" onClick={() => void rotate(item)}>Rotate secret</button>}
                    <button type="button" className="btn sm" onClick={() => void toggle(item)}>{item.enabled ? "Pause" : "Resume"}</button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="autom-section">
          <h2 className="autom-section-label">Recent activity</h2>
          {definitionRuns.length === 0 ? (
            <p className="settings-hint">Runs will show up here once an automation fires.</p>
          ) : (
            <div className="automation-list">
              {definitionRuns.slice(0, 12).map((run) => {
                const outcome = runOutcome(run.status);
                const defName = items.find((i) => i.id === run.definitionId)?.name;
                const sessionId = run.output?.sessionId;
                return (
                  <div className="automation-row" key={run.id}>
                    <div className="automation-row-main">
                      <div className="automation-row-title">
                        <strong>{run.title}</strong>
                        <span className={`run-status ${outcome.tone}`}>{outcome.label}</span>
                      </div>
                      <div className="settings-hint">
                        {[defName, new Date(run.createdAt).toLocaleString(), run.triggerKind].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="settings-actions">
                      {sessionId && (
                        <button
                          type="button"
                          className="btn sm primary"
                          onClick={() => { onOpenSession(sessionId); onClose(); }}
                        >
                          Open session
                        </button>
                      )}
                      {run.output?.prUrl && (
                        <a className="btn sm" href={run.output.prUrl} target="_blank" rel="noreferrer">View PR</a>
                      )}
                      {!sessionId && !run.output?.prUrl && (
                        <span className="settings-hint">{outcome.label}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {draft && (
        <AutomationEditor
          state={state}
          initial={draft}
          onCancel={() => setDraft(null)}
          onSaved={async () => { setDraft(null); await refresh().catch((e) => setError(String(e))); }}
          onOpenWorkQueue={() => {
            setDraft(null);
            setWorkQueueOpen(true);
          }}
        />
      )}

      {sourceEdit && (
        <SourceAutomationEditor
          item={sourceEdit}
          state={state}
          sources={sources}
          onClose={() => setSourceEdit(null)}
          onSaved={async () => {
            setSourceEdit(null);
            await refresh().catch((e) => setError(String(e)));
          }}
          onConnect={() => {
            setSourceEdit(null);
            setWorkQueueOpen(true);
          }}
        />
      )}

      {workQueueOpen && (
        <WorkQueueSetupSheet
          state={state}
          onClose={() => setWorkQueueOpen(false)}
          onOpenFullSettings={(view = "github") => {
            setWorkQueueOpen(false);
            onOpenSettings(view);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

// ── Source automation editor (GitHub / Linear / CI) ─────────────────────────
// Filters + routing defaults. Connect stays one tap away when the source is missing.

function SourceAutomationEditor({
  item,
  state,
  sources,
  onClose,
  onSaved,
  onConnect,
}: {
  item: AccountAutomation;
  state: AppState;
  sources: SourcesSnapshot;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onConnect: () => void;
}) {
  const trigger = item.trigger as "github" | "linear" | "github_ci";
  const [name, setName] = useState(item.name);
  const [enabled, setEnabled] = useState(item.enabled);
  const [labelsText, setLabelsText] = useState((item.labels ?? (trigger === "github_ci" ? [] : ["bivy"])).join(", "));
  const [reposText, setReposText] = useState((item.repos ?? []).join(", "));
  const [repoDefault, setRepoDefault] = useState(item.repo || "");
  const [nodeSuffix, setNodeSuffix] = useState(nodeLabelSuffix(item.nodeLabel));
  const [runtimeId, setRuntimeId] = useState(item.runtimeId || "");
  const [model, setModel] = useState(item.model || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsConnect =
    (trigger === "github" || trigger === "github_ci") && githubSourceStatus(sources.github).tone === "off"
    || trigger === "linear" && linearSourceStatus(sources.linear).tone === "off";

  const parseList = (raw: string): string[] | undefined => {
    const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  };

  async function save() {
    setBusy(true);
    setError("");
    try {
      const labels = parseList(labelsText);
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
      await updateAutomation(controller.local, item.id, {
        name: name.trim() || item.name,
        enabled,
        labels: labels ?? [],
        repos: repos ?? [],
        repo: repoDefault.trim() || "",
        nodeLabel: nodeSuffix.trim() ? `bivy/${nodeSuffix.trim()}` : "",
        runtimeId: runtimeId.trim() || "",
        model: model.trim() || "",
      });
      await onSaved();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  const title =
    trigger === "github_ci" ? "Edit Fix failed CI"
      : trigger === "linear" ? "Edit Linear automation"
        : "Edit GitHub automation";

  return (
    <div className="wizard-scrim" onClick={onClose}>
      <div className="wizard autom-editor" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="wizard-head">
          <strong>{title}</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cancel">✕</button>
        </div>
        <div className="wizard-body">
          {needsConnect && (
            <div className="autom-banner" role="status">
              Connect {trigger === "linear" ? "Linear" : "GitHub"} before this automation can fire.
              <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={onConnect}>Connect</button>
            </div>
          )}
          {trigger === "github_ci" && enabled && !needsConnect && (
            <div className="autom-banner" role="status">
              Requires <code>workflow_run</code> on the GitHub App (included for apps created in Bivy).
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

          <div className="settings-field">
            <label className="field-label" htmlFor="src-labels">
              {trigger === "github_ci" ? "Workflow names (optional)" : "Labels"}
            </label>
            <input
              id="src-labels"
              className="picker-search"
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
              placeholder={trigger === "github_ci" ? "e.g. CI, Build (empty = any failed workflow)" : "e.g. bivy"}
            />
            <p className="settings-hint">
              {trigger === "github_ci"
                ? "Comma-separated. Empty matches every failed workflow on allowed repos."
                : "Comma-separated. Default bivy also matches bivy/&lt;node&gt;. Mentions ignore this filter."}
            </p>
          </div>

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
                {repoDefault && !state.repos.some((r) => r.slug === repoDefault) && (
                  <option value={repoDefault}>{repoDefault}</option>
                )}
                {state.repos.map((r) => (
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
                <option value="">Node default</option>
                {state.runtimes.map((r) => (
                  <option key={r.id} value={r.id}>{r.name || r.id}</option>
                ))}
              </select>
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="src-model">Model</label>
              <input id="src-model" className="picker-search" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Node default" />
            </div>
          </details>

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
// Name + trigger + instructions + machine on one form (Grok-style). Advanced
// agent/model/autonomy knobs tuck behind a disclosure. Webhook create still
// holds on a one-time URL/secret reveal before closing.

function AutomationEditor({
  state,
  initial,
  onCancel,
  onSaved,
  onOpenWorkQueue,
}: {
  state: AppState;
  initial: Draft;
  onCancel: () => void;
  onSaved: () => void;
  /** Source triggers (GitHub/Linear) leave the form and open work-queue setup. */
  onOpenWorkQueue: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nlError, setNlError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));

  const tzList = useMemo(() => timezoneOptions(d.timezone), [d.timezone]);
  const cronHuman = useMemo(() => describeCron(d.cron), [d.cron]);
  const selectedNode = state.nodes.find((n) => n.id === d.nodeId);
  const pick = d.hasTrigger ? matchTriggerPick(d) : null;
  const canEditTrigger = !d.id;

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
      // GitHub/Linear start sessions via the work queue — same runtime, connect
      // flow lives in the setup sheet rather than this definition form.
      setPickerOpen(false);
      onOpenWorkQueue();
      return;
    }
    if (opt.trigger === "webhook") {
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

  const scheduleOk = d.trigger === "webhook"
    || (d.kind === "cron" ? Boolean(d.cron.trim()) && Boolean(cronHuman) : Boolean(d.onceAt));
  const canSave =
    d.name.trim().length > 0
    && d.instructions.trim().length > 0
    && d.hasTrigger
    && scheduleOk
    && Boolean(d.nodeId)
    && Boolean(controller.local.keys()[d.nodeId]);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const roomKey = d.nodeId ? controller.local.keys()[d.nodeId] : undefined;
      if (!d.nodeId || !roomKey) throw new Error("Connect to the assigned machine before saving encrypted instructions.");
      const encrypted = await seal(await importRoomKey(unb64(roomKey)), d.instructions.trim());
      const nodeName = selectedNode?.name;
      const repo = d.repo.trim();
      if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error("Repository must look like owner/name");
      }
      const input = {
        name: d.name.trim(),
        templateCiphertext: `${TEMPLATE_PREFIX}:${d.nodeId}:${encrypted}`,
        nodeLabel: nodeName ? `bivy/${nodeName}` : undefined,
        runtimeId: d.runtimeId.trim() || undefined,
        model: d.model.trim() || undefined,
        approvalMode: d.approvalMode,
        sandbox: d.sandbox,
        enabled: true,
        trigger: d.trigger,
        // Empty string clears on update; omit on create when unset.
        repo: repo || (d.id ? "" : undefined),
        ...(d.trigger === "schedule"
          ? {
              schedule: d.kind === "cron"
                ? { kind: "cron" as const, expression: d.cron.trim(), timezone: d.timezone.trim() }
                : { kind: "once" as const, at: new Date(d.onceAt).toISOString() },
            }
          : {}),
      };
      if (d.id) {
        await updateAutomation(controller.local, d.id, input);
        onSaved();
      } else {
        const result = await createAutomation(controller.local, input);
        if (d.trigger === "webhook" && result.webhookSecret) {
          setCreated({ url: result.webhookUrl ?? "", secret: result.webhookSecret });
        } else {
          onSaved();
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
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel">✕</button>
        </div>

        {created ? (
          <>
            <div className="wizard-body">
              <p className="settings-hint">
                Send signed events to this URL. Copy the signing secret now — it isn&apos;t shown again (you can rotate it later).
              </p>
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
              <button type="button" className="btn primary autom-save-btn" onClick={onSaved}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="wizard-body">
              {/* Name row: icon badge + title field */}
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

              {/* Triggers */}
              <div className="autom-field-block">
                <div className="autom-field-label">Triggers</div>
                {d.hasTrigger && pick ? (
                  <div className="autom-trigger-chip">
                    <span className="autom-trigger-chip-icon" aria-hidden="true">
                      {pick.id === "webhook" ? <IconWebhook /> : <IconClock />}
                    </span>
                    <div className="autom-trigger-chip-text">
                      <strong>{pick.label}</strong>
                      <span>
                        {d.trigger === "webhook"
                          ? pick.hint
                          : d.kind === "once"
                            ? (d.onceAt ? new Date(d.onceAt).toLocaleString() : pick.hint)
                            : (cronHuman || pick.hint)}
                      </span>
                    </div>
                    {canEditTrigger && (
                      <button type="button" className="icon-btn autom-trigger-clear" onClick={clearTrigger} aria-label="Remove trigger">✕</button>
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
                                : opt.id === "github" || opt.id === "github_ci" || opt.id === "linear"
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

                {/* Schedule details once a schedule trigger is set */}
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
                  <p className="settings-hint autom-trigger-config">
                    {d.id
                      ? "Fires on a signed POST to its webhook URL. Copy the URL from the automation row; rotate the secret there if needed."
                      : "You'll get the signed URL and a one-time signing secret after you save. The event can pick the machine, repo, and context; agent, model, sandbox, and instructions stay as configured here."}
                  </p>
                )}

                {/* Workspace target — required for schedule (event has no repo); optional default for webhook. */}
                {d.hasTrigger && (
                  <div className="autom-trigger-config">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-repo">
                        {d.trigger === "schedule" ? "Repository" : "Repository (optional default)"}
                      </label>
                      <select
                        id="autom-repo"
                        className="picker-search"
                        value={d.repo}
                        onChange={(e) => set("repo", e.target.value)}
                      >
                        <option value="">{d.trigger === "schedule" ? "Select a GitHub repo…" : "Event may supply the repo"}</option>
                        {d.repo && !state.repos.some((r) => r.slug === d.repo) && (
                          <option value={d.repo}>{d.repo}</option>
                        )}
                        {state.repos.map((r) => (
                          <option key={r.slug} value={r.slug}>{r.slug}</option>
                        ))}
                      </select>
                      <p className="settings-hint">
                        {d.trigger === "schedule"
                          ? "The node clones this repo before the session starts. Connect GitHub on the machine if the list is empty."
                          : "Used when the webhook event does not include a repo. Definition wins over the event when both are set."}
                      </p>
                      {!d.repo && d.trigger === "schedule" && (
                        <p className="schedule-hint warn">Pick a repository so scheduled runs land in the right project.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Instructions */}
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
                    <div className="autom-instructions-meta">
                      <label className="autom-inline-label">
                        <span>Machine</span>
                        <select
                          className="autom-inline-select"
                          value={d.nodeId}
                          onChange={(e) => set("nodeId", e.target.value)}
                          aria-label="Machine"
                        >
                          {!d.nodeId && <option value="">Select…</option>}
                          {state.nodes.map((n) => (
                            <option key={n.id} value={n.id}>{String(n.name || n.id)}</option>
                          ))}
                          {d.nodeId && !state.nodes.some((n) => n.id === d.nodeId) && (
                            <option value={d.nodeId}>{d.nodeId}</option>
                          )}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="autom-advanced-link"
                        onClick={() => setShowAdvanced((v) => !v)}
                        aria-expanded={showAdvanced}
                      >
                        {showAdvanced ? "Hide advanced" : "Advanced"}
                      </button>
                    </div>
                  </div>
                </div>
                {d.nodeId && !controller.local.keys()[d.nodeId] && (
                  <p className="schedule-hint warn">This device doesn&apos;t hold that machine&apos;s encryption key. Pick a machine you&apos;re paired with.</p>
                )}
                {showAdvanced && (
                  <div className="wizard-advanced">
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-runtime">Agent</label>
                      <select id="autom-runtime" className="picker-search" value={d.runtimeId} onChange={(e) => set("runtimeId", e.target.value)}>
                        <option value="">Machine default</option>
                        {state.runtimes.map((r) => <option key={r.id} value={r.id}>{String(r.displayName || r.name || r.id)}</option>)}
                        {d.runtimeId && !state.runtimes.some((r) => r.id === d.runtimeId) && (
                          <option value={d.runtimeId}>{d.runtimeId} (not installed here)</option>
                        )}
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="field-label" htmlFor="autom-model">Model</label>
                      <select id="autom-model" className="picker-search" value={d.model} onChange={(e) => set("model", e.target.value)}>
                        <option value="">Agent default</option>
                        {state.models.map((m) => (
                          <option key={String((m as { provider?: string }).provider || "") + ":" + m.id} value={m.id}>{m.label || m.id}</option>
                        ))}
                        {d.model && !state.models.some((m) => m.id === d.model) && <option value={d.model}>{d.model}</option>}
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
                  </div>
                )}
                <p className="settings-hint">Encrypted for the assigned machine before upload. The hosted control plane never sees the prompt, your code, or credentials.</p>
              </div>

              {error && <p className="settings-error">{error}</p>}
            </div>

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
              <button
                type="button"
                className="btn primary autom-save-btn"
                onClick={() => void save()}
                disabled={busy || !canSave}
              >
                {busy ? "Saving…" : d.id ? "Save" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Icons (inline SVG, 18–20px) ─────────────────────────────────────────────

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconWebhook() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 16a3 3 0 1 0-2.8-4H9.8A3 3 0 1 0 12 16h6Z" /><path d="M8.5 9.5 12 4l3.5 5.5" />
    </svg>
  );
}
function IconPackage() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v6c0 5 3.5 8 7 9 3.5-1 7-4 7-9V6l-7-3Z" />
    </svg>
  );
}
function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}
function IconFlask() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
    </svg>
  );
}
function IconCi() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16v12H4z" /><path d="m8 10 2 2-2 2M12 14h4" />
    </svg>
  );
}
function IconBug() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 9a4 4 0 0 1 8 0v7a4 4 0 0 1-8 0V9Z" /><path d="M8 12H4M20 12h-4M9 5 7 3M15 5l2-2M9 19l-2 2M15 19l2 2" />
    </svg>
  );
}
function IconRadar() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 12 17 7" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconPr() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" />
      <path d="M7 8v8M17 16V9a2 2 0 0 0-2-2h-3" />
    </svg>
  );
}
