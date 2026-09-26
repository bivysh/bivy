// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Device handoff: an unsent draft another device left on a session. Pure, so
// the rules are testable without a browser. Who drove last isn't a handoff:
// any device can send at any time, so there's nothing to "continue".
import type { DeviceRef, SessionPresence } from "@bivy/core";

/** Another device's activity counts as "just now" for this long. */
export const HANDOFF_RECENT_MS = 30 * 60 * 1000;

export type Handoff = { from: string; text: string; at: number };

/** The draft to offer on this device, if any: another device's unsent draft,
 *  but only while this composer is empty, so nothing typed here is replaced. */
export function handoffFor(presence: SessionPresence | undefined, me: DeviceRef, composerEmpty: boolean, now: number): Handoff | undefined {
  const draft = presence?.draft;
  if (draft && draft.device.id !== me.id && composerEmpty && now - draft.at < HANDOFF_RECENT_MS) {
    return { from: draft.device.label, text: draft.text, at: draft.at };
  }
  return undefined;
}
