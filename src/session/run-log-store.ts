// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Durable scrollback for a `bivy run` whose agent exposed no session of its own
// (no launch-time pin, nothing discoverable in an agent store — e.g. a raw
// `bivy run -- <command>`, or an agent Bivy has no session reader for). The
// run-terminal subsystem keeps the PTY's retained output tail here at exit so
// the run still has a row in the session list and can be reopened as a
// read-only terminal log, instead of vanishing the moment the process ends.
//
// One JSON file per run under <dataDir>/run-logs/<termId>.json. Ids are the
// daemon's own terminal ids (never client-supplied paths), and are validated
// to a safe charset before touching the filesystem.

import fs from "node:fs";
import path from "node:path";

export interface StoredRunLog {
  data: string;
  code: number;
  exitedAt: number;
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export interface RunLogStore {
  save(termId: string, log: StoredRunLog): string | undefined;
  load(termId: string): StoredRunLog | undefined;
  remove(termId: string): void;
}

export function createRunLogStore(dataDir: string): RunLogStore {
  const dir = path.join(dataDir, "run-logs");
  const fileFor = (termId: string): string | undefined => (SAFE_ID.test(termId) ? path.join(dir, `${termId}.json`) : undefined);

  return {
    save(termId, log) {
      const file = fileFor(termId);
      if (!file) return undefined;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...log }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return file;
    },
    load(termId) {
      const file = fileFor(termId);
      if (!file) return undefined;
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { return undefined; }
      try {
        const parsed = JSON.parse(raw) as Partial<StoredRunLog>;
        if (typeof parsed.data !== "string") return undefined;
        return { data: parsed.data, code: Number.isFinite(parsed.code) ? Number(parsed.code) : 0, exitedAt: Number(parsed.exitedAt) || 0 };
      } catch {
        return undefined;
      }
    },
    remove(termId) {
      const file = fileFor(termId);
      if (!file) return;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}
