#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Design-system fitness check: keep exactly ONE source of truth for design
// tokens. packages/ui/tokens.css owns every palette value; no other stylesheet
// may redeclare one. This is the mechanical guard that stops the palette "fork"
// from silently coming back (an app stylesheet growing its own :root { --accent }
// that drifts away from the design system).
//
//   node scripts/check-design-tokens.mjs   # exit 1 if a palette token is
//                                           # redeclared outside tokens.css
//
// It also rejects raw numeric z-index values and component classes retired in
// favor of canonical design-system primitives. Raw hex/rgb color literals are
// reported as a drift signal — app CSS should reference var(--…), not hardcode color. Flip
// HEX_IS_ERROR to true once the app stylesheets are fully tokenized to promote
// that from a warning to a hard failure (same pattern as check-module-boundaries).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEX_IS_ERROR = false;

// The single source of truth. Everything else is a consumer.
const TOKENS_FILE = "packages/ui/tokens.css";

// Stylesheets that consume the design system and must NOT redeclare palette tokens.
const SCAN_DIRS = ["packages/web/src"];
const SCAN_FILES = [];

// Canonical palette tokens (from tokens.css). Declaring any of these outside
// tokens.css means a second source of truth — the exact drift we're preventing.
const PALETTE_TOKENS = [
  "bg", "surface", "surface-2", "surface-3",
  "ink", "muted", "line", "line-strong", "overlay",
  "accent", "accent-contrast", "accent-hover", "accent-active", "accent-soft",
  "danger", "danger-soft", "ok", "merged", "unseen",
  "s-github", "s-slack", "s-linear", "s-schedule", "s-webhook", "s-manual", "s-cli", "s-app",
];
const declRe = new RegExp(`--(${PALETTE_TOKENS.join("|")})\\s*:`, "g");
// Hex or rgb/rgba/hsl literals used as a value (rough — good enough as a signal).
const hexRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
const rawZIndexRe = /z-index\s*:\s*-?\d/;
const RETIRED_CLASSES = [
  "autom-new-btn", "autom-save-btn", "autom-empty-new-btn", "pill",
  "picker-action", "repo-connect-copy", "connect-copy", "connect-refresh",
  "autom-notice", "autom-banner", "autom-success", "routing-readiness",
  "autom-trigger-menu", "autom-trigger-option", "template-card-badge",
];
const retiredClassRe = new RegExp(`(?:\\.|className[^\\n]*[\\"'\\x60 {])(${RETIRED_CLASSES.join("|")})(?=[\\s.\\"'\\x60}:])`, "g");

function walk(dir) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(?:css|ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = [...SCAN_DIRS.flatMap(walk), ...SCAN_FILES].filter(
  (f) => f !== TOKENS_FILE && fs.existsSync(path.join(repoRoot, f)),
);

const redeclarations = [];
const hexHits = [];
const rawZIndexHits = [];
const retiredClassHits = [];
for (const file of files) {
  const lines = fs.readFileSync(path.join(repoRoot, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("/*") || line.trimStart().startsWith("*")) return;
    for (const m of line.matchAll(declRe)) redeclarations.push({ file, line: i + 1, token: m[1] });
    if (file.endsWith(".css") && hexRe.test(line)) hexHits.push({ file, line: i + 1, text: line.trim().slice(0, 80) });
    hexRe.lastIndex = 0;
    if (rawZIndexRe.test(line)) rawZIndexHits.push({ file, line: i + 1, text: line.trim() });
    for (const m of line.matchAll(retiredClassRe)) retiredClassHits.push({ file, line: i + 1, className: m[1] });
  });
}

let failed = false;

if (redeclarations.length) {
  failed = true;
  console.error(`\n✖ ${redeclarations.length} palette token(s) redeclared outside ${TOKENS_FILE}:`);
  for (const r of redeclarations) console.error(`  ${r.file}:${r.line}  --${r.token}`);
  console.error(`\n  These tokens live in ${TOKENS_FILE} only. Reference them with var(--…);`);
  console.error(`  change the value there so every surface moves together.\n`);
} else {
  console.log(`✓ Single source of truth: no palette token is redeclared outside ${TOKENS_FILE}.`);
}

if (rawZIndexHits.length) {
  failed = true;
  console.error(`\n✖ ${rawZIndexHits.length} raw z-index value(s); use a --z-* token:`);
  for (const h of rawZIndexHits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
}

if (retiredClassHits.length) {
  failed = true;
  console.error(`\n✖ ${retiredClassHits.length} retired design-system class use(s):`);
  for (const h of retiredClassHits) console.error(`  ${h.file}:${h.line}  .${h.className}`);
}

if (hexHits.length) {
  const label = HEX_IS_ERROR ? "✖" : "⚠";
  const stream = HEX_IS_ERROR ? console.error : console.warn;
  if (HEX_IS_ERROR) failed = true;
  stream(`\n${label} ${hexHits.length} raw color literal(s) in app CSS (prefer var(--…) tokens):`);
  for (const h of hexHits.slice(0, 25)) stream(`  ${h.file}:${h.line}  ${h.text}`);
  if (hexHits.length > 25) stream(`  … and ${hexHits.length - 25} more`);
  if (!HEX_IS_ERROR) stream(`  (warning only — set HEX_IS_ERROR=true in this script to enforce once tokenized)\n`);
}

process.exit(failed ? 1 : 0);
