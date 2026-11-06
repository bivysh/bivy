// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";

const encoder = new TextEncoder();
const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`);

/**
 * Settings → Team → Team instructions: what every agent session on every
 * member's machines gets, ahead of each person's own instructions. Encrypted
 * on the connected machine and opened by members' machines, so it reads and
 * saves through whichever machine is connected.
 */
export function TeamInstructions({ state }: { state: AppState }) {
  const online = state.connection.status === "online";
  const settings = online ? state.settings.nodeSettings : undefined;
  const team = settings?.teamInstructions;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const nodeId = controller.local.cur;
  useEffect(() => { if (online) controller.getNodeSettings(); }, [online, nodeId]);
  // Follow the machine's copy until the person starts editing.
  useEffect(() => { if (draft === null || draft === team?.text) setDraft(team?.text ?? ""); }, [team?.generation, team?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const heading = <h4 className="settings-subhead">Team instructions</h4>;
  const note = (text: string) => <section className="settings-section">{heading}<p className="muted small">{text}</p></section>;
  if (!online) return note("Team instructions are read and saved through one of your machines. Connect to a machine to see them.");
  if (!settings) return note("Loading…");
  if (!team) return note("This machine's version of Bivy doesn't support team instructions yet. Update it, or connect to another machine.");
  if (team.state === "none") return note("This machine hasn't picked up the team yet. It checks every minute.");
  if (team.state === "waiting-for-key") {
    return note("The team has instructions this machine can't open yet. Another member's machine shares the team key automatically the next time one is online.");
  }

  const text = draft ?? team.text ?? "";
  const bytes = encoder.encode(text).length;
  const over = bytes > team.maxBytes;
  const dirty = text !== (team.text ?? "");

  const save = async () => {
    if (saving || over || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await controller.setNodeSettings({ teamInstructions: text, teamInstructionsBaseGeneration: team.generation ?? 0 });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      {heading}
      <p className="muted small">
        Every agent session on every member's machines gets these, ahead of each person's own instructions and the repository's,
        which win where they conflict. They're end-to-end encrypted: Bivy's servers can't read them.
      </p>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {team.canEdit ? (
        <>
          <label className="field-label" htmlFor="team-instructions">Instructions (Markdown)</label>
          <textarea
            id="team-instructions"
            className="picker-search"
            rows={10}
            value={text}
            placeholder={"How your team's agents should work, e.g.\n- Use pnpm, never npm.\n- Open pull requests as drafts."}
            aria-describedby="team-instructions-size"
            aria-invalid={over || undefined}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          />
          <p id="team-instructions-size" className={over ? "settings-error" : "muted small"}>
            {formatSize(bytes)} of {formatSize(team.maxBytes)}{over ? " — shorten them to save." : ""}
          </p>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={save} disabled={saving || over || !dirty}>
              {saving ? "Saving…" : saved ? "Saved" : "Save"}
            </button>
            {dirty && <button type="button" className="btn" onClick={() => setDraft(team.text ?? "")} disabled={saving}>Revert</button>}
          </div>
        </>
      ) : team.text?.trim() ? (
        <pre className="code-snippet agent-note-text">{team.text}</pre>
      ) : (
        <p className="muted small">Your team has no shared instructions yet. An admin can add them here.</p>
      )}
    </section>
  );
}
