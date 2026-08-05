// SPDX-License-Identifier: FSL-1.1-ALv2
import { useCallback, useEffect, useMemo, useState } from "react";
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

const TEMPLATE_PREFIX = "bivy-room-v1";

// Quick-pick recurring schedules, shown as chips above the natural-language
// field. Each carries the plain-English phrase (dropped into the input so the
// user can tweak it) and the cron it resolves to.
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

// IANA timezone list for the picker, newest browsers expose it directly; fall
// back to a small common set (plus the detected zone) on older engines.
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

export function AutomationsPanel({ state }: { state: AppState }) {
  const [items, setItems] = useState<AccountAutomation[]>([]);
  const [runs, setRuns] = useState<AccountAutomationRun[]>([]);
  const [name, setName] = useState("");
  const [ciphertext, setCiphertext] = useState("");
  const [cron, setCron] = useState("0 9 * * 1");
  // The natural-language schedule box ("every day at 9am"). Kept separate from
  // `cron` (the value actually saved) so hand-edits to the advanced cron field
  // and preset chips don't fight the text the user typed.
  const [nlText, setNlText] = useState("");
  const [nlError, setNlError] = useState("");
  const [showCronField, setShowCronField] = useState(false);
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [onceAt, setOnceAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [nodeLabel, setNodeLabel] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [model, setModel] = useState("");
  const [approvalMode, setApprovalMode] = useState<"never" | "risky" | "always" | "autonomous">("autonomous");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write" | "danger-full-access">("workspace-write");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [definitions, recent] = await Promise.all([
      fetchAutomations(controller.local),
      fetchAutomationRuns(controller.local, 30),
    ]);
    setItems(definitions);
    setRuns(recent);
  }, []);

  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, [refresh]);

  // Populate the Runtime/Model selects with what this node actually offers.
  useEffect(() => {
    controller.listRuntimes();
    controller.listModels();
  }, []);

  const tzList = useMemo(() => timezoneOptions(timezone), [timezone]);
  const cronHuman = useMemo(() => describeCron(cron), [cron]);

  // Natural-language → cron. We update the saved `cron` on every successful
  // parse and surface a gentle hint (not a hard error) while a phrase is still
  // being typed, keeping the last good cron so the preview never flickers empty.
  function onNlChange(value: string) {
    setNlText(value);
    if (!value.trim()) { setNlError(""); return; }
    const parsed = nlToCron(value);
    if (isNlCronOk(parsed)) { setCron(parsed.cron); setNlError(""); }
    else setNlError(parsed.error);
  }

  function applyPreset(preset: (typeof CRON_PRESETS)[number]) {
    setNlText(preset.phrase);
    setCron(preset.cron);
    setNlError("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const nodeId = state.currentNodeId || controller.local.cur;
      const roomKey = nodeId ? controller.local.keys()[nodeId] : undefined;
      if (!nodeId || !roomKey) throw new Error("Connect to the assigned machine before saving encrypted instructions.");
      if (kind === "cron" && !cron.trim()) throw new Error("Describe when to run, e.g. “every day at 9am”.");
      if (kind === "once" && !onceAt) throw new Error("Pick a date and time to run.");
      const encrypted = await seal(await importRoomKey(unb64(roomKey)), ciphertext.trim());
      const currentNode = state.nodes.find((node) => node.id === nodeId);
      const input = {
        name: name.trim(),
        templateCiphertext: `${TEMPLATE_PREFIX}:${nodeId}:${encrypted}`,
        // A room-key envelope is readable only by this node. Default to its
        // targeted queue so another online node cannot claim an undecryptable run.
        nodeLabel: nodeLabel.trim() || (currentNode?.name ? `bivy/${currentNode.name}` : undefined),
        runtimeId: runtimeId.trim() || undefined,
        model: model.trim() || undefined,
        approvalMode,
        sandbox,
        enabled: true,
        schedule: kind === "cron"
          ? { kind: "cron" as const, expression: cron.trim(), timezone: timezone.trim() }
          : { kind: "once" as const, at: new Date(onceAt).toISOString() },
      };
      if (editing) await updateAutomation(controller.local, editing, input);
      else await createAutomation(controller.local, input);
      setName("");
      setCiphertext("");
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: AccountAutomation) {
    await updateAutomation(controller.local, item.id, { enabled: !item.enabled });
    await refresh();
  }

  async function runNow(item: AccountAutomation) {
    await runAutomationNow(controller.local, item.id);
    await refresh();
  }

  async function edit(item: AccountAutomation) {
    setEditing(item.id);
    setName(item.name);
    const parts = item.templateCiphertext?.split(":");
    if (parts?.[0] === TEMPLATE_PREFIX && parts[1] && parts.slice(2).length) {
      const roomKey = controller.local.keys()[parts[1]];
      if (!roomKey) {
        setError("This device does not hold the assigned machine's encryption key.");
        return;
      }
      setCiphertext(await open(await importRoomKey(unb64(roomKey)), parts.slice(2).join(":")));
    } else {
      setCiphertext("");
    }
    setNodeLabel(item.nodeLabel || "");
    setRuntimeId(item.runtimeId || "");
    setModel(item.model || "");
    setApprovalMode(item.approvalMode ?? "autonomous");
    setSandbox(item.sandbox || "workspace-write");
    setKind(item.schedule.kind);
    if (item.schedule.kind === "cron") {
      setCron(item.schedule.expression);
      setTimezone(item.schedule.timezone);
      // The saved cron may not map back to a single English phrase, so start the
      // NL box empty and let the human-readable preview describe the schedule.
      setNlText("");
      setNlError("");
      setShowCronField(true);
    } else {
      setOnceAt(toLocalInput(new Date(item.schedule.at)));
    }
  }

  return (
    <div className="automations-layout">
      <div className="automations-main">
      <section className="settings-section">
        <h3>Scheduled automations</h3>
        <p className="settings-hint">
          Instructions are encrypted for the assigned machine before upload. The hosted control plane never receives
          plaintext prompts, repository contents, transcripts, credentials, or tool output.
        </p>
        <form onSubmit={submit} className="settings-form">
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-name">Name</label>
            <input id="automation-name" className="picker-search" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-instructions">Instructions</label>
            <textarea id="automation-instructions" className="picker-search" value={ciphertext} onChange={(e) => setCiphertext(e.target.value)} required rows={4} />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-schedule">Schedule</label>
            <select id="automation-schedule" className="picker-search" value={kind} onChange={(e) => setKind(e.target.value as "cron" | "once")}>
              <option value="cron">Recurring</option>
              <option value="once">One time</option>
            </select>
          </div>
          {kind === "cron" ? <>
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-nl">When to run</label>
              <input
                id="automation-nl"
                className="picker-search"
                value={nlText}
                onChange={(e) => onNlChange(e.target.value)}
                placeholder="e.g. every day at 9am"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="schedule-presets">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`schedule-preset${cron.trim() === p.cron ? " active" : ""}`}
                    onClick={() => applyPreset(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {nlError
                ? <p className="schedule-hint warn">{nlError}</p>
                : cronHuman
                  ? <p className="schedule-hint ok">Runs {cronHuman.charAt(0).toLowerCase() + cronHuman.slice(1)}.</p>
                  : <p className="schedule-hint warn">Not a valid schedule yet.</p>}
              <button
                type="button"
                className="schedule-advanced-toggle"
                onClick={() => setShowCronField((v) => !v)}
                aria-expanded={showCronField}
              >
                {showCronField ? "▾" : "▸"} Edit cron expression
              </button>
              {showCronField && (
                <input
                  id="automation-cron"
                  className="picker-search schedule-cron-input"
                  value={cron}
                  onChange={(e) => { setCron(e.target.value); setNlText(""); setNlError(""); }}
                  aria-label="Cron expression"
                  spellCheck={false}
                  required
                />
              )}
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-timezone">Timezone</label>
              <select id="automation-timezone" className="picker-search" value={timezone} onChange={(e) => setTimezone(e.target.value)} required>
                {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
          </> : (
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-once-at">Run at</label>
              <input id="automation-once-at" className="picker-search" type="datetime-local" min={toLocalInput(new Date())} value={onceAt} onChange={(e) => setOnceAt(e.target.value)} required />
              {onceAt && <p className="schedule-hint ok">Runs {new Date(onceAt).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"}).</p>}
            </div>
          )}
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-node-label">Machine label (optional)</label>
            <input id="automation-node-label" className="picker-search" value={nodeLabel} onChange={(e) => setNodeLabel(e.target.value)} placeholder="bivy/laptop" />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-runtime">Agent (optional)</label>
            <select id="automation-runtime" className="picker-search" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
              <option value="">Machine default</option>
              {state.runtimes.map((r) => (
                <option key={r.id} value={r.id}>{String(r.displayName || r.name || r.id)}</option>
              ))}
              {runtimeId && !state.runtimes.some((r) => r.id === runtimeId) && (
                <option value={runtimeId}>{runtimeId} (not installed here)</option>
              )}
            </select>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-model">Model (optional)</label>
            <select id="automation-model" className="picker-search" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Agent default</option>
              {state.models.map((m) => (
                <option key={String((m as { provider?: string }).provider || "") + ":" + m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
              {model && !state.models.some((m) => m.id === model) && (
                <option value={model}>{model}</option>
              )}
            </select>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-approvals">Approvals</label>
            <select id="automation-approvals" className="picker-search" value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as typeof approvalMode)}>
              <option value="autonomous">Autonomous (default; pauses only for high-risk actions)</option>
              <option value="risky">Ask before risky actions</option>
              <option value="always">Ask before every action</option>
              <option value="never">Never ask</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-sandbox">Sandbox</label>
            <select id="automation-sandbox" className="picker-search" value={sandbox} onChange={(e) => setSandbox(e.target.value as typeof sandbox)}>
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option value="danger-full-access">Full access</option>
            </select>
          </div>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create schedule"}</button>
        </form>
        {error && <p className="settings-error">{error}</p>}
      </section>
      <section className="settings-section">
        {items.map((item) => (
          <div className="settings-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <div className="settings-hint">
                {item.schedule.kind === "cron" ? `${item.schedule.expression} · ${item.schedule.timezone}` : item.schedule.at}
                {" · "}{item.nextRunAt ? `next ${new Date(item.nextRunAt).toLocaleString()}` : "no next run"}
              </div>
            </div>
            <div className="settings-actions">
              <button className="btn" onClick={() => void runNow(item)}>Run now</button>
              <button className="btn" onClick={() => void edit(item)}>Edit</button>
              <button className="btn" onClick={() => void toggle(item)}>{item.enabled ? "Disable" : "Enable"}</button>
            </div>
          </div>
        ))}
      </section>
      </div>
      <aside className="automations-aside">
        <section className="settings-section">
          <h3>Recent results</h3>
          {runs.filter((run) => run.definitionId).slice(0, 10).map((run) => (
            <div className="settings-row" key={run.id}>
              <span>{run.title}</span><span>{run.status} · {new Date(run.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}
