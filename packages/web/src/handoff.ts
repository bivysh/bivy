// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Device handoff: what the next device should say about a session another
// device was just driving. Pure, so the rules are testable without a browser.
import type { DeviceRef, SessionPresence } from "@bivy/core";

/** Another device's activity counts as "just now" for this long. */
export const HANDOFF_RECENT_MS = 30 * 60 * 1000;

export type Handoff =
  | { kind: "draft"; from: string; text: string; at: number }
  | { kind: "driver"; from: string; via: "chat" | "terminal"; at: number };

/** The handoff to offer on this device, if any. An unsent draft from another
 *  device wins, but only while this composer is empty, so nothing typed here is
 *  ever replaced. Otherwise, name the device that drove the session recently. */
export function handoffFor(presence: SessionPresence | undefined, me: DeviceRef, composerEmpty: boolean, now: number): Handoff | undefined {
  const draft = presence?.draft;
  if (draft && draft.device.id !== me.id && composerEmpty && now - draft.at < HANDOFF_RECENT_MS) {
    return { kind: "draft", from: draft.device.label, text: draft.text, at: draft.at };
  }
  const driver = presence?.driver;
  if (driver && driver.id !== me.id && now - driver.at < HANDOFF_RECENT_MS) {
    return { kind: "driver", from: driver.label, via: driver.via, at: driver.at };
  }
  return undefined;
}
