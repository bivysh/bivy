// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { inflateSync } from "node:zlib";
import type { AppReview, ReviewCardMode } from "./types.js";

/** What each review-card mode lets through. `present`: the agent's
 * `bivy app present` makes a card. `minChange`: at the end of a run whose
 * preview changed, the share of pixels that must differ from the page before
 * the run; undefined = never on its own. A new mode is a new row. */
export const REVIEW_MODES: Record<ReviewCardMode, { present: boolean; minChange?: number }> = {
  // ~8×8 CSS px at 2× on a phone-sized page: a moved button or changed
  // label, not a blinking caret (~0.01%).
  ready: { present: true, minChange: 0.0002 },
  every: { present: true, minChange: 0 },
  off: { present: false },
};

export interface ReviewDecision {
  trigger: AppReview["trigger"];
  mode: ReviewCardMode;
  /** The user muted cards for the rest of this run. */
  muted: boolean;
  /** The view's revision changed during the run. */
  revisionChanged: boolean;
  /** Share of pixels that differ from the baseline; undefined when there is
   * no baseline or no screenshot. */
  change?: number;
}

/** Whether a moment gets a review card. Show me ("asked") is the user's own
 * request, so it always does. Without a baseline, a run can't prove a visible
 * change, so it gets no card: a backend-only run must never produce one. */
export function shouldReview(input: ReviewDecision): boolean {
  if (input.trigger === "asked") return true;
  if (input.muted) return false;
  const rule = REVIEW_MODES[input.mode];
  if (input.trigger === "present") return rule.present;
  return input.revisionChanged && rule.minChange !== undefined && input.change !== undefined && input.change > rule.minChange;
}

/** What the "session finished" notification carries about a review: IDs only.
 * The device fetches the screenshot over the encrypted session channel. */
export function reviewHint(review: AppReview): { review: { appId: string; viewId: string; reviewId: string }; body: string } {
  return {
    review: { appId: review.appId, viewId: review.viewId, reviewId: review.id },
    body: `${review.name} ${review.trigger === "present" ? "is ready to review" : "changed"} — tap to see it.`,
  };
}

/** Decodes the 8-bit, non-interlaced RGB(A) PNGs Chrome and rfb.ts write. */
export function decodePng(png: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG.");
  let offset = 8, width = 0, height = 0, channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      const [depth, color, , , interlace] = chunk.subarray(8, 13);
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace) throw new Error("Unsupported PNG.");
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels]! : 0;
      const b = y ? pixels[out - stride + x]! : 0;
      const c = y && x >= channels ? pixels[out - stride + x - channels]! : 0;
      let value = line[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      pixels[out + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Share of pixels that visibly differ (0–1). Different sizes count as a
 * full change: the page grew or shrank. */
export function visualChange(before: Buffer, after: Buffer): number {
  if (before.equals(after)) return 0;
  const a = decodePng(before), b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0, p = 0; p < a.width * a.height; p++, i += a.channels) {
    const j = p * b.channels;
    const delta = Math.abs(a.pixels[i]! - b.pixels[j]!) + Math.abs(a.pixels[i + 1]! - b.pixels[j + 1]!) + Math.abs(a.pixels[i + 2]! - b.pixels[j + 2]!);
    // Re-renders of the same page are pixel-identical; this only skips
    // sub-pixel antialiasing shifts, not a light grey on white.
    if (delta > 12) changed++;
  }
  return changed / (a.width * a.height);
}

/** PNG dimensions, from the header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
