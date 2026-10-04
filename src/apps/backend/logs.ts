// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { redactSecrets } from "../../redact.js";
import type { LogLine, LogMark } from "../types.js";

const MAX_LINES = 2000;
const MAX_MARKS = 50;
const MAX_LINE = 2000;

/** How bad a line is, as rows tried in order. A server's own words decide:
 *  "error", an exception, a 5xx it answered. Adding a pattern is adding a row. */
const LEVELS: { level: LogLine["level"]; pattern: RegExp }[] = [
  { level: "error", pattern: /\b(error|exception|fatal|panic|traceback|uncaught|unhandled|failed)\b|[a-z](?:Error|Exception)\b|\b(?:Completed|status[=: ]+|HTTP\/\d(?:\.\d)?"?\s+)5\d\d\b|\s5\d\d\s+in\s+\d/i },
  { level: "warn", pattern: /\b(warn|warning|deprecat\w*)\b/i },
];
// Terminal colour and cursor codes: a log is read as text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** A stack frame or continuation belongs to the line above it. */
const CONTINUATION = /^(\s+\S|\s*at\s|\s*from\s|\s*File\s"|Caused by:|\s*\.\.\.\s\d+ more)/;

/** One source's recent lines, each stamped when it arrived. */
export class LogBuffer {
  lines: LogLine[] = [];
  private partial = "";
  append(data: string, at = Date.now()): void {
    const text = this.partial + data.replace(ANSI, "").replace(/\r\n?/g, "\n");
    const parts = text.split("\n");
    this.partial = parts.pop()!.slice(-MAX_LINE);
    for (const raw of parts) {
      if (!raw.trim()) continue;
      const line = raw.slice(0, MAX_LINE);
      const previous = this.lines.at(-1);
      const level = CONTINUATION.test(line) && previous && previous.level !== "info" ? previous.level : LEVELS.find((row) => row.pattern.test(line))?.level ?? "info";
      this.lines.push({ at, text: line, level });
    }
    if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES);
  }
  /** Lines since `since`, with secrets taken out: they're shown, and may be sent to an agent. */
  read(since = 0): LogLine[] {
    return this.lines.filter((line) => line.at > since).map((line) => ({ ...line, text: redactSecrets(line.text) }));
  }
  errorsBetween(from: number, to = Infinity): LogLine[] {
    return this.read(from).filter((line) => line.level === "error" && line.at <= to);
  }
}

/** "Your last action" per app: what the person (or the agent) just did, so the
 *  log can say what came of it. */
export class LogMarks {
  private marks = new Map<string, LogMark[]>();
  add(appId: string, label: string, at = Date.now()): void {
    const list = this.marks.get(appId) ?? [];
    // A page and the requests it makes in the same moment are one action.
    if (list.at(-1) && at - list.at(-1)!.at < 1000) return;
    list.push({ at, label: label.slice(0, 200) });
    this.marks.set(appId, list.slice(-MAX_MARKS));
  }
  read(appId: string): LogMark[] { return [...this.marks.get(appId) ?? []]; }
  forget(appId: string): void { this.marks.delete(appId); }
}
