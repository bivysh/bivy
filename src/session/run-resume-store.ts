// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The live `bivy run` terminals the node should bring back after it restarts.
// A run is written here when it opens and whenever the command that resumes it
// changes, and removed when it ends on its own or the person closes it. So
// whatever is left when the node starts is exactly the runs a stop, crash or
// update cut short. Startup takes them all at once (a failed resume is never
// retried).
//
// One JSON file per run under <dataDir>/run-resume/<termId>.json, owner-only.
// No environment is kept: the restored run is provisioned afresh.

import fs from "node:fs";
import path from "node:path";
import type { ResumeCommand } from "../program-resume.js";

export interface SuspendedRun {
  termId: string;
  workspace: string;
  /** The program the run was launched with (`spec.command`). */
  command: string;
  agent?: string;
  label?: string;
  name?: string;
  model?: string;
  /** The agent session id pinned at launch. */
  sessionId?: string;
  createdAt: number;
  savedAt: number;
  /** What the program itself reported (OSC 7577), when it did. */
  resume?: ResumeCommand;
}

export interface RunResumeStore {
  save(run: SuspendedRun): void;
  remove(termId: string): void;
  /** Every saved run, removing them from disk. */
  takeAll(): SuspendedRun[];
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function parse(raw: string): SuspendedRun | undefined {
  try {
    const run = JSON.parse(raw) as Partial<SuspendedRun>;
    if (typeof run.termId !== "string" || !SAFE_ID.test(run.termId)) return undefined;
    if (typeof run.workspace !== "string" || typeof run.command !== "string" || !run.command) return undefined;
    const argv = run.resume?.argv;
    if (run.resume && (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string"))) return undefined;
    return run as SuspendedRun;
  } catch {
    return undefined;
  }
}

export function createRunResumeStore(dataDir: string): RunResumeStore {
  const dir = path.join(dataDir, "run-resume");
  const fileFor = (termId: string): string | undefined => (SAFE_ID.test(termId) ? path.join(dir, `${termId}.json`) : undefined);

  return {
    save(run) {
      const file = fileFor(run.termId);
      if (!file) return;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(run), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    remove(termId) {
      const file = fileFor(termId);
      if (!file) return;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
    takeAll() {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return []; }
      const runs: SuspendedRun[] = [];
      for (const name of names) {
        const file = path.join(dir, name);
        let raw = "";
        try { raw = fs.readFileSync(file, "utf8"); } catch { /* unreadable: dropped below */ }
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        const run = name.endsWith(".json") ? parse(raw) : undefined;
        if (run && `${run.termId}.json` === name) runs.push(run);
      }
      return runs;
    },
  };
}
