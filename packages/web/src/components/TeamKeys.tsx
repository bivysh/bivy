// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * Settings → Team → Team keys: API keys every agent on members' machines can
 * use by name (`bivy secrets exec --env NAME`). They travel in the team vault,
 * end-to-end encrypted, and nobody sees a value again after saving it. A
 * member's own key of the same name wins.
 */
export function TeamKeys({ state }: { state: AppState }) {
  const team = state.connection.status === "online" ? state.settings.nodeSettings?.teamInstructions : undefined;
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Instructions explain why this is unavailable; keys say nothing extra.
  if (!team || team.state !== "ready" || !team.keys) return null;

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await controller.setNodeSettings({ ...patch, teamInstructionsBaseGeneration: team.generation ?? 0 });
      return true;
    } catch (e) {
      setError(String((e as Error)?.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const validName = NAME.test(name.trim());
  const exists = team.keys.some((k) => k.name === name.trim());

  return (
    <section className="settings-section">
      <h4 className="settings-subhead">Team keys</h4>
      <p className="muted small">
        API keys every agent on your team's machines can use by name, with <code>bivy secrets exec --env NAME</code>. They're
        end-to-end encrypted, and nobody can see a value after it's saved. Someone's own key with the same name wins on their machines.
      </p>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      <div className="picker-list">
        {team.keys.length === 0 && <div className="picker-empty">No team keys yet.</div>}
        {team.keys.map((key) => (
          <PickerItem
            key={key.name}
            title={<code>{key.name}</code>}
            meta={`Updated ${formatDate(key.updatedAt)}`}
            right={team.canEdit ? (
              <button type="button" className="btn sm danger-ghost" disabled={busy} onClick={() => setRemoving(key.name)}>Remove</button>
            ) : undefined}
          />
        ))}
      </div>
      {team.canEdit && (
        <form className="field-row" onSubmit={(e) => {
          e.preventDefault();
          if (!validName || !value) return;
          void save({ teamKeySet: { name: name.trim(), value } }).then((ok) => { if (ok) { setName(""); setValue(""); } });
        }}>
          <input className="field" value={name} placeholder="NAME" aria-label="Key name" autoComplete="off" spellCheck={false}
            aria-invalid={Boolean(name) && !validName || undefined} onChange={(e) => setName(e.target.value)} />
          <input className="field" type="password" value={value} placeholder="Value" aria-label="Key value" autoComplete="new-password"
            onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn primary" disabled={busy || !validName || !value}>{exists ? "Replace" : "Add"}</button>
        </form>
      )}
      {team.canEdit && Boolean(name) && !validName && (
        <p className="settings-error">A name is a letter followed by letters, digits or underscores, like STRIPE_API_KEY.</p>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing}?`}
          message="Agents on your team's machines stop getting this key within a minute."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => { const name = removing; setRemoving(null); void save({ teamKeyRemove: name }); }}
        />
      )}
    </section>
  );
}
