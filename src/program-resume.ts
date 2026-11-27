// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// OSC 7577 (Program Resume Protocol): a program tells its terminal the command
// that brings it back after the terminal restarts. Bivy's node is the terminal
// for every PTY it opens, so it hands each PTY a fresh token, checks reports
// against it, and keeps the command a program last reported.
//
// Spec: https://www.superlogical.com/rex/docs/build/program-resume (rev 0.5).
// Pi reports this; any program that does gets the same treatment.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The environment variable a program reads its token from. */
export const PROGRAM_RESUME_ENV = "OSC7577_TOKEN";

export interface ResumeCommand {
  argv: string[];
  /** Absolute working directory the program asked for. */
  cwd?: string;
}

/** A fresh 128-bit token for one PTY (22 base64url characters). */
export function newResumeToken(): string {
  return randomBytes(16).toString("base64url");
}

const PAIR_VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const PAIR_KEY = /^[a-z]+$/;
const PID = /^[1-9][0-9]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CLOCK_WINDOW_S = 60;
const MAX_ARGV = 256;
/** Keys this terminal implements; a report that `need`s another is rejected. */
const KNOWN_KEYS = new Set(["pid", "time", "mac", "argv", "cwd", "clear", "need"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Standard base64 of UTF-8 text with no control characters, else null. */
function decodeElement(value: string): string | null {
  if (!BASE64.test(value)) return null;
  const bare = value.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  if (value.length !== bare.length && value.length % 4 !== 0) return null; // padding, if any, must be exact
  const bytes = Buffer.from(bare, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== bare) return null; // stray bits
  let text: string;
  try { text = utf8.decode(bytes); } catch { return null; }
  return CONTROL.test(text) ? null : text;
}

export type ResumeReport =
  /** Failed the mac or clock check: changes nothing. */
  | { outcome: "ignored" }
  /** Authentic but invalid: drops every record of `pid`. */
  | { outcome: "rejected"; pid: number }
  | { outcome: "report"; pid: number; time: number; command: ResumeCommand }
  | { outcome: "clear"; pid: number; time: number };

/**
 * Check one OSC 7577 body against this PTY's token. `now` is epoch seconds.
 * The mac is verified before anything else is decoded.
 */
export function readResumeReport(body: string, token: string, now: number): ResumeReport {
  const at = body.lastIndexOf(":mac=");
  if (at < 0) return { outcome: "ignored" };
  const mac = body.slice(at + 5);
  if (!/^[0-9a-f]{64}$/.test(mac)) return { outcome: "ignored" };
  const expected = createHash("sha256").update(`${body.slice(0, at)}:${token}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return { outcome: "ignored" };

  const pairs = new Map<string, string>();
  let malformed = false;
  for (const pair of body.slice(0, at).split(":")) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq) : "";
    const value = pair.slice(eq + 1);
    if (!PAIR_KEY.test(key) || !PAIR_VALUE.test(value) || pairs.has(key) || key === "mac") { malformed = true; continue; }
    pairs.set(key, value);
  }
  const time = pairs.get("time");
  if (!time || !PID.test(time) || Math.abs(Number(time) - now) > CLOCK_WINDOW_S) return { outcome: "ignored" };
  const pidText = pairs.get("pid");
  if (!pidText || !PID.test(pidText)) return { outcome: "ignored" }; // no owner to reject
  const pid = Number(pidText);
  const reject = { outcome: "rejected", pid } as const;
  if (malformed) return reject;
  const need = pairs.get("need");
  if (need !== undefined && need.split(",").some((key) => !KNOWN_KEYS.has(key))) return reject;

  const clear = pairs.get("clear");
  const argvText = pairs.get("argv");
  if ((clear === undefined) === (argvText === undefined)) return reject;
  if (clear !== undefined) return clear === "1" ? { outcome: "clear", pid, time: Number(time) } : reject;

  const parts = argvText!.split(",");
  if (parts.length > MAX_ARGV) return reject;
  const argv: string[] = [];
  for (const part of parts) {
    const arg = decodeElement(part);
    if (arg === null) return reject;
    argv.push(arg);
  }
  const program = argv[0];
  if (!program || (!program.startsWith("/") && (program.startsWith("-") || program.includes("/")))) return reject;
  const command: ResumeCommand = { argv };
  const cwdText = pairs.get("cwd");
  if (cwdText !== undefined) {
    const cwd = decodeElement(cwdText);
    if (!cwd || !cwd.startsWith("/")) return reject;
    command.cwd = cwd;
  }
  return { outcome: "report", pid, time: Number(time), command };
}

/**
 * The resume commands one PTY holds: one per reporting process. The PTY's own
 * first process wins over anything it started (prefer the ancestor), else the
 * latest report. A record ends with its owner's `clear` or rejection.
 */
export class ProgramResumeBoard {
  private readonly records = new Map<number, ResumeCommand>();
  private readonly lastTime = new Map<number, number>();

  constructor(
    private readonly token: string,
    private readonly rootPid: () => number | undefined,
    private readonly alive: (pid: number) => boolean = processAlive,
  ) {}

  /** Apply one OSC 7577 body; true when `current()` may have changed. */
  apply(body: string, now = Math.floor(Date.now() / 1000)): boolean {
    const report = readResumeReport(body, this.token, now);
    if (report.outcome === "ignored") return false;
    if (report.outcome !== "rejected") {
      if (report.time < (this.lastTime.get(report.pid) ?? 0)) return false;
      this.lastTime.set(report.pid, report.time);
    }
    this.records.delete(report.pid);
    if (report.outcome === "report") this.records.set(report.pid, report.command);
    return true;
  }

  current(): ResumeCommand | undefined {
    const root = this.rootPid();
    const own = root === undefined ? undefined : this.records.get(root);
    if (own) return own;
    let latest: ResumeCommand | undefined;
    for (const [pid, command] of this.records) if (this.alive(pid)) latest = command;
    return latest;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
