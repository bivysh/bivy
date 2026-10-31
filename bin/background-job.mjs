// SPDX-License-Identifier: MIT
// `bivy background` runs a command away from the agent's turn and wakes the
// agent when it is done: this watcher (spawned detached by the CLI) runs the
// command, keeps its output in a log file, and posts a short note into the
// session when the command exits, or when it first prints a line matching
// --match. The note arrives as a new message, so any agent picks it up.
//
// The CLI passes everything in $BIVY_BACKGROUND_JOB (JSON):
//   { sessionId, nodeUrl, auth?, command, args, cwd, log, label, match? }
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const TAIL_LINES = 20;
const TAIL_CHARS = 4000;

/** The last lines of a command's output, trimmed to fit in one message. */
export function outputTail(text, lines = TAIL_LINES) {
  const tail = String(text).replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
  return tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The note the agent receives (plain text: the chat shows it as a user message).
 *  `event` is { line } for a match, else { code, signal }. */
export function wakeText({ label, log, ms, event, tail }) {
  const indent = (text) => text.split("\n").map((l) => `    ${l}`).join("\n");
  const what = "line" in event
    ? `printed a line matching what you waited for, and is still running (${duration(ms)}):\n${indent(event.line.trim())}`
    : event.signal
      ? `was stopped by ${event.signal} after ${duration(ms)}.`
      : `exited with code ${event.code} after ${duration(ms)}.`;
  return [
    `Background command "${label}" ${what}`,
    tail ? `Last output:\n${indent(tail)}` : "",
    `Full log: ${log}`,
  ].filter(Boolean).join("\n\n");
}

async function post(spec, text) {
  const body = JSON.stringify({ text, clientMessageId: `bg-${randomUUID()}` });
  // The node may be restarting: retry for about a minute, then give up.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${spec.nodeUrl}/api/session/${encodeURIComponent(spec.sessionId)}/wake`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(spec.auth ? { authorization: `Bearer ${spec.auth}` } : {}) },
        body,
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        fs.appendFileSync(spec.log, `\n[bivy background] ${res.ok ? "woke the session" : `could not wake the session (${res.status})`}\n`);
        return;
      }
    } catch { /* node unreachable: retry */ }
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
}

export async function runBackgroundJob(spec) {
  const started = Date.now();
  const out = fs.openSync(spec.log, "a");
  const env = { ...process.env };
  delete env.BIVY_BACKGROUND_JOB;
  const child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const match = spec.match ? new RegExp(spec.match) : undefined;
  let recent = "";
  let pending = "";
  let matched = false;
  const sends = [];
  const onData = (chunk) => {
    fs.writeSync(out, chunk);
    const text = chunk.toString("utf8");
    recent = (recent + text).slice(-TAIL_CHARS * 4);
    if (!match || matched) return;
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const line = lines.find((l) => match.test(l));
    if (line === undefined) return;
    matched = true;
    sends.push(post(spec, wakeText({ ...spec, ms: Date.now() - started, event: { line }, tail: "" })));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const event = await new Promise((resolve) => {
    child.on("error", (error) => {
      fs.writeSync(out, `${error.message}\n`);
      recent += `${error.message}\n`;
      resolve({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  fs.closeSync(out);
  await Promise.all(sends);
  await post(spec, wakeText({ ...spec, ms: Date.now() - started, event, tail: outputTail(recent) }));
}

if (process.env.BIVY_BACKGROUND_JOB && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBackgroundJob(JSON.parse(process.env.BIVY_BACKGROUND_JOB));
}
