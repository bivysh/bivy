// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// How this browser names itself to the node for the device handoff ("Last on
// iPhone · 2m ago"). A stable random id per browser profile, plus a short label
// read from the platform. Presentation only; every linked device is already
// trusted by the room key.

import type { DeviceRef } from "@bivy/core";

const ID_KEY = "bivy.device.id";

// First match wins, so more specific platforms come before generic ones.
const PLATFORM_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android.*Mobile/, "Android phone"],
  [/Android/, "Android tablet"],
  [/CrOS/, "Chromebook"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Windows/, "Windows PC"],
  [/Linux/, "Linux"],
];

/** A short device label from a user-agent string. iPadOS reports itself as a
 *  Mac, so a Mac with a touch screen counts as an iPad. */
export function deviceLabel(userAgent: string, touchPoints = 0): string {
  const label = PLATFORM_LABELS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Browser";
  return label === "Mac" && touchPoints > 1 ? "iPad" : label;
}

let cached: DeviceRef | undefined;

export function thisDevice(): DeviceRef {
  if (cached) return cached;
  let id = "";
  try { id = localStorage.getItem(ID_KEY) ?? ""; } catch { /* storage blocked */ }
  if (!id) {
    id = `web:${crypto.randomUUID()}`;
    try { localStorage.setItem(ID_KEY, id); } catch { /* one id per page load then */ }
  }
  cached = { id, label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints) };
  return cached;
}
