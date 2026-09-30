// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useCallback, useState } from "react";
import type { HandoffSeed } from "@bivy/core";
import { Sheet } from "./Sheet.js";
import { ChevronRightIcon } from "./UiIcons.js";
import { controller, useAppState } from "../store/useStore.js";

/** The source agent's display name when this node knows it, else what the seed says. */
function agentLabel(from: string): string {
  const runtime = controller.store.getState().catalogs.runtimes.find((r) => r.id === from);
  return String(runtime?.displayName || runtime?.name || from);
}

/** The session the open one was forked from, while it still exists to open. */
function useForkSource(): { sessionId: string; name: string; nodeId?: string } | undefined {
  const { activeSession: { activeSessionId }, sessionIndex: { sessions } } = useAppState();
  const forkedFrom = sessions.find((s) => s.sessionId === activeSessionId)?.forkedFrom;
  const source = forkedFrom ? sessions.find((s) => s.sessionId === forkedFrom) : undefined;
  if (!source) return undefined;
  return { sessionId: source.sessionId, name: source.name || `Session ${source.sessionId.slice(0, 8)}`, nodeId: source.nodeId };
}

/**
 * The prompt that carried a conversation into an agent that couldn't import it
 * natively (see @bivy/core handoff-seed). It restates the transcript above for
 * the agent, so it reads as one muted line — the same shape as a work group —
 * that opens the exact text that was sent, and links back to the session the
 * conversation came from.
 */
export const HandoffSeedLine = memo(function HandoffSeedLine({ seed, text }: { seed: HandoffSeed; text: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const source = useForkSource();
  const label = seed.kind === "fork" ? "Handed over" : "Imported";
  const summary = `from ${agentLabel(seed.from)}`;
  const showSent = `${label} ${summary}. Show what was sent`;
  return (
    <div className="tool-group handoff-line">
      <button className="tool-group-line" onClick={() => setOpen(true)} aria-label={showSent}>
        <span className="tool-group-label">{label}</span>
        <span className="tool-group-summary">{summary}</span>
      </button>
      {seed.kind === "fork" && source && (
        <button
          type="button"
          className="handoff-source"
          onClick={() => controller.openSessionOnNode(source.sessionId, undefined, source.nodeId)}
          aria-label={`Open the original session: ${source.name}`}
        >
          {source.name}
        </button>
      )}
      <button className="tool-group-line handoff-open" onClick={() => setOpen(true)} tabIndex={-1} aria-hidden="true">
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
