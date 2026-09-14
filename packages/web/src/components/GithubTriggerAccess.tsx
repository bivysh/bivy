// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from "react";
import type { GithubAppInfo } from "@bivy/core";
import { controller } from "../store/controller.js";

export function GithubTriggerAccess({ info, onChanged }: { info: GithubAppInfo; onChanged?: () => void }) {
  const id = useId();
  const initial = info.apps.find((app) => app.triggerAccess)?.triggerAccess ?? info.triggerAccess ?? "everyone";
  const [access, setAccess] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setAccess(initial); }, [initial]);
  async function save(next: typeof access) {
    setSaving(true); setError(""); setSaved(false);
    try {
      setAccess(await controller.setGithubAppTriggerAccess(next));
      setSaved(true);
      onChanged?.();
    } catch (error) { setError(String((error as Error).message || error)); }
    finally { setSaving(false); }
  }
  return <div className="settings-field">
    <label className="field-label" htmlFor={id}>Who can trigger with a GitHub mention?</label>
    <select id={id} className="picker-search" value={access} disabled={saving} onChange={(event) => void save(event.target.value as typeof access)}>
      <option value="everyone">Anyone on GitHub</option>
      <option value="contributor">Contributors and collaborators</option>
      <option value="collaborator">Collaborators with write access</option>
    </select>
    <p className="settings-hint">Applies to every GitHub App on your Bivy account, not just this automation. Changes save immediately. Label events already require permission to apply labels on GitHub.</p>
    {saving && <p className="settings-hint" role="status">Saving permissions…</p>}
    {saved && !saving && <p className="settings-hint" role="status">Permissions saved.</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}
