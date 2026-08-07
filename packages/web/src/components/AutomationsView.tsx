// SPDX-License-Identifier: AGPL-3.0-only
//
// The first-class Automations destination — a full-screen surface reached from
// the sidebar foot (peer to Settings), not a panel buried in Settings. It has
// three zones: a concrete-job template gallery ("what do you want to automate?"),
// the user's existing automations, and recent run activity. Creating or editing
// an automation happens in a short, guided step-by-step wizard rather than a wall
// of fields — a template pre-answers most steps, and advanced knobs stay tucked
// behind disclosure. Everything still writes the same POST /account/automations
// definition the old form did; this is presentation over the existing system.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import cronstrue from "cronstrue";
import {
  createAutomation,
  fetchAutomationRuns,
  fetchAutomations,
  runAutomationNow,
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
} from "@bivy/core";
import { controller } from "../store/controller.js";
import { AUTOMATION_TEMPLATES, type ScheduleTemplate } from "./automationTemplates.js";

const TEMPLATE_PREFIX = "bivy-room-v1";

// Quick-pick recurring schedules, shown as chips beside the natural-language
// field. Each carries the plain-English phrase and the cron it resolves to.
const CRON_PRESETS: Array<{ label: string; phrase: string; cron: string }> = [
  { label: "Hourly", phrase: "every hour", cron: "0 * * * *" },
  { label: "Every day 9am", phrase: "every day at 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", phrase: "every weekday at 9am", cron: "0 9 * * 1,2,3,4,5" },
  { label: "Mondays 9am", phrase: "every monday at 9am", cron: "0 9 * * 1" },
  { label: "Every 15 min", phrase: "every 15 minutes", cron: "*/15 * * * *" },
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

// IANA timezone list for the picker; fall back to a small common set (plus the
// detected zone) on engines without Intl.supportedValuesOf.
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

/** A datetime-local value (YYYY-MM-DDTHH:mm) for `date`, in local wall time. */
function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A one-line human schedule summary for an automation card. */
function scheduleSummary(item: AccountAutomation): string {
  if (item.schedule.kind === "once") return `Once · ${new Date(item.schedule.at).toLocaleString()}`;
  return describeCron(item.schedule.expression) || `${item.schedule.expression} · ${item.schedule.timezone}`;
}

// Map a run's raw lifecycle status to the customer-facing outcome vocabulary
// (see docs/automation-runs.md) and a tone class for the status pill.
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

// The editable draft the wizard operates on. `id` is set when editing an
// existing automation, null for a fresh create.
interface Draft {
  id: string | null;
  name: string;
  instructions: string;
  kind: "cron" | "once";
  cron: string;
  nlText: string;
  timezone: string;
  onceAt: string;
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
    kind: "cron",
    cron: "0 9 * * 1",
    nlText: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    onceAt: toLocalInput(new Date(Date.now() + 60 * 60_000)),
    nodeId,
    runtimeId: "",
    model: "",
    approvalMode: "autonomous",
    sandbox: "workspace-write",
  };
}

