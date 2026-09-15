// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { ModelInfo, SessionLaunchProgress } from "@bivy/core";
import { Sheet, PickerItem } from "./Sheet.js";

/** Destination-scoped model selection; never reads the previous node's catalog. */
export function LaunchModelChoice({ choice, onChoose, onRefresh, onSetupCredentials }: {
  choice: NonNullable<SessionLaunchProgress["modelChoice"]>;
  onChoose?: (model: ModelInfo) => Promise<void>;
  onRefresh?: () => void;
  onSetupCredentials?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const models = choice.models.filter(model => `${model.label ?? model.id} ${model.provider}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <p>Your prompt is saved. Choose a model on this machine to send it. No message has been sent yet.</p>
    {choice.error && <p role="alert">{choice.error}</p>}
    <button type="button" className="btn primary session-launch-action" disabled={choice.loading || choice.selecting || !onChoose} onClick={() => setOpen(true)}>
      {choice.loading ? "Loading models…" : choice.selecting ? "Selecting model…" : "Choose model and send"}
    </button>
    {open && <Sheet title="Choose a model" onClose={() => setOpen(false)} size="large" autoFocusSearch={false}>
      <p>Selecting a model sends your saved first message.</p>
      <input className="picker-search" aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="picker-list">
        {models.map(model => <PickerItem
          key={`${model.provider}:${model.id}`} title={model.label || model.id}
          meta={`${model.provider}${choice.current?.id === model.id && choice.current.provider === model.provider ? " · Default on this machine" : ""}`}
          onClick={() => { setOpen(false); void onChoose?.(model); }}
        />)}
        {!!choice.models.length && !models.length && <p className="picker-empty">No models match your search.</p>}
        {!choice.models.length && <p className="picker-empty">{choice.error || "No connected models are available. Set up model credentials, then refresh."}</p>}
      </div>
      <button type="button" className="btn ghost" onClick={onRefresh}>Refresh models</button>
      {!choice.models.length && !choice.error && onSetupCredentials && <button type="button" className="btn ghost" onClick={() => { void onSetupCredentials(); }}>Set up model credentials</button>}
    </Sheet>}
  </>;
}
