// SPDX-License-Identifier: FSL-1.1-ALv2
import { useCallback, useEffect, useState } from "react";
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
  type AppState,
  type AccountAutomation,
  type AccountAutomationRun,
} from "@bivy/core";
import { controller } from "../store/controller.js";

const TEMPLATE_PREFIX = "bivy-room-v1";

export function AutomationsPanel({ state }: { state: AppState }) {
  const [items, setItems] = useState<AccountAutomation[]>([]);
  const [runs, setRuns] = useState<AccountAutomationRun[]>([]);
  const [name, setName] = useState("");
  const [ciphertext, setCiphertext] = useState("");
  const [cron, setCron] = useState("0 9 * * 1");
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [onceAt, setOnceAt] = useState("");
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const nodeId = state.currentNodeId || controller.local.cur;
      const roomKey = nodeId ? controller.local.keys()[nodeId] : undefined;
      if (!nodeId || !roomKey) throw new Error("Connect to the assigned node before saving encrypted instructions.");
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
        setError("This device does not hold the assigned node's encryption key.");
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
    } else {
      const at = new Date(item.schedule.at);
      setOnceAt(new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    }
  }

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3>Scheduled automations</h3>
        <p className="settings-hint">
          Instructions are encrypted for the assigned node before upload. The hosted control plane never receives
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
              <option value="cron">Recurring cron</option>
              <option value="once">One time</option>
            </select>
          </div>
          {kind === "cron" ? <>
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-cron">Cron expression</label>
              <input id="automation-cron" className="picker-search" value={cron} onChange={(e) => setCron(e.target.value)} required />
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-timezone">Timezone</label>
              <input id="automation-timezone" className="picker-search" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
            </div>
          </> : (
            <div className="settings-field">
              <label className="field-label" htmlFor="automation-once-at">Run at</label>
              <input id="automation-once-at" className="picker-search" type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} required />
            </div>
          )}
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-node-label">Node label (optional)</label>
            <input id="automation-node-label" className="picker-search" value={nodeLabel} onChange={(e) => setNodeLabel(e.target.value)} placeholder="bivy/laptop" />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-runtime">Runtime (optional)</label>
            <input id="automation-runtime" className="picker-search" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="automation-model">Model (optional)</label>
            <input id="automation-model" className="picker-search" value={model} onChange={(e) => setModel(e.target.value)} />
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
      <section className="settings-section">
        <h3>Recent results</h3>
        {runs.filter((run) => run.definitionId).slice(0, 10).map((run) => (
          <div className="settings-row" key={run.id}>
            <span>{run.title}</span><span>{run.status} · {new Date(run.createdAt).toLocaleString()}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
