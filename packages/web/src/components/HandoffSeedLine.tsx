// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useCallback, useState } from "react";
import type { HandoffSeed } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { ChevronRightIcon } from "./UiIcons.js";
import { controller } from "../store/useStore.js";

/** The source agent's display name when this node knows it, else what the seed says. */
function agentLabel(from: string): string {
  const runtime = controller.store.getState().catalogs.runtimes.find((r) => r.id === from);
  return String(runtime?.displayName || runtime?.name || from);
}

/**
 * The prompt that carried a conversation into an agent that couldn't import it
 * natively (see @bivy/core handoff-seed). It restates the transcript above for
 * the agent, so it reads as one muted line — the same shape as a work group —
 * that opens the exact text that was sent.
 */
export const HandoffSeedLine = memo(function HandoffSeedLine({ seed, text }: { seed: HandoffSeed; text: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = seed.kind === "fork" ? "Handed over" : "Imported";
  const summary = `Conversation context from ${agentLabel(seed.from)}`;
  return (
    <div className="tool-group">
      <button className="tool-group-line" onClick={() => setOpen(true)} aria-label={`${label}: ${summary}. Show what was sent`}>
        <span className="tool-group-label">{label}</span>
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-chevron"><ChevronRightIcon size={14} /></span>
      </button>
      {open && (
        <Sheet title="Context sent to the agent" onClose={close}>
          <div className="tool-detail-value output handoff-seed-text">{text}</div>
        </Sheet>
      )}
    </div>
  );
});
