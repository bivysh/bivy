// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { readFileSync } from "node:fs";
import { decodePng } from "./review.js";
import { encodePng } from "./rfb.js";

/** A mark drawn over a preview, in page CSS pixels (or the image's, on a
 * Compare screenshot). A box uses its first and last points as corners. */
export interface Stroke { tool: "pen" | "box"; points: [number, number][] }
/** What the page said about state a fresh browser on the machine can't have. */
export interface PageSignals { storage?: boolean; cookies?: boolean; interacted?: boolean; open?: boolean; edited?: boolean;
  /** The page couldn't say (no inspector): assume it may differ. */
  unknown?: boolean }

const MAX_STROKES = 50;
const MAX_POINTS = 10_000;

/** Validates strokes from the client (untrusted shape): bounded, finite. */
export function readStrokes(input: unknown): Stroke[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_STROKES) throw new Error("Draw at least one mark (at most 50).");
  let total = 0;
  return input.map((raw) => {
    const stroke = raw as { tool?: unknown; points?: unknown };
    if ((stroke?.tool !== "pen" && stroke?.tool !== "box") || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error("Invalid mark.");
    total += stroke.points.length;
    if (total > MAX_POINTS) throw new Error("Too many points in the marks.");
    const points = stroke.points.map((p) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e6)) throw new Error("Invalid mark point.");
      return [p[0], p[1]] as [number, number];
    });
    return { tool: stroke.tool, points };
  });
}

/** Whether a picture retaken on the machine may not match what the user saw:
 * the page kept state a fresh browser doesn't have (storage, cookies, typed
 * input, an open menu or dialog, anything the user did since it loaded), or
 * the retake couldn't scroll to where they were. A Compare screenshot or a
 * desktop app's frame is the exact picture, so never approximate. */
export function approximate(source: "retake" | "exact", signals: PageSignals = {}, scrolledTo = true): boolean {
  if (source === "exact") return false;
  return !scrolledTo || Object.values(signals).some(Boolean);
}

/** The annotation colours, read from the design tokens (single source). */
function tokenColor(name: string, fallback: string): [number, number, number] {
  let hex = fallback;
  try { hex = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(readFileSync(new URL("./tokens.css", import.meta.url), "utf8"))?.[1] ?? fallback; } catch { /* fallback */ }
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
const INK = tokenColor("annotate", "#ff2d78");
const HALO = tokenColor("annotate-halo", "#ffffff");
/** Mark width in CSS pixels, and its halo on each side. */
const WIDTH = 4;
const HALO_WIDTH = 1.5;

/** Draws marks onto a PNG. `scale` maps CSS pixels to image pixels;
 * `offset` (CSS px) is subtracted first — the scroll position the picture
 * was taken at. Halos go under every mark first, so crossings stay clean. */
export function composite(png: Buffer, strokes: Stroke[], map: { scale: number; offset?: { x: number; y: number } }): Buffer {
  const image = decodePng(png);
  const { width, height, channels } = image;
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) image.pixels.copy(rgb, p * 3, p * channels, p * channels + 3);
  const off = map.offset ?? { x: 0, y: 0 };
  const toImage = ([x, y]: [number, number]): [number, number] => [(x - off.x) * map.scale, (y - off.y) * map.scale];
  const paths = strokes.map((stroke) => {
    const points = stroke.points.map(toImage);
    if (stroke.tool === "pen") return points;
    const [a, b] = [points[0]!, points[points.length - 1]!];
    return [a, [b[0], a[1]], b, [a[0], b[1]], a] as [number, number][];
  });
  const disc = (cx: number, cy: number, r: number, color: [number, number, number]) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) rgb.set(color, (y * width + x) * 3);
      }
    }
  };
  const trace = (path: [number, number][], r: number, color: [number, number, number]) => {
    const step = Math.max(0.5, r / 2);
    for (let i = 0; i < path.length; i++) {
      const [x0, y0] = path[i]!;
      const [x1, y1] = path[i + 1] ?? path[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 0; k <= n; k++) disc(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, r, color);
    }
  };
  const r = (WIDTH / 2) * map.scale;
  for (const path of paths) trace(path, r + HALO_WIDTH * map.scale, HALO);
  for (const path of paths) trace(path, r, INK);
  return encodePng(width, height, rgb);
}
