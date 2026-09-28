import { useEffect, useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";

const encoder = new TextEncoder();

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * Settings → Agent instructions: the account-wide AGENTS.md every agent session
 * receives on top of the workspace's own. Stored on the connected machine and
 * synced (end-to-end encrypted) to the account's other machines, so the edit
 * goes through whichever machine is connected.
 */
export function AgentInstructionsPanel({ state }: { state: AppState }) {
  const nodeOnline = state.connection.status === "online";
  const remote = nodeOnline ? state.settings.nodeSettings?.agentInstructions : undefined;
  const supported = !nodeOnline || !state.settings.nodeSettings || Boolean(remote);

  const [draft, setDraft] = useState("");
  // The version the draft was loaded from; the node refuses a save based on an
  // older version so an edit from another device isn't silently overwritten.
  const [base, setBase] = useState<number | null>(null);
  const [baseText, setBaseText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const currentNodeId = controller.local.cur;
  useEffect(() => {
    if (nodeOnline) controller.getNodeSettings();
  }, [nodeOnline, currentNodeId]);

  const dirty = base !== null && draft !== baseText;
  const stale = Boolean(remote && base !== null && remote.updatedAt !== base && remote.text !== draft);

  // Rebase the draft onto the newer copy so saving it replaces that copy.
  const keepMine = () => {
    if (!remote) return;
    setBase(remote.updatedAt);
    setBaseText(remote.text);
    setError(null);
  };
  const load = () => {
    if (!remote) return;
    setDraft(remote.text);
    setBase(remote.updatedAt);
    setBaseText(remote.text);
    setError(null);
  };
  // Seed on first arrival, then follow the node's copy whenever nothing unsaved
  // would be lost — including the echo of our own save.
  useEffect(() => {
    if (remote && (base === null || !dirty || remote.text === draft)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.updatedAt, remote?.text]);

  if (!nodeOnline) {
    return (
      <div className="settings-form">
        <div className="vault-empty">
          <h4>No machine connected</h4>
          <p className="muted small">Agent instructions are saved through one of your machines. Connect to a machine to edit them.</p>
        </div>
      </div>
    );
  }
  if (!supported) {
    return (
      <div className="settings-form">
        <div className="vault-empty">
          <h4>Update this machine</h4>
          <p className="muted small">This machine's version of Bivy doesn't support agent instructions yet. Update it, or connect to another machine.</p>
        </div>
      </div>
    );
  }
  if (!remote || base === null) {
    return <div className="settings-form"><p className="muted">Loading instructions…</p></div>;
  }

  const bytes = encoder.encode(draft).length;
  const over = bytes > remote.maxBytes;

  const save = async () => {
    if (saving || over || !dirty || stale) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await controller.setNodeSettings({ agentInstructions: draft, agentInstructionsBaseUpdatedAt: base });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-form">
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {stale && (
        <div className="banner inline" data-tone="warn" role="status">
          <span className="banner-text">These instructions were changed on another device. Load that version, or keep your edit and save over it.</span>
          <span className="banner-actions">
            <button type="button" className="btn sm" onClick={load}>Load latest</button>
            <button type="button" className="btn sm ghost" onClick={keepMine}>Keep mine</button>
          </span>
        </div>
      )}
      <section className="settings-section">
        <p className="muted small">
          Every agent session on all your machines gets these, in addition to the repository's own AGENTS.md or CLAUDE.md. Where they
          conflict, the repository wins. Changes apply to new sessions.
        </p>
        <label className="field-label" htmlFor="agent-instructions">Instructions (Markdown)</label>
        <textarea
          id="agent-instructions"
          className="picker-search"
          rows={16}
          value={draft}
          placeholder={"How you like agents to work, e.g.\n- Prefer small, focused commits.\n- Run the tests before saying you're done."}
          aria-describedby="agent-instructions-size"
          aria-invalid={over || undefined}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
        />
        <p id="agent-instructions-size" className={over ? "settings-error" : "muted small"}>
          {formatSize(bytes)} of {formatSize(remote.maxBytes)}{over ? " — shorten the instructions to save them." : ""}
        </p>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={save} disabled={saving || over || !dirty || stale}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
          {dirty && <button type="button" className="btn" onClick={load} disabled={saving}>Revert</button>}
        </div>
      </section>
      <details className="settings-section settings-disclosure">
        <summary className="settings-disclosure-summary">How agents receive them</summary>
        <div className="settings-disclosure-body">
          <p className="muted small">
            Claude Code, Codex, Pi and OpenCode get them as part of their system instructions. Other agents get them through Bivy's
            MCP server where it is available, which each agent may weigh differently. They're synced to your other machines end-to-end
            encrypted, and stored on each machine as <code>AGENTS.md</code> in Bivy's data directory.
          </p>
        </div>
      </details>
    </div>
  );
}
