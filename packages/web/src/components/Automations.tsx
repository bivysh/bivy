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
  const [approvalMode, setApprovalMode] = useState<"ask" | "autonomous" | "never">("autonomous");
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
    setApprovalMode(item.approvalMode || "autonomous");
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
          <label className="field-label">Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="field-label">Instructions<textarea value={ciphertext} onChange={(e) => setCiphertext(e.target.value)} required rows={4} /></label>
          <label className="field-label">Schedule<select value={kind} onChange={(e) => setKind(e.target.value as "cron" | "once")}><option value="cron">Recurring cron</option><option value="once">One time</option></select></label>
          {kind === "cron" ? <>
            <label className="field-label">Cron expression<input value={cron} onChange={(e) => setCron(e.target.value)} required /></label>
            <label className="field-label">Timezone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} required /></label>
          </> : <label className="field-label">Run at<input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} required /></label>}
          <label className="field-label">Node label (optional)<input value={nodeLabel} onChange={(e) => setNodeLabel(e.target.value)} placeholder="bivy/laptop" /></label>
          <label className="field-label">Runtime (optional)<input value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)} /></label>
          <label className="field-label">Model (optional)<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
          <label className="field-label">Approvals<select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as typeof approvalMode)}><option value="ask">Ask</option><option value="autonomous">Autonomous</option><option value="never">Never ask</option></select></label>
          <label className="field-label">Sandbox<select value={sandbox} onChange={(e) => setSandbox(e.target.value as typeof sandbox)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></label>
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
