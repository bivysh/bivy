// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { readFileSync } from "node:fs";
import { decodePng } from "./review.js";
import { encodePng } from "./rfb.js";

/** A mark drawn over a preview, in page CSS pixels (or the image's, on a
 * Compare screenshot). A box uses its first and last points as corners. */
export interface Stroke { tool: "pen" | "box"; points: [number, number][] }
export interface ElementScroll { selector: string; x: number; y: number }
/** Scroll containers are page data, never executable capture instructions. */
export function readElementScrolls(input: unknown): ElementScroll[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error("Invalid scroll containers.");
  return input.map((raw) => {
    if (!raw || typeof raw.selector !== "string" || !raw.selector.length || raw.selector.length > 2048
      || ![raw.x, raw.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100_000)) throw new Error("Invalid scroll container.");
    return { selector: raw.selector, x: raw.x, y: raw.y };
  });
}
/** What the page said about state a fresh browser on the machine can't have. */
export interface PageSignals { storage?: boolean; cookies?: boolean; interacted?: boolean; open?: boolean; edited?: boolean;
  /** The page couldn't say (no inspector): assume it may differ. */
  unknown?: boolean }

/** One mark and the words about it: the unit a pin is made from. */
export interface MarkNote { n: number; words: string; selectors: string[]; strokes: Stroke[] }
const MAX_NOTES = 20;

/** Notes from the client (untrusted shape): numbered, bounded, with strokes. */
export function readNotes(input: unknown): MarkNote[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.length || input.length > MAX_NOTES) throw new Error(`A message carries 1 to ${MAX_NOTES} notes.`);
  return input.map((raw, index) => {
    const note = raw as { n?: unknown; words?: unknown; selectors?: unknown };
    if (!Number.isInteger(note?.n) || (note.n as number) < 1 || (note.n as number) > MAX_NOTES) throw new Error("Invalid note number.");
    if (note.words !== undefined && typeof note.words !== "string") throw new Error("Invalid note text.");
    const selectors = Array.isArray(note.selectors) ? note.selectors.filter((s): s is string => typeof s === "string" && !!s && s.length <= 300).slice(0, 8) : [];
    return { n: index + 1, words: typeof note.words === "string" ? note.words.trim().slice(0, 2000) : "", selectors, strokes: readStrokes((raw as { strokes?: unknown }).strokes) };
  });
}

/** Where a note's number sits: the top-left of everything it covers. */
export function noteAnchor(note: MarkNote): { x: number; y: number } {
  const xs = note.strokes.flatMap((stroke) => stroke.points.map(([x]) => x));
  const ys = note.strokes.flatMap((stroke) => stroke.points.map(([, y]) => y));
  return { x: Math.min(...xs), y: Math.min(...ys) };
}

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
/** A note's number, in CSS pixels: the pill's half-height, and the digits. */
const PIP = { radius: 11, height: 12, width: 6, gap: 3, stroke: 1.6 };

/** Seven-segment digits, drawn rather than typeset: the picture has to carry
 * the numbers, and a PNG writer has no font. Adding a glyph is adding a row.
 *
 *      aaa
 *     f   b
 *      ggg
 *     e   c
 *      ddd
 */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};
function digit(glyph: string, x: number, y: number, w: number, h: number): [number, number][][] {
  const middle = y + h / 2;
  const lines: Record<string, [number, number][]> = {
    a: [[x, y], [x + w, y]], b: [[x + w, y], [x + w, middle]], c: [[x + w, middle], [x + w, y + h]],
    d: [[x, y + h], [x + w, y + h]], e: [[x, middle], [x, y + h]], f: [[x, y], [x, middle]], g: [[x, middle], [x + w, middle]],
  };
  return [...(SEGMENTS[glyph] ?? "")].map((name) => lines[name]!);
}

/** Cuts out the part of a picture a pin is about, with room around it so the
 * mark is read in its surroundings rather than in isolation. `scale` maps CSS
 * pixels to image pixels. Returns the whole picture when the cut would be
 * empty or nearly all of it. */
export function crop(png: Buffer, region: { x: number; y: number; width: number; height: number }, scale: number, padding = 24): Buffer {
  const image = decodePng(png);
  const { width, height, channels } = image;
  const pad = padding * scale;
  const left = Math.max(0, Math.floor((region.x - padding) * scale));
  const top = Math.max(0, Math.floor((region.y - padding) * scale));
  const right = Math.min(width, Math.ceil((region.x + region.width) * scale + pad));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * scale + pad));
  const w = right - left, h = bottom - top;
  if (w < 8 || h < 8 || (w >= width * 0.9 && h >= height * 0.9)) return png;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((y + top) * width + (x + left)) * channels;
      image.pixels.copy(rgb, (y * w + x) * 3, from, from + 3);
    }
  }
  return encodePng(w, h, rgb);
}

/** Draws marks onto a PNG. `scale` maps CSS pixels to image pixels;
 * `offset` (CSS px) is subtracted first — the scroll position the picture
 * was taken at. Halos go under every mark first, so crossings stay clean. */
export function composite(png: Buffer, strokes: Stroke[], map: { scale: number; offset?: { x: number; y: number } }, badges: { n: number; x: number; y: number }[] = []): Buffer {
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
  // The numbers last, over the marks, so a note and the thing it is about stay
  // paired in the picture as well as in the words.
  for (const badge of badges) {
    const glyphs = [...String(badge.n)];
    const [pw, ph, gap, pr] = [PIP.width, PIP.height, PIP.gap, PIP.radius].map((v) => v * map.scale);
    const span = glyphs.length * pw + (glyphs.length - 1) * gap;
    const [cx, cy] = toImage([badge.x, badge.y]);
    // A traced line of radius `pr` is a pill: a disc at each end, filled between.
    trace([[cx - span / 2, cy], [cx + span / 2, cy]], pr, INK);
    glyphs.forEach((glyph, index) => {
      for (const segment of digit(glyph, cx - span / 2 + index * (pw + gap), cy - ph / 2, pw, ph)) trace(segment, PIP.stroke * map.scale, HALO);
    });
  }
  return encodePng(width, height, rgb);
}
