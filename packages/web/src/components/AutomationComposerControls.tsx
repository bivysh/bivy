// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { Sheet, PickerItem } from "./Sheet.js";
import { AutomationAccounts } from "./AutomationAccounts.js";

type Settings = {
  runtimeId: string;
  model: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode: "never" | "risky" | "always" | "autonomous";
  credentialLabels: Record<string, string>;
};
type Choice = { id: string; label: string };
const sandboxes: Choice[] = [
  { id: "read-only", label: "Read only" },
  { id: "workspace-write", label: "Workspace write" },
  { id: "danger-full-access", label: "Full access" },
];
const approvals: Choice[] = [
  { id: "autonomous", label: "Autonomous" },
  { id: "risky", label: "Ask before risky actions" },
  { id: "always", label: "Ask before every action" },
  { id: "never", label: "Never ask" },
];

/** Draft-local pickers: never mutate the regular session composer's settings. */
export function AutomationComposerControls({ state, value, onChange }: {
  state: AppState;
  value: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [picker, setPicker] = useState<keyof Settings | null>(null);
  const fields: { key: Exclude<keyof Settings, "credentialLabels">; title: string; options: Choice[] }[] = [
    { key: "runtimeId", title: "Agent", options: [{ id: "", label: "Machine default" }, ...state.catalogs.runtimes.map(r => ({ id: r.id, label: String(r.displayName || r.name || r.id) }))] },
    { key: "model", title: "Model", options: [{ id: "", label: "Agent default" }, ...Array.from(new Map(state.catalogs.models.map(m => [m.id, { id: m.id, label: m.label || m.id }])).values())] },
    { key: "sandbox", title: "Sandbox", options: sandboxes },
    { key: "approvalMode", title: "Approvals", options: approvals },
  ];
  const active = fields.find(field => field.key === picker);
  return <>
    <div className="automation-composer-controls">
      {fields.map(field => <button key={field.key} type="button" className="btn sm ghost" aria-haspopup="dialog"
        aria-label={`${field.title}: ${field.options.find(o => o.id === value[field.key])?.label || value[field.key]}`}
        onClick={() => setPicker(field.key)}>
        {field.options.find(o => o.id === value[field.key])?.label || value[field.key]} ▾
      </button>)}
      <button type="button" className="btn sm ghost" aria-haspopup="dialog" onClick={() => setPicker("credentialLabels")}>Accounts ▾</button>
    </div>
    {active && <Sheet title={active.title} onClose={() => setPicker(null)} autoFocusSearch={false}>
      <div className="picker-list">
        {active.options.map(option => <PickerItem key={option.id} title={option.label} active={value[active.key] === option.id}
          onClick={() => { onChange({ [active.key]: option.id }); setPicker(null); }} />)}
      </div>
      {active.key === "approvalMode" && <p className="settings-hint">Runs pause when approval is required. Keep a device available to respond. Never ask disables approval prompts.</p>}
      {active.key === "sandbox" && <p className="settings-hint">Full access allows actions beyond the workspace. Review approvals before enabling.</p>}
    </Sheet>}
    {picker === "credentialLabels" && <Sheet title="Accounts" onClose={() => setPicker(null)} autoFocusSearch={false}>
      <AutomationAccounts state={state} value={value.credentialLabels} onChange={credentialLabels => onChange({ credentialLabels })} />
    </Sheet>}
  </>;
}
