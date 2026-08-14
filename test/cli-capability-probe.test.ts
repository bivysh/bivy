// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// #4 — opt-in capability probing. Our resume/model capabilities are pinned to each
// CLI's docs; a version that renamed or dropped a flag would keep advertising a
// no-op control. `BIVY_AGENT_PROBE=1` runs `<cli> --help` and DOWNGRADES any
// capability the installed binary doesn't evidence (never upgrades). This tests the
// pure refinement and the end-to-end env-gated integration with a stub `--help`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRuntimes, refineCapabilitiesFromHelp, resolveCliExecutionMode, invalidateCliProbeCache } from "../src/runtime/index.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(e as Error).stack ?? (e as Error).message}`);
  }
}

// --- pure refinement ---------------------------------------------------------

check("refine: keeps capabilities the help text evidences", () => {
  const help = "usage: foo [--resume <id>] [--model <m>] run <prompt>";
  const out = refineCapabilitiesFromHelp(help, { resume: true, modelSelection: true }, { resumeTokens: ["--resume"], modelFlag: "--model" });
  assert.deepEqual(out, { resume: true, modelSelection: true });
});

check("refine: downgrades a resume flag the binary no longer mentions", () => {
  const help = "usage: foo [--model <m>] run <prompt>"; // no --resume
  const out = refineCapabilitiesFromHelp(help, { resume: true, modelSelection: true }, { resumeTokens: ["--resume"], modelFlag: "--model" });
  assert.equal(out.resume, false, "missing resume flag → downgraded");
  assert.equal(out.modelSelection, true, "model flag still present → kept");
});

check("refine: downgrades a model flag the binary no longer mentions", () => {
  const help = "usage: foo [--resume <id>] run <prompt>"; // no --model
  const out = refineCapabilitiesFromHelp(help, { resume: true, modelSelection: true }, { resumeTokens: ["--resume"], modelFlag: "--model" });
  assert.equal(out.modelSelection, false);
  assert.equal(out.resume, true);
});

check("refine: any one resume token present keeps resume (subcommand form)", () => {
  const help = "commands:\n  threads continue <id>   resume a thread";
  const out = refineCapabilitiesFromHelp(help, { resume: true, modelSelection: false }, { resumeTokens: ["threads", "continue"], modelFlag: undefined });
  assert.equal(out.resume, true);
});

check("refine: empty resumeTokens never downgrades (can't tell)", () => {
  const out = refineCapabilitiesFromHelp("no flags here", { resume: true, modelSelection: false }, { resumeTokens: [], modelFlag: undefined });
  assert.equal(out.resume, true);
});

check("refine: never UPGRADES (off stays off even if the flag appears)", () => {
  const out = refineCapabilitiesFromHelp("--resume --model", { resume: false, modelSelection: false }, { resumeTokens: ["--resume"], modelFlag: "--model" });
  assert.deepEqual(out, { resume: false, modelSelection: false });
});

// --- execution mode resolution ----------------------------------------------

check("mode: auto prefers protocol, then structured pipe, then plain pipe", () => {
  assert.equal(resolveCliExecutionMode({ protocolAvailable: true, structuredAvailable: true, protocolPreferred: true }), "protocol");
  assert.equal(resolveCliExecutionMode({ protocolAvailable: false, structuredAvailable: true }), "structured-pipe");
  assert.equal(resolveCliExecutionMode({ protocolAvailable: false, structuredAvailable: false }), "pipe");
});

check("mode: explicit choices are honored and unavailable modes fail closed", () => {
  assert.equal(resolveCliExecutionMode({ requested: "structured", protocolAvailable: false, structuredAvailable: true }), "structured-pipe");
  assert.equal(resolveCliExecutionMode({ requested: "pipe", protocolAvailable: true, structuredAvailable: true }), "pipe");
  assert.throws(() => resolveCliExecutionMode({ requested: "protocol", protocolAvailable: false, structuredAvailable: true }), /no configured protocol/);
  assert.throws(() => resolveCliExecutionMode({ requested: "structured-pipe", protocolAvailable: false, structuredAvailable: false }), /no available structured parser/);
  assert.throws(() => resolveCliExecutionMode({ requested: "wat", protocolAvailable: false, structuredAvailable: false }), /Invalid agent execution mode/);
});

// --- end-to-end, env-gated, via a stub `--help` on PATH ----------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-probe-"));
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

// A stub `gemini` whose --help advertises neither -m nor -r, so probing should
// downgrade BOTH modelSelection and resume for the gemini runtime.
fs.writeFileSync(
  path.join(binDir, "gemini"),
  ["#!/bin/sh", 'echo "usage: gemini [-p <prompt>] [--yolo]"', 'echo "a stripped-down build with no model or resume flags"', ""].join("\n"),
  { mode: 0o755 },
);
// CLI probes are memoized for the process lifetime, and the catalog is built once
// at import — before this stub exists and this PATH is set — so `gemini` is already
// cached as "not found". Drop that cache now that the stub is in place, exactly as
// an install would, so the probe-on check below actually re-probes the stub.
invalidateCliProbeCache();

check("probe off by default: gemini keeps its pinned capabilities", () => {
  delete process.env.BIVY_AGENT_PROBE;
  const g = listRuntimes().find((r) => r.id === "gemini");
  assert.ok(g, "gemini in picker");
  const caps = g!.capabilities as Record<string, unknown>;
  assert.equal(caps.modelSelection, true, "without probing, model stays advertised");
  assert.equal(caps.resume, true, "without probing, resume stays advertised");
});

check("probe on: gemini downgrades to match a stripped `--help`", () => {
  process.env.BIVY_AGENT_PROBE = "1";
  try {
    const g = listRuntimes().find((r) => r.id === "gemini");
    const caps = g!.capabilities as Record<string, unknown>;
    assert.equal(caps.modelSelection, false, "no -m in help → model downgraded");
    assert.equal(caps.resume, false, "no -r in help → resume downgraded");
  } finally {
    delete process.env.BIVY_AGENT_PROBE;
  }
});

process.env.PATH = originalPath;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

if (failures > 0) {
  console.error(`\n${failures} cli-capability-probe test(s) failed`);
  process.exit(1);
}
console.log("\ncli-capability-probe: all tests passed");
