// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import type { SessionDotState } from "../sessionStatus.js";

export type StatusDotState = SessionDotState | "online";

/** Canonical compact status signal. Supply `label` when visible neighboring
 * text does not already spell out the state. */
export function StatusDot({ status, label }: { status: StatusDotState; label?: string }) {
  return (
    <>
      <span className="status-dot" data-status={status} aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}
