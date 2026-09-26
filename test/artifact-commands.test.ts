// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { listMachineArtifacts } from "../src/controllers/artifact-commands.js";
import type { LogRecord } from "../src/session/event-log.js";

const sent = (hash: string, createdAt: number, extra: { artifact?: boolean; caption?: string } = {}): LogRecord => ({
  bivyKind: "outbound-attachment", createdAt, afterMessageCount: 0, id: `e-${hash}-${createdAt}`,
  ref: { hash, name: `${hash}.pdf`, mimeType: "application/pdf", size: 10, kind: "file" }, ...extra,
});

test("the machine index lists only stored files, once each, linked to where they were sent last", () => {
  const logs: Record<string, LogRecord[]> = {
    a: [sent("report", 1, { artifact: true }), sent("pruned", 2)],
    b: [sent("report", 5, { caption: "Final" }), { bivyKind: "attachment", createdAt: 9, text: "user upload", refs: [] }],
  };
  const artifacts = listMachineArtifacts({
    sessionIds: () => Object.keys(logs),
    scan: (id) => logs[id] ?? [],
    stored: (hash) => hash !== "pruned",
  });
  // The resend in session b wins, and keeps the artifact marking from session a.
  assert.deepEqual(artifacts.map((a) => [a.sessionId, a.hash, a.createdAt, a.artifact, a.caption]), [["b", "report", 5, true, "Final"]]);
});
