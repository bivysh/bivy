// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { Badge } from "./Badge.js";
import { GlobeIcon } from "./UiIcons.js";

/** The session's previews, one tap from the composer: published apps, or a
 *  server running in the workspace that isn't previewed yet. Reviewer notes
 *  left since the owner last opened the Apps sheet show as a count. Renders
 *  nothing when the session has neither. */
export function AppsPill({ apps, serverPorts, newNotes, onOpen }: {
  apps: number;
  serverPorts: readonly number[];
  newNotes: number;
  onOpen: () => void;
}) {
  const label = apps > 0 ? `${apps} app${apps === 1 ? "" : "s"}`
    : serverPorts.length === 1 ? `Preview :${serverPorts[0]}`
    : serverPorts.length > 1 ? `${serverPorts.length} servers` : null;
  if (!label) return null;
  const notes = newNotes > 0 ? `${newNotes} new note${newNotes === 1 ? "" : "s"}` : null;
  return (
    <button type="button" className="run-pill apps-pill" onClick={onOpen} aria-label={["Open apps", label, notes].filter(Boolean).join(" · ")}>
      <GlobeIcon size={16} />
      <span className="run-pill-label">{label}</span>
      {notes && <Badge tone="unseen" variant="solid">{notes}</Badge>}
    </button>
  );
}
