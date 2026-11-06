// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared plumbing for the dispatchers in this directory (DISPATCH.md): read
// the request, run the operation, write the answer. No dependencies, so a
// dispatcher runs with plain `node`.

import fs from "node:fs";

/** Every machine the fleet creates is labelled with its app, so an account's
 * machines can be found, listed and deleted together. */
export const APP_LABEL = "bivy-app";

/** Where the boot payload lives on the machine, so a start can run it again. */
export const BOOT_SCRIPT = "/etc/bivy/boot.sh";

/** The node runs for hours: start the boot script detached, logging to disk. */
export const START_BOOT = `nohup bash ${BOOT_SCRIPT} >/var/log/bivy-boot.log 2>&1 </dev/null &`;

/** The boot script from the fleet's spec: its files, then its init command. */
export function bootScript(spec) {
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash\nexec ${spec.init.exec.map(quote).join(" ")}\n`;
}

/** Rough CPU and memory from the fleet's size names ("shared-4x-8gb"). */
export function sizeOf(size) {
  const match = /(\d+)x-(\d+)gb/i.exec(String(size ?? ""));
  return { cpus: match ? Number(match[1]) : 2, memoryGb: match ? Number(match[2]) : 4 };
}

export function need(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** JSON over fetch, with the platform's error text on failure. */
export async function api(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (res.status === 404 && init.allow404) return null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 300)}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}

/** Run one operation from the table and answer. Unknown operations answer
 * empty: anything the platform has no counterpart for is a no-op. */
export async function serve(operations) {
  const op = process.env.BIVY_DISPATCH_OP ?? "";
  const raw = fs.readFileSync(0, "utf8");
  const request = raw.trim() ? JSON.parse(raw) : {};
  try {
    const answer = operations[op] ? await operations[op](request) : {};
    process.stdout.write(JSON.stringify(answer ?? {}));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
