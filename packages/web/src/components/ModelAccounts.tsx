// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import type { AppState, ModelInfo } from "@bivy/core";
import { controller } from "../store/controller.js";
import { modelAccountChoice, modelAccountProject } from "../modelAccounts.js";
import { Sheet, PickerItem } from "./Sheet.js";

/** The model picker's nested account view; routing is shared with the vault. */
export function ModelAccounts({ state, model, onClose }: { state: AppState; model: ModelInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const provider = String(model.provider || "");
  const records = state.settings.credentialRecords.filter((r) => r.provider === provider);
  const presets = state.settings.credentialPresets;
  const project = modelAccountProject(state);
  const choice = modelAccountChoice(provider, records, presets, project);
  const name = state.catalogs.providers.find((p) => p.id === provider)?.name || provider;
  const title = `${model.label || model.id} account`;

  return <Sheet title={<><button type="button" className="btn ghost icon" onClick={onClose} aria-label="Back to models">‹</button> {title}</>}
    ariaLabel={title} onClose={onClose} size="large" autoFocusSearch={false}>
    <div className="picker-list">
      <div className="settings-form">
        <p className="settings-hint">{project
          ? `Applies to all ${name} models in ${project} on this machine.`
          : `Applies to all ${name} models using this machine’s active credential preset, including other sessions.`}</p>
        {busy && <p className="muted" role="status">Switching account…</p>}
        {!presets && <p className="muted" role="status">Loading accounts…</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      {records.length === 0 && <div className="picker-empty">No saved accounts available on this machine.</div>}
      {records.map((record) => <PickerItem
        key={record.label}
        title={<>{record.label}{choice.label === record.label && <span className="sr-only"> (selected)</span>}</>}
        meta={record.kind === "oauth" ? "Subscription sign-in" : record.kind === "reference" ? "Password-manager reference" : "API key"}
        active={choice.label === record.label}
        disabled={busy || !presets || state.connection.status !== "online"}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await controller.setPresetMapping(choice.preset, provider, record.label);
            controller.listModels();
            if (mounted.current) onClose();
          } catch (err) {
            if (mounted.current) setError(err instanceof Error ? err.message : String(err));
          } finally {
            if (mounted.current) setBusy(false);
          }
        }}
      />)}
    </div>
  </Sheet>;
}
