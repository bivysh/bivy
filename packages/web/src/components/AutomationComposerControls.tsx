// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/controller.js";
import { Sheet, PickerItem } from "./Sheet.js";
import { ChevronRightIcon } from "./UiIcons.js";

type Settings = {
  runtimeId: string;
  model: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode: "never" | "risky" | "always" | "autonomous";
  credentialLabels: Record<string, string>;
};
const sandboxes = [
  { id: "read-only", label: "Read only", hint: "Inspect files without changing them." },
  { id: "workspace-write", label: "Workspace write", hint: "Allow changes within the workspace." },
  { id: "danger-full-access", label: "Full access", hint: "Allow access beyond the workspace." },
] as const;
const approvals = [
  { id: "autonomous", label: "Autonomous", hint: "Runs unattended; pauses for high-risk actions." },
  { id: "risky", label: "Ask before risky actions", hint: "Keep a device available to approve risky actions." },
  { id: "always", label: "Ask before every action", hint: "Each action waits for your approval." },
  { id: "never", label: "Never ask", hint: "Runs without approval prompts. Review the sandbox carefully." },
] as const;

/** The composer's sheet/row vocabulary, with run-local values rather than session mutations. */
export function AutomationComposerControls({ state, value, onChange }: {
  state: AppState;
  value: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [picker, setPicker] = useState<"agent" | "model" | "protection" | null>(null);
  const [accountProvider, setAccountProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (picker === "model") controller.listCredentialRecords();
  }, [picker, state.connection.currentNodeId]);
  const close = () => { setPicker(null); setAccountProvider(null); setQuery(""); };
  const providerName = (id: string) => state.catalogs.providers.find(p => p.id === id)?.name || id;
  const records = state.settings.credentialRecords;
  const providers = [...new Set([...records.map(r => r.provider), ...Object.keys(value.credentialLabels)])].sort();
  const model = state.catalogs.models.find(m => m.id === value.model);
  const account = model?.provider ? value.credentialLabels[String(model.provider)] : undefined;
  const agentLabel = state.catalogs.runtimes.find(r => r.id === value.runtimeId)?.displayName || value.runtimeId || "Agent default";
  const modelLabel = model?.label || value.model || "Model default";
  const sandboxLabel = sandboxes.find(s => s.id === value.sandbox)!.label;
  const accountRecords = records.filter(r => r.provider === accountProvider);
  const selectedAccount = accountProvider ? value.credentialLabels[accountProvider] : undefined;
  const chooseAccount = (label: string) => {
    if (!accountProvider) return;
    const next = { ...value.credentialLabels };
    if (label) next[accountProvider] = label;
    else delete next[accountProvider];
    onChange({ credentialLabels: next });
    setAccountProvider(null);
  };

  return <>
    <div className="automation-composer-controls">
      <button type="button" className="btn sm ghost agent-pill" aria-haspopup="dialog" aria-label={`Agent: ${agentLabel}`} onClick={() => setPicker("agent")}>{agentLabel} ▾</button>
      <button type="button" className="btn sm ghost model-pill" aria-haspopup="dialog" aria-label={`Model and account: ${modelLabel}`} onClick={() => setPicker("model")}>{modelLabel}{account ? ` · ${account}` : ""} ▾</button>
      <button type="button" className="btn sm ghost sandbox-pill" aria-haspopup="dialog" aria-label={`Protection: ${sandboxLabel}`} onClick={() => setPicker("protection")}>{sandboxLabel} ▾</button>
    </div>
    {picker === "agent" && <Sheet title="Agent" ariaLabel="Agent" onClose={close} autoFocusSearch={false} size="large">
      {dismiss => <div className="picker-list">
        <PickerItem title="Machine default" active={!value.runtimeId} onClick={() => dismiss(() => onChange({ runtimeId: "" }))} />
        {state.catalogs.runtimes.map(runtime => <PickerItem key={runtime.id} title={String(runtime.displayName || runtime.name || runtime.id)} active={value.runtimeId === runtime.id} onClick={() => dismiss(() => onChange({ runtimeId: runtime.id }))} />)}
        {value.runtimeId && !state.catalogs.runtimes.some(r => r.id === value.runtimeId) && <PickerItem title={value.runtimeId} meta="Not installed on the connected machine" active />}
      </div>}
    </Sheet>}
    {picker === "model" && <Sheet title={accountProvider ? `${providerName(accountProvider)} accounts` : "Model"} ariaLabel={accountProvider ? "Model accounts" : "Model"} onClose={close} autoFocusSearch={false} size="large"
      headExtra={accountProvider ? <button type="button" className="sheet-back" onClick={() => setAccountProvider(null)} aria-label="Back to models">‹</button> : undefined}>
      {dismiss => accountProvider ? <>
        <p className="settings-hint">Choose an account for this automation. Other sessions are unaffected.</p>
        <div className="picker-list">
          <PickerItem title="Machine/project default" active={!selectedAccount} onClick={() => chooseAccount("")} />
          {accountRecords.map(record => <PickerItem key={record.label} title={record.label === "default" ? "Default account" : record.label} meta={record.kind} active={selectedAccount === record.label} onClick={() => chooseAccount(record.label)} />)}
          {selectedAccount && !accountRecords.some(r => r.label === selectedAccount) && <PickerItem title={selectedAccount} meta="Unavailable on the connected machine" active />}
        </div>
        {!accountRecords.length && <p className="settings-hint" role="status">No accounts loaded for this provider. Connect to the assigned machine to check availability.</p>}
      </> : <>
        <input className="picker-search" type="search" aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="picker-list">
          <PickerItem title="Agent default" active={!value.model} onClick={() => dismiss(() => onChange({ model: "" }))} />
          {state.catalogs.models.filter(m => `${m.id} ${m.label || ""} ${m.provider || ""}`.toLowerCase().includes(query.toLowerCase())).map(m => {
            const provider = String(m.provider || "");
            const configured = (m as { configured?: boolean }).configured !== false;
            return <PickerItem key={`${provider}:${m.id}`} title={m.label || m.id} active={value.model === m.id} disabled={!configured}
              meta={[providerName(provider), configured ? value.credentialLabels[provider] || "Machine/project default" : "Not connected"].filter(Boolean).join(" · ")}
              right={provider && <button type="button" className="btn ghost icon" aria-label={`Change account for ${m.label || m.id}`} onClick={() => setAccountProvider(provider)}><ChevronRightIcon /></button>}
              onClick={() => dismiss(() => onChange({ model: m.id }))} />;
          })}
          {!state.catalogs.models.length && <p className="picker-empty">No models loaded from the connected machine.</p>}
          {value.model && !state.catalogs.models.some(m => m.id === value.model) && <PickerItem title={value.model} meta="Not listed on the connected machine" active />}
        </div>
        {providers.length > 0 && <>
          <div className="picker-section-label">Provider accounts</div>
          <div className="picker-list">{providers.map(provider => <PickerItem key={provider} title={providerName(provider)} meta={value.credentialLabels[provider] || "Machine/project default"} onClick={() => setAccountProvider(provider)} right={<ChevronRightIcon />} />)}</div>
        </>}
      </>}
    </Sheet>}
    {picker === "protection" && <Sheet title="Protection" ariaLabel="Protection" onClose={close} autoFocusSearch={false} size="large">
      {dismiss => <>
        <div className="picker-section-label">Sandbox</div>
        <div className="picker-list">{sandboxes.map(option => <PickerItem key={option.id} title={option.label} meta={option.hint} active={value.sandbox === option.id} onClick={() => onChange({ sandbox: option.id })} />)}</div>
        <div className="picker-section-label">Approvals</div>
        <div className="picker-list">{approvals.map(option => <PickerItem key={option.id} title={option.label} meta={option.hint} active={value.approvalMode === option.id} onClick={() => onChange({ approvalMode: option.id })} />)}</div>
        <button type="button" className="btn" onClick={() => dismiss()}>Done</button>
      </>}
    </Sheet>}
  </>;
}
