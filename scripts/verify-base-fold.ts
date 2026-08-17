// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Dry-run gate for the base-transcript fold.
// Reads a node's REAL on-disk data read-only and asserts, per session, that folding
// the legacy base transcript into the event log is behaviour-preserving:
//
//   1. migrate:  appendBaseSnapshot(legacyBase) then readBase() == legacyBase
//   2. derive:   deriveHistory(reopened, runtimeBase=[])  ==  the LEGACY derivation
//                mergeTranscript(legacyBase, <overlay extras from the real log>)
//
// Writes only into a throwaway temp dir; the real .bivy is never modified. Run before
// deploying the fold:  ./node_modules/.bin/tsx scripts/verify-base-fold.ts [dataDir]
// (dataDir defaults to ~/.bivy/app/.bivy).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

import { EventLog, parseLog, replayExtras } from "../src/session/event-log.js";
import { mergeTranscript, type SidecarMessage } from "../src/session/transcript-merge.js";
import type { RuntimeMessage } from "../src/runtime/types.js";

const dataDir = process.argv[2] ?? path.join(os.homedir(), ".bivy", "app", ".bivy");
const transcriptsDir = path.join(dataDir, "transcripts");
const eventLogDir = path.join(dataDir, "event-log");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-base-fold-verify-"));
const pathFor = (id: string) => path.join(tmp, `${encodeURIComponent(id)}.jsonl`);

let ids: string[] = [];
try {
  ids = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
} catch {
  console.error(`no transcripts dir at ${transcriptsDir}`);
}

let ok = 0;
let skipped = 0;
const failures: string[] = [];

for (const id of ids) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(transcriptsDir, `${encodeURIComponent(id)}.json`), "utf8"));
    if (!Array.isArray(parsed) || !parsed.length) { skipped++; continue; }
    const legacyBase = parsed.filter((m) => m != null && typeof m === "object" && typeof m.role === "string") as RuntimeMessage[];
    if (!legacyBase.length) { skipped++; continue; }

    // The real overlay entries this session already has in its log.
    let overlayEntries: SidecarMessage[] = [];
    try {
      overlayEntries = replayExtras(parseLog(fs.readFileSync(path.join(eventLogDir, `${encodeURIComponent(id)}.jsonl`), "utf8")));
    } catch { /* no overlay log yet */ }

    // Seed a throwaway log with the real overlay records, then migrate the base in.
    let seed = "";
    try { seed = fs.readFileSync(path.join(eventLogDir, `${encodeURIComponent(id)}.jsonl`), "utf8"); } catch {}
    if (seed) fs.writeFileSync(pathFor(id), seed);
    const log = new EventLog(tmp, pathFor, (t) => t, 0);
    log.appendBaseSnapshot(id, legacyBase);
    log.flush(id);

    // 1. Migration is lossless: replayed base equals the legacy snapshot exactly.
    assert.deepEqual(log.readBase(id), JSON.parse(JSON.stringify(legacyBase)), "readBase != legacyBase");

    // 2. The derived history (reopened session, empty runtime base) equals what the
    //    old mergeConversation produced from the legacy base + the same overlays.
    const derived = log.deriveHistory(id, []);
    const legacyDerived = mergeTranscript(JSON.parse(JSON.stringify(legacyBase)), overlayEntries);
    assert.deepEqual(derived, legacyDerived, "deriveHistory != legacy mergeConversation");

    ok++;
    console.log(`ok    ${id}  base=${legacyBase.length} overlays=${overlayEntries.length} derived=${derived.length}`);
  } catch (err) {
    failures.push(`${id}: ${(err as Error).message}`);
    console.error(`FAIL  ${id}: ${(err as Error).message}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ok} ok, ${skipped} skipped (empty), ${failures.length} failed, of ${ids.length} sessions`);
if (failures.length) { process.exitCode = 1; }
