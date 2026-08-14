// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Config gate + noise guard for PASSIVELY surfacing tool-produced images (e.g. a
// screenshot MCP tool's output riding home on a tool_result) into the chat as
// attachments — see issue #292. Today a runtime adapter that notices an image
// inside a tool_result (e.g. src/runtime/claude-code.ts's toolResultText, which
// deliberately keeps only the text parts) can route the image through here to
// decide whether it's allowed at all, and if so, whether this turn's budget has
// room for it.
//
// Kept independent of both src/runtime and src/session/server so nothing new
// crosses that layering: a runtime adapter only needs the pure functions below;
// src/server.ts wires the config setter to settings.json/env — mirroring
// src/harness/sandbox.ts's live-config pattern — and owns the actual
// store+persist+broadcast (see handlePassiveToolImage in src/server.ts), the
// same way it already does for an explicit `bivy attach`.

// ---- Opt-in gate ---------------------------------------------------------
//
// Off by default: an image silently appearing in the chat with no explicit
// attach call is new, surprising behavior, and a badly-behaved tool could turn
// it into transcript noise (the per-turn budget below bounds that too, but the
// gate is the first line of defense — no existing installation should see any
// change unless it opts in).

let configuredEnabled: boolean | undefined;

/** Set from settings.json at boot and whenever node settings change (mirrors
 *  setConfiguredSandboxTier in src/harness/sandbox.ts). */
export function setConfiguredAutoAttachToolImages(value: unknown): void {
  configuredEnabled = value === true;
}

/** Whether a tool_result image should be captured as a passive attachment.
 *  Precedence: `BIVY_AUTO_ATTACH_TOOL_IMAGES` env (plain truthiness — any
 *  non-empty value enables, matching BIVY_MCP_PROXY's convention) > the node's
 *  persisted `settings.json` setting > off. */
export function autoAttachToolImagesEnabled(): boolean {
  if (process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES) return true;
  return configuredEnabled === true;
}

// ---- Per-turn noise guard -------------------------------------------------
//
// A chatty tool (one that screenshots after every step, say) must never be
// able to flood the transcript just because the feature is on. Both caps are
// deliberately small relative to the explicit-attach ceiling
// (MAX_AGENT_ATTACHMENT_BYTES in src/session/attach-to-chat.ts) — passive
// images are unreviewed by a human before they land in the chat.

/** Max images passively surfaced from a single turn's tool results. */
export const MAX_PASSIVE_IMAGES_PER_TURN = 4;

/** Max total decoded bytes passively surfaced from a single turn. */
export const MAX_PASSIVE_IMAGE_BYTES_PER_TURN = 12 * 1024 * 1024;

/**
 * Tracks how much of one turn's passive-image budget has been spent so a
 * runtime can decide, per image, whether to surface it or drop it. Reset at
 * the start of every turn (a fresh instance is the simplest reset).
 */
export class PassiveImageBudget {
  private count = 0;
  private bytes = 0;
  private droppedCount = 0;
  private droppedBytes = 0;

  /** Reserves the budget and returns true if `byteLength` fits under both caps;
   *  otherwise records the drop (for droppedSummary) and returns false. */
  admit(byteLength: number): boolean {
    if (this.count >= MAX_PASSIVE_IMAGES_PER_TURN || this.bytes + byteLength > MAX_PASSIVE_IMAGE_BYTES_PER_TURN) {
      this.droppedCount += 1;
      this.droppedBytes += byteLength;
      return false;
    }
    this.count += 1;
    this.bytes += byteLength;
    return true;
  }

  /** True once anything has been dropped this turn (for logging at the call site). */
  get hasDropped(): boolean {
    return this.droppedCount > 0;
  }

  /** Human-readable summary of what this turn dropped, or "" if nothing was. */
  droppedSummary(): string {
    if (!this.droppedCount) return "";
    return `dropped ${this.droppedCount} tool-produced image(s) totaling ${this.droppedBytes} bytes (per-turn cap: ${MAX_PASSIVE_IMAGES_PER_TURN} images / ${MAX_PASSIVE_IMAGE_BYTES_PER_TURN} bytes)`;
  }
}
