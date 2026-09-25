// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from "react";
import type { WebhookFilterDraft } from "./webhookFilterDraft.js";

/** Optional trusted script that accepts or skips each delivery before an agent starts. */
export function WebhookFilterFields({ value, error, onChange }: {
  value: WebhookFilterDraft;
  error?: string;
  onChange: (value: WebhookFilterDraft) => void;
}) {
  const id = useId();
  const set = <K extends keyof WebhookFilterDraft>(key: K, next: WebhookFilterDraft[K]) => onChange({ ...value, [key]: next });
  return <>
    <label className="settings-toggle-row webhook-signing-toggle">
      <span className="settings-toggle-text">
        <strong className="settings-toggle-title">Filter deliveries with a script</strong>
        <small className="muted">Run a script on the machine first. It decides whether each delivery starts the agent.</small>
      </span>
      <input className="sr-only" type="checkbox" checked={value.enabled} onChange={(event) => set("enabled", event.target.checked)} />
      <span className={`settings-toggle${value.enabled ? " on" : ""}`} aria-hidden="true"><span className="settings-toggle-knob" /></span>
    </label>
    {value.enabled && <>
      <div className="settings-field">
        <label className="field-label" htmlFor={`${id}-command`}>Command</label>
        <input id={`${id}-command`} className="picker-search" value={value.command} placeholder="node filter.mjs"
          autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => set("command", event.target.value)} />
        <p className="settings-hint">Runs directly, without a shell. Quote arguments that contain spaces. The script receives <code>{"{\"event\":{\"payload\":…}}"}</code> on stdin and must print <code>{"{\"decision\":\"accept\"}"}</code> or <code>{"{\"decision\":\"skip\",\"reason\":\"…\"}"}</code>.</p>
      </div>
      <div className="settings-field">
        <label className="field-label" htmlFor={`${id}-cwd`}>Directory on the machine</label>
        <input id={`${id}-cwd`} className="picker-search" value={value.cwd} placeholder="/srv/bivy/trusted-filters"
          autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => set("cwd", event.target.value)} />
        <p className="settings-hint">Absolute path to scripts you put there yourself. Do not use a repository the agent can edit: the script runs as the Bivy user and is not sandboxed.</p>
      </div>
      <div className="settings-field">
        <label className="field-label" htmlFor={`${id}-timeout`}>Timeout (seconds)</label>
        <input id={`${id}-timeout`} className="picker-search" type="number" inputMode="numeric" min={1} max={60} step={1}
          value={value.timeoutSeconds} onChange={(event) => set("timeoutSeconds", event.target.value)} />
        <p className="settings-hint">A skip completes the run without starting the agent. A script error, invalid output, or timeout marks the run as needing attention.</p>
      </div>
      {error && <p className="schedule-hint warn">{error}</p>}
    </>}
  </>;
}