export function AutomationsView({
  state,
  onClose,
  onOpenSettings,
  onOpenSession,
}: {
  state: AppState;
  onClose: () => void;
  /** Jump to a Settings panel (webhook / work-queue templates configure their
   *  trigger there). */
  onOpenSettings: (view: "webhooks" | "queue") => void;
  /** Open the chat session a run produced, in the unified session list. */
  onOpenSession: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<AccountAutomation[]>([]);
  const [runs, setRuns] = useState<AccountAutomationRun[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = useCallback(async () => {
    const [definitions, recent] = await Promise.all([
      fetchAutomations(controller.local),
      fetchAutomationRuns(controller.local, 30),
    ]);
    setItems(definitions);
    setRuns(recent);
  }, []);

  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, [refresh]);
  useEffect(() => { controller.listRuntimes(); controller.listModels(); }, []);

  const defaultNodeId = state.currentNodeId || controller.local.cur || "";

  // Start a create from a template: pre-fill the draft and open the wizard.
  function startFromTemplate(template: ScheduleTemplate) {
    const p = template.prefill;
    setError("");
    setDraft({
      ...emptyDraft(defaultNodeId),
      name: p.name,
      instructions: p.instructions,
      cron: p.schedule.cron,
      nlText: p.schedule.nlText,
      approvalMode: p.approvalMode,
      sandbox: p.sandbox,
    });
  }

  function startCustom() {
    setError("");
    setDraft(emptyDraft(defaultNodeId));
  }

  async function edit(item: AccountAutomation) {
    setError("");
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
      nodeId,
      runtimeId: item.runtimeId || "",
      model: item.model || "",
      approvalMode: item.approvalMode ?? "autonomous",
      sandbox: item.sandbox || "workspace-write",
      kind: item.schedule.kind,
      cron: item.schedule.kind === "cron" ? item.schedule.expression : base.cron,
      timezone: item.schedule.kind === "cron" ? item.schedule.timezone : base.timezone,
      onceAt: item.schedule.kind === "once" ? toLocalInput(new Date(item.schedule.at)) : base.onceAt,
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

  const definitionRuns = useMemo(() => runs.filter((r) => r.definitionId), [runs]);

  return createPortal(
    <div className="automations-view" role="dialog" aria-modal="true" aria-label="Automations">
      <header className="automations-view-head">
        <div className="automations-view-title">
          <IconBolt />
          <h1>Automations</h1>
        </div>
        <div className="automations-view-head-actions">
          <button className="btn" onClick={startCustom}>New automation</button>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close automations">✕</button>
        </div>
      </header>

      <div className="automations-view-body">
        {error && <p className="settings-error">{error}</p>}

        <section className="settings-section">
          <h3>What do you want to automate?</h3>
          <p className="settings-hint">Concrete jobs, preset over Bivy&apos;s automation system. Pick one to get started, or build a custom automation.</p>
          <div className="automation-templates">
            {AUTOMATION_TEMPLATES.map((template) => (
              <div className="template-card" key={template.key}>
                <div className="template-card-body">
                  <strong className="template-card-title">{template.title}</strong>
                  <p className="template-card-tagline">{template.tagline}</p>
                </div>
                {template.kind === "schedule" ? (
                  <button type="button" className="btn primary template-card-action" onClick={() => startFromTemplate(template)}>
                    Use template
                  </button>
                ) : (
                  <button type="button" className="btn template-card-action" onClick={() => onOpenSettings(template.route)}>
                    {template.cta}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Your automations</h3>
          {items.length === 0 ? (
            <p className="settings-hint">Nothing yet. Start from a template above, or create a custom automation.</p>
          ) : (
            <div className="automation-list">
              {items.map((item) => (
                <div className="automation-row" key={item.id}>
                  <div className="automation-row-main">
                    <div className="automation-row-title">
                      <strong>{item.name}</strong>
                      <span className={`autom-status ${item.enabled ? "on" : "off"}`}>{item.enabled ? "Active" : "Paused"}</span>
                    </div>
                    <div className="settings-hint">
                      {scheduleSummary(item)}
                      {item.enabled && item.nextRunAt ? ` · next ${new Date(item.nextRunAt).toLocaleString()}` : ""}
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button className="btn" onClick={() => void runNow(item)}>Run now</button>
                    <button className="btn" onClick={() => void edit(item)}>Edit</button>
                    <button className="btn" onClick={() => void toggle(item)}>{item.enabled ? "Pause" : "Resume"}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="settings-section">
          <h3>Recent activity</h3>
          {definitionRuns.length === 0 ? (
            <p className="settings-hint">Runs will show up here with their outcome once an automation fires.</p>
          ) : (
            <div className="automation-list">
              {definitionRuns.slice(0, 12).map((run) => {
                const outcome = runOutcome(run.status);
                return (
                  <div className="automation-row" key={run.id}>
                    <div className="automation-row-main">
                      <div className="automation-row-title">
                        <strong>{run.title}</strong>
                        <span className={`run-status ${outcome.tone}`}>{outcome.label}</span>
                      </div>
                      <div className="settings-hint">{new Date(run.createdAt).toLocaleString()}</div>
                    </div>
                    {(run.output?.sessionId || run.output?.prUrl) && (
                      <div className="settings-actions">
                        {run.output?.sessionId && (
                          <button className="btn" onClick={() => onOpenSession(run.output!.sessionId!)}>Open session</button>
                        )}
                        {run.output?.prUrl && (
                          <a className="btn" href={run.output.prUrl} target="_blank" rel="noreferrer">View PR</a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {draft && (
        <AutomationWizard
          state={state}
          initial={draft}
          onCancel={() => setDraft(null)}
          onSaved={async () => { setDraft(null); await refresh().catch((e) => setError(String(e))); }}
        />
      )}
    </div>,
    document.body,
  );
}

// ── Guided create/edit wizard ───────────────────────────────────────────────
// Four steps: What → When → Where → Review. A template arrives with every step
// pre-answered, so the common path is just clicking through to Review. Advanced
// routing (agent, model, approvals, sandbox) hides behind disclosure in Where.

const STEPS = ["What", "When", "Where", "Review"] as const;

function AutomationWizard({
  state,
  initial,
  onCancel,
  onSaved,
}: {
  state: AppState;
  initial: Draft;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [step, setStep] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nlError, setNlError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));

  const tzList = useMemo(() => timezoneOptions(d.timezone), [d.timezone]);
  const cronHuman = useMemo(() => describeCron(d.cron), [d.cron]);
  const selectedNode = state.nodes.find((n) => n.id === d.nodeId);

  function onNlChange(value: string) {
    set("nlText", value);
    if (!value.trim()) { setNlError(""); return; }
    const parsed = nlToCron(value);
    if (isNlCronOk(parsed)) { set("cron", parsed.cron); setNlError(""); }
    else setNlError(parsed.error);
  }

  // Per-step gate for the Next button, so the user can't advance past an
  // incomplete step (and Review can't submit an invalid definition).
  const stepValid = (() => {
    if (step === 0) return d.name.trim().length > 0 && d.instructions.trim().length > 0;
    if (step === 1) return d.kind === "cron" ? Boolean(d.cron.trim()) && Boolean(cronHuman) : Boolean(d.onceAt);
    if (step === 2) return Boolean(d.nodeId) && Boolean(controller.local.keys()[d.nodeId]);
    return true;
  })();

  async function save() {
    setBusy(true);
    setError("");
    try {
      const roomKey = d.nodeId ? controller.local.keys()[d.nodeId] : undefined;
      if (!d.nodeId || !roomKey) throw new Error("Connect to the assigned machine before saving encrypted instructions.");
      const encrypted = await seal(await importRoomKey(unb64(roomKey)), d.instructions.trim());
      const nodeName = selectedNode?.name;
      const input = {
        name: d.name.trim(),
        templateCiphertext: `${TEMPLATE_PREFIX}:${d.nodeId}:${encrypted}`,
        // A room-key envelope is readable only by this node; default routing to
        // its targeted queue so no other node can claim an undecryptable run.
        nodeLabel: nodeName ? `bivy/${nodeName}` : undefined,
        runtimeId: d.runtimeId.trim() || undefined,
        model: d.model.trim() || undefined,
        approvalMode: d.approvalMode,
        sandbox: d.sandbox,
        enabled: true,
        schedule: d.kind === "cron"
          ? { kind: "cron" as const, expression: d.cron.trim(), timezone: d.timezone.trim() }
          : { kind: "once" as const, at: new Date(d.onceAt).toISOString() },
      };
      if (d.id) await updateAutomation(controller.local, d.id, input);
      else await createAutomation(controller.local, input);
      onSaved();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-scrim" onClick={onCancel}>
      <div className="wizard" role="dialog" aria-modal="true" aria-label={d.id ? "Edit automation" : "New automation"} onClick={(e) => e.stopPropagation()}>
        <div className="wizard-head">
          <strong>{d.id ? "Edit automation" : "New automation"}</strong>
          <button className="icon-btn" onClick={onCancel} aria-label="Cancel">✕</button>
        </div>
        <ol className="wizard-steps">
          {STEPS.map((label, i) => (
            <li key={label} className={`wizard-step-tab${i === step ? " active" : ""}${i < step ? " done" : ""}`}>
              <span className="wizard-step-num">{i + 1}</span>{label}
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === 0 && (
            <div className="wizard-pane">
              <h4>What should happen?</h4>
              <div className="settings-field">
                <label className="field-label" htmlFor="wiz-name">Name</label>
                <input id="wiz-name" className="picker-search" value={d.name} onChange={(e) => set("name", e.target.value)} autoFocus />
              </div>
              <div className="settings-field">
                <label className="field-label" htmlFor="wiz-instructions">Instructions for the agent</label>
                <textarea id="wiz-instructions" className="picker-search" rows={7} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} />
                <p className="settings-hint">Encrypted for the assigned machine before upload. The hosted control plane never sees the prompt, your code, or credentials.</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-pane">
              <h4>When should it run?</h4>
              <div className="settings-field">
                <label className="field-label" htmlFor="wiz-kind">Frequency</label>
                <select id="wiz-kind" className="picker-search" value={d.kind} onChange={(e) => set("kind", e.target.value as "cron" | "once")}>
                  <option value="cron">Recurring</option>
                  <option value="once">One time</option>
                </select>
              </div>
              {d.kind === "cron" ? (
                <>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-nl">When to run</label>
                    <input id="wiz-nl" className="picker-search" value={d.nlText} onChange={(e) => onNlChange(e.target.value)} placeholder="e.g. every day at 9am" autoComplete="off" spellCheck={false} />
                    <div className="schedule-presets">
                      {CRON_PRESETS.map((p) => (
                        <button key={p.label} type="button" className={`schedule-preset${d.cron.trim() === p.cron ? " active" : ""}`} onClick={() => { set("nlText", p.phrase); set("cron", p.cron); setNlError(""); }}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {nlError
                      ? <p className="schedule-hint warn">{nlError}</p>
                      : cronHuman
                        ? <p className="schedule-hint ok">Runs {cronHuman.charAt(0).toLowerCase() + cronHuman.slice(1)}.</p>
                        : <p className="schedule-hint warn">Not a valid schedule yet.</p>}
                  </div>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-cron">Cron expression</label>
                    <input id="wiz-cron" className="picker-search schedule-cron-input" value={d.cron} onChange={(e) => { set("cron", e.target.value); set("nlText", ""); setNlError(""); }} aria-label="Cron expression" spellCheck={false} />
                  </div>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-tz">Timezone</label>
                    <select id="wiz-tz" className="picker-search" value={d.timezone} onChange={(e) => set("timezone", e.target.value)}>
                      {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                    </select>
                  </div>
                </>
              ) : (
                <div className="settings-field">
                  <label className="field-label" htmlFor="wiz-once">Run at</label>
                  <input id="wiz-once" className="picker-search" type="datetime-local" min={toLocalInput(new Date())} value={d.onceAt} onChange={(e) => set("onceAt", e.target.value)} />
                  {d.onceAt && <p className="schedule-hint ok">Runs {new Date(d.onceAt).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"}).</p>}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="wizard-pane">
              <h4>Where should it run?</h4>
              <div className="settings-field">
                <label className="field-label" htmlFor="wiz-node">Machine</label>
                <select id="wiz-node" className="picker-search" value={d.nodeId} onChange={(e) => set("nodeId", e.target.value)}>
                  {!d.nodeId && <option value="">Select a machine…</option>}
                  {state.nodes.map((n) => (
                    <option key={n.id} value={n.id}>{String(n.name || n.id)}</option>
                  ))}
                  {d.nodeId && !state.nodes.some((n) => n.id === d.nodeId) && <option value={d.nodeId}>{d.nodeId}</option>}
                </select>
                {d.nodeId && !controller.local.keys()[d.nodeId]
                  ? <p className="schedule-hint warn">This device doesn&apos;t hold that machine&apos;s encryption key. Pick a machine you&apos;re paired with.</p>
                  : <p className="settings-hint">Runs on your own infrastructure — its repository, tools, and credentials. Instructions are encrypted to this machine.</p>}
              </div>

              <button type="button" className="schedule-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
                {showAdvanced ? "▾" : "▸"} Advanced — agent, model, autonomy
              </button>
              {showAdvanced && (
                <div className="wizard-advanced">
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-runtime">Agent</label>
                    <select id="wiz-runtime" className="picker-search" value={d.runtimeId} onChange={(e) => set("runtimeId", e.target.value)}>
                      <option value="">Machine default</option>
                      {state.runtimes.map((r) => <option key={r.id} value={r.id}>{String(r.displayName || r.name || r.id)}</option>)}
                      {d.runtimeId && !state.runtimes.some((r) => r.id === d.runtimeId) && <option value={d.runtimeId}>{d.runtimeId} (not installed here)</option>}
                    </select>
                  </div>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-model">Model</label>
                    <select id="wiz-model" className="picker-search" value={d.model} onChange={(e) => set("model", e.target.value)}>
                      <option value="">Agent default</option>
                      {state.models.map((m) => (
                        <option key={String((m as { provider?: string }).provider || "") + ":" + m.id} value={m.id}>{m.label || m.id}</option>
                      ))}
                      {d.model && !state.models.some((m) => m.id === d.model) && <option value={d.model}>{d.model}</option>}
                    </select>
                  </div>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-approvals">Approvals</label>
                    <select id="wiz-approvals" className="picker-search" value={d.approvalMode} onChange={(e) => set("approvalMode", e.target.value as Draft["approvalMode"])}>
                      <option value="autonomous">Autonomous (default; pauses only for high-risk actions)</option>
                      <option value="risky">Ask before risky actions</option>
                      <option value="always">Ask before every action</option>
                      <option value="never">Never ask</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="wiz-sandbox">Sandbox</label>
                    <select id="wiz-sandbox" className="picker-search" value={d.sandbox} onChange={(e) => set("sandbox", e.target.value as Draft["sandbox"])}>
                      <option value="read-only">Read only</option>
                      <option value="workspace-write">Workspace write</option>
                      <option value="danger-full-access">Full access</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="wizard-pane">
              <h4>Review</h4>
              <dl className="wizard-review">
                <dt>Name</dt><dd>{d.name}</dd>
                <dt>Runs</dt><dd>{d.kind === "cron" ? (cronHuman || d.cron) : `once at ${new Date(d.onceAt).toLocaleString()}`}</dd>
                <dt>Machine</dt><dd>{String(selectedNode?.name || d.nodeId)}</dd>
                <dt>Agent</dt><dd>{d.runtimeId || "machine default"}{d.model ? ` · ${d.model}` : ""}</dd>
                <dt>Autonomy</dt><dd>{d.approvalMode} · {d.sandbox}</dd>
              </dl>
              <p className="settings-hint">The agent will follow your instructions, run the project&apos;s checks, and open a pull request. It runs entirely on the selected machine.</p>
            </div>
          )}

          {error && <p className="settings-error">{error}</p>}
        </div>

        <div className="wizard-actions">
          {step > 0
            ? <button className="btn" onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</button>
            : <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
          {step < STEPS.length - 1
            ? <button className="btn primary" onClick={() => setStep((s) => s + 1)} disabled={!stepValid}>Continue</button>
            : <button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : d.id ? "Save changes" : "Create automation"}</button>}
        </div>
      </div>
    </div>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </svg>
  );
}
