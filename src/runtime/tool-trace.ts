// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { boundedToolPayload, type ToolCallMapContext } from "./tool-call-map.js";

/** Explicit opt-in capture of bounded provider payloads for fixture curation.
 * Traces may contain source/code/commands and must never be enabled by default. */
export function traceToolPayload(input: {
  phase: "call" | "result";
  context: ToolCallMapContext;
  name: string;
  callId: string;
  payload: unknown;
}): void {
  const file = process.env.BIVY_TOOL_TRACE_FILE?.trim();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...input, payload: boundedToolPayload(input.payload) })}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // Diagnostics must never affect an agent turn.
  }
}
